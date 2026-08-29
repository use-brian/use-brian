/**
 * Which assistant may speak in a room — the shared predicate behind BOTH
 * paths that can point a room's turn at an assistant.
 *
 * Two routes ask this question and they must never drift:
 *   - `routes/chat.ts` — `@AssistantName` picks who answers ONE turn
 *     (multiplayer chat T9);
 *   - `routes/sessions.ts` — `PATCH /:id/assistant` moves the room's DEFAULT
 *     voice for every later turn.
 *
 * It lives in its own module rather than in `chat.ts` because `chat.ts`
 * already imports `gateSessionRead` from `sessions.ts`; importing back the
 * other way would close an ESM cycle through two of the heaviest modules in
 * the package. `chat.ts` re-exports it, so existing importers are unchanged.
 */

/**
 * May this assistant ANSWER in this room? (Multiplayer chat T9.)
 *
 * `@AssistantName` picks which workspace assistant answers a turn, but the
 * room's `effective_clearance` is its members' read floor — an assistant
 * cleared ABOVE the room would draw on data the room's readers may not see,
 * so the answering assistant's clearance must not out-rank the room's.
 * (Equal or lower is fine: no widening.) A NULL room clearance is treated as
 * 'internal', matching the session-create default.
 */
export function mayAssistantAnswerInRoom(params: {
  assistantClearance: string | null
  roomClearance: string | null
}): boolean {
  const rank = (c: string | null, fallback: number): number =>
    c === 'public' ? 0 : c === 'internal' ? 1 : c === 'confidential' ? 2 : fallback
  return rank(params.assistantClearance, 1) <= rank(params.roomClearance, 1)
}

/**
 * May a send whose `assistantId` differs from the session's binding run the
 * turn as that assistant? The single decision behind the chat route's
 * cross-assistant exception, covering BOTH per-turn-addressable session
 * kinds (chat-app.md → "Choosing an assistant"):
 *
 *   - a workspace-shared room (multiplayer chat T9): allowed same-workspace,
 *     capped by the room's read floor (`mayAssistantAnswerInRoom`) — an
 *     assistant cleared above the room would draw on data its readers may
 *     not see;
 *   - the doc dock's PERSONAL thread (the room mechanics without the room):
 *     allowed same-workspace with NO clearance cap — the thread's audience
 *     is its owner alone, reachability is already `getUserAssistant`-gated,
 *     and each turn's tool reads run under the ANSWERING assistant's own
 *     clearance via RLS, so there is no widened reader to protect.
 *
 * Everything else — an ordinary personal chat thread, a cross-workspace id —
 * stays rejected. Pure so `room-mechanics.test.ts` can pin the whole matrix.
 */
export function crossAssistantSendPolicy(params: {
  /** `isSharedChatSession(session)` — a workspace-shared room. */
  isSharedSession: boolean
  /** `isDocSurface(session)` — the doc dock's personal thread. */
  isDocSurfaceSession: boolean
  /** The requested assistant lives in the SAME workspace as the session's
   *  bound assistant. */
  sameWorkspace: boolean
  assistantClearance: string | null
  /** The session's `effective_clearance` (rooms; null on personal rows). */
  sessionClearance: string | null
}): 'allow' | 'clearance_refused' | 'reject' {
  if (!params.sameWorkspace) return 'reject'
  if (params.isSharedSession) {
    return mayAssistantAnswerInRoom({
      assistantClearance: params.assistantClearance,
      roomClearance: params.sessionClearance,
    })
      ? 'allow'
      : 'clearance_refused'
  }
  if (params.isDocSurfaceSession) return 'allow'
  return 'reject'
}
