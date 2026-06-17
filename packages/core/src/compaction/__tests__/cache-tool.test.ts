import { describe, it, expect } from 'vitest'
import { createCacheTool, type CacheStore } from '../cache-tool.js'

function makeFakeCacheStore(initial: Record<string, unknown> = {}): CacheStore & { sets: unknown[] } {
  const store = new Map<string, unknown>(Object.entries(initial))
  const sets: unknown[] = []
  return {
    sets,
    async get(sessionId, toolName) {
      return store.get(`${sessionId}:${toolName}`) ?? null
    },
    async set(sessionId, toolName, input, result, expiryHours) {
      store.set(`${sessionId}:${toolName}`, result)
      sets.push({ sessionId, toolName, input, result, expiryHours })
    },
  }
}

const ctx = {
  assistantId: 'a1',
  userId: 'u1',
  sessionId: 's1',
  appId: 'sidanclaw',
  channelType: 'web',
  channelId: 'c_1',
  abortSignal: new AbortController().signal,
}

describe('[COMP:compaction/cache-tool] retrieveCachedResults', () => {
  it('returns cached data when present', async () => {
    const store = makeFakeCacheStore({ 's1:webSearch': { results: ['hit'] } })
    const tool = createCacheTool(store)
    const result = await tool.execute({ toolName: 'webSearch' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.data).toEqual({ results: ['hit'] })
  })

  it('returns an error when no cache exists for the tool', async () => {
    const store = makeFakeCacheStore()
    const tool = createCacheTool(store)
    const result = await tool.execute({ toolName: 'webSearch' }, ctx)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('No cached results')
  })

  it('is scoped to the current session (not cross-session)', async () => {
    const store = makeFakeCacheStore({ 'other_session:webSearch': { results: ['other'] } })
    const tool = createCacheTool(store)
    const result = await tool.execute({ toolName: 'webSearch' }, ctx)
    expect(result.isError).toBe(true)
  })

  it('is read-only and concurrency-safe', () => {
    const store = makeFakeCacheStore()
    const tool = createCacheTool(store)
    expect(tool.isReadOnly).toBe(true)
    expect(tool.isConcurrencySafe).toBe(true)
  })
})
