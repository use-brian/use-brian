import { isWorkspaceWideWebChat, type WebChatEventScope } from './_web-chat-event-scope.js'
import { dispatchIncomingMessageEvent } from '../message-events.js'

/** Call only after authorizing and persisting a new human input, never output.
 * Web has no installed channel integration: the DB session UUID is its stable
 * source integration AND channel id (not the caller-controlled channelId).
 * appOrigin describes UI placement, not provenance: workflow/assistant UI
 * inputs are human messages too, but only workspace-wide unrestricted
 * sessions may enter the unscoped dispatcher. Private/scoped inputs never do.
 */
export function dispatchPersistedWebInput(input: {
  workspaceId: string | null | undefined
  session: WebChatEventScope & { id: string }
  userId: string
  stored: { id: string; createdAt: Date }
  text: string
  replay?: boolean
}): void {
  if (!input.workspaceId || input.replay || !isWorkspaceWideWebChat(input.session)) return
  void dispatchIncomingMessageEvent({
    workspaceId: input.workspaceId,
    integrationId: input.session.id,
    incoming: {
      channelType: 'web',
      userId: input.userId,
      channelId: input.session.id,
      messageId: input.stored.id,
      text: input.text,
      isGroupChat: input.session.visibility === 'workspace',
      timestamp: input.stored.createdAt.getTime() / 1000,
      // Never forward the HTTP body, attachment context, or authorization data.
      raw: {},
    },
  })
}
