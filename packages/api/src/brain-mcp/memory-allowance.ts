import { z } from 'zod'
import type { BrainTool } from './tools.js'

type AllowanceDecision = 'allowed' | 'unavailable' | 'exhausted' | 'too_large' | 'storage_limit'

const refusals = {
  storage_limit: 'The free workspace memory write allowance has been reached. Existing memories are available to read.',
  exhausted: 'The daily memory allowance is exhausted. Try again after midnight UTC.',
  unavailable: 'This connection no longer has access to the workspace.',
  too_large: 'The requested memory operation exceeds the free allowance of 16 KiB per call.',
}
const meteredTools = new Set(['saveMemory', 'getMemory', 'searchBrain'])
const returnedMemory = z.object({ id: z.string().uuid() })

export interface MemoryAllowance {
  contextOnly(workspaceId: string): Promise<boolean>
  consume(workspaceId: string, userId: string, inputBytes: number, writesMemory?: boolean): Promise<AllowanceDecision>
  recordRead(workspaceId: string, userId: string, memoryId: string): Promise<void>
}

export const memoryConnectionRequired = {
  error: 'memory_connection_required',
  message: 'Reconnect using standard Brain memory access for this free workspace.',
}

export const memoryConnectionUnavailable = { error: 'memory_connection_unavailable', retrySafe: true }

export function applyMemoryAllowance(
  tools: BrainTool[], policy: MemoryAllowance, workspaceId: string, userId: string, contextOnly: boolean,
): BrainTool[] {
  if (contextOnly) {
    const reader = tools.find(tool => tool.name === 'getMemory')
    if (!reader) throw new Error('Memory reader unavailable')
    // The native memory reader's query path performs scoped PostgreSQL text
    // searches. It has no model or embedding provider dependency.
    const searchInput = z.object({ query: z.string().trim().min(1).max(500), scope: z.literal('memory').optional() }).strict()
    tools = [
      ...tools.filter(tool => tool.name === 'getMemory' || tool.name === 'saveMemory'),
      {
        name: 'searchBrain',
        description: 'Search authorized memories in this Brian by keywords and return up to five matches.',
        inputSchema: searchInput,
        handler: args => reader.handler({ query: searchInput.parse(args).query }),
      },
    ]
  }
  return tools.map(tool => {
    if (!meteredTools.has(tool.name)) return tool
    return {
      ...tool,
      async handler(args, invocation) {
        const decision = await policy.consume(workspaceId, userId, Buffer.byteLength(JSON.stringify(args)), tool.name === 'saveMemory')
        if (decision !== 'allowed') {
          return { isError: true, content: [{ type: 'text', text: refusals[decision] }] }
        }
        const result = await tool.handler(args, invocation)
        if (tool.name === 'getMemory' && !result.isError && result.structuredContent?.status === 'succeeded') {
          const memory = returnedMemory.safeParse(result.structuredContent.data)
          if (memory.success) {
            // Preserve the successful read even if cohort measurement is unavailable.
            await policy.recordRead(workspaceId, userId, memory.data.id)
              .catch(() => console.warn('[brain-mcp] Could not record claim recall'))
          }
        }
        return result
      },
    }
  })
}
