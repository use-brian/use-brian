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
}

/**
 * Create the retrieveCachedResults tool backed by a CacheStore.
 */
export function createCacheTool(store: CacheStore): Tool {
  return buildTool({
    name: 'retrieveCachedResults',
    description: 'Retrieve previously cached search or tool results from this session. Use after conversation was compacted to access earlier results without re-searching.',
    inputSchema: z.object({
      toolName: z.string().describe('Which tool produced the cached results (e.g., "webSearch", "urlReader")'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,

    async execute(input, context) {
      const cached = await store.get(context.sessionId, input.toolName, context.userId)
      if (!cached) {
        return { data: 'No cached results found for this tool in this session.', isError: true }
      }
      return { data: cached }
    },
  })
}
