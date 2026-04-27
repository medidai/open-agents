import "server-only";
import { getAppOctokit, isGitHubAppConfigured } from "./app-auth";

interface InstallationLookupResponse {
  id: number;
}

interface AppInstallationAccount {
  login?: string;
  type?: string;
  html_url?: string;
}

interface AppInstallationResponse {
  id: number;
  account: AppInstallationAccount | null;
  repository_selection?: "all" | "selected";
  html_url?: string;
}

export interface AppInstallationSummary {
  installationId: number;
  accountLogin: string;
  accountType: "User" | "Organization";
  repositorySelection: "all" | "selected";
  installationUrl: string | null;
}

function normalizeAccountType(
  type: string | undefined,
): "User" | "Organization" {
  return type === "Organization" ? "Organization" : "User";
}

/**
 * Resolve the GitHub App installation that covers a given repository, by
 * calling `GET /repos/{owner}/{repo}/installation` with the App JWT.
 *
 * Returns null if the App is not configured, the App is not installed on the
 * repo's owner, or the installation does not have access to the repo.
 */
export async function getInstallationIdForRepo(params: {
  owner: string;
  repo: string;
}): Promise<number | null> {
  if (!isGitHubAppConfigured()) return null;

  try {
    const octokit = getAppOctokit();
    const response = await octokit.request(
      "GET /repos/{owner}/{repo}/installation",
      { owner: params.owner, repo: params.repo },
    );
    const data = response.data as InstallationLookupResponse;
    return typeof data.id === "number" ? data.id : null;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404) return null;
    console.error(
      `Failed to resolve installation for ${params.owner}/${params.repo}:`,
      error,
    );
    return null;
  }
}

/**
 * List all installations of the GitHub App. Used as a fallback for Vercel
 * users who have not linked a GitHub account, so they can still pick a repo
 * from any org/user the App is installed on.
 */
export async function listAllAppInstallations(): Promise<
  AppInstallationSummary[]
> {
  if (!isGitHubAppConfigured()) return [];

  const octokit = getAppOctokit();
  const installations: AppInstallationSummary[] = [];

  try {
    let page = 1;
    const perPage = 100;
    while (true) {
      const response = await octokit.request("GET /app/installations", {
        per_page: perPage,
        page,
      });
      const pageData = response.data as AppInstallationResponse[];

      for (const item of pageData) {
        if (!item.account?.login) continue;
        installations.push({
          installationId: item.id,
          accountLogin: item.account.login,
          accountType: normalizeAccountType(item.account.type),
          repositorySelection: item.repository_selection ?? "selected",
          installationUrl: item.html_url ?? item.account.html_url ?? null,
        });
      }

      if (pageData.length < perPage) break;
      page += 1;
    }
  } catch (error) {
    console.error("Failed to list App installations:", error);
    return [];
  }

  installations.sort((a, b) =>
    a.accountLogin.toLowerCase().localeCompare(b.accountLogin.toLowerCase()),
  );

  return installations;
}
