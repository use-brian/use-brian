/** Scope-checked textual Memory reads for agent handoff. [COMP:api/memory-context-copy] */
import type { SessionContextAuthority } from '@use-brian/core/memory/session-state-types.js'
import { getMemoryById, searchWorkspaceMemories } from './db/memories.js'

export async function searchMemoryContext(authority: SessionContextAuthority, query: string) {
  const memories = await searchWorkspaceMemories(authority.execution.security.access, { searchQuery: query, limit: 20 }, authority)
  return memories.filter(memory => !memory.retractedAt).map(({ id, summary }) => ({ id, summary }))
}

export async function readMemoryContext(authority: SessionContextAuthority, id: string) {
  const memory = await getMemoryById(authority.execution.security.access, id, undefined, undefined, authority)
  if (!memory || memory.retractedAt) return null
  const { summary, detail, updatedAt } = memory
  return { summary, detail, updatedAt: updatedAt.toISOString() }
}
