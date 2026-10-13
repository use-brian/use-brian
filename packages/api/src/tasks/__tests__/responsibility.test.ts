import { describe, expect, it, vi } from 'vitest'
import type { TaskRecord, TaskResponsibility, TaskStore } from '@use-brian/core'

const sql = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }))
vi.mock('../../db/client.js', () => ({ query: vi.fn(async () => ({ rows: sql.rows })) }))

const { claimTask, validateTaskResponsibility } = await import('../responsibility.js')

const NONE: TaskResponsibility = { assigneeId: null, executorAssistantId: null, followUpMemberId: null, home: null }
const ENVELOPE = { workspaceId: 'ws', sensitivity: 'internal', compartments: [], projectIds: [], privateUserId: null, privateAssistantId: null }
const HOME = { kind: 'department' as const, id: 'dept' }

/** A fake transaction client answering each eligibility helper from a table. */
function db(answers: Record<string, boolean>) {
  const calls: string[] = []
  return {
    calls,
    query: vi.fn(async (text: string) => {
      const fn = /public\.(task_[a-z_]+)\(/.exec(text)?.[1] ?? 'unknown'
      calls.push(fn)
      return { rows: [{ ok: answers[fn] ?? false }] }
    }),
  }
}

describe('[COMP:api/task-responsibility] actor-bound validation and guarded claim', () => {
  describe('validateTaskResponsibility', () => {
    it('checks nothing when no responsibility value changed (a legacy row never fails an unrelated edit)', async () => {
      const d = db({})
      const legacy = { ...NONE, executorAssistantId: 'a1', followUpMemberId: 'm1', home: HOME }
      await validateTaskResponsibility(d, 'actor', ENVELOPE, legacy, legacy)
      expect(d.calls).toEqual([])
    })

    it('checks only the changed executor and refuses an ineligible one with a typed error', async () => {
      const d = db({ task_executor_eligible: false })
      await expect(validateTaskResponsibility(d, 'actor', ENVELOPE, NONE, { ...NONE, executorAssistantId: 'a1' }))
        .rejects.toMatchObject({ code: 'task_executor_invalid', status: 400 })
      expect(d.calls).toEqual(['task_executor_eligible'])
    })

    it('refuses an ineligible contact without widening anything', async () => {
      const d = db({ task_follow_up_eligible: false })
      await expect(validateTaskResponsibility(d, 'actor', ENVELOPE, NONE, { ...NONE, followUpMemberId: 'm1' }))
        .rejects.toMatchObject({ code: 'task_follow_up_invalid' })
    })

    it('re-checks the existing executor and contact against a new home', async () => {
      const d = db({ task_home_admissible: true, task_executor_eligible: true, task_follow_up_eligible: true })
      const before = { ...NONE, executorAssistantId: 'a1', followUpMemberId: 'm1' }
      await validateTaskResponsibility(d, 'actor', ENVELOPE, before, { ...before, home: HOME })
      expect(d.calls).toEqual(['task_home_admissible', 'task_executor_eligible', 'task_follow_up_eligible'])
    })

    it('refuses a home outside the actor and a Project home that is not the task Project', async () => {
      await expect(validateTaskResponsibility(db({ task_home_admissible: false }), 'actor', ENVELOPE, NONE, { ...NONE, home: HOME }))
        .rejects.toMatchObject({ code: 'task_home_invalid' })
      const located = { ...ENVELOPE, projectIds: ['p-located'] }
      await expect(validateTaskResponsibility(db({ task_home_admissible: true }), 'actor', located, NONE,
        { ...NONE, home: { kind: 'project', id: 'p-other' } })).rejects.toMatchObject({ code: 'task_home_mismatch', status: 409 })
    })

    it('clearing values needs no eligibility check', async () => {
      const d = db({})
      await validateTaskResponsibility(d, 'actor', ENVELOPE, { ...NONE, executorAssistantId: 'a1', followUpMemberId: 'm1', home: HOME }, NONE)
      expect(d.calls).toEqual([])
    })
  })

  describe('claimTask', () => {
    function store(current: TaskResponsibility) {
      const update = vi.fn(async (_actor: string, id: string, fields: object, opts?: Parameters<TaskStore['update']>[3]) => {
        const verdict = opts?.precondition?.({ ...current, status: 'todo', workspaceId: 'ws' })
        if (verdict === 'noop') return { id, ...current } as unknown as TaskRecord
        return { id: `${id}-next`, ...current, ...fields } as unknown as TaskRecord
      })
      return { update }
    }

    it('claims an unassigned task for the acting person by member id', async () => {
      sql.rows = [{ id: 'member-me' }]
      const s = store(NONE)
      const task = await claimTask(s, 'user-me', 'ws', 't1', { kind: 'person' })
      expect(s.update).toHaveBeenCalledWith('user-me', 't1', { assigneeId: 'member-me' }, expect.objectContaining({ writtenBy: 'user' }))
      expect(task.assigneeId).toBe('member-me')
    })

    it('is idempotent for the same claim and refuses a different holder', async () => {
      sql.rows = [{ id: 'member-me' }]
      const mine = await claimTask(store({ ...NONE, assigneeId: 'member-me' }), 'user-me', 'ws', 't1', { kind: 'person' })
      expect(mine.id).toBe('t1')
      await expect(claimTask(store({ ...NONE, executorAssistantId: 'a1' }), 'user-me', 'ws', 't1', { kind: 'person' }))
        .rejects.toMatchObject({ code: 'task_already_claimed', status: 409 })
      expect((await claimTask(store({ ...NONE, executorAssistantId: 'a1' }), 'user-me', 'ws', 't1', { kind: 'assistant', assistantId: 'a1' })).id).toBe('t1')
    })

    it('refuses a task in another workspace and a missing task as not found', async () => {
      sql.rows = [{ id: 'member-me' }]
      await expect(claimTask(store(NONE), 'user-me', 'other-ws', 't1', { kind: 'person' })).rejects.toMatchObject({ code: 'task_not_found' })
      await expect(claimTask({ update: vi.fn(async () => null) }, 'user-me', 'ws', 't1', { kind: 'person' })).rejects.toMatchObject({ code: 'task_not_found' })
      sql.rows = []
      await expect(claimTask(store(NONE), 'not-a-member', 'ws', 't1', { kind: 'person' })).rejects.toMatchObject({ code: 'task_not_found' })
    })
  })
})
