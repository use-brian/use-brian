/**
 * Tiny event bus telling deck surfaces to re-fetch (app-web).
 *
 * Mirrors `workflow-events.ts`: the shell-level workspace stream
 * (`workspace-events.ts`) dispatches this for `deck` change signals from ANY
 * lane — assistant chat, the callee executor, workflow steps, another tab —
 * so the deck live preview refreshes the moment updatePowerpoint rebuilds
 * the deck. Payloads are signals, not data: subscribers re-fetch.
 */

export const DECK_REFRESH_EVENT = "sidan:deck-refresh";

export type DeckRefreshDetail = {
  /** Scopes the refresh; surfaces ignore other workspaces. */
  workspaceId: string | null;
  /** The changed deck id when the server signal carried one. */
  rowId?: string;
};
