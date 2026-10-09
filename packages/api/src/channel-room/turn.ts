// [COMP:api/channel-room] How a turn in a converged room differs from a
// per-user group turn (unified-sessions §4.4, D1, D3). Pure, so every
// transport's pipeline turn is graded by one table.
//
// Spec: docs/architecture/channels/adapter-pattern.md -> "Channel rooms".

export type RoomTurnFacts = {
  /** The turn landed in a channel room (`resolveRoomBinding` matched). */
  inRoom: boolean
  isGroupChat: boolean
  /** The sender is a member of the assistant's workspace. */
  senderIsWorkspaceMember: boolean
  /** The sender's provider account is linked to their platform account. */
  senderLinkedIdentity: boolean
  /** The route classified the sender as an external guest. */
  externalGuest: boolean
  /** The member mode the sender's role implies. */
  memberMode: 'member' | 'external' | undefined
}

export type RoomTurnShape = {
  /**
   * The conversation-only external-guest lane. A room never takes it: a
   * non-member there is a GUEST answered at the room's clearance (D1).
   */
  externalGuest: boolean
  /**
   * Whose ceilings bound the turn. A room answers at the room's clearance
   * whoever addresses it (D1): the assistant's own ceilings, capped by the
   * group's approved audience envelope.
   */
  memberMode: 'member' | 'external' | 'assistant' | undefined
  /** Does the addresser's own personal context load? Never in a room (D3). */
  groupSpeaker: boolean
  /** A guest never gains a memory (D1): no memory-write tools, no extraction. */
  memoryWrites: boolean
  /** The legacy per-user group context block; a room's transcript replaces it. */
  legacyGroupContext: boolean
  /** Attribute each stored row to its sender and label speakers at assembly. */
  attributeSenders: boolean
  /** Fold the room's un-addressed posts into the addressed turn. */
  coalesce: boolean
}

export function roomTurnShape(facts: RoomTurnFacts): RoomTurnShape {
  const guest = facts.inRoom && !facts.senderIsWorkspaceMember
  return {
    externalGuest: facts.externalGuest && !facts.inRoom,
    memberMode: facts.inRoom ? 'assistant' : facts.memberMode,
    groupSpeaker: !facts.inRoom && facts.isGroupChat && facts.senderIsWorkspaceMember && facts.senderLinkedIdentity,
    memoryWrites: !guest,
    legacyGroupContext: facts.isGroupChat && !facts.inRoom,
    attributeSenders: facts.inRoom,
    coalesce: facts.inRoom,
  }
}
