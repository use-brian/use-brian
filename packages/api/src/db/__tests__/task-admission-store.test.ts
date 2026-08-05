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
}))

vi.mock('../client.js', () => ({
  query: db.query,
  getAppPool: () => ({
    connect: async () => ({ query: db.clientQuery, release: db.release }),
  }),
  rollbackAndRelease: db.rollbackAndRelease,
}))

vi.mock('../goals.js', () => ({
  abandonGoalsForHostTaskSystem: vi.fn().mockResolvedValue(0),
}))

import { loadPolicyForPrompt, recordCandidate, rejectTask } from '../task-admission-store.js'

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

    expect(String(db.query.mock.calls[0]?.[0])).toContain('similarity, quality, expires_at')
    const params = db.query.mock.calls[0]?.[1] as unknown[]
    expect(JSON.parse(String(params[13]))).toMatchObject({
      classification: 'needs_spec',
      evidenceVerified: true,
      missing: ['target', 'description', 'starting_point', 'completion_signal'],
    })
    expect(params[14]).toBe(expiresAt)
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
    expect(db.release).toHaveBeenCalledOnce()
    // Explicit active-rule consent bypasses the separate post-commit proposal query.
    expect(db.query).not.toHaveBeenCalled()
  })
})
