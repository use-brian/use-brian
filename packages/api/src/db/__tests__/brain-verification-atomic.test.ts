import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  verifiedByUserId: null as string | null,
  workspaceId: '00000000-0000-4000-8000-000000000001',
  client: null as null | { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> },
}))
const journal = vi.hoisted(() => ({ appendDecisionEvent: vi.fn() }))
const goals = vi.hoisted(() => ({ abandonGoalsForHostTaskSystem: vi.fn() }))

vi.mock('../client.js', () => ({
  query: vi.fn(),
  getPool: () => ({ connect: vi.fn(async () => state.client) }),
}))
vi.mock('../decision-event-store.js', () => ({
  appendDecisionEvent: journal.appendDecisionEvent,
}))
vi.mock('../memory-verifications-store.js', () => ({
  recordVerification: vi.fn(),
}))
vi.mock('../goals.js', () => ({
  abandonGoalsForHostTaskSystem: goals.abandonGoalsForHostTaskSystem,
}))

import {
  applyBrainCorrection,
  deleteBrainInboxRow,
  deleteBrainInboxTasks,
  verifyBrainInboxRow,
} from '../brain-inbox-store.js'

const WORKSPACE = '00000000-0000-4000-8000-000000000001'
const ROW = '00000000-0000-4000-8000-000000000002'
const ACTOR = '00000000-0000-4000-8000-000000000003'
const VERIFICATION = '00000000-0000-4000-8000-000000000004'

beforeEach(() => {
  vi.clearAllMocks()
  state.workspaceId = WORKSPACE
  state.verifiedByUserId = null
  const query = vi.fn(async (sql: string) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [], rowCount: 0 }
    if (sql.includes('verified_by_user_id AS "verifiedByUserId"')) {
      return { rows: [{ workspaceId: state.workspaceId, verifiedByUserId: state.verifiedByUserId }] }
    }
    if (sql.includes('workspace_id AS "workspaceId"') && sql.includes('FOR UPDATE')) {
      return { rows: [{ workspaceId: state.workspaceId }] }
    }
    if (sql.includes('UPDATE tasks')) {
      return { rows: [{ id: ROW }], rowCount: 1 }
    }
    if (sql.includes('UPDATE entities') || sql.includes('UPDATE workspace_files')) {
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('UPDATE file_segments')) return { rows: [], rowCount: 2 }
    if (sql.includes('SELECT sensitivity')) {
      return { rows: [{ sensitivity: 'internal', userId: null, assistantId: null }] }
    }
    if (sql.includes('INSERT INTO brain_verifications')) {
      return { rows: [{ id: VERIFICATION }], rowCount: 1 }
    }
    throw new Error(`Unexpected SQL: ${sql}`)
  })
  state.client = { query, release: vi.fn() }
  journal.appendDecisionEvent.mockResolvedValue({
    inserted: true,
    event: { id: '00000000-0000-4000-8000-000000000005' },
  })
  goals.abandonGoalsForHostTaskSystem.mockResolvedValue(0)
})

describe('[COMP:api/decision-capture] atomic Brain verification', () => {
  it('commits the verifier stamp, domain audit, and decision event together', async () => {
    const result = await verifyBrainInboxRow({
      primitive: 'entity',
      rowId: ROW,
      workspaceId: WORKSPACE,
      verifiedByUserId: ACTOR,
    })
    expect(result).toEqual({ status: 'verified', stamped: true })
    expect(journal.appendDecisionEvent).toHaveBeenCalledWith(expect.objectContaining({
      sourceKind: 'brain_verification',
      sourceId: VERIFICATION,
      eventKind: 'brain.verification_recorded',
    }), state.client)
    expect(state.client!.query.mock.calls.map((call) => call[0])).toEqual([
      'BEGIN',
      expect.stringContaining('FOR UPDATE'),
      expect.stringContaining('UPDATE entities'),
      expect.stringContaining('SELECT sensitivity'),
      expect.stringContaining('INSERT INTO brain_verifications'),
      'COMMIT',
    ])
  })

  it('does not append duplicate evidence when the row is already verified', async () => {
    state.verifiedByUserId = ACTOR
    const result = await verifyBrainInboxRow({
      primitive: 'entity',
      rowId: ROW,
      workspaceId: WORKSPACE,
      verifiedByUserId: ACTOR,
    })
    expect(result).toEqual({ status: 'already_verified', stamped: false })
    expect(journal.appendDecisionEvent).not.toHaveBeenCalled()
    expect(state.client!.query.mock.calls.at(-1)?.[0]).toBe('COMMIT')
  })

  it('rolls back the verifier stamp when journal capture fails', async () => {
    journal.appendDecisionEvent.mockRejectedValueOnce(new Error('journal unavailable'))
    await expect(verifyBrainInboxRow({
      primitive: 'entity',
      rowId: ROW,
      workspaceId: WORKSPACE,
      verifiedByUserId: ACTOR,
    })).rejects.toThrow('journal unavailable')
    expect(state.client!.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK')
  })

  it('closes file retrieval rows and journals the delete in the same transaction', async () => {
    const result = await deleteBrainInboxRow({
      primitive: 'workspace_file',
      rowId: ROW,
      workspaceId: WORKSPACE,
      deletedByUserId: ACTOR,
    })
    expect(result).toEqual({ status: 'deleted' })
    const sql = state.client!.query.mock.calls.map((call) => String(call[0]))
    expect(sql.some((value) => value.includes('UPDATE workspace_files'))).toBe(true)
    expect(sql.some((value) => value.includes('UPDATE file_segments'))).toBe(true)
    expect(journal.appendDecisionEvent).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ action: 'delete' }),
    }), state.client)
    expect(sql.at(-1)).toBe('COMMIT')
  })

  it('closes bulk tasks, retires hosted goals, and journals each delete in one transaction', async () => {
    const result = await deleteBrainInboxTasks({
      taskIds: [ROW],
      workspaceId: WORKSPACE,
      deletedByUserId: ACTOR,
    })
    expect(result).toEqual([ROW])
    expect(goals.abandonGoalsForHostTaskSystem).toHaveBeenCalledWith(
      ROW,
      'host_task_deleted',
      { exec: state.client },
    )
    expect(journal.appendDecisionEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventKind: 'brain.verification_recorded',
      payload: expect.objectContaining({
        primitive: 'task',
        targetId: ROW,
        action: 'delete',
      }),
    }), state.client)
    expect(state.client!.query.mock.calls.map((call) => String(call[0])).at(-1)).toBe('COMMIT')
  })

  it('rolls back a composed domain correction when journal capture fails', async () => {
    journal.appendDecisionEvent.mockRejectedValueOnce(new Error('journal unavailable'))
    await expect(applyBrainCorrection({
      mutate: async (client) => {
        await client.query('UPDATE entities SET display_name = $2 WHERE id = $1', [ROW, 'Revised'])
        return { id: ROW }
      },
      verifications: () => [{
        targetKind: 'entity',
        targetId: ROW,
        workspaceId: WORKSPACE,
        verifiedByUserId: ACTOR,
        action: 'edit_summary',
      }],
    })).rejects.toThrow('journal unavailable')
    const sql = state.client!.query.mock.calls.map((call) => String(call[0]))
    expect(sql[0]).toBe('BEGIN')
    expect(sql[1]).toContain('UPDATE entities SET display_name')
    expect(sql.at(-1)).toBe('ROLLBACK')
    expect(sql).not.toContain('COMMIT')
  })
})
