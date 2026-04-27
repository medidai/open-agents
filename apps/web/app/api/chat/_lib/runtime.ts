import { discoverSkills } from "@open-agents/agent";
import { connectSandbox } from "@open-agents/sandbox";
import { resolveGitHubAuth } from "@/lib/github/resolve-token";
import { getUserGitHubToken } from "@/lib/github/token";
import {
  installCommitTrailerHook,
  removeCommitTrailerHook,
} from "@/lib/sandbox/commit-trailer-hook";
import { DEFAULT_SANDBOX_PORTS } from "@/lib/sandbox/config";
import { getSandboxSkillDirectories } from "@/lib/skills/directories";
import { getCachedSkills, setCachedSkills } from "@/lib/skills-cache";
import type { SessionRecord } from "./chat-context";

type DiscoveredSkills = Awaited<ReturnType<typeof discoverSkills>>;
type ConnectedSandbox = Awaited<ReturnType<typeof connectSandbox>>;
type ActiveSandboxState = NonNullable<SessionRecord["sandboxState"]>;

async function loadSessionSkills(
  sessionId: string,
  sandboxState: ActiveSandboxState,
  sandbox: ConnectedSandbox,
): Promise<DiscoveredSkills> {
  const cachedSkills = await getCachedSkills(sessionId, sandboxState);
  if (cachedSkills !== null) {
    return cachedSkills;
  }

  // Discover project-level skills from the sandbox working directory plus
  // global skills installed outside the repo working tree.
  // TODO: Optimize if this becomes a bottleneck (~20ms no skills, ~130ms with 5 skills)
  const skillDirs = await getSandboxSkillDirectories(sandbox);

  const discoveredSkills = await discoverSkills(sandbox, skillDirs);
  await setCachedSkills(sessionId, sandboxState, discoveredSkills);
  return discoveredSkills;
}

export async function createChatRuntime(params: {
  userId: string;
  sessionId: string;
  sessionRecord: SessionRecord;
}): Promise<{
  sandbox: ConnectedSandbox;
  skills: DiscoveredSkills;
}> {
  const { userId, sessionId, sessionRecord } = params;

  const sandboxState = sessionRecord.sandboxState;
  if (!sandboxState) {
    throw new Error("Sandbox state is required to create chat runtime");
  }

  const resolvedAuth =
    sessionRecord.repoOwner && sessionRecord.repoName
      ? await resolveGitHubAuth({
          userId,
          owner: sessionRecord.repoOwner,
          repo: sessionRecord.repoName,
        })
      : null;
  const githubToken =
    resolvedAuth?.token ?? (await getUserGitHubToken(userId)) ?? undefined;

  const sandbox = await connectSandbox(sandboxState, {
    githubToken,
    ports: DEFAULT_SANDBOX_PORTS,
  });

  // Re-assert the commit trailer hook on every connect so a fresh App token
  // session always has the right attribution, and so the hook is removed
  // promptly if the user just linked their GitHub account.
  try {
    if (resolvedAuth?.source === "app" && resolvedAuth.coAuthorTrailer) {
      await installCommitTrailerHook({
        sandbox,
        trailer: resolvedAuth.coAuthorTrailer,
      });
    } else if (resolvedAuth?.source === "user") {
      await removeCommitTrailerHook({ sandbox });
    }
  } catch (error) {
    console.warn(
      `Failed to sync commit trailer hook for session ${sessionId}:`,
      error,
    );
  }

  const skills = await loadSessionSkills(sessionId, sandboxState, sandbox);

  return {
    sandbox,
    skills,
  };
}
