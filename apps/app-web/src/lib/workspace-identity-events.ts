/**
 * Server-backed workspace identity refresh signal.
 *
 * `workspace-events.ts` dispatches this alongside the Home-app refresh for a
 * `workspace_config` SSE payload. The persistent `WorkspaceContextProvider`
 * listens and re-reads the small name/icon projection so chrome self-heals
 * across tabs, devices, and teammates.
 */

export const WORKSPACE_IDENTITY_REFRESH_EVENT =
  "sidan:workspace-identity-refresh";

export type WorkspaceIdentityRefreshDetail = {
  workspaceId: string;
};
