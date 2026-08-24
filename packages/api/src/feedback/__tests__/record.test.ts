/**
 * Unit tests for the single feedback writer.
 * Component tag: [COMP:brain/feedback-recorder].
 *
 * `recordFeedback` is the one writer behind all four feedback surfaces
 * (web modal, Slack reaction, Telegram reaction, Feishu/Lark reaction). Every path must write
 * exactly one `analytics_events` row; the auto-memory branch fires only
 * for negative feedback carrying ≥10 chars of trimmed details, which is
 * how reactions (short emoji labels) are kept out of the memory store
 * while web-modal explanations flow in. Memory-write failures are
 * swallowed so the analytics row (what the reflection consolidation
 * reads) is never lost.
 *
 * Mocks the db-layer writers so the branch logic is exercised without a
 * database. Spec: docs/architecture/brain/corrections.md → "Feedback signal".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/client.js', () => ({ query: vi.fn() }))
vi.mock('../../db/users.js', () => ({ getDefaultAssistant: vi.fn() }))
vi.mock('../../db/memories.js', () => ({ createMemory: vi.fn() }))

import { recordFeedback, type RecordFeedbackParams } from '../record.js'
import { query } from '../../db/client.js'
import { getDefaultAssistant } from '../../db/users.js'
import { createMemory } from '../../db/memories.js'

const mockQuery = vi.mocked(query)
const mockDefaultAssistant = vi.mocked(getDefaultAssistant)
const mockCreateMemory = vi.mocked(createMemory)

const ASSISTANT = { id: 'a1' } as Awaited<ReturnType<typeof getDefaultAssistant>>

function params(over?: Partial<RecordFeedbackParams>): RecordFeedbackParams {
  return {
    userId: 'u1',
    messageId: 'msg1',
    sessionId: 's1',
    kind: 'negative',
    source: 'web',
    ...over,
  }
}

describe('[COMP:brain/feedback-recorder] recordFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockQuery.mockResolvedValue({ rows: [{ id: 'evt1' }] } as never)
    mockDefaultAssistant.mockResolvedValue(ASSISTANT)
    mockCreateMemory.mockResolvedValue({ id: 'mem1' } as never)
  })

  it('always writes one analytics_events row, stamping channel_type from source', async () => {
    const res = await recordFeedback(params({ kind: 'positive', source: 'slack' }))
    expect(mockQuery).toHaveBeenCalledTimes(1)
    const [sql, values] = mockQuery.mock.calls[0]
    expect(sql).toContain('INSERT INTO analytics_events')
    // channel_type (last positional) carries the source surface.
    expect(values as unknown[]).toContain('slack')
    // event name encodes the polarity.
    expect((values as unknown[])[2]).toBe('feedback_positive')
    expect(res.analyticsId).toBe('evt1')
  })

  it('does NOT write a memory for positive feedback, even with long details', async () => {
    const res = await recordFeedback(
      params({ kind: 'positive', details: 'this was genuinely a great and helpful answer' }),
    )
    expect(mockCreateMemory).not.toHaveBeenCalled()
    expect(res.memoryId).toBeNull()
  })

  it('does NOT write a memory when negative details are below the 10-char threshold (reaction path)', async () => {
    // Reaction handlers pass a short emoji label like ":angry:".
    const res = await recordFeedback(params({ kind: 'negative', details: ':angry:', source: 'telegram' }))
    expect(mockCreateMemory).not.toHaveBeenCalled()
    expect(res.memoryId).toBeNull()
  })

  it('treats whitespace-only details as empty (no memory)', async () => {
    const res = await recordFeedback(params({ kind: 'negative', details: '            ' }))
    expect(mockCreateMemory).not.toHaveBeenCalled()
    expect(res.memoryId).toBeNull()
  })

  it('writes a feedback/correction memory for negative + substantive details', async () => {
    const res = await recordFeedback(
      params({ kind: 'negative', issueType: 'Wrong facts', details: 'The revenue number was off by a year' }),
    )
    expect(mockCreateMemory).toHaveBeenCalledTimes(1)
    const arg = mockCreateMemory.mock.calls[0][0]
    expect(arg.tags).toEqual(expect.arrayContaining(['feedback', 'correction', 'wrong_facts']))
    expect(arg.source).toBe('feedback')
    expect(arg.detail).toContain('The revenue number was off by a year')
    expect(res.memoryId).toBe('mem1')
  })

  it('returns analytics-only when the user has no default assistant', async () => {
    mockDefaultAssistant.mockResolvedValue(null)
    const res = await recordFeedback(params({ kind: 'negative', details: 'ten characters or more here' }))
    expect(mockCreateMemory).not.toHaveBeenCalled()
    expect(res.analyticsId).toBe('evt1')
    expect(res.memoryId).toBeNull()
  })

  it('swallows a memory-write failure and still returns the analytics id', async () => {
    mockCreateMemory.mockRejectedValue(new Error('memory store down'))
    const res = await recordFeedback(params({ kind: 'negative', details: 'ten characters or more here' }))
    expect(res.analyticsId).toBe('evt1')
    expect(res.memoryId).toBeNull()
  })
})
