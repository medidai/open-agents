import { NextRequest, NextResponse } from "next/server";
import { getInstallationByUserAndId } from "@/lib/db/installations";
import { isGitHubAppConfigured } from "@/lib/github/app-auth";
import {
  listAppInstallationRepositories,
  listUserInstallationRepositories,
} from "@/lib/github/installation-repos";
import {
  type AppInstallationSummary,
  listAllAppInstallations,
} from "@/lib/github/installation-resolver";
import { getUserGitHubToken } from "@/lib/github/token";
import { getServerSession } from "@/lib/session/get-server-session";

function parseInstallationId(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

export async function GET(request: NextRequest) {
  const session = await getServerSession();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const installationId = parseInstallationId(
    searchParams.get("installation_id"),
  );
  const query = searchParams.get("query")?.trim() || undefined;
  const limitParam = searchParams.get("limit");
  const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
  const limit =
    typeof parsedLimit === "number" && Number.isFinite(parsedLimit)
      ? parsedLimit
      : undefined;

  if (!installationId) {
    return NextResponse.json(
      { error: "installation_id is required" },
      { status: 400 },
    );
  }

  const userInstallation = await getInstallationByUserAndId(
    session.user.id,
    installationId,
  );
  const userToken = userInstallation
    ? await getUserGitHubToken(session.user.id)
    : null;

  try {
    if (userInstallation && userToken) {
      const repos = await listUserInstallationRepositories({
        installationId,
        userToken,
        owner: userInstallation.accountLogin,
        query,
        limit,
      });
      return NextResponse.json(repos);
    }

    // App fallback: confirm the installation belongs to the App, then list
    // its repos using an installation token.
    if (!isGitHubAppConfigured()) {
      return NextResponse.json(
        { error: "Installation not found" },
        { status: 403 },
      );
    }

    const appInstallations = await listAllAppInstallations();
    const appInstallation: AppInstallationSummary | undefined =
      appInstallations.find((entry) => entry.installationId === installationId);
    if (!appInstallation) {
      return NextResponse.json(
        { error: "Installation not found" },
        { status: 403 },
      );
    }

    const repos = await listAppInstallationRepositories({
      installationId,
      query,
      limit,
    });
    return NextResponse.json(repos);
  } catch (error) {
    console.error("Failed to fetch installation repositories:", error);
    return NextResponse.json(
      { error: "Failed to fetch repositories" },
      { status: 500 },
    );
  }
}
