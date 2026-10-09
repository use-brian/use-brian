import type { Session } from '../db/sessions.js'

// Required fields deliberately mirror the real Session loaders. A partial
// projection must not silently widen an input's audience at this boundary.
export type WebChatEventScope = Pick<Session,
  'channelType' | 'anchorKind' | 'visibility' | 'mode' | 'effectiveClearance' |
  'contextGroupId' | 'contextProjectId' | 'contextCompartments'>

/** Workspace automation has no per-session authority envelope. Even a caller
 * who can read a private/scoped chat cannot publish it into workflow run input.
 * Source UUID secrecy and picker permissions are NOT authorization controls.
 *
 * Require explicit public clearance. NULL is the omitted insert default (and
 * sensitivity_rank is SQL STRICT), NOT evidence of an unrestricted audience.
 * Unknown/missing fields fail closed as well. Draft sessions have additional
 * feed-source audience rules, so they are not eligible for unscoped fan-out.
 * appOrigin is intentionally irrelevant: shared unrestricted workflow and
 * assistant-surface chats have exactly the same policy as the chat app.
 */
export function isWorkspaceWideWebChat(session: WebChatEventScope): boolean {
  return session.channelType === 'web' &&
    session.visibility === 'workspace' &&
    session.mode === null &&
    session.effectiveClearance === 'public' &&
    session.contextGroupId === null &&
    session.contextProjectId === null &&
    Array.isArray(session.contextCompartments) &&
    session.contextCompartments.length === 0
}
