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

import { classifySession } from '../session-kind.js'
import type { AccessCeiling } from '@use-brian/agent-runtime/security/access-ceiling.js'
import type { Session } from '../db/sessions.js'

/**
 * The immutable audience envelope for one workspace-shared room. Delivery,
 * roster projection, and read authorization all use these stored fields; a
 * later assistant/member grant may narrow the room but can never widen it.
 */
export function roomAudienceCeiling(
  workspaceId: string,
  session: Pick<Session, 'effectiveClearance' | 'contextCompartments' | 'contextProjectId'>,
): AccessCeiling {
  return {
    workspaceId,
    // A shared room is not a personal audience. Source evidence with a
    // private user owner therefore cannot cross this boundary.
    userId: '',
    clearance: session.effectiveClearance === 'public'
      || session.effectiveClearance === 'confidential'
      ? session.effectiveClearance
      : 'internal',
    compartments: session.contextCompartments ?? [],
    mutationCompartments: session.contextCompartments ?? [],
    projectIds: session.contextProjectId ? [session.contextProjectId] : [],
    visibilityAssistantIds: null,
  }
}

const clearanceRank = (c: string | null | undefined, fallback: number): number =>
  c === 'public' ? 0 : c === 'internal' ? 1 : c === 'confidential' ? 2 : fallback

/**
 * How an assistant's clearance fits a room's read floor (M5Q-7 variant A).
 *
 *   - `exceeds`: cleared ABOVE the room. It would draw on data the room's
 *     readers may not see, so it must not answer (no widening).
 *   - `below`: cleared BELOW the room. Its ceiling cannot read the room's
 *     envelope or transcript, so every lane would refuse its turn; it is
 *     refused at invitation instead of being admitted and then failed.
 *   - `fits`: cleared exactly to the room.
 *
 * A NULL room clearance is treated as 'internal', matching the
 * session-create default; a NULL assistant clearance likewise. The room's
 * clearance never moves to make an assistant fit (chat-app.md, "The room's
 * clearance NEVER moves").
 */
export function roomClearanceFit(params: {
  assistantClearance: string | null
  roomClearance: string | null
}): 'fits' | 'exceeds' | 'below' {
  const assistant = clearanceRank(params.assistantClearance, 1)
  const room = clearanceRank(params.roomClearance, 1)
  return assistant > room ? 'exceeds' : assistant < room ? 'below' : 'fits'
}

/**
 * May this assistant ANSWER in this room? (Multiplayer chat T9.)
 *
 * `@AssistantName` picks which workspace assistant answers a turn, and
 * `PATCH /:id/assistant` moves the room's default voice. Either way the
 * answering assistant must be cleared exactly to the room's
 * `effective_clearance` (`roomClearanceFit`): above would widen the room,
 * below could not read it.
 */
export function mayAssistantAnswerInRoom(params: {
  assistantClearance: string | null
  roomClearance: string | null
}): boolean {
  return roomClearanceFit(params) === 'fits'
}

/**
 * May a ceiling read a row labelled `label`? The personal response-group
 * rule: the authored row keeps the label its first member's turn stamped,
 * and a later member whose ceiling is below it is refused at invitation
 * rather than lowering the row (session-messages.md, "Response groups and
 * the native conversation reader"). A missing label (a pre-scope row) is
 * not a refusal: the reader still admits that row on its own.
 */
export function mayCeilingReadLabel(params: {
  ceiling: string | null | undefined
  label: string | null | undefined
}): boolean {
  if (!params.label) return true
  return clearanceRank(params.ceiling, 1) >= clearanceRank(params.label, 2)
}

/** The refusal code for an assistant whose ceiling cannot read the
 *  conversation it was invited into (room floor or authored row). */
export const ASSISTANT_CLEARANCE_BELOW_CONVERSATION = 'assistant_clearance_below_conversation'

/**
 * Server copy for that refusal. Names the assistant and the mismatch, never
 * a clearance level (the client never sees clearance levels), and says what
 * resolves it. `skipped` is a response-group member passed over while the
 * cleared members answer; otherwise the mention itself was rejected.
 */
export function clearanceBelowConversationCopy(params: {
  assistantName: string
  conversation: 'room' | 'message'
  skipped: boolean
}): string {
  const target = params.conversation === 'room' ? 'this room' : 'this message'
  return params.skipped
    ? `${params.assistantName} was skipped because it is not cleared to read ${target}. A workspace admin can raise its clearance.`
    : `${params.assistantName} is not cleared to read ${target}, so it cannot answer here. Remove the mention, or ask a workspace admin to raise its clearance.`
}

/**
 * Copy for a room's DEFAULT voice that cannot read the room: a rebind
 * refused under this rule, or a room left bound below its floor by a rebind
 * the old rule admitted (its default turns are refused up front). The fix is
 * choosing another default, not removing a mention.
 */
export function clearanceBelowRoomDefaultCopy(assistantName: string): string {
  return `${assistantName} is not cleared to read this room, so it cannot answer here. Choose an assistant cleared for this room, or ask a workspace admin to raise its clearance.`
}

/**
 * May a send whose `assistantId` differs from the session's binding run the
 * turn as that assistant? The single decision behind the chat route's
 * cross-assistant exception, covering BOTH per-turn-addressable session
 * kinds (chat-app.md → "Choosing an assistant"):
 *
 *   - a workspace-shared room (multiplayer chat T9): allowed same-workspace
 *     at the room's read floor (`roomClearanceFit`). Above it is
 *     `clearance_refused` (it would draw on data the room's readers may not
 *     see); below it is `clearance_below` (it cannot read the room, so the
 *     chat route refuses or, for a response-group member, skips it);
 *   - a personal web chat (chat-parity D1, a room with one human): allowed
 *     same-workspace with NO clearance cap (`ownerOnly`), as below;
 *   - the doc dock's PERSONAL thread (the room mechanics without the room):
 *     allowed same-workspace with NO clearance cap — the thread's audience
 *     is its owner alone, reachability is already `getUserAssistant`-gated,
 *     and each turn's tool reads run under the ANSWERING assistant's own
 *     clearance via RLS, so there is no widened reader to protect.
 *
 * Everything else (a personal thread on another surface or transport, a
 * cross-workspace id) stays rejected. Pure so `room-mechanics.test.ts` can pin the whole matrix.
 */
export function crossAssistantSendPolicy(params: {
  /** `sessionPolicy(kind).crossAssistantSend === 'room'`: a workspace room. */
  isSharedSession: boolean
  /** `sessionPolicy(kind).crossAssistantSend === 'doc'`: the doc dock's personal thread. */
  isDocSurfaceSession: boolean
  /** The requested assistant lives in the SAME workspace as the session's
   *  bound assistant. */
  sameWorkspace: boolean
  assistantClearance: string | null
  /** The session's `effective_clearance` (rooms; null on personal rows). */
  sessionClearance: string | null
  /**
   * `sessionPolicy(kind).read.rule === 'owner'`: a personal web chat, a room
   * with one human (chat-parity D1/T3). Its only reader is its owner, so
   * there is no wider audience for a clearance cap to protect: the
   * answering assistant reads under its own clearance, exactly as in a 1:1
   * chat with that user, the same reasoning as the doc dock's thread.
   */
  ownerOnly?: boolean
}): 'allow' | 'clearance_refused' | 'clearance_below' | 'reject' {
  if (!params.sameWorkspace) return 'reject'
  if (params.isSharedSession && params.ownerOnly === true) return 'allow'
  if (params.isSharedSession) {
    const fit = roomClearanceFit({
      assistantClearance: params.assistantClearance,
      roomClearance: params.sessionClearance,
    })
    return fit === 'fits' ? 'allow' : fit === 'exceeds' ? 'clearance_refused' : 'clearance_below'
  }
  if (params.isDocSurfaceSession) return 'allow'
  return 'reject'
}


/**
 * The ONLY session shape the doc dock's `scope=workspace` resume may return
 * (`GET /api/sessions?scope=workspace&appOrigin=doc`, `routes/sessions.ts`).
 *
 * The dock's thread is per-turn addressable: switching the assistant in the
 * header does NOT start a new thread, it re-addresses the next turn on the
 * current one. So a row the resume can ATTACH must also be a row
 * `crossAssistantSendPolicy` will let another workspace assistant ANSWER on —
 * i.e. its policy must be `docSurface`. When the two drifted apart the dock
 * latched onto rows it could never re-address (2026-09-01: the workspace's
 * newest owner row was the `channel_id='notifications'` inbox thread —
 * `app_origin IS NULL`, `channel_type='notification'` — so every send after an
 * assistant switch died on "Session does not belong to this assistant", with
 * no way out: the dock has no new-chat control and each rejected send bumped
 * `last_active_at`, keeping the unusable row at the top of the resume).
 *
 * The list query is BUILT from these values rather than hard-coding them, and
 * `sessions-list-scope.test.ts` asserts `policyFor(DOC_DOCK_RESUME_ROW).docSurface` —
 * so widening the resume without widening the policy fails the test.
 */
export const DOC_DOCK_RESUME_ROW = {
  appOrigin: 'doc',
  channelType: 'web',
  anchorKind: 'none',
} as const
