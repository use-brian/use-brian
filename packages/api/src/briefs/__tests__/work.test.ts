import { describe, expect, it, vi, beforeEach } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'

const db = vi.hoisted(() => ({
  statements: [] as string[],
  fail: null as string | null,
  rows: [] as Record<string, unknown>[],
  goals: [] as Record<string, unknown>[],
}))

vi.mock('../../db/workspace-viewpoint.js', () => ({
  resolveWorkspaceViewpoint: vi.fn(async (userId: string) => userId === 'stranger' ? null
    : { userId, workspaceId: 'ws', assistantId: '', assistantKind: 'primary', clearance: 'internal', compartments: null }),
}))
vi.mock('../../db/access-predicate.js', () => ({
  buildAccessPredicate: () => ({ sql: 'true', params: [], nextIdx: 1 }),
}))
vi.mock('../../db/client.js', () => {
  const run = async (text: string) => {
    db.statements.push(text)
    if (db.fail && text.includes(db.fail)) throw new Error('source down')
    if (text.includes('task_home_admissible')) return { rows: [{ ok: true }] }
    if (text.includes('FROM workspace_members WHERE')) return { rows: [{ id: 'member-me' }] }
    if (text.includes('FROM department_owners WHERE')) return { rows: [{ kind: 'department', id: 'dept' }] }
    if (text.includes('FROM tasks')) return { rows: db.rows }
    if (text.includes('FROM goals')) return { rows: db.goals }
    if (text.includes('task_home_owner_ids($1, h.kind')) return { rows: [{ kind: 'department', id: 'dept', owners: ['user-me'] }] }
    if (text.includes('FROM assistants')) return { rows: [{ id: 'a1', name: 'Ops' }] }
    return { rows: [] }
  }
  return { query: vi.fn((t: string) => run(t)), queryGated: vi.fn((_c: unknown, t: string) => run(t)), queryWithRLS: vi.fn((_u: string, t: string) => run(t)) }
})

const notify = vi.hoisted(() => vi.fn())
vi.mock('../../brain-stream/notify.js', () => ({ notifyBrainInboxChange: notify }))

const { readWorkProjection, WorkUnavailableError } = await import('../work.js')
const { workRoutes } = await import('../../routes/work.js')

const row = (over: Record<string, unknown>) => ({
  id: 't', title: 'Fictional', status: 'todo', due: null, assigneeId: null, executorAssistantId: null,
  followUpMemberId: null, homeKind: null, homeId: null, createdByUserId: 'someone', updatedAt: new Date('2026-10-01T00:00:00Z'), ...over,
})

beforeEach(() => { db.statements = []; db.fail = null; db.rows = []; db.goals = [] })

describe('[COMP:api/brief-work] work projection and work routes', () => {
  it('sorts visible rows into one section each and counts exactly what it returns', async () => {
    db.rows = [
      row({ id: 'queue', homeKind: 'department', homeId: 'dept' }),
      row({ id: 'mine', assigneeId: 'member-me' }),
      row({ id: 'assistant', executorAssistantId: 'a1', homeKind: 'department', homeId: 'dept', status: 'in_progress' }),
      row({ id: 'question', executorAssistantId: 'a1', followUpMemberId: 'member-me' }),
      row({ id: 'not-mine', assigneeId: 'member-else' }),
    ]
    db.goals = [{ hostId: 'question', status: 'awaiting_approval', blockerReason: null }]
    const w = await readWorkProjection('user-me', 'ws', { kind: 'personal' }, new Date('2026-10-13T00:00:00Z'))
    expect(w.sections.needsAssignment.map(i => i.taskId)).toEqual(['queue'])
    expect(w.sections.myWork.map(i => i.taskId)).toEqual(['mine', 'assistant'])
    expect(w.sections.needsYou.map(i => [i.taskId, i.nextAction])).toEqual([['question', 'answer']])
    expect(w.counts).toEqual({ needsYou: 1, myWork: 2, needsAssignment: 1 })
    expect(w.sections.myWork[1]).toMatchObject({ executor: { kind: 'assistant', assistantId: 'a1', name: 'Ops' }, followUp: { source: 'home_owners', viewerIsOwner: true } })
  })

  it('distinguishes an authoritative empty queue from an unavailable source', async () => {
    const empty = await readWorkProjection('user-me', 'ws', { kind: 'personal' })
    expect(empty.counts).toEqual({ needsYou: 0, myWork: 0, needsAssignment: 0 })
    db.fail = 'FROM tasks'
    await expect(readWorkProjection('user-me', 'ws', { kind: 'personal' })).rejects.toBeInstanceOf(WorkUnavailableError)
  })

  it('reads only: every statement is a SELECT and nothing reaches a model', async () => {
    db.rows = [row({ id: 'mine', assigneeId: 'member-me' })]
    await readWorkProjection('user-me', 'ws', { kind: 'department', id: 'dept' })
    for (const sql of db.statements) expect(sql.trim()).toMatch(/^(SELECT|WITH)\b/i)
    expect(db.statements.some(s => /INSERT|UPDATE |DELETE/i.test(s))).toBe(false)
  })

  it('treats a non-member as not found', async () => {
    await expect(readWorkProjection('stranger', 'ws', { kind: 'personal' })).rejects.toMatchObject({ code: 'brief_not_found' })
  })

  describe('routes', () => {
    async function serve(update = vi.fn()) {
      const app = express()
      app.use(express.json())
      app.use((req, _res, next) => { (req as { userId?: string }).userId = 'user-me'; next() })
      app.use('/api', workRoutes({ taskStore: { update }, auth: (_req, _res, next) => next() }))
      const server = app.listen(0)
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
      return { base, update, close: () => server.close() }
    }
    const WS = '11111111-1111-4111-8111-111111111111'
    const TASK = '22222222-2222-4222-8222-222222222222'

    it('answers 503 work_unavailable when a source fails, never an empty queue', async () => {
      const s = await serve()
      db.fail = 'FROM tasks'
      const res = await fetch(`${s.base}/workspaces/${WS}/work`)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'work_unavailable' })
      s.close()
    })

    it('validates the claim body and maps a taken task to 409', async () => {
      const update = vi.fn(async (_a: string, _id: string, _f: object, opts: { precondition: (c: object) => unknown }) => {
        opts.precondition({ assigneeId: 'member-else', executorAssistantId: null, workspaceId: WS })
        return null
      })
      const s = await serve(update as never)
      const bad = await fetch(`${s.base}/workspaces/${WS}/tasks/${TASK}/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ executor: { kind: 'robot' } }) })
      expect(bad.status).toBe(400)
      const taken = await fetch(`${s.base}/workspaces/${WS}/tasks/${TASK}/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ executor: { kind: 'person' } }) })
      expect(taken.status).toBe(409)
      expect(await taken.json()).toEqual({ error: 'task_already_claimed' })
      s.close()
    })

    it('notifies other tabs after a successful claim', async () => {
      const update = vi.fn(async (_a: string, id: string) => ({ id: `${id}-next`, assigneeId: 'member-me', executorAssistantId: null }))
      db.rows = []
      const s = await serve(update as never)
      const ok = await fetch(`${s.base}/workspaces/${WS}/tasks/${TASK}/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ executor: { kind: 'person' } }) })
      expect(ok.status).toBe(200)
      expect(notify).toHaveBeenCalledWith(WS, 'task', `${TASK}-next`, 'update')
      s.close()
    })

    it('rejects an invalid owner kind as not found', async () => {
      const s = await serve()
      const res = await fetch(`${s.base}/workspaces/${WS}/briefs/by-owner/team/${TASK}/work`)
      expect(res.status).toBe(404)
      s.close()
    })
  })
})
