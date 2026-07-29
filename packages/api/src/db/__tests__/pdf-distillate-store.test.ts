import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
}))

import { contentSha256, getPdfDistillate, savePdfDistillate } from '../pdf-distillate-store.js'
import { query } from '../client.js'

const mockQuery = vi.mocked(query)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:files/pdf-distillate-store] distillate cache', () => {
  it('hashes the bytes, not the file identity — the same document caches once', () => {
    // The whole point of hashing content: a PDF attached in chat, dropped into
    // Telegram, and ingested to the brain arrives as three different file ids
    // and must distill once.
    const bytes = Buffer.from('%PDF-1.4 report')
    expect(contentSha256(bytes)).toBe(contentSha256(Buffer.from(bytes)))
    expect(contentSha256(bytes)).not.toBe(contentSha256(Buffer.from('%PDF-1.4 other')))
    expect(contentSha256(bytes)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reads by the composite (content, config) key', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ text: '## Page 1', model: 'qwen-vl-max', pageCount: 3, truncated: false }],
    } as never)

    const row = await getPdfDistillate('abc123', 'v1:w1120:c6:qwen-vl-max')

    expect(row).toEqual({ text: '## Page 1', model: 'qwen-vl-max', pageCount: 3, truncated: false })
    const [sql, params] = mockQuery.mock.calls[0]!
    expect(sql).toContain('content_sha256 = $1')
    expect(sql).toContain('config_key = $2')
    expect(params).toEqual(['abc123', 'v1:w1120:c6:qwen-vl-max'])
  })

  it('misses on a different config even for identical bytes', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never)
    expect(await getPdfDistillate('abc123', 'v2:w1024:c12:gpt-5.6-luna')).toBeNull()
  })

  it('writes idempotently so two concurrent surfaces both succeed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never)
    await savePdfDistillate({
      contentHash: 'abc123',
      configKey: 'v1:w1120:c6:qwen-vl-max',
      text: '## Page 1',
      model: 'qwen-vl-max',
      usage: { inputTokens: 84_000, outputTokens: 30_000 },
      pageCount: 40,
      truncated: true,
    })

    const [sql, params] = mockQuery.mock.calls[0]!
    expect(sql).toContain('ON CONFLICT (content_sha256, config_key) DO NOTHING')
    expect(params).toEqual([
      'abc123',
      'v1:w1120:c6:qwen-vl-max',
      '## Page 1',
      'qwen-vl-max',
      JSON.stringify({ inputTokens: 84_000, outputTokens: 30_000 }),
      40,
      true,
    ])
  })

  it('stores a partial read rather than dropping it', async () => {
    // A truncated distillate carries its own explicit notes about what is
    // missing; re-running would produce the same partial result at full cost.
    mockQuery.mockResolvedValueOnce({ rows: [] } as never)
    await savePdfDistillate({ contentHash: 'h', configKey: 'c', text: 't', model: 'm' })
    expect(mockQuery.mock.calls[0]![1]).toEqual(['h', 'c', 't', 'm', null, null, false])
  })
})
