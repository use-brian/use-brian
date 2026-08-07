import { describe, expect, it, vi } from 'vitest'
import { createChatArchiveMediaStore } from '../chat-archive-media-store.js'

describe('[COMP:api/chat-archive-media] media job terminal states', () => {
  it('keeps retryable extraction failures pending and marks only the fifth failure terminal', async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [] }))
    const store = createChatArchiveMediaStore({ query } as never)

    await store.failJob('job-1', 'asset-1', 1, 'temporary')
    await store.failJob('job-1', 'asset-1', 5, 'terminal')

    expect(query.mock.calls[0]![0]).toContain("CASE WHEN $4 = 'dead' THEN 'failed' ELSE 'pending' END")
    expect(query.mock.calls[0]![1]).toEqual(['job-1', 'asset-1', 'temporary', 'failed', 30])
    expect(query.mock.calls[1]![1]).toEqual(['job-1', 'asset-1', 'terminal', 'dead', 480])
  })
})
