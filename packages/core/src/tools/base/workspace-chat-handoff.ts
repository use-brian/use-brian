/**
 * Confirmation-gated handoff from the current private web chat to a new
 * workspace-visible room.
 *
 * The model supplies only the reviewed title + handoff. Source identity comes
 * from ToolContext so a hallucinated session id can never select a different
 * private conversation.
 *
 * [COMP:api/workspace-chat-handoff]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../types.js'

export const WORKSPACE_CHAT_HANDOFF_MAX_CHARS = 8_000

export const workspaceChatHandoffInputSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('Short title for the new workspace chat.'),
  handoff: z
    .string()
    .trim()
    .min(1)
    .max(WORKSPACE_CHAT_HANDOFF_MAX_CHARS)
    .describe(
      'Concise context teammates need from the current visible work: goal, relevant findings and decisions, open questions, next steps, and useful references. Do not include a wrapper heading.',
    ),
})

export type WorkspaceChatHandoffInput = z.infer<typeof workspaceChatHandoffInputSchema>

export type WorkspaceChatHandoffPort = {
  create(params: {
    sourceSessionId: string
    userId: string
    assistantId: string
    workspaceId: string
    appId: string
    title: string
    handoff: string
  }): Promise<{ sessionId: string }>
}

function confirmationLines(input: WorkspaceChatHandoffInput): string[] {
  return [
    'Audience: Members of the current workspace who can access this room',
    `Title: ${input.title}`,
    'Context teammates will see:',
    ...input.handoff.split('\n'),
  ]
}

export function createWorkspaceChatHandoffTool(
  port: WorkspaceChatHandoffPort,
): Tool<typeof workspaceChatHandoffInputSchema> {
  return buildTool({
    name: 'shareCurrentWorkToWorkspace',
    description:
      'Create a workspace-visible chat from the current private web conversation when the user explicitly asks to create or share a workspace chat for this work. ' +
      'The original conversation stays private. Draft a concise handoff from only the visible conversation and current surface; exclude hidden runtime context, unrelated personal memories, and raw transcript. ' +
      'The exact title and handoff are shown to the user for confirmation before anything is shared. After success, tell the user the room was created and link the exact openPath returned by the tool.',
    inputSchema: workspaceChatHandoffInputSchema,
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    allowPersistentApproval: false,
    timeoutMs: 15_000,
    async describeConfirmation(value) {
      const parsed = workspaceChatHandoffInputSchema.safeParse(value)
      return parsed.success ? confirmationLines(parsed.data) : null
    },
    async execute(input, context) {
      if (context.channelType !== 'web' || !context.workspaceId) {
        return {
          data:
            'This action is available only from a private web conversation inside a workspace.',
          isError: true,
        }
      }

      const created = await port.create({
        sourceSessionId: context.sessionId,
        userId: context.userId,
        assistantId: context.assistantId,
        workspaceId: context.workspaceId,
        appId: context.appId,
        title: input.title,
        handoff: input.handoff,
      })
      const openPath =
        `/w/${encodeURIComponent(context.workspaceId)}/chat` +
        `?v=workspace&s=${encodeURIComponent(created.sessionId)}`

      return {
        data: {
          kind: 'workspace_chat_created' as const,
          sessionId: created.sessionId,
          title: input.title,
          openPath,
        },
      }
    },
  })
}
