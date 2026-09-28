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

const clientQuery = vi.fn()
const release = vi.fn()
vi.mock('../../db/client.js', () => ({
  getPool: () => ({ connect: async () => ({ query: clientQuery, release }) }),
}))
vi.mock('../../db/memories.js', () => ({ createMemory: vi.fn() }))
vi.mock('../../db/derived-scope-store.js', () => ({ recordDerivedResource: vi.fn() }))

import { recordFeedback, type RecordFeedbackParams } from '../record.js'
import { createMemory } from '../../db/memories.js'
import { recordDerivedResource } from '../../db/derived-scope-store.js'
import type { ScopeSource } from '@use-brian/core'

const mockCreateMemory = vi.mocked(createMemory)
const mockRecordDerived = vi.mocked(recordDerivedResource)
const WORKSPACE = '00000000-0000-0000-0000-000000000011'
const USER = '00000000-0000-0000-0000-000000000012'
const ASSISTANT = '00000000-0000-0000-0000-000000000013'
const MESSAGE = '00000000-0000-0000-0000-000000000014'
const SESSION = '00000000-0000-0000-0000-000000000015'
let targetSource: ScopeSource | null

function params(over?: Partial<RecordFeedbackParams>): RecordFeedbackParams {
  return {
    userId: USER,
    messageId: MESSAGE,
    sessionId: SESSION,
    kind: 'negative',
    source: 'web',
    ...over,
  }
}

describe('[COMP:brain/feedback-recorder] recordFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    targetSource = {
      workspaceId: WORKSPACE,
      userId: USER,
      assistantId: ASSISTANT,
      sensitivity: 'confidential',
      compartments: ['finance'],
      projectIds: [],
      resourceKind: 'session_message',
      resourceId: MESSAGE,
      version: '1',
    }
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM session_messages sm')) return { rows: [{
        workspace_id: WORKSPACE,
        session_id: SESSION,
        assistant_id: ASSISTANT,
        role: 'assistant',
        source: targetSource,
      }] }
      if (sql.includes('FROM workspace_members wm')) return { rows: [{
        role: 'owner', clearance: 'confidential', compartments: null, projects_allowed: true,
      }] }
      if (sql.includes('INSERT INTO analytics_events')) return { rows: [{ id: 'evt1' }] }
      return { rows: [] }
    })
    mockCreateMemory.mockResolvedValue({ id: 'mem1' } as never)
  })

  it('always writes one analytics_events row, stamping channel_type from source', async () => {
    const res = await recordFeedback(params({ kind: 'positive', source: 'slack' }))
    const insert = clientQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO analytics_events'))!
    const [sql, values] = insert
    expect(sql).toContain('INSERT INTO analytics_events')
    expect(values as unknown[]).toContain('slack')
    expect((values as unknown[])[3]).toBe('feedback_positive')
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
    expect(arg.derivation?.sources).toEqual([
      expect.objectContaining({ resourceKind: 'feedback_event', resourceId: 'evt1' }),
    ])
    expect(mockRecordDerived).toHaveBeenCalledTimes(1)
    expect(res.memoryId).toBe('mem1')
  })

  it('keeps legacy unclassified messages analytics-only', async () => {
    targetSource = null
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
