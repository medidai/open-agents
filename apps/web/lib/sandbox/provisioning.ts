import "server-only";

import {
  connectSandbox,
  type Sandbox,
  type SandboxState,
} from "@open-agents/sandbox";
import {
  getSessionById,
  updateSessionIfNotArchived,
  type SessionRecord,
} from "@/lib/db/sessions";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import {
  resolveGitHubAuth,
  type ResolvedGitHubAuth,
} from "@/lib/github/resolve-token";
import { getGitHubUserProfile } from "@/lib/github/users";
import {
  installCommitTrailerHook,
  removeCommitTrailerHook,
} from "@/lib/sandbox/commit-trailer-hook";
import {
  DEFAULT_SANDBOX_BASE_SNAPSHOT_ID,
  DEFAULT_SANDBOX_PORTS,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  DEFAULT_SANDBOX_VCPUS,
} from "@/lib/sandbox/config";
import { syncEnvSeedToWorkspace } from "@/lib/sandbox/env-seed";
import {
  buildActiveLifecycleUpdate,
  getNextLifecycleVersion,
} from "@/lib/sandbox/lifecycle";
import { kickSandboxLifecycleWorkflow } from "@/lib/sandbox/lifecycle-kick";
import {
  getResumableSandboxName,
  getSessionSandboxName,
  isSandboxActive,
} from "@/lib/sandbox/utils";
import { installGlobalSkills } from "@/lib/skills/global-skill-installer";
import { eq } from "drizzle-orm";

type UserRecord = {
  id: string;
  username: string;
  name: string | null;
  email: string | null;
};

export type ProvisionSessionSandboxResult = {
  sandboxState: SandboxState;
  workingDirectory: string;
  currentBranch?: string;
  environmentDetails?: string;
  didSetupWorkspace: boolean;
  session: SessionRecord;
};

export class SessionArchivedDuringProvisioningError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} was archived during sandbox provisioning`);
    this.name = "SessionArchivedDuringProvisioningError";
  }
}

function isSandboxState(value: unknown): value is SandboxState {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "vercel"
  );
}

async function getUserById(userId: string): Promise<UserRecord | null> {
  const [user] = await db
    .select({
      id: users.id,
      username: users.username,
      name: users.name,
      email: users.email,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return user ?? null;
}

function buildSandboxSource(session: SessionRecord): SandboxState["source"] {
  if (!session.cloneUrl) {
    return undefined;
  }

  const branchExistsOnOrigin = session.prNumber != null;
  const shouldCreateNewBranch = session.isNewBranch && !branchExistsOnOrigin;

  return {
    repo: session.cloneUrl,
    ...(shouldCreateNewBranch
      ? { newBranch: session.branch ?? undefined }
      : { branch: session.branch ?? "main" }),
  };
}

function buildSandboxState(session: SessionRecord): SandboxState {
  const existingState = session.sandboxState;
  const sandboxName =
    getResumableSandboxName(existingState) ?? getSessionSandboxName(session.id);
  const source = buildSandboxSource(session);

  return {
    type: "vercel",
    ...(isSandboxState(existingState) ? existingState : {}),
    sandboxName,
    ...(source ? { source } : {}),
  };
}

async function getGitUser(user: UserRecord) {
  const profile = await getGitHubUserProfile(user.id);
  const githubNoreplyEmail =
    profile?.externalUserId && profile.username
      ? `${profile.externalUserId}+${profile.username}@users.noreply.github.com`
      : undefined;

  return {
    name: user.name ?? profile?.username ?? user.username,
    email:
      githubNoreplyEmail ??
      user.email ??
      `${user.username}@users.noreply.github.com`,
  };
}

/**
 * Resolve GitHub auth for the session repo. Supports users without a linked
 * GitHub account by falling back to a GitHub App installation token (the
 * "non-gh users" flow), matching the /api/sandbox route behavior.
 */
async function getSetupAuth(params: {
  user: UserRecord;
  session: SessionRecord;
}): Promise<ResolvedGitHubAuth | undefined> {
  if (!params.session.cloneUrl) {
    return undefined;
  }
  if (!params.session.repoOwner || !params.session.repoName) {
    throw new Error("Session is missing repository metadata");
  }

  const auth = await resolveGitHubAuth({
    userId: params.user.id,
    owner: params.session.repoOwner,
    repo: params.session.repoName,
    // Workflow steps run outside a request scope (no session cookie), so
    // supply the user's identity from the database for git attribution.
    fallbackIdentity: {
      name: params.user.name,
      email: params.user.email,
      username: params.user.username,
    },
  });
  if (!auth) {
    throw new Error("Connect GitHub to access repositories");
  }

  return auth;
}

async function installSessionGlobalSkills(params: {
  session: SessionRecord;
  sandbox: Sandbox;
  didSetupWorkspace: boolean;
}): Promise<void> {
  if (!params.didSetupWorkspace) {
    return;
  }

  const globalSkillRefs = params.session.globalSkillRefs ?? [];
  if (globalSkillRefs.length === 0) {
    return;
  }

  try {
    await installGlobalSkills({
      sandbox: params.sandbox,
      globalSkillRefs,
    });
  } catch (error) {
    console.error(
      `Failed to install global skills for session ${params.session.id}:`,
      error,
    );
  }
}

async function stopSandboxAfterArchiveRace(params: {
  sessionId: string;
  sandbox: Sandbox;
}): Promise<never> {
  try {
    await params.sandbox.stop();
  } catch (error) {
    console.error(
      `Failed to stop sandbox after session ${params.sessionId} was archived during provisioning:`,
      error,
    );
  }

  throw new SessionArchivedDuringProvisioningError(params.sessionId);
}

export async function provisionSessionSandbox(params: {
  sessionId: string;
  userId?: string;
}): Promise<ProvisionSessionSandboxResult> {
  const session = await getSessionById(params.sessionId);
  if (!session) {
    throw new Error("Session not found");
  }
  if (params.userId && session.userId !== params.userId) {
    throw new Error("Unauthorized");
  }
  if (session.status === "archived") {
    throw new Error("Session is archived");
  }

  const didSetupWorkspace = !isSandboxActive(session.sandboxState);
  const user = await getUserById(session.userId);
  if (!user) {
    throw new Error("User not found");
  }

  const setupAuth = await getSetupAuth({
    user,
    session,
  });
  // When the App is acting for an unlinked user, commit as the bot identity;
  // otherwise attribute commits to the user.
  const gitUser = setupAuth?.gitUser ?? (await getGitUser(user));

  const sandbox: Sandbox = await connectSandbox({
    state: buildSandboxState(session),
    options: {
      githubToken: setupAuth?.token,
      gitUser,
      timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
      vcpus: DEFAULT_SANDBOX_VCPUS,
      ports: DEFAULT_SANDBOX_PORTS,
      baseSnapshotId: DEFAULT_SANDBOX_BASE_SNAPSHOT_ID,
      persistent: true,
      resume: true,
      createIfMissing: true,
    },
  });

  const rawSandboxState = sandbox.getState?.();
  const sandboxState = isSandboxState(rawSandboxState)
    ? rawSandboxState
    : buildSandboxState(session);

  const updatedSession = await updateSessionIfNotArchived(params.sessionId, {
    sandboxState,
    snapshotUrl: null,
    snapshotCreatedAt: null,
    lifecycleVersion: getNextLifecycleVersion(session.lifecycleVersion),
    lifecycleError: null,
    ...buildActiveLifecycleUpdate(sandboxState),
  });

  if (!updatedSession) {
    await stopSandboxAfterArchiveRace({
      sessionId: params.sessionId,
      sandbox,
    });
  }

  // Copy the env seed baked into the base snapshot into the working
  // directory so the dev server gets .env.local (best-effort).
  try {
    await syncEnvSeedToWorkspace(sandbox);
  } catch (error) {
    console.error(
      `Failed to sync env seed for session ${params.sessionId}:`,
      error,
    );
  }

  await installSessionGlobalSkills({
    session,
    sandbox,
    didSetupWorkspace,
  });

  // When the GitHub App is acting on behalf of an unlinked Vercel user,
  // install a prepare-commit-msg hook that records the user via a
  // Co-authored-by trailer. Otherwise ensure the hook is removed (in case
  // the user just linked their GitHub account on a persistent sandbox).
  try {
    if (setupAuth?.source === "app" && setupAuth.coAuthorTrailer) {
      await installCommitTrailerHook({
        sandbox,
        trailer: setupAuth.coAuthorTrailer,
      });
    } else {
      await removeCommitTrailerHook({ sandbox });
    }
  } catch (error) {
    console.error(
      `Failed to configure commit trailer hook for session ${params.sessionId}:`,
      error,
    );
  }

  kickSandboxLifecycleWorkflow({
    sessionId: params.sessionId,
    reason: "sandbox-created",
  });

  return {
    sandboxState,
    workingDirectory: sandbox.workingDirectory,
    currentBranch: sandbox.currentBranch,
    environmentDetails: sandbox.environmentDetails,
    didSetupWorkspace,
    session: updatedSession ?? session,
  };
}
