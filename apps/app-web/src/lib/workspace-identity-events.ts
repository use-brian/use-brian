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
  /** Set on the spine's reconnect / tab-visible catch-up burst, never on a
   * server-sent change. See `isCatchUpRefresh`. */
  catchUp?: true;
};

/**
 * True when a spine event is the speculative catch-up burst (`allDomainDispatches`
 * on every stream `open` and tab-visible) rather than a change the server sent.
 * The stream cycles every ~5 minutes, so an authority listener that purges on
 * every identity event blanks its surface to a skeleton on that cadence. A
 * catch-up revalidates behind the paint instead; a real `workspace_config`
 * change (every access command emits one) still purges.
 */
export function isCatchUpRefresh(event: Event): boolean {
  return (event as CustomEvent<{ catchUp?: unknown } | null>).detail?.catchUp === true;
}
