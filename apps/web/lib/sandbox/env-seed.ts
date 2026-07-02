import "server-only";

import type { Sandbox } from "@open-agents/sandbox";

const ENV_SEED_PATH = "/home/vercel-sandbox/.env.seed";

/**
 * Copy the env seed file baked into the base snapshot into the repo working
 * directory as `.env.local`, so the dev server gets its environment without
 * requiring Vercel project linking (which depends on private-beta API
 * permissions).
 *
 * Rewrites localhost redirect URIs to the sandbox's public URL so OAuth
 * callbacks resolve. Best-effort: a missing seed file or write failure is a
 * no-op.
 */
export async function syncEnvSeedToWorkspace(sandbox: Sandbox): Promise<void> {
  let seedContent = await sandbox
    .readFile(ENV_SEED_PATH, "utf-8")
    .catch(() => null);
  if (!seedContent) {
    return;
  }

  if (sandbox.domain) {
    const sandboxOrigin = sandbox.domain(5173).replace(/\/$/, "");
    seedContent = seedContent.replace(
      /^(WORKOS_REDIRECT_URI=).*$/m,
      `$1${sandboxOrigin}/api/auth/callback`,
    );
  }

  await sandbox
    .writeFile(`${sandbox.workingDirectory}/.env.local`, seedContent, "utf-8")
    .catch(() => {});
}
