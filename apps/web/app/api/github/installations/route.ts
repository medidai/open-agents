import { NextResponse } from "next/server";
import { getInstallationsByUserId } from "@/lib/db/installations";
import { getInstallationManageUrl } from "@/lib/github/installation-url";
import { listAllAppInstallations } from "@/lib/github/installation-resolver";
import { getServerSession } from "@/lib/session/get-server-session";

export async function GET() {
  const session = await getServerSession();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  try {
    const installations = await getInstallationsByUserId(session.user.id);

    if (installations.length > 0) {
      return NextResponse.json(
        installations.map((installation) => ({
          installationId: installation.installationId,
          accountLogin: installation.accountLogin,
          accountType: installation.accountType,
          repositorySelection: installation.repositorySelection,
          installationUrl: getInstallationManageUrl(
            installation.installationId,
            installation.installationUrl,
          ),
        })),
      );
    }

    // Fall back to listing every installation the GitHub App has, so users
    // who haven't linked a personal GitHub account can still pick a repo.
    const appInstallations = await listAllAppInstallations();
    return NextResponse.json(
      appInstallations.map((installation) => ({
        installationId: installation.installationId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        repositorySelection: installation.repositorySelection,
        installationUrl: getInstallationManageUrl(
          installation.installationId,
          installation.installationUrl,
        ),
      })),
    );
  } catch (error) {
    console.error("Failed to fetch GitHub installations:", error);
    return NextResponse.json(
      { error: "Failed to fetch installations" },
      { status: 500 },
    );
  }
}
