/**
 * Native agent tools over the provider-neutral local chat archive.
 * Owner identity comes from ToolContext on every call; the model can narrow a
 * source/instance/conversation but can never choose whose archive to read.
 *
 * [COMP:tools/chat-archive]
 */

import { z } from 'zod'
import { buildTool, type Embedder, type Tool } from '@use-brian/core'
import { searchChatArchive } from '../db/chat-archive-store.js'
import { CHAT_ARCHIVE_SEARCH_TOOL } from './tool-catalog.js'

export type ChatArchiveToolDeps = {
  embedder?: Pick<Embedder, 'embed'>
  search?: typeof searchChatArchive
}

const sourceFilter = z
  .string()
  .min(1)
  .optional()
  .describe('Provider source, for example `whatsapp` or `wechat`. Omit to search every archived chat source.')

const instanceFilter = z
  .string()
  .uuid()
  .optional()
  .describe('Optional connector instance id, from a prior chat-history result.')

const timeFilters = {
  since: z.string().optional().describe('ISO 8601 lower time bound, inclusive.'),
  before: z.string().optional().describe('ISO 8601 upper time bound, exclusive.'),
}

function parseTime(value: string | undefined, field: string): string | undefined | { error: string } {
  if (value === undefined) return undefined
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return { error: `${field} is not a valid ISO 8601 date/time: ${value}` }
  }
  return parsed.toISOString()
}

function toolError(name: string, err: unknown): { data: string; isError: true } {
  return { data: `${name} failed: ${err instanceof Error ? err.message : String(err)}`, isError: true }
}

export function createChatArchiveTools(deps: ChatArchiveToolDeps = {}): Tool[] {
  const search = deps.search ?? searchChatArchive

  const searchTool = buildTool({
    name: CHAT_ARCHIVE_SEARCH_TOOL.name,
    description: CHAT_ARCHIVE_SEARCH_TOOL.description,
    inputSchema: z.object({
      query: z.string().min(1).describe('What to find in chat history, in natural language.'),
      topK: z.number().int().min(1).max(20).optional().describe('Results to return (default 8, max 20).'),
      source: sourceFilter,
      instanceId: instanceFilter,
      conversationId: z.string().min(1).optional().describe('Exact provider conversation id from a prior result.'),
      sender: z.string().min(1).optional().describe('Sender id or display-name substring.'),
      direction: z.enum(['inbound', 'outbound']).optional(),
      kind: z.enum(['text', 'image', 'voice', 'file', 'link']).optional(),
      ...timeFilters,
    }),
    isReadOnly: true,
    isConcurrencySafe: true,
    requiresConfirmation: false,
    timeoutMs: 30_000,
    async execute(input, context) {
      const since = parseTime(input.since, 'since')
      if (since && typeof since !== 'string') return { data: since.error, isError: true }
      const before = parseTime(input.before, 'before')
      if (before && typeof before !== 'string') return { data: before.error, isError: true }
      try {
        const result = await search(
          {
            ownerUserId: context.userId,
            query: input.query,
            topK: input.topK,
            source: input.source,
            instanceId: input.instanceId,
            conversationId: input.conversationId,
            sender: input.sender,
            direction: input.direction,
            kind: input.kind,
            since,
            before,
          },
          deps.embedder ? { embedder: deps.embedder } : undefined,
        )
        return {
          data: {
            hits: result.hits,
            embeddingCoverage: result.embeddingCoverage.note ?? 'complete for the selected filters',
          },
        }
      } catch (err) {
        return toolError('searchChatHistory', err)
      }
    },
  })

  return [searchTool]
}
