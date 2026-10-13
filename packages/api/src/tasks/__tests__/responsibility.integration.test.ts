/**
 * Task responsibility against a migration-replayed PostgreSQL: the migration
 * 753 trigger and helpers, actor-bound validation inside the writer
 * transaction, supersession carry-forward, the executor_changed cascade, the
 * guarded claim under a race, and current-owner fallback resolution.
 *
 * Runs only through scripts/crm/local-fixture.mjs (disposable database).
 * Fictional identities only.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { getAppPool, getPool } from '../../db/client.js'
import { bindTaskExecutorChangeHook, createTask, getTaskByIdSystem, updateTask } from '../../db/tasks.js'
import { createDbTaskStore } from '../../db/tasks-store.js'
import { briefFixture, type BriefFixture } from '../../briefs/__tests__/fixture.js'
import { claimTask, homeOwnerIds } from '../responsibility.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
afterAll(async () => { bindTaskExecutorChangeHook(null); await getAppPool().end(); await pool.end() })

const memberId = async (f: BriefFixture, userId: string) =>
  (await f.q('SELECT id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, userId])).rows[0].id as string

const financeHome = (f: BriefFixture) => ({ kind: 'department' as const, id: f.finance })
const live = async (id: string) => (await pool.query(
  'SELECT assignee_id, executor_assistant_id, follow_up_member_id, home_kind, home_id FROM tasks WHERE id=$1', [id])).rows[0]

async function seedGoal(f: BriefFixture, taskId: string, confirmed: boolean) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO goals (workspace_id, host_type, host_id, outcome, done_when, means, status, created_by_user_id, confirmed_at)
     VALUES ($1, 'task', $2, 'Fictional outcome', '{"kind":"subtasks"}'::jsonb, '{}'::jsonb, 'active', $3, $4) RETURNING id`,
    [f.workspaceId, taskId, f.people.financeLead, confirmed ? new Date() : null])).rows[0].id
}
const goalStatus = async (id: string) => (await pool.query('SELECT status, blocker_reason FROM goals WHERE id=$1', [id])).rows[0]

describe('[COMP:api/task-responsibility] executor, follow-up, home and guarded claim (real PG)', () => {
  it('the workspace-match trigger refuses a foreign assistant executor on a plain insert', async () => {
    const f = await briefFixture(), other = await briefFixture()
    await expect(pool.query(
      `INSERT INTO tasks (workspace_id, title, created_by_user_id, executor_assistant_id) VALUES ($1,'Fictional',$2,$3)`,
      [f.workspaceId, f.people.financeLead, other.assistants.ops])).rejects.toThrow(/task_executor_invalid/)
    await expect(pool.query(
      `INSERT INTO tasks (workspace_id, title, created_by_user_id, home_kind, home_id) VALUES ($1,'Fictional',$2,'department',$3)`,
      [f.workspaceId, f.people.financeLead, other.finance])).rejects.toThrow(/task_home_invalid/)
    const ok = await pool.query<{ id: string }>(
      `INSERT INTO tasks (workspace_id, title, created_by_user_id, executor_assistant_id, home_kind, home_id)
       VALUES ($1,'Fictional',$2,$3,'department',$4) RETURNING id`,
      [f.workspaceId, f.people.financeLead, f.assistants.brian, f.finance])
    expect(ok.rows[0].id).toBeTruthy()
    await expect(pool.query('UPDATE tasks SET assignee_id=$2 WHERE id=$1',
      [ok.rows[0].id, await memberId(f, f.people.financeLead)])).rejects.toThrow(/tasks_one_executor/)
  })

  it('refuses a person and an assistant executor in one write', async () => {
    const f = await briefFixture()
    await expect(createTask(f.people.financeLead, {
      workspaceId: f.workspaceId, title: 'Conflict', assigneeId: await memberId(f, f.people.financeLead), executorAssistantId: f.assistants.brian,
    })).rejects.toMatchObject({ code: 'task_executor_conflict' })
  })

  it('admits only an executor visible to the actor and admitted to the home', async () => {
    const f = await briefFixture()
    await expect(createTask(f.people.financeLead, {
      workspaceId: f.workspaceId, title: 'Ops not in Finance', executorAssistantId: f.assistants.ops, home: financeHome(f),
    })).rejects.toMatchObject({ code: 'task_executor_invalid' })
    const task = await createTask(f.people.financeLead, {
      workspaceId: f.workspaceId, title: 'Brian in Finance', executorAssistantId: f.assistants.brian, home: financeHome(f),
    })
    expect(task).toMatchObject({ executorAssistantId: f.assistants.brian, assigneeId: null, home: financeHome(f), followUpMemberId: null })
    // Without a home, any visible configured assistant may execute.
    expect(await createTask(f.people.member, { workspaceId: f.workspaceId, title: 'Ops anywhere', executorAssistantId: f.assistants.ops }))
      .toMatchObject({ executorAssistantId: f.assistants.ops })
  })

  it('refuses a home the actor does not belong to and a Project home that is not the task Project', async () => {
    const f = await briefFixture()
    await expect(createTask(f.people.outsider, { workspaceId: f.workspaceId, title: 'Not my Department', home: financeHome(f) }))
      .rejects.toMatchObject({ code: 'task_home_invalid' })
    await expect(createTask(f.people.outsider, {
      workspaceId: f.workspaceId, title: 'Not on the roster', home: { kind: 'project', id: f.projectId },
    })).rejects.toMatchObject({ code: 'task_home_invalid' })
    const plain = await createTask(f.people.lead, { workspaceId: f.workspaceId, title: 'Project work', home: { kind: 'project', id: f.projectId } })
    expect(plain.home).toEqual({ kind: 'project', id: f.projectId })
    const otherProject = randomUUID()
    await f.q(`INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Other','other',$3)`,
      [otherProject, f.workspaceId, f.people.lead])
    const located = await createTask(f.people.lead, { workspaceId: f.workspaceId, title: 'Located', projectIds: [otherProject] })
    await expect(updateTask(f.people.lead, located.id, { home: { kind: 'project', id: f.projectId } }))
      .rejects.toMatchObject({ code: 'task_home_mismatch' })
  })

  it('keeps the human contact independent of the assistant executor and carries all of it through supersession', async () => {
    const f = await briefFixture()
    await f.edge('user', f.people.member)
    const task = await createTask(f.people.financeLead, {
      workspaceId: f.workspaceId, title: 'Assistant work', executorAssistantId: f.assistants.brian, home: financeHome(f),
    })
    const contact = await memberId(f, f.people.member)
    const withContact = await updateTask(f.people.financeLead, task.id, { followUpMemberId: contact })
    expect(withContact).toMatchObject({ executorAssistantId: f.assistants.brian, assigneeId: null, followUpMemberId: contact })
    const renamed = await updateTask(f.people.financeLead, withContact!.id, { title: 'Renamed' })
    expect(await live(renamed!.id)).toMatchObject({
      assignee_id: null, executor_assistant_id: f.assistants.brian, follow_up_member_id: contact, home_kind: 'department', home_id: f.finance,
    })
  })

  it('refuses a contact who cannot see the task or is not admitted to its home', async () => {
    const f = await briefFixture()
    const task = await createTask(f.people.financeLead, {
      workspaceId: f.workspaceId, title: 'Finance work', executorAssistantId: f.assistants.brian, home: financeHome(f),
    })
    await expect(updateTask(f.people.financeLead, task.id, { followUpMemberId: await memberId(f, f.people.outsider) }))
      .rejects.toMatchObject({ code: 'task_follow_up_invalid' })
    await f.q("UPDATE workspace_members SET clearance='confidential' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.people.lead])
    const secret = await createTask(f.people.lead, { workspaceId: f.workspaceId, title: 'Confidential', sensitivity: 'confidential' })
    await expect(updateTask(f.people.lead, secret.id, { followUpMemberId: await memberId(f, f.people.member) }))
      .rejects.toMatchObject({ code: 'task_follow_up_invalid' })
  })

  it('treats the executor as one slot and retires only automatic drafts when it changes', async () => {
    const f = await briefFixture()
    const hook = vi.fn()
    bindTaskExecutorChangeHook(hook)
    const task = await createTask(f.people.financeLead, {
      workspaceId: f.workspaceId, title: 'Hand over', executorAssistantId: f.assistants.brian, home: financeHome(f),
    })
    const draft = await seedGoal(f, task.id, false), confirmed = await seedGoal(f, task.id, true)
    const person = await updateTask(f.people.financeLead, task.id, { assigneeId: await memberId(f, f.people.financeLead) })
    expect(person).toMatchObject({ assigneeId: await memberId(f, f.people.financeLead), executorAssistantId: null })
    expect(await goalStatus(draft)).toEqual({ status: 'abandoned', blocker_reason: 'executor_changed' })
    expect((await goalStatus(confirmed)).status).toBe('active')
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ id: person!.id }), expect.objectContaining({ executorAssistantId: f.assistants.brian }), f.people.financeLead, undefined)
    hook.mockClear()
    // A contact change is not an executor change: no cascade, no hook.
    const later = await seedGoal(f, person!.id, false)
    await f.edge('user', f.people.member)
    await updateTask(f.people.financeLead, person!.id, { followUpMemberId: await memberId(f, f.people.member) })
    expect((await goalStatus(later)).status).toBe('active')
    expect(hook).not.toHaveBeenCalled()
    bindTaskExecutorChangeHook(null)
  })

  it('lets racing owners claim one unassigned task exactly once, idempotently, through a stale id', async () => {
    const f = await briefFixture()
    await f.q('INSERT INTO department_owners(workspace_id,department_id,user_id) VALUES($1,$2,$3)', [f.workspaceId, f.finance, f.people.member])
    await f.edge('user', f.people.member)
    const store = createDbTaskStore()
    const task = await createTask(f.people.financeLead, { workspaceId: f.workspaceId, title: 'Queue item', home: financeHome(f) })
    const stale = task.id
    const renamed = await updateTask(f.people.financeLead, task.id, { title: 'Queue item, renamed' })
    const results = await Promise.allSettled([
      claimTask(store, f.people.financeLead, f.workspaceId, stale, { kind: 'person' }),
      claimTask(store, f.people.member, f.workspaceId, renamed!.id, { kind: 'person' }),
    ])
    const won = results.filter(r => r.status === 'fulfilled')
    const lost = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[]
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect(lost[0].reason).toMatchObject({ code: 'task_already_claimed', status: 409 })
    const winner = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof claimTask>>>).value
    const winnerUser = winner.assigneeId === await memberId(f, f.people.financeLead) ? f.people.financeLead : f.people.member
    const again = await claimTask(store, winnerUser, f.workspaceId, stale, { kind: 'person' })
    expect(again.id).toBe(winner.id)
    const liveRows = await pool.query('SELECT count(*)::int n FROM tasks WHERE workspace_id=$1 AND valid_to IS NULL', [f.workspaceId])
    expect(liveRows.rows[0].n).toBe(1)
    await expect(claimTask(store, f.people.financeLead, f.workspaceId, randomUUID(), { kind: 'person' }))
      .rejects.toMatchObject({ code: 'task_not_found' })
  })

  it('claims for an admitted assistant and refuses one that is not admitted', async () => {
    const f = await briefFixture(), store = createDbTaskStore()
    const task = await createTask(f.people.financeLead, { workspaceId: f.workspaceId, title: 'Assistant claim', home: financeHome(f) })
    await expect(claimTask(store, f.people.financeLead, f.workspaceId, task.id, { kind: 'assistant', assistantId: f.assistants.ops }))
      .rejects.toMatchObject({ code: 'task_executor_invalid' })
    expect(await claimTask(store, f.people.financeLead, f.workspaceId, task.id, { kind: 'assistant', assistantId: f.assistants.brian }))
      .toMatchObject({ executorAssistantId: f.assistants.brian, assigneeId: null })
  })

  it('resolves fallback owners from current ownership: changes and departures re-route', async () => {
    const f = await briefFixture()
    const dept = financeHome(f), project = { kind: 'project' as const, id: f.projectId }
    let owners = await homeOwnerIds(f.workspaceId, [dept, project])
    expect(owners.get(`department:${f.finance}`)).toEqual([f.people.financeLead])
    expect(owners.get(`project:${f.projectId}`)).toEqual([f.people.lead])
    await f.q('INSERT INTO department_owners(workspace_id,department_id,user_id) VALUES($1,$2,$3)', [f.workspaceId, f.finance, f.people.member])
    await f.q('DELETE FROM department_owners WHERE department_id=$1 AND user_id=$2', [f.finance, f.people.financeLead])
    owners = await homeOwnerIds(f.workspaceId, [dept])
    expect(owners.get(`department:${f.finance}`)).toEqual([f.people.member])
    await f.q('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.people.member])
    owners = await homeOwnerIds(f.workspaceId, [dept])
    expect(owners.get(`department:${f.finance}`)).toEqual([])
  })

  it('leaves a legacy task home unknown through ordinary edits; nothing is backfilled', async () => {
    const f = await briefFixture()
    const legacy = await createTask(f.people.financeLead, { workspaceId: f.workspaceId, title: 'Legacy', assigneeId: await memberId(f, f.people.financeLead) })
    const edited = await updateTask(f.people.financeLead, legacy.id, { status: 'in_progress' })
    expect(edited).toMatchObject({ home: null, executorAssistantId: null, followUpMemberId: null, assigneeId: await memberId(f, f.people.financeLead) })
    expect((await getTaskByIdSystem(edited!.id))?.home).toBeNull()
  })
})
