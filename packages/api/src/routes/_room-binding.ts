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
