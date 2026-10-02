import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { createGoalTools } from '@use-brian/core'
import { createDbGoalStore } from '../goals-store.js'
import { afterAll, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { process.env.PG_SINGLE_CONNECTION = '1' })
import { getPool, getAppPool } from '../client.js'
import { runWithAgentAccess, currentAgentAccess } from '../agent-access-context.js'
import { createTask } from '../tasks.js'
import { createGoal, getGoalById } from '../goals.js'
import { captureTaskGoalSource } from '../../workspace-access/goal-source-admission.js'
import { produceTaskGoalDraft } from '../goal-task-producer.js'
import { triageTaskForGoal, type TaskGoalTriageDeps } from '../goal-task-triage.js'
import { createDbTaskStore } from '../tasks-store.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
afterAll(async () => { await pool.end() })
const brief = { outcome: 'Finish canonical task', verification: 'Check task', approach: 'Work task', judgeReason: 'Actionable' }
async function fixture() {
  const workspaceId = randomUUID(), owner = randomUUID(), userId = randomUUID(), assistantId = randomUUID(), teamId = randomUUID()
  const compartment = `team:${teamId}`
  for (const id of [owner, userId]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Single connection workflow',$2)", [workspaceId, owner])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [workspaceId, owner, userId])
  await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1,$2,'Team',$3,'team',$1::uuid::text,$4)", [teamId, workspaceId, owner, compartment])
  await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,created_by,managed_by,managed_ref_id) VALUES($1,$2,'Team',$3,'team',$4)", [workspaceId, compartment, owner, teamId])
  await pool.query('INSERT INTO workspace_group_compartment_grants(group_id,compartment_key,granted_by_user_id) VALUES($1,$2,$3)', [teamId, compartment, owner])
  await pool.query('INSERT INTO workspace_group_members(group_id,user_id) VALUES($1,$2)', [teamId, userId])
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance,team_scope_mode) VALUES($1,'Primary',$2,$3,'primary','internal','assigned')", [assistantId, owner, workspaceId])
  await pool.query('INSERT INTO workspace_group_assistants(group_id,assistant_id) VALUES($1,$2)', [teamId, assistantId])
  await pool.query('UPDATE assistants SET default_workspace_group_id=$2 WHERE id=$1', [assistantId, teamId])
  await pool.query("UPDATE workspace_members SET team_scope_mode='assigned' WHERE workspace_id=$1 AND user_id=$2", [workspaceId,userId])
  const definition = { startStepId: 'call', steps: [{ id: 'call', type: 'assistant_call' as const, target: { assistantId }, prompt: 'Test' }] }
  await pool.query("UPDATE workspace_access_policies SET access_mode='departments',setup_state='ready' WHERE workspace_id=$1", [workspaceId])
  const access = { workspaceId, userId, clearance: 'internal' as const, compartments: [compartment], mutationCompartments: [compartment], projectIds: [] as string[], visibilityAssistantIds: [assistantId] }
  const task = await createTask(owner, { workspaceId, title: 'Canonical title', compartments: [compartment] })
  const input = { workspaceId, userId, assistantId, taskId: task.id }
  const run = <T>(fn: () => T) => runWithAgentAccess(access, fn)
  const capture = () => run(() => captureTaskGoalSource(input))
  const params = { workspaceId, createdByUserId: userId, host: { type: 'task' as const, id: task.id }, outcome: 'Finish', doneWhen: { kind: 'subtasks' as const }, confirmed: false }
  const insert = (token: object, patch = {}) => run(() => createGoal({ ...params, ...patch }, undefined, token))
  return { workspaceId, userId, owner, assistantId, teamId, compartment, access, task, input, run, capture, params, insert }
}

describe('task goal source admission, real PG and producer, one connection', () => {
  it('uses executing actor, canonical input and finite durable consent, not historical creator', async () => {
    const f = await fixture()
    expect(getAppPool()).toBe(pool)
    expect(pool.options.max).toBe(1)
    const judge = vi.fn(async (task: { title: string }) => {
      expect(task.title).toBe('Canonical title')
      // Proves no checkout is held during the producer.
      await pool.query('SELECT 1')
      return brief
    })
    const goal = await f.run(() => produceTaskGoalDraft(f.input, judge))
    expect(goal).toMatchObject({ createdByUserId: f.userId, contextGroupId: f.teamId, contextProjectId: null })
    expect((await pool.query('SELECT created_by_user_id FROM tasks WHERE id=$1',[f.task.id])).rows[0].created_by_user_id).toBe(f.owner)
    expect(goal?.authoringAuthority?.ceiling).toMatchObject({ userId: f.userId, compartments: [f.compartment], mutationCompartments: [f.compartment], projectIds: [] })
    expect(await getGoalById(f.userId, goal!.id)).not.toBeNull()
    expect(await runWithAgentAccess({...f.access,clearance:'public'},()=>getGoalById(f.userId,goal!.id))).toBeNull()
    expect(judge).toHaveBeenCalledOnce()
  })
  it('one attempt, lost acknowledgment, concurrent recapture cannot duplicate a goal', async () => {
    const f = await fixture(), token = await f.capture(), second = await f.capture()
    const results = await Promise.allSettled([f.insert(token), f.insert(second)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    await expect(f.insert(token)).rejects.toThrow()
    await expect(f.insert(await f.capture())).rejects.toThrow()
    expect((await pool.query('SELECT count(*)::int n FROM goals WHERE workspace_id=$1',[f.workspaceId])).rows[0].n).toBe(1)
  })
  it('does not accept JSON proof, runtime absence, actor substitution, or revoked mutation', async () => {
    const f = await fixture()
    await expect(f.insert({ ...f.input })).rejects.toThrow()
    await expect(captureTaskGoalSource(f.input)).rejects.toThrow()
    await expect(f.run(() => captureTaskGoalSource({ ...f.input, userId: f.owner }))).rejects.toThrow()
    const token = await f.capture()
    await expect(runWithAgentAccess({ ...f.access, mutationCompartments: [] }, () => createGoal(f.params, undefined, token))).rejects.toThrow()
    await expect(f.insert(token)).rejects.toThrow()
    await pool.query('DELETE FROM workspace_group_members WHERE group_id=$1 AND user_id=$2', [f.teamId,f.userId])
    await expect(f.capture()).rejects.toThrow()
  })
  it('keeps inherited old binding across mode/default changes; omission inherits but explicit null conflicts', async () => {
    const f = await fixture(), token = await f.capture()
    await pool.query("UPDATE workspace_access_policies SET access_mode='simple',default_department_id=$2 WHERE workspace_id=$1", [f.workspaceId,f.teamId])
    await pool.query('UPDATE assistants SET default_workspace_group_id=NULL WHERE id=$1',[f.assistantId])
    await expect(f.insert(token, { contextGroupId: null })).rejects.toThrow()
    const goal = await f.insert(await f.capture())
    expect(goal.contextGroupId).toBe(f.teamId)
    const saved = (await pool.query('SELECT proof FROM goal_task_source_authority WHERE task_id=$1',[f.task.id])).rows[0].proof
    expect(saved.authority).toEqual(goal.authoringAuthority)
  })
  it.each(['private','sensitivity','version','held'])('rejects %s source changes during actual producer', async kind => {
    const f = await fixture()
    await expect(f.run(() => produceTaskGoalDraft(f.input, async () => {
      const sql = { private: 'user_id=$2', sensitivity: "sensitivity='confidential'", version: 'valid_to=now()', held: 'scope_held=true' }[kind]!
      await pool.query(`UPDATE tasks SET ${sql} WHERE id=$1`, kind==='private' ? [f.task.id,f.userId] : [f.task.id])
      return brief
    }))).rejects.toThrow()
    expect((await pool.query('SELECT count(*)::int n FROM goals WHERE workspace_id=$1',[f.workspaceId])).rows[0].n).toBe(0)
  })
  it('workspace barrier observes a winning source update; no stale source capture', async () => {
    const f = await fixture(), token = await f.capture()
    const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await blocker.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[f.workspaceId])
      const pending = expect(f.insert(token)).rejects.toThrow()
      await blocker.query("UPDATE tasks SET title='Racing replacement' WHERE id=$1",[f.task.id])
      await blocker.query('COMMIT')
      await pending
      await expect(f.capture()).rejects.toThrow() // persisted proof is not renewed
    } finally { await blocker.query('ROLLBACK'); await blocker.end() }
  })
  it('withholds derived goal reads when source authority is revoked', async () => {
    const f = await fixture(), goal = await f.insert(await f.capture())
    await pool.query('DELETE FROM workspace_group_members WHERE group_id=$1 AND user_id=$2',[f.teamId,f.userId])
    expect(await getGoalById(f.userId,goal.id)).toBeNull()
  })
  it('clips the actual producer to saved finite source authority, and does not renew it on retry', async () => {
    const f = await fixture()
    const wider = { ...f.access, clearance: 'confidential' as const, projectIds: [randomUUID()] }
    await runWithAgentAccess(wider, () => produceTaskGoalDraft(f.input, async () => {
      expect(currentAgentAccess()).toMatchObject({ clearance: 'internal', projectIds: [], compartments: [f.compartment] })
      return null
    }))
    const before = (await pool.query('SELECT proof FROM goal_task_source_authority WHERE task_id=$1',[f.task.id])).rows[0].proof
    await runWithAgentAccess(wider, () => produceTaskGoalDraft(f.input, async () => brief))
    const after = (await pool.query('SELECT proof FROM goal_task_source_authority WHERE task_id=$1',[f.task.id])).rows[0].proof
    expect(after).toEqual(before)
    await expect(f.run(() => captureTaskGoalSource({ ...f.input, userId: f.owner }))).rejects.toThrow()
  })
  it('retains a single Project; rejects explicit null, runtime removal and archived Project', async () => {
    const f = await fixture(), project = randomUUID()
    await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Project','project',$3)",[project,f.workspaceId,f.owner])
    await pool.query('INSERT INTO workspace_project_members(project_id,user_id) VALUES($1,$2)',[project,f.userId])
    await pool.query('UPDATE tasks SET project_ids=ARRAY[$2::uuid] WHERE id=$1',[f.task.id,project])
    f.access.projectIds.push(project)
    const first = await f.capture()
    await expect(f.insert(first,{contextProjectId:null})).rejects.toThrow()
    const second = await f.capture()
    f.access.projectIds.length=0
    await expect(f.insert(second)).rejects.toThrow()
    f.access.projectIds.push(project)
    const goal=await f.insert(await f.capture(),{contextProjectId:project})
    expect(goal.authoringAuthority?.ceiling.projectIds).toEqual([project])
    await pool.query("UPDATE workspace_projects SET status='archived' WHERE id=$1",[project])
    await expect(f.capture()).rejects.toThrow()
  })
  it.each(['private','assistant','multi-project','multi-department'])('rejects unsupported %s before invoking the judge', async kind => {
    const f=await fixture(), judge=vi.fn(async()=>brief)
    if(kind==='private') await pool.query('UPDATE tasks SET user_id=$2 WHERE id=$1',[f.task.id,f.userId])
    if(kind==='assistant') await pool.query('UPDATE tasks SET assistant_id=$2 WHERE id=$1',[f.task.id,f.assistantId])
    if(kind==='multi-project') {
      const ids=[randomUUID(),randomUUID()]
      for(const id of ids) await pool.query('INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,$1::uuid::text,$1::uuid::text,$3)',[id,f.workspaceId,f.owner])
      await expect(pool.query('UPDATE tasks SET project_ids=$2 WHERE id=$1',[f.task.id,ids])).rejects.toMatchObject({constraint:'tasks_one_project_check'})
      expect(judge).not.toHaveBeenCalled()
      return
    }
    if(kind==='multi-department') await pool.query('UPDATE tasks SET compartments=$2 WHERE id=$1',[f.task.id,[f.compartment,'other']])
    await expect(f.run(()=>produceTaskGoalDraft(f.input,judge))).rejects.toMatchObject({code:'goal_source_unsupported'})
    expect(judge).not.toHaveBeenCalled()
  })
  it('native tool with only UUID/session/model snapshot is explicitly rejected, not treated as attended proof', async () => {
    const f=await fixture(), tool=createGoalTools(createDbGoalStore()).setGoal
    await expect(f.run(()=>tool.execute({outcome:'Native',done_when:{kind:'subtasks'}},{...f.access,
      assistantId:f.assistantId,assistantKind:'primary',activeGroupId:f.teamId,
      sessionId:randomUUID(),appId:'test',channelType:'web',channelId:'web',abortSignal:new AbortController().signal,
    }))).rejects.toMatchObject({code:'operational_authoring_proof_required'})
  })
  it('a membership revoke winning the workspace barrier blocks insertion with the old token', async () => {
    const f=await fixture(),token=await f.capture(),blocker=new pg.Client({connectionString:process.env.DATABASE_URL})
    await blocker.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[f.workspaceId])
      const rejected=expect(f.insert(token)).rejects.toThrow()
      await blocker.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.userId])
      await blocker.query('COMMIT')
      await rejected
    } finally {await blocker.query('ROLLBACK');await blocker.end()}
  })

})


describe('boot task-triage adapter: canonical mode selection and actual task callback', () => {
  function deps(f: Awaited<ReturnType<typeof fixture>>): TaskGoalTriageDeps {
    return {
      goalStore: createDbGoalStore(),
      resolveAssistantId: vi.fn(async () => f.assistantId),
      publicCoreCapabilities: Object.freeze(['Public core task capability']),
      summariseCapabilities: vi.fn(async () => ['Work with tasks']),
      judge: vi.fn(async () => brief),
    }
  }
  it('ready uses canonical task data and executing actor, never the legacy create branch', async () => {
    const f = await fixture(), d = deps(f)
    const legacyCreate = vi.spyOn(d.goalStore, 'create')
    const goal = await f.run(() => triageTaskForGoal({ ...f.task, title: 'Stale callback data' }, f.userId, d))
    expect(goal?.createdByUserId).toBe(f.userId)
    expect(d.judge).toHaveBeenCalledWith(expect.objectContaining({ title: 'Canonical title', userId: f.userId }))
    expect(legacyCreate).not.toHaveBeenCalled()
  })
  it('legacy retains the original judge/store path, optional assistant and no saved proof', async () => {
    const f = await fixture(), d = deps(f)
    await pool.query("UPDATE workspace_access_policies SET setup_state='legacy' WHERE workspace_id=$1", [f.workspaceId])
    d.resolveAssistantId = vi.fn(async () => undefined)
    const legacyCreate = vi.spyOn(d.goalStore, 'create')
    const goal = await triageTaskForGoal({ ...f.task, title: 'Original legacy callback' }, f.userId, d)
    expect(d.judge).toHaveBeenCalledWith(expect.objectContaining({ title: 'Original legacy callback', assistantId: undefined, userId: f.userId }))
    expect(legacyCreate).toHaveBeenCalledOnce()
    expect(goal).toMatchObject({ createdByUserId: f.userId, authoringAuthority: null, confirmedAt: null })
    expect((await pool.query('SELECT count(*)::int n FROM goal_task_source_authority WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
  })
  it.each(['ready', 'legacy'] as const)('%s capability input isolates ready goals from secret connector canaries', async setupState => {
    const f = await fixture(), d = deps(f)
    await pool.query('UPDATE workspace_access_policies SET setup_state=$2 WHERE workspace_id=$1', [f.workspaceId,setupState])
    const canaries = [
      'CONFIDENTIAL_UNKNOWN_PROVIDER_LABEL_7ca1',
      'PERSONAL_CONNECTOR_LABEL_3bf2',
      'OTHER_TEAM_CONNECTOR_LABEL_4ed3',
      'OTHER_PROJECT_CONNECTOR_LABEL_9af4',
    ]
    d.summariseCapabilities = vi.fn(async () => [...canaries])
    // Echo the full judge input into the saved goal so a leak is observable
    // both at the producer boundary and in the committed shared output.
    d.judge = vi.fn(async input => ({ ...brief, approach: JSON.stringify(input) }))
    const goal = await f.run(() => triageTaskForGoal(f.task, f.userId, d))
    expect(goal).not.toBeNull()
    const expected = setupState === 'ready' ? [...d.publicCoreCapabilities] : canaries
    expect(d.judge).toHaveBeenCalledWith(expect.objectContaining({ capabilities: expected }))
    if (setupState === 'ready') {
      expect(d.summariseCapabilities).not.toHaveBeenCalled()
      const stored = (await pool.query('SELECT outcome,brief FROM goals WHERE id=$1', [goal!.id])).rows[0]
      for (const canary of canaries) {
        expect(JSON.stringify(vi.mocked(d.judge).mock.calls)).not.toContain(canary)
        expect(JSON.stringify(stored)).not.toContain(canary)
      }
    } else {
      expect(d.summariseCapabilities).toHaveBeenCalledExactlyOnceWith(f.userId, f.workspaceId)
      for (const canary of canaries) expect(goal!.brief!.approach).toContain(canary)
    }
  })
  it('legacy activation during the judge rejects at canonical insertion without reauthoring', async () => {
    const f = await fixture(), d = deps(f)
    await pool.query("UPDATE workspace_access_policies SET setup_state='legacy' WHERE workspace_id=$1", [f.workspaceId])
    d.judge = vi.fn(async () => {
      await pool.query("UPDATE workspace_access_policies SET setup_state='ready' WHERE workspace_id=$1", [f.workspaceId])
      return brief
    })
    await expect(f.run(() => triageTaskForGoal(f.task, f.userId, d))).rejects.toMatchObject({ code: 'operational_authoring_proof_required' })
    expect((await pool.query('SELECT count(*)::int n FROM goals WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM goal_task_source_authority WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
  })
  it('ready downgrade during the judge rejects its proof without legacy fallback', async () => {
    const f = await fixture(), d = deps(f), legacyCreate = vi.spyOn(d.goalStore, 'create')
    d.judge = vi.fn(async () => {
      await pool.query("UPDATE workspace_access_policies SET setup_state='legacy' WHERE workspace_id=$1", [f.workspaceId])
      return brief
    })
    await expect(f.run(() => triageTaskForGoal(f.task, f.userId, d))).rejects.toMatchObject({ code: 'goal_source_unsupported' })
    expect(legacyCreate).not.toHaveBeenCalled()
    expect((await pool.query('SELECT count(*)::int n FROM goals WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
  })
  it('mode projection rejects a nonmember before assistant lookup or judge', async () => {
    const f = await fixture(), d = deps(f)
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId,f.userId])
    await expect(triageTaskForGoal(f.task, f.userId, d)).rejects.toMatchObject({ code: 'not_found' })
    expect(d.resolveAssistantId).not.toHaveBeenCalled()
    expect(d.judge).not.toHaveBeenCalled()
  })
  it('ready rechecks membership after mode projection before producing', async () => {
    const f = await fixture(), d = deps(f)
    d.resolveAssistantId = async () => {
      await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId,f.userId])
      return f.assistantId
    }
    await expect(f.run(() => triageTaskForGoal(f.task, f.userId, d))).rejects.toThrow()
    expect(d.judge).not.toHaveBeenCalled()
  })
  it('ready missing runtime proof does not fall back to the legacy store', async () => {
    const f = await fixture(), d = deps(f), legacyCreate = vi.spyOn(d.goalStore, 'create')
    await expect(triageTaskForGoal(f.task, f.userId, d)).rejects.toMatchObject({ code: 'goal_source_unsupported' })
    expect(d.judge).not.toHaveBeenCalled()
    expect(legacyCreate).not.toHaveBeenCalled()
  })
  it('actual taskStore.onTaskCreate invokes the same adapter with current actor; dedup emits once at max:1', async () => {
    const f = await fixture(), d = deps(f)
    let completion: ReturnType<typeof triageTaskForGoal> | undefined
    const callback = vi.fn((task: Parameters<typeof triageTaskForGoal>[0], actor: string) => {
      completion = triageTaskForGoal(task, actor, d)
    })
    const tasks = createDbTaskStore({ onTaskCreate: callback })
    const input = { workspaceId: f.workspaceId, userId: f.userId, title: 'Actual task writer', compartments: [f.compartment] }
    const task = await f.run(() => tasks.create(input))
    const goal = await completion
    expect(goal).toMatchObject({ host: { type: 'task', id: task.id }, createdByUserId: f.userId })
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), f.userId)
    expect((await f.run(() => tasks.create(input))).id).toBe(task.id)
    expect(callback).toHaveBeenCalledOnce()
    expect(d.judge).toHaveBeenCalledOnce()
  })
  it.each(['legacy', 'ready'] as const)('a negative judge in %s never creates a goal', async setupState => {
    const f = await fixture(), d = deps(f), legacyCreate = vi.spyOn(d.goalStore, 'create')
    await pool.query('UPDATE workspace_access_policies SET setup_state=$2 WHERE workspace_id=$1', [f.workspaceId,setupState])
    d.judge = vi.fn(async () => null)
    expect(await f.run(() => triageTaskForGoal(f.task, f.userId, d))).toBeNull()
    expect(legacyCreate).not.toHaveBeenCalled()
    expect((await pool.query('SELECT count(*)::int n FROM goals WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
  })
  it('ready without an assistant explicitly rejects before capabilities or judge', async () => {
    const f = await fixture(), d = deps(f)
    d.resolveAssistantId = async () => undefined
    await expect(f.run(() => triageTaskForGoal(f.task, f.userId, d))).rejects.toMatchObject({ code: 'goal_source_unsupported' })
    expect(d.summariseCapabilities).not.toHaveBeenCalled()
    expect(d.judge).not.toHaveBeenCalled()
  })

})
