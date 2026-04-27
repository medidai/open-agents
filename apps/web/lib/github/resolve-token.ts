import "server-only";
import { getServerSession } from "@/lib/session/get-server-session";
import {
  getAppCoAuthorTrailer,
  getBotGitIdentity,
  getInstallationToken,
  isGitHubAppConfigured,
} from "./app-auth";
import { getInstallationIdForRepo } from "./installation-resolver";
import { getGitHubUserProfile, getUserGitHubToken } from "./token";

export type ResolvedGitHubAuth = {
  source: "user" | "app";
  token: string;
  gitUser: { name: string; email: string };
  /**
   * Trailer to append to commit messages so the "other party" is recorded.
   * - source = "user": the human is the committer; the bot is the co-author.
   * - source = "app":  the bot is the committer; the Vercel user is the co-author.
   * Null only when no bot identity is available for the user-source path.
   */
  coAuthorTrailer: string | null;
};

interface VercelUserIdentity {
  name: string;
  email: string;
}

async function resolveVercelUserIdentity(
  userId: string,
): Promise<VercelUserIdentity> {
  const session = await getServerSession();
  const sessionUser = session?.user?.id === userId ? session.user : undefined;

  const fallbackUsername = sessionUser?.username ?? userId;
  const name = sessionUser?.name ?? sessionUser?.username ?? "Vercel User";
  const email =
    sessionUser?.email ?? `${fallbackUsername}@users.noreply.vercel.app`;

  return { name, email };
}

/**
 * Resolve a GitHub auth context for a given user + target repository.
 *
 * Returns the user's linked GitHub OAuth token when available. Otherwise,
 * falls back to an installation token from the GitHub App (when the App is
 * installed on the repo). Returns null when no auth path is available.
 *
 * The "app" branch also supplies the bot git identity to use as committer
 * and a `Co-authored-by:` trailer that attributes the Vercel user.
 */
export async function resolveGitHubAuth(params: {
  userId: string;
  owner: string;
  repo: string;
}): Promise<ResolvedGitHubAuth | null> {
  const { userId, owner, repo } = params;

  const userToken = await getUserGitHubToken(userId);
  if (userToken) {
    const ghProfile = await getGitHubUserProfile(userId);
    const session = await getServerSession();
    const sessionUser = session?.user?.id === userId ? session.user : undefined;

    const noreplyEmail =
      ghProfile?.externalUserId && ghProfile.username
        ? `${ghProfile.externalUserId}+${ghProfile.username}@users.noreply.github.com`
        : undefined;

    const gitUser = {
      name:
        sessionUser?.name ??
        ghProfile?.username ??
        sessionUser?.username ??
        "Vercel User",
      email:
        noreplyEmail ??
        sessionUser?.email ??
        `${sessionUser?.username ?? userId}@users.noreply.github.com`,
    };

    const botTrailer = await getAppCoAuthorTrailer();

    return {
      source: "user",
      token: userToken,
      gitUser,
      coAuthorTrailer: botTrailer,
    };
  }

  if (!isGitHubAppConfigured()) return null;

  const installationId = await getInstallationIdForRepo({ owner, repo });
  if (!installationId) return null;

  let appToken: string;
  try {
    appToken = await getInstallationToken(installationId);
  } catch (error) {
    console.error(
      `Failed to mint installation token for ${owner}/${repo}:`,
      error,
    );
    return null;
  }

  const botIdentity = await getBotGitIdentity();
  if (!botIdentity) return null;

  const vercelUser = await resolveVercelUserIdentity(userId);
  const coAuthorTrailer = `Co-authored-by: ${vercelUser.name} <${vercelUser.email}>`;

  return {
    source: "app",
    token: appToken,
    gitUser: botIdentity,
    coAuthorTrailer,
  };
}
