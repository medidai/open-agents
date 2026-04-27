import "server-only";
import type { Sandbox } from "@open-agents/sandbox";

const HOOK_RELATIVE_PATH = ".git/hooks/prepare-commit-msg";

/**
 * Install a `prepare-commit-msg` git hook in the sandbox that appends the
 * given Co-authored-by trailer to every commit message. The hook is
 * idempotent — `git interpret-trailers --if-exists addIfDifferent` skips the
 * trailer when it is already present.
 */
export async function installCommitTrailerHook(params: {
  sandbox: Sandbox;
  trailer: string;
}): Promise<void> {
  const { sandbox, trailer } = params;
  const cwd = sandbox.workingDirectory;

  const escapedTrailer = trailer.replace(/'/g, "'\\''");
  const hookContent = `#!/bin/sh
# Auto-installed by medida sandbox to attribute commits to the originating
# Vercel user when the GitHub App is the committer.
COMMIT_MSG_FILE="$1"
COMMIT_SOURCE="$2"

# Skip merge / squash / rebase auto-generated messages.
case "$COMMIT_SOURCE" in
  merge|squash) exit 0 ;;
esac

git interpret-trailers --in-place --if-exists addIfDifferent \\
  --trailer '${escapedTrailer}' "$COMMIT_MSG_FILE"
`;

  await sandbox.writeFile(`${cwd}/${HOOK_RELATIVE_PATH}`, hookContent, "utf-8");
  await sandbox.exec(`chmod +x ${HOOK_RELATIVE_PATH}`, cwd, 5000);
}

export async function removeCommitTrailerHook(params: {
  sandbox: Sandbox;
}): Promise<void> {
  const { sandbox } = params;
  const cwd = sandbox.workingDirectory;
  await sandbox.exec(`rm -f ${HOOK_RELATIVE_PATH}`, cwd, 5000);
}
