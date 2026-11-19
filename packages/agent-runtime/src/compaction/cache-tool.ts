import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'

/**
 * Cache store interface — injected by the API layer.
 */
export type CacheStore = {
  /**
   * `actorUserId` scopes the read to the asking user. On workspace-shared /
   * doc-thread sessions multiple users drive one sessionId, so an
   * actor-less read would serve one member's cached fetch to another
   * (cross-tenant — 2026-06-02 audit #7). Always pass the turn's user id.
   */
  get(sessionId: string, toolName: string, actorUserId?: string | null): Promise<unknown | null>
  set(sessionId: string, toolName: string, input: unknown, result: unknown, expiryHours: number, actorUserId?: string | null): Promise<void>
  /**
   * Optional: the distinct tool names that have a live (unexpired) entry for
   * this session + actor. Lets a cache miss name what IS retrievable instead
   * of leaving the model to guess tool names (the 2026-08-17 retried
   * `retrieveCachedResults` on a never-cached tool).
   */
  listToolNames?(sessionId: string, actorUserId?: string | null): Promise<string[]>
}

/**
 * Tools that write to the cache today. Only `urlReader` does
 * (`tools/base/fetch-stack.ts` write-through, 24h). Kept as an explicit list
 * so the tool description and the miss copy stay truthful — a description
 * that says "webSearch is cached" trains the model to call a tool that can
 * only fail.
 */
export const CACHE_WRITING_TOOLS = ['urlReader'] as const

/**
 * Create the retrieveCachedResults tool backed by a CacheStore.
 */
export function createCacheTool(store: CacheStore): Tool {
  return buildTool({
    name: 'retrieveCachedResults',
    description:
      'Retrieve the most recent cached result a tool produced earlier in THIS session, after compaction dropped it from context. ' +
      `Only ${CACHE_WRITING_TOOLS.map((t) => `\`${t}\``).join(', ')} ${CACHE_WRITING_TOOLS.length === 1 ? 'writes' : 'write'} to this cache (24h TTL), and only the latest result per tool is kept — webSearch and other tools are NOT cached; re-run them instead. ` +
      'A miss lists which tools do have a cached entry; do not retry this tool with guessed names.',
    inputSchema: z.object({
      toolName: z.string().describe(`Which tool produced the cached result. Cached tools: ${CACHE_WRITING_TOOLS.join(', ')}.`),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,

    async execute(input, context) {
      const cached = await store.get(context.sessionId, input.toolName, context.userId)
      if (!cached) {
        const available = store.listToolNames
          ? await store.listToolNames(context.sessionId, context.userId).catch(() => [])
          : []
        const isCacheable = (CACHE_WRITING_TOOLS as readonly string[]).includes(input.toolName)
        const availableText = available.length
          ? `Tools with a cached entry in this session: ${available.map((t) => `\`${t}\``).join(', ')} — call retrieveCachedResults with one of those names if it is what you need.`
          : 'Nothing is cached for this session at all.'
        const cause = isCacheable
          ? `\`${input.toolName}\` does cache its results, but none were produced (or they expired) in this session under your user.`
          : `\`${input.toolName}\` never writes to this cache (only ${CACHE_WRITING_TOOLS.join(', ')} ${CACHE_WRITING_TOOLS.length === 1 ? 'does' : 'do'}), so retrying with that name cannot succeed.`
        return {
          data: `No cached results for \`${input.toolName}\` in this session. ${cause} ${availableText} Otherwise re-run the original tool.`,
          isError: true,
        }
      }
      return { data: cached }
    },
  })
}
