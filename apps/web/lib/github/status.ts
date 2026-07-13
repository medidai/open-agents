export type GitHubConnectionStatus =
  | "not_connected"
  | "connected"
  | "reconnect_required";

export type GitHubConnectionReason =
  | "token_unavailable"
  | "installations_missing"
  | "sync_auth_failed";

export interface GitHubConnectionStatusResponse {
  status: GitHubConnectionStatus;
  reason: GitHubConnectionReason | null;
  hasInstallations: boolean;
  syncedInstallationsCount: number | null;
  /**
   * True when the user has no linked GitHub account but the GitHub App is
   * configured, so repo operations can fall back to App installation tokens
   * (the "non-gh users" flow).
   */
  appFallbackAvailable?: boolean;
}
