import { describe, it, expect } from 'vitest'
import { createCacheTool, type CacheStore } from '../cache-tool.js'

function makeFakeCacheStore(initial: Record<string, unknown> = {}): CacheStore & { sets: unknown[]; listToolNames?: CacheStore['listToolNames'] } {
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
  appId: 'Use Brian',
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

  it('a miss on a never-cached tool says the name cannot succeed and lists what IS cached', async () => {
    const store = makeFakeCacheStore({ 's1:urlReader': { text: 'page' } })
    store.listToolNames = async (sessionId: string) => (sessionId === 's1' ? ['urlReader'] : [])
    const tool = createCacheTool(store)
    const result = await tool.execute({ toolName: 'webSearch' }, ctx)
    expect(result.isError).toBe(true)
    const text = String(result.data)
    expect(text).toContain('`webSearch` never writes to this cache')
    expect(text).toContain('retrying with that name cannot succeed')
    expect(text).toContain('`urlReader`')
  })

  it('a miss with an empty cache says nothing is cached and to re-run the original tool', async () => {
    const store = makeFakeCacheStore()
    store.listToolNames = async () => []
    const tool = createCacheTool(store)
    const result = await tool.execute({ toolName: 'urlReader' }, ctx)
    expect(result.isError).toBe(true)
    const text = String(result.data)
    expect(text).toContain('Nothing is cached for this session at all')
    expect(text).toContain('re-run the original tool')
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
