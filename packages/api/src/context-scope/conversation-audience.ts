/** One conversation record's audience, independent of history length.
 * Callers resolve current facts; this predicate grants no read on its own.
 * SQL source/destination admission must enforce the same containment contract.
 * Spec: scoped-context.md, "Conversation-record source audience".
 * [COMP:api/conversation-visibility] */
import type { ResourceScope } from '@use-brian/agent-runtime/security/derived-scope.js'
import { canRead } from '@use-brian/agent-runtime/security/sensitivity.js'
import { hasWorkspaceConversationAudience, type ConversationVisibility } from '../session-kind.js'

export type ConversationAudience = {
  sessionId: string
  workspaceId: string
  starterUserId: string
  visibility: ConversationVisibility
  participantUserIds: readonly string[]
  cap: ResourceScope['sensitivity']
  compartments: readonly string[]
  projectIds: readonly string[]
  anchor: { kind: string; id: string } | null
  /** Audience/withdrawal authority, not the number of appended messages. */
  generation: string
}

export type ConversationDerivativeDestination =
  | { kind: 'conversation'; audience: ConversationAudience }
  | { kind: 'resource'; scope: ResourceScope; anchor?: ConversationAudience['anchor'] }

const contains = (superset: readonly string[], subset: readonly string[]) => {
  const values = new Set(superset)
  return subset.every(value => values.has(value))
}
const participants = (audience: ConversationAudience): string[] => [audience.starterUserId,
  ...(audience.visibility === 'private_by_kind' ? [] : audience.participantUserIds)]
const sameAnchor = (a: ConversationAudience['anchor'], b: ConversationAudience['anchor']) =>
  a === null || b !== null && a.kind === b.kind && a.id === b.id

export type ConversationContainmentDecision =
  | { allowed: true }
  | { allowed: false; reason: 'workspace' | 'labels' | 'participants' | 'anchor' | 'generation' }

/** Detached fact from the receiving boundary's fresh source read for its actual
 * personal recipient. Never populate this from a tool/client request or from
 * the acting author's own admission. SQL repeats it at write/delivery time. */
export type CurrentPersonalSourceReader = {
  sourceSessionId: string
  sourceGeneration: string
  readerUserId: string
}

/** Structural audience containment for an already-admitted source. It never
 * treats an administrator role, an actor id, or a label stamp as widening
 * consent. The authenticated owner handoff uses its own durable operation.
 * Mixed source sets must admit every source separately, with no dropped source.
 * A personal derivative retains its conversation edge, so future reads still
 * check that record's live audience and anchor after revocation. */
export function conversationAudienceContainsDestination(source: ConversationAudience,
  destination: ConversationDerivativeDestination,
  currentPersonalReader?: CurrentPersonalSourceReader): ConversationContainmentDecision {
  const target = destination.kind === 'conversation' ? destination.audience : destination.scope
  if (source.workspaceId !== target.workspaceId) return { allowed: false, reason: 'workspace' }
  if (destination.kind === 'conversation' && source.sessionId === destination.audience.sessionId
    && source.generation !== destination.audience.generation) return { allowed: false, reason: 'generation' }
  const cap = destination.kind === 'conversation' ? destination.audience.cap : destination.scope.sensitivity
  if (!canRead(cap, source.cap) || !contains(target.compartments, source.compartments)
    || !contains(target.projectIds, source.projectIds)) return { allowed: false, reason: 'labels' }
  const destinationParticipants = destination.kind === 'conversation' && !hasWorkspaceConversationAudience(destination.audience.visibility)
    ? [...new Set(participants(destination.audience))] : []
  const privateUser = destination.kind === 'resource' ? destination.scope.userId
    : destinationParticipants.length === 1 ? destinationParticipants[0] : null
  if (!hasWorkspaceConversationAudience(source.visibility)) {
    if (destination.kind === 'conversation') {
      if (hasWorkspaceConversationAudience(destination.audience.visibility)
        || !contains(participants(source), participants(destination.audience))) return { allowed: false, reason: 'participants' }
      // Matching readers now cannot turn a permanent 1:1 boundary into an
      // administrator-widenable copy. Only the explicit owner handoff carries
      // that record out; this generic derivation predicate has no bypass flag.
      if (source.visibility === 'private_by_kind' && destination.audience.visibility !== 'private_by_kind')
        return { allowed: false, reason: 'participants' }
    } else if (privateUser === null || !participants(source).includes(privateUser)) return { allowed: false, reason: 'participants' }
  }
  // A personal conversation and personal resource use the same rule. The
  // actor's successful Page read does not prove another participant can read
  // it now. Retaining an edge cannot authorize already-streamed recipient text.
  const anchor = destination.kind === 'conversation' ? destination.audience.anchor : destination.anchor ?? null
  if (!sameAnchor(source.anchor, anchor)) {
    if (privateUser === null || currentPersonalReader?.readerUserId !== privateUser
      || currentPersonalReader.sourceSessionId !== source.sessionId) return { allowed: false, reason: 'anchor' }
    if (currentPersonalReader.sourceGeneration !== source.generation) return { allowed: false, reason: 'generation' }
  }
  return { allowed: true }
}
