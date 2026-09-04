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

/**
 * Is this turn happening on the Doc surface? True for a session that
 * originated in `apps/app-web` (`appOrigin='doc'`) or a doc comment
 * thread. This is the surface signal that drives doc-skill injection,
 * decoupled from WHICH assistant is talking (the workspace primary by default,
 * or any assistant the user switched to). Mirrors the surface test in
 * `resolveRunChannel`.
 *
 * Lives here rather than in `chat.ts` because `sessions.ts` needs the SAME
 * predicate to decide what the doc dock's resume may return (see
 * `DOC_DOCK_RESUME_ROW`) and cannot import `chat.ts` without closing an ESM
 * cycle. `chat.ts` re-exports it, so existing importers are unchanged.
 */
export function isDocSurface(session: {
  appOrigin: string | null
  channelType: string
}): boolean {
  return session.appOrigin === 'doc' || session.channelType === 'doc_thread'
}

/**
 * The ONLY session shape the doc dock's `scope=workspace` resume may return
 * (`GET /api/sessions?scope=workspace&appOrigin=doc`, `routes/sessions.ts`).
 *
 * The dock's thread is per-turn addressable: switching the assistant in the
 * header does NOT start a new thread, it re-addresses the next turn on the
 * current one. So a row the resume can ATTACH must also be a row
 * `crossAssistantSendPolicy` will let another workspace assistant ANSWER on —
 * i.e. it must satisfy `isDocSurface`. When the two drifted apart the dock
 * latched onto rows it could never re-address (2026-09-01: the workspace's
 * newest owner row was the `channel_id='notifications'` inbox thread —
 * `app_origin IS NULL`, `channel_type='notification'` — so every send after an
 * assistant switch died on "Session does not belong to this assistant", with
 * no way out: the dock has no new-chat control and each rejected send bumped
 * `last_active_at`, keeping the unusable row at the top of the resume).
 *
 * The list query is BUILT from these values rather than hard-coding them, and
 * `sessions-list-scope.test.ts` asserts `isDocSurface(DOC_DOCK_RESUME_ROW)` —
 * so widening the resume without widening the policy fails the test.
 */
export const DOC_DOCK_RESUME_ROW = {
  appOrigin: 'doc',
  channelType: 'web',
} as const
