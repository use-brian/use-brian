import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  verifiedByUserId: null as string | null,
  client: null as null | { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> },
}))
const journal = vi.hoisted(() => ({ appendDecisionEvent: vi.fn() }))

vi.mock('../client.js', () => ({
  query: vi.fn(),
  getPool: () => ({ connect: vi.fn(async () => state.client) }),
}))
vi.mock('../decision-event-store.js', () => ({
  appendDecisionEvent: journal.appendDecisionEvent,
}))

import { verifyMemoryDecision } from '../memory-verifications-store.js'

const MEMORY = '00000000-0000-4000-8000-000000000001'
const WORKSPACE = '00000000-0000-4000-8000-000000000002'
const ACTOR = '00000000-0000-4000-8000-000000000003'
const VERIFICATION = '00000000-0000-4000-8000-000000000004'

beforeEach(() => {
  vi.clearAllMocks()
  state.verifiedByUserId = null
  const query = vi.fn(async (sql: string) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [], rowCount: 0 }
    if (sql.includes('verified_by_user_id AS "verifiedByUserId"')) {
      return { rows: [{ verifiedByUserId: state.verifiedByUserId }] }
    }
    if (sql.includes('UPDATE memories')) return { rows: [], rowCount: 1 }
    if (sql.includes('SELECT assistant_id AS "assistantId"')) {
      return {
        rows: [{
          assistantId: null,
          sourceSessionId: null,
          scope: 'workspace',
          sensitivity: 'internal',
        }],
      }
    }
    if (sql.includes('INSERT INTO memory_verifications')) {
      return {
        rows: [{
          id: VERIFICATION,
          memoryId: MEMORY,
          workspaceId: WORKSPACE,
          verifiedBy: ACTOR,
          action: 'confirm',
          modelValue: null,
          userValue: null,
          reason: null,
          createdAt: new Date(),
        }],
      }
    }
    throw new Error(`Unexpected SQL: ${sql}`)
  })
  state.client = { query, release: vi.fn() }
  journal.appendDecisionEvent.mockResolvedValue({
    inserted: true,
    event: { id: '00000000-0000-4000-8000-000000000005' },
  })
})

describe('[COMP:api/decision-capture] atomic memory verification', () => {
  it('commits the stamp, verification row, and decision event in one transaction', async () => {
    const result = await verifyMemoryDecision({
      memoryId: MEMORY,
      workspaceId: WORKSPACE,
      verifiedBy: ACTOR,
    })
    expect(result).toEqual({ status: 'verified', stamped: true })
    expect(journal.appendDecisionEvent).toHaveBeenCalledWith(expect.objectContaining({
      sourceKind: 'memory_verification',
      sourceId: VERIFICATION,
      eventKind: 'brain.verification_recorded',
    }), state.client)
    expect(state.client!.query.mock.calls.at(-1)?.[0]).toBe('COMMIT')
  })

  it('does not append a second decision for an already verified row', async () => {
    state.verifiedByUserId = ACTOR
    const result = await verifyMemoryDecision({
      memoryId: MEMORY,
      workspaceId: WORKSPACE,
      verifiedBy: ACTOR,
    })
    expect(result).toEqual({ status: 'already_verified', stamped: false })
    expect(journal.appendDecisionEvent).not.toHaveBeenCalled()
  })

  it('rolls the stamp back when decision capture fails', async () => {
    journal.appendDecisionEvent.mockRejectedValueOnce(new Error('journal unavailable'))
    await expect(verifyMemoryDecision({
      memoryId: MEMORY,
      workspaceId: WORKSPACE,
      verifiedBy: ACTOR,
    })).rejects.toThrow('journal unavailable')
    expect(state.client!.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK')
  })
})
