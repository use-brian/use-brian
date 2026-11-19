/** Additive session DTO and mutation contract for M7 conversation visibility.
 * The server resolves capabilities from current authority on every operation.
 * Missing metadata means the server has not activated this contract.
 * [COMP:api/conversation-visibility] */
export const CONVERSATION_VISIBILITIES = ['private_by_kind', 'configured_private', 'workspace'] as const
export type ConversationVisibility = typeof CONVERSATION_VISIBILITIES[number]
export type ConversationVisibilityCapabilities = {
  canNarrow: boolean
  canWiden: boolean
  canManageParticipants: boolean
  canRaiseCap: boolean
  canMoveProject: boolean
}
export type ConversationVisibilityMetadata = {
  conversationVisibility: ConversationVisibility
  conversationVisibilityVersion: number
  conversationCap: 'public' | 'internal' | 'confidential'
  conversationCompartments: string[]
  conversationProjectIds: string[]
  participantUserIds: string[]
  capabilities: ConversationVisibilityCapabilities
}
export type ConversationVisibilityMutation = {
  expectedVersion: number
  visibility: Exclude<ConversationVisibility, 'private_by_kind'>
  participantUserIds?: string[]
}
export type ConversationCapMutation = {
  expectedVersion: number
  cap: ConversationVisibilityMetadata['conversationCap']
}
export type ConversationProjectMutation = {
  expectedVersion: number
  projectId: string | null
}
export type ConversationVisibilityErrorCode = 'conversation_visibility_conflict' | 'conversation_access_denied'
  | 'conversation_cap_cannot_lower'

export type ConversationSettingsUnreadable = {
  committed: true
  readable: false
  sessionId: string
  version: number
  code: 'conversation_access_denied'
}
export type ConversationSettingsResult<Session> =
  | (Session & ConversationVisibilityMetadata)
  | ConversationSettingsUnreadable
