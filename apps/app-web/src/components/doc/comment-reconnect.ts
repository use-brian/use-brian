/**
 * Live-turn reconnect decision for a comment thread.
 *
 * A doc comment-reply turn runs to completion in the background after a page
 * refresh (the `doc_thread` carve-out in the chat route). When the editor lists
 * threads on page open, a thread whose turn is still running arrives carrying
 * `sessionStatus === 'running'`. The thread body then re-attaches to that turn
 * via `GET /api/sessions/:id/stream` to show the live "working…" indicator and
 * stream the reply in.
 *
 * Pure so the rule is unit-testable without a DOM / SSE. See
 * docs/architecture/features/doc-comments.md → "Live turn reconnect".
 *
 * [COMP:app-web/comment-reconnect]
 */

export function shouldReconnectToTurn(params: {
  /** The thread's backing session status from the list endpoint. */
  sessionStatus?: string | null;
  /** The body is mounting a fresh seed hand-off (a brand-new thread whose first
   *  message it is about to send itself) — that turn streams over its own POST,
   *  so there's nothing to reconnect to. */
  seeded: boolean;
  /** The body is already sending its own reply turn (the local streaming path
   *  owns the bubble); a reconnect would double-drive it. */
  busy: boolean;
}): boolean {
  if (params.seeded || params.busy) return false;
  return params.sessionStatus === "running";
}
