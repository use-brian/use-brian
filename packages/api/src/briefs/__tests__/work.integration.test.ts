/**
 * The work projection against a migration-replayed PostgreSQL with real RLS:
 * exact rows AND counts per viewer, current-owner fallback, owner changes,
 * protected-row exclusion after a clearance drop, scope validation, and no
 * write from a read. Runs only through scripts/crm/local-fixture.mjs.
 * Fictional identities only.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool } from '../../db/client.js'
import { createTask, updateTask } from '../../db/tasks.js'
import { briefFixture, type BriefFixture } from './fixture.js'
import { readWorkProjection, type WorkProjection } from '../work.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
afterAll(async () => { await getAppPool().end(); await pool.end() })

const memberId = async (f: BriefFixture, userId: string) =>
  (await f.q('SELECT id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, userId])).rows[0].id as string
const ids = (w: WorkProjection, section: keyof WorkProjection['sections']) => w.sections[section].map(i => i.taskId).sort()
const finance = (f: BriefFixture) => ({ kind: 'department' as const, id: f.finance })

describe('[COMP:api/brief-work] viewer-bound work projection (real PG + RLS)', () => {
  it('puts unassigned Department work in its owner queue only, with counts equal to rows', async () => {
    const f = await briefFixture()
    const queued = await createTask(f.people.financeLead, { workspaceId: f.workspaceId, title: 'Unassigned finance work', home: finance(f) })
    const lead = await readWorkProjection(f.people.financeLead, f.workspaceId, { kind: 'personal' })
    expect(ids(lead, 'needsAssignment')).toEqual([queued.id])
    expect(lead.counts).toEqual({ needsYou: 0, myWork: 0, needsAssignment: 1 })
    expect(lead.sections.needsAssignment[0]).toMatchObject({ nextAction: 'assign', executor: { kind: 'unassigned' }, followUp: { source: 'owner_queue' } })
    // A member who can see the task gets no owner nudge.
    const member = await readWorkProjection(f.people.member, f.workspaceId, { kind: 'personal' })
    expect(member.counts).toEqual({ needsYou: 0, myWork: 0, needsAssignment: 0 })
    const scoped = await readWorkProjection(f.people.financeLead, f.workspaceId, { kind: 'department', id: f.finance })
    expect(ids(scoped, 'needsAssignment')).toEqual([queued.id])
  })

  it('lists a person their own work and raises an overdue item into Needs you', async () => {
    const f = await briefFixture()
    const mine = await createTask(f.people.member, { workspaceId: f.workspaceId, title: 'My work', assigneeId: await memberId(f, f.people.member) })
    const late = await createTask(f.people.member, { workspaceId: f.workspaceId, title: 'Late work', assigneeId: await memberId(f, f.people.member), due: new Date('2026-01-01T00:00:00Z') })
    const w = await readWorkProjection(f.people.member, f.workspaceId, { kind: 'personal' })
    expect(ids(w, 'myWork')).toEqual([mine.id])
    expect(ids(w, 'needsYou')).toEqual([late.id])
    expect(w.sections.needsYou[0].reasons).toEqual(['overdue', 'assigned_to_you'])
  })

  it('gives the explicit human the assistant task, and its blocked Goal, while the assistant stays executor', async () => {
    const f = await briefFixture()
    await f.edge('user', f.people.member)
    const task = await createTask(f.people.financeLead, {
      workspaceId: f.workspaceId, title: 'Assistant work', executorAssistantId: f.assistants.brian, home: finance(f),
      followUpMemberId: await memberId(f, f.people.member),
    })
    let w = await readWorkProjection(f.people.member, f.workspaceId, { kind: 'personal' })
    expect(w.sections.myWork).toEqual([expect.objectContaining({
      taskId: task.id, executor: { kind: 'assistant', assistantId: f.assistants.brian, name: 'Brian' },
      followUp: expect.objectContaining({ source: 'explicit' }), reasons: ['follow_up'],
    })])
    // The Department owner is not the fallback once an explicit human exists.
    expect((await readWorkProjection(f.people.financeLead, f.workspaceId, { kind: 'personal' })).counts.myWork).toBe(0)
    await pool.query(`INSERT INTO goals (workspace_id, host_type, host_id, outcome, done_when, means, status, blocker_reason, created_by_user_id, confirmed_at)
      VALUES ($1,'task',$2,'Fictional','{"kind":"subtasks"}'::jsonb,'{}'::jsonb,'blocked','Needs the invoice export',$3,now())`,
    [f.workspaceId, task.id, f.people.financeLead])
    w = await readWorkProjection(f.people.member, f.workspaceId, { kind: 'personal' })
    expect(w.sections.needsYou).toEqual([expect.objectContaining({ taskId: task.id, nextAction: 'unblock', blockerReason: 'Needs the invoice export' })])
    expect(w.counts).toEqual({ needsYou: 1, myWork: 0, needsAssignment: 0 })
  })

  it('routes assistant-only work to the current Department owner and re-routes on an owner change', async () => {
    const f = await briefFixture()
    const task = await createTask(f.people.financeLead, { workspaceId: f.workspaceId, title: 'Assistant only', executorAssistantId: f.assistants.brian, home: finance(f) })
    expect(ids(await readWorkProjection(f.people.financeLead, f.workspaceId, { kind: 'personal' }), 'myWork')).toEqual([task.id])
    await f.edge('user', f.people.member)
    await f.q('INSERT INTO department_owners(workspace_id,department_id,user_id) VALUES($1,$2,$3)', [f.workspaceId, f.finance, f.people.member])
    await f.q('DELETE FROM department_owners WHERE department_id=$1 AND user_id=$2', [f.finance, f.people.financeLead])
    expect((await readWorkProjection(f.people.financeLead, f.workspaceId, { kind: 'personal' })).counts.myWork).toBe(0)
    expect(ids(await readWorkProjection(f.people.member, f.workspaceId, { kind: 'personal' }), 'myWork')).toEqual([task.id])
  })

  it('uses Project ownership for assistant work in an independent shared Project', async () => {
    const f = await briefFixture()
    const task = await createTask(f.people.lead, { workspaceId: f.workspaceId, title: 'Project assistant work', executorAssistantId: f.assistants.brian, home: { kind: 'project', id: f.projectId } })
    const w = await readWorkProjection(f.people.lead, f.workspaceId, { kind: 'project', id: f.projectId })
    expect(w.sections.myWork).toEqual([expect.objectContaining({ taskId: task.id, followUp: { source: 'home_owners', home: { kind: 'project', id: f.projectId }, viewerIsOwner: true } })])
    await expect(readWorkProjection(f.people.outsider, f.workspaceId, { kind: 'project', id: f.projectId })).rejects.toMatchObject({ code: 'brief_not_found' })
    await expect(readWorkProjection(f.people.outsider, f.workspaceId, { kind: 'department', id: f.finance })).rejects.toMatchObject({ code: 'brief_not_found' })
  })

  it('discloses missing routing to the person who started unroutable assistant work', async () => {
    const f = await briefFixture()
    const task = await createTask(f.people.member, { workspaceId: f.workspaceId, title: 'No home', executorAssistantId: f.assistants.ops })
    const w = await readWorkProjection(f.people.member, f.workspaceId, { kind: 'personal' })
    expect(w.sections.needsYou).toEqual([expect.objectContaining({ taskId: task.id, nextAction: 'select_follow_up', followUp: { source: 'missing_routing', reason: 'no_home' } })])
    expect((await readWorkProjection(f.people.financeLead, f.workspaceId, { kind: 'personal' })).counts.needsYou).toBe(0)
  })

  it('drops a protected task from both rows and counts once the viewer loses clearance', async () => {
    const f = await briefFixture()
    await f.q("UPDATE workspace_members SET clearance='confidential' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.people.financeLead])
    await f.q("UPDATE department_edges SET clearance='confidential' WHERE department_id=$1 AND user_id=$2", [f.finance, f.people.financeLead])
    const open = await createTask(f.people.financeLead, { workspaceId: f.workspaceId, title: 'Open queue item', home: finance(f) })
    const secret = await createTask(f.people.financeLead, { workspaceId: f.workspaceId, title: 'Protected queue item', home: finance(f), sensitivity: 'confidential' })
    let w = await readWorkProjection(f.people.financeLead, f.workspaceId, { kind: 'personal' })
    expect(ids(w, 'needsAssignment')).toEqual([open.id, secret.id].sort())
    expect(w.counts.needsAssignment).toBe(2)
    await f.q("UPDATE workspace_members SET clearance='internal' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.people.financeLead])
    w = await readWorkProjection(f.people.financeLead, f.workspaceId, { kind: 'personal' })
    expect(ids(w, 'needsAssignment')).toEqual([open.id])
    expect(w.counts.needsAssignment).toBe(1)
    expect(JSON.stringify(w)).not.toContain('Protected queue item')
  })

  it('drops resolved work and never writes on read', async () => {
    const f = await briefFixture()
    const task = await createTask(f.people.member, { workspaceId: f.workspaceId, title: 'Finish me', assigneeId: await memberId(f, f.people.member) })
    const before = (await pool.query('SELECT count(*)::int n, max(updated_at) u FROM tasks WHERE workspace_id=$1', [f.workspaceId])).rows[0]
    const bindings = (await pool.query('SELECT count(*)::int n FROM brief_bindings WHERE workspace_id=$1', [f.workspaceId])).rows[0].n
    expect((await readWorkProjection(f.people.member, f.workspaceId, { kind: 'personal' })).counts.myWork).toBe(1)
    expect((await pool.query('SELECT count(*)::int n, max(updated_at) u FROM tasks WHERE workspace_id=$1', [f.workspaceId])).rows[0]).toEqual(before)
    expect((await pool.query('SELECT count(*)::int n FROM brief_bindings WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(bindings)
    await updateTask(f.people.member, task.id, { status: 'done' })
    expect((await readWorkProjection(f.people.member, f.workspaceId, { kind: 'personal' })).counts).toEqual({ needsYou: 0, myWork: 0, needsAssignment: 0 })
  })
})
