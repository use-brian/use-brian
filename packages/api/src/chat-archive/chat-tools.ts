/**
 * Native agent tools over the provider-neutral local chat archive.
 *
 * These are thin clients now. The archive owns its own database, embeds its own
 * segments and executes its own ranking, so the platform's job here is to bind
 * the caller's identity and pass raw query text across a versioned HTTP
 * contract.
 *
 * Owner identity comes from ToolContext on every call. It is deliberately absent
 * from the input schema: the model can narrow a channel or a time range, but
 * cannot express whose archive to read.
 *
 * [COMP:tools/chat-archive]
 */

import { z } from 'zod'
import { buildTool, toolFailure, type Tool } from '@use-brian/core'
import { CHAT_ARCHIVE_CHANNELS_TOOL, CHAT_ARCHIVE_SEARCH_TOOL } from './tool-catalog.js'
import type { MessageStoreClient } from './message-store-client.js'

export type ChatArchiveToolDeps = {
  client: MessageStoreClient
}

/**
 * Accepts a full RFC 3339 timestamp or a bare calendar date.
 *
 * A zoneless datetime is refused rather than guessed at. The previous
 * implementation passed these to `new Date()`, which silently accepts "2026" and
 * "Jan 5" and resolves them against the server clock — so a query could quietly
 * search the wrong range and still look successful.
 */
const isoDateOrDateTime = z
  .string()
  .refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2}$/.test(value) ||
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value),
    {
      message:
        'must be a date (2026-08-14) or an RFC 3339 timestamp with an offset (2026-08-14T09:00:00Z); ' +
        'a time without a zone is ambiguous',
    },
  )

const channelFilter = z
  .string()
  .min(3)
  .optional()
  .describe(
    'Channel handle from listChatChannels or a prior hit, formatted "<instanceId>:<conversationId>". ' +
      'Omit to search every archived conversation.',
  )

export function createChatArchiveTools(deps: ChatArchiveToolDeps): Tool[] {
  const searchTool = buildTool({
    name: CHAT_ARCHIVE_SEARCH_TOOL.name,
    description: CHAT_ARCHIVE_SEARCH_TOOL.description,
    inputSchema: z.object({
      query: z.string().min(1).describe('What to find in chat history, in natural language.'),
      channel: channelFilter,
      since: isoDateOrDateTime.optional().describe('Lower time bound, inclusive.'),
      until: isoDateOrDateTime.optional().describe('Upper time bound, exclusive.'),
      topK: z.number().int().min(1).max(20).optional().describe('Results to return (default 8, max 20).'),
    }),
    isReadOnly: true,
    isConcurrencySafe: true,
    requiresConfirmation: false,
    timeoutMs: 30_000,
    async execute(input, context) {
      try {
        const result = await deps.client.search({
          ownerUserId: context.userId,
          query: input.query,
          channel: input.channel,
          since: input.since,
          until: input.until,
          topK: input.topK,
        })
        return {
          data: {
            hits: result.hits.map((hit) => ({
              ...hit,
              // Handed back ready to reuse, so narrowing a follow-up search does
              // not require the model to reassemble the pair itself — and cannot
              // accidentally pair a conversation id with the wrong account.
              channel: `${hit.instance_id}:${hit.conversation_id}`,
            })),
            embeddingCoverage: result.embedding_coverage?.note ?? 'complete for the selected filters',
          },
        }
      } catch (err) {
        // A thrown search is a FAILURE, never an empty archive: the model must
        // not report "no matching chats" on the strength of it.
        return toolFailure(err, {
          tool: CHAT_ARCHIVE_SEARCH_TOOL.name,
          target: `query "${input.query}"`,
          next:
            'This is a failure of the archive lookup, NOT an empty result. The archive holds only chats synced for THIS user, so a `channel` handle that was never synced finds nothing to search — ' +
            'widen or drop the filter before deciding the history is empty, and never present a public-web answer as if it came from the user\'s own chats.',
        })
      }
    },
  })

  const channelsTool = buildTool({
    name: CHAT_ARCHIVE_CHANNELS_TOOL.name,
    description: CHAT_ARCHIVE_CHANNELS_TOOL.description,
    inputSchema: z.object({
      query: z.string().min(1).optional().describe('Substring of a sender name or recent message text.'),
      since: isoDateOrDateTime.optional().describe('Only channels active at or after this time.'),
      until: isoDateOrDateTime.optional().describe('Only channels active before this time.'),
      limit: z.number().int().min(1).max(50).optional().describe('Channels to return (default 20, max 50).'),
    }),
    isReadOnly: true,
    isConcurrencySafe: true,
    requiresConfirmation: false,
    timeoutMs: 30_000,
    async execute(input, context) {
      try {
        const channels = await deps.client.listChannels({
          ownerUserId: context.userId,
          query: input.query,
          since: input.since,
          until: input.until,
          limit: input.limit,
        })
        return { data: { channels } }
      } catch (err) {
        return toolFailure(err, {
          tool: CHAT_ARCHIVE_CHANNELS_TOOL.name,
          next: 'This is a failure of the archive lookup, NOT proof that no chats are archived — do not tell the user nothing is synced.',
        })
      }
    },
  })

  return [searchTool, channelsTool]
}
