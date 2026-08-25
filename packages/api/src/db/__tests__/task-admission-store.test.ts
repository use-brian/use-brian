/**
 * DB-adapter contract for task feedback and pre-extraction duplicate context.
 *
 * [COMP:tasks/admission-store]
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  rollbackAndRelease: vi.fn(),
  applyRLSGucs: vi.fn(),
}))
const brain = vi.hoisted(() => ({ appendBrainVerification: vi.fn() }))

vi.mock('../client.js', () => ({
  query: db.query,
  getAppPool: () => ({
    connect: async () => ({ query: db.clientQuery, release: db.release }),
  }),
  rollbackAndRelease: db.rollbackAndRelease,
  applyRLSGucs: db.applyRLSGucs,
}))

vi.mock('../goals.js', () => ({
  abandonGoalsForHostTaskSystem: vi.fn().mockResolvedValue(0),
}))

vi.mock('../decision-event-store.js', () => ({
  appendDecisionEvent: vi.fn(async (event: unknown) => ({
    event: { id: 'decision-1', ...(event as object), createdAt: new Date() },
    inserted: true,
  })),
}))
vi.mock('../brain-inbox-store.js', () => ({
  appendBrainVerification: brain.appendBrainVerification,
}))

import {
  findOpenTasksForGithubMatch,
  findOrCreateAllowRule,
  loadPolicyForPrompt,
  recordCandidate,
  rejectTask,
} from '../task-admission-store.js'
import { appendDecisionEvent } from '../decision-event-store.js'

const mockAppendDecisionEvent = vi.mocked(appendDecisionEvent)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:tasks/admission-store] task admission DB adapter', () => {
  it('persists the structured readiness assessment with held candidates', async () => {
    db.query.mockResolvedValue({ rows: [] })
    const expiresAt = new Date('2026-08-19T00:00:00.000Z')
    await recordCandidate({
      workspaceId: 'workspace-1',
      title: 'Pull a group',
      due: null,
      lane: 'extracted',
      sourceKind: 'slack_thread',
      sourceEpisodeId: 'episode-1',
      createdByAssistantId: null,
      status: 'pending',
      reasonCode: 'needs_spec',
      quality: {
        classification: 'needs_spec',
        evidenceQuote: 'pull a group',
        evidenceVerified: true,
        commitment: 'explicit',
        objective: 'Pull a group',
        target: null,
        description: null,
        startingPointKind: 'missing',
        startingPoint: null,
        completionSignal: null,
        missing: ['target', 'description', 'starting_point', 'completion_signal'],
        explanation: 'The target and completion signal are missing.',
      },
      expiresAt,
    })

    expect(String(db.query.mock.calls[0]?.[0])).toContain('similarity, quality,')
    expect(String(db.query.mock.calls[0]?.[0])).toContain('created_task_id, expires_at')
    const params = db.query.mock.calls[0]?.[1] as unknown[]
    expect(JSON.parse(String(params[14]))).toMatchObject({
      classification: 'needs_spec',
      evidenceVerified: true,
      missing: ['target', 'description', 'starting_point', 'completion_signal'],
    })
    expect(params[16]).toBe(expiresAt)
  })

  it('loads only relevant live open tasks for pre-extraction context', async () => {
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM task_rules')) return { rows: [] }
      if (sql.includes('FROM task_tombstones')) return { rows: [] }
      if (sql.includes('word_similarity')) {
        return {
          rows: [{ id: 'task-1', title: 'Integrate Teams', sim: 0.875 }],
        }
      }
      throw new Error(`Unexpected query: ${sql}`)
    })

    const result = await loadPolicyForPrompt(
      'workspace-1',
      'We are discussing progress on integrate teams',
    )

    expect(result.openTasks).toEqual([
      { id: 'task-1', title: 'Integrate Teams', similarity: 0.875 },
    ])
    const relevantQuery = db.query.mock.calls.find(([sql]) =>
      String(sql).includes('word_similarity'),
    )
    expect(String(relevantQuery?.[0])).toMatch(/valid_to IS NULL/)
    expect(String(relevantQuery?.[0])).toMatch(/status NOT IN \('done', 'archived'\)/)
    expect(relevantQuery?.[1]).toEqual([
      'workspace-1',
      'We are discussing progress on integrate teams',
      0.65,
    ])
  })

  it('atomically writes a tombstone and an active source/channel-scoped rule', async () => {
    db.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] }
      if (sql.includes('SELECT t.id, t.title')) {
        return {
          rows: [
            {
              id: 'task-1',
              title: 'Integrate Teams',
              source: 'extracted',
              source_kind: 'slack_thread',
              channel_ref: 'C456',
              source_session_id: '00000000-0000-4000-8000-000000000020',
              created_by_assistant_id: '00000000-0000-4000-8000-000000000021',
              sensitivity: 'internal',
            },
          ],
        }
      }
      if (sql.includes('INSERT INTO task_tombstones')) {
        return { rows: [{ id: 'tombstone-1' }] }
      }
      if (sql.includes('SELECT id FROM task_rules')) return { rows: [] }
      if (sql.includes('INSERT INTO task_rules')) {
        return { rows: [{ id: 'rule-1' }] }
      }
      if (sql.includes('UPDATE tasks')) return { rows: [] }
      throw new Error(`Unexpected query: ${sql}`)
    })

    const result = await rejectTask({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      taskId: 'task-1',
      reason: 'Discussion about an active task is context, not a new commitment',
      createRule: true,
      recordBrainVerification: true,
    })

    expect(result).toMatchObject({
      tombstoneId: 'tombstone-1',
      activeRuleId: 'rule-1',
      proposedRuleId: null,
    })
    const ruleInsert = db.clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO task_rules'),
    )
    expect(JSON.parse(String(ruleInsert?.[1]?.[1]))).toEqual({
      lanes: ['extracted'],
      title_matches: ['integrate teams'],
      source_kinds: ['slack_thread'],
      channel_refs: ['C456'],
    })
    expect(db.clientQuery.mock.calls.map(([sql]) => sql)).toContain('COMMIT')
    expect(mockAppendDecisionEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventKind: 'task.rejected',
      reason: 'Discussion about an active task is context, not a new commitment',
      payload: {
        taskId: 'task-1',
        tombstoneId: 'tombstone-1',
        activeRuleId: 'rule-1',
        proposedRuleId: null,
        reasonStoredOn: 'task_tombstone',
      },
    }), expect.anything())
    expect(brain.appendBrainVerification).toHaveBeenCalledWith(expect.objectContaining({
      targetKind: 'task',
      targetId: 'task-1',
      action: 'delete',
    }), expect.anything())
    // The transaction runs RLS-scoped to the acting user (app pool policies
    // hide every row from the unscoped sentinel).
    expect(db.applyRLSGucs).toHaveBeenCalledWith(expect.anything(), 'user-1')
    expect(db.rollbackAndRelease).toHaveBeenCalledOnce()
    // Explicit active-rule consent bypasses the separate post-commit proposal query.
    expect(db.query).not.toHaveBeenCalled()
  })

  it('releases the client on the not-found early return (2026-08-07 pool-exhaustion outage)', async () => {
    db.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN') return { rows: [] }
      if (sql.includes('SELECT t.id, t.title')) return { rows: [] }
      throw new Error(`Unexpected query: ${sql}`)
    })

    const result = await rejectTask({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      taskId: 'task-gone',
      reason: 'stale suggestion',
    })

    expect(result).toBeNull()
    expect(db.rollbackAndRelease).toHaveBeenCalledOnce()
  })

  it('creates a class-level allow rule once and re-activates the identical one after', async () => {
    // First call: no existing rule → INSERT.
    db.query.mockImplementationOnce(async () => ({ rows: [] }))
    db.query.mockImplementationOnce(async () => ({ rows: [{ id: 'rule-allow-1' }] }))
    const created = await findOrCreateAllowRule({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      sourceKind: 'slack_thread',
      channelRef: 'C456',
      nlClause: 'Automatically create ready task suggestions from slack_thread (channel C456).',
    })
    expect(created).toEqual({ id: 'rule-allow-1', created: true })
    const insert = db.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO task_rules'))
    expect(JSON.parse(String(insert?.[1]?.[1]))).toEqual({
      lanes: ['extracted'],
      source_kinds: ['slack_thread'],
      channel_refs: ['C456'],
    })

    // Second call: identical predicate exists → UPDATE to active, no INSERT.
    db.query.mockReset()
    db.query.mockImplementationOnce(async () => ({ rows: [{ id: 'rule-allow-1' }] }))
    db.query.mockImplementationOnce(async () => ({ rows: [] }))
    const reused = await findOrCreateAllowRule({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      sourceKind: 'slack_thread',
      channelRef: 'C456',
      nlClause: 'Automatically create ready task suggestions from slack_thread (channel C456).',
    })
    expect(reused).toEqual({ id: 'rule-allow-1', created: false })
    expect(
      db.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO task_rules')),
    ).toBe(false)
  })

  it('excludes github-backlinked and closed tasks from the PR-match candidate pool', async () => {
    db.query.mockResolvedValue({
      rows: [{ id: 'task-1', title: 'Fix the login redirect bug', description: null, sim: 0.62 }],
    })
    const pool = await findOpenTasksForGithubMatch('workspace-1', 'Fix login redirect')
    expect(pool).toEqual([
      { id: 'task-1', title: 'Fix the login redirect bug', description: null },
    ])
    const sql = String(db.query.mock.calls[0]?.[0])
    expect(sql).toContain(`NOT (external_ref @> '{"provider":"github"}'::jsonb)`)
    expect(sql).toContain(`status NOT IN ('done', 'archived')`)
  })
})
