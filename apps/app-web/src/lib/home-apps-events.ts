/**
 * Tiny event bus telling the Home app-bar to re-read its config (app-web).
 *
 * Mirrors `deck-events.ts` / `workflow-events.ts`: the shell-level workspace
 * stream (`workspace-events.ts`) dispatches this for `workspace_config` change
 * signals from any lane — the Studio "Mini apps" tab in this tab, an admin on
 * another device, a custom app that just dropped to `needs_consent`. Payloads
 * are signals, not data: subscribers re-fetch.
 *
 * WHY THIS EXISTS AT ALL. The app-bar renders inside `WorkspaceChrome`, which
 * is mounted by the `/w/[workspaceId]` layout and therefore **never unmounts**
 * during SPA navigation. A `useEffect(..., [workspaceId])` fetch there fires
 * once per full page load — `workspaceId` does not change when the user goes
 * Studio → doc → brain — so the strip could never self-heal after a config
 * change. A surface inside a persistent layout must subscribe to a signal. See
 * docs/architecture/platform/realtime-sync.md → "Why the roster needs a signal
 * at all", which is the same bug in the assistant switcher.
 *
 * The handler is **repair-only** where it holds a live selection: re-resolving
 * the active app unconditionally would yank the user off the surface they are
 * reading whenever a teammate reorders the strip.
 */

export const HOME_APPS_REFRESH_EVENT = "sidan:home-apps-refresh";

export type HomeAppsRefreshDetail = {
  /** Scopes the refresh; surfaces ignore other workspaces. */
  workspaceId: string | null;
};
