import { advanceWorkflowRun,executionToolContext,type ExecutorDeps,type WorkflowDefinition } from '@use-brian/core'
import {createDbWorkflowStore,createDbWorkflowRunStore} from '../workflow-store.js'
import {createDbJobStore} from '../job-store.js'
import {createGoalWorkTools} from '../../goals/work-tools.js'
import {resolveWorkflowRunScope} from '../../context-scope/workflow-authority.js'
import {resolveRetainedGoalWorkflowRuntime} from '../../workspace-access/goal-source-admission.js'
import {confirmRetainedGoal} from '../goals.js'
import {advanceRetainedGoalWorkflow,pauseWorkflowRunForWait,resumeWorkflowWaitJob} from '../../workflow/wait-lifecycle.js'
import express from 'express'
import request from 'supertest'
import {requireAuth} from '../../auth/middleware.js'
import {createTokens} from '../../auth/jwt.js'
import {authSessionStore} from '../auth-session-store.js'
import {goalsRoutes} from '../../routes/goals.js'
import {createWorkspaceStore} from '../workspace-store.js'
import * as goalNotifications from '../../brain-stream/notify.js'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { createGoalTools,ContextScopeAccumulator,createExecutionContext } from '@use-brian/core'
import { createSessionAuthorityLease,assertCurrentAuthority } from '../../context-scope/authority-lease.js'
import { resolveGoalAuthoritySystem } from '../../context-scope/workflow-authority.js'
import { resolveLiveAccessCeilingSystem } from '../../context-scope/resolve-turn-scope.js'
import { findAssistantById } from '../users.js'
import { findSessionAuthorityById } from '../sessions.js'
import { writeRetainedGoalWorkflowContextFrame,readRetainedContextFrame } from '../session-context-revisions.js'
import { readLegacyCanonicalCrmPoint } from '../crm-reader.js'
import { createDbGoalStore } from '../goals-store.js'
import { afterAll, describe, expect, it, vi } from 'vitest'
// Production keeps distinct owner/application roles. Each runtime pool remains max:1.
// The former owner-alias embedded profile is an explicit separate compatibility gap.
vi.hoisted(() => { delete process.env.PG_SINGLE_CONNECTION; process.env.PG_POOL_MAX = '1' })
import { getPool, getAppPool } from '../client.js'
import { runWithAgentAccess, currentAgentAccess } from '../agent-access-context.js'
import { createTask } from '../tasks.js'
import { createGoal, tryClaimGoalForTick,claimGoalRollupTerminalSystem,getGoalById, abandonGoalsForHostTaskSystem, getGoalByIdSystem, getGoalForExecutionSystem, getRetainedGoalById, listGoals, listGoalsByHostSystem } from '../goals.js'
import { captureTaskGoalSource } from '../../workspace-access/goal-source-admission.js'
import { produceTaskGoalDraft } from '../goal-task-producer.js'
import { triageTaskForGoal, type TaskGoalTriageDeps } from '../goal-task-triage.js'
import { createDbTaskStore } from '../tasks-store.js'
import { executeWorkspaceScopeReview } from '../../workspace-access/scope-review.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
afterAll(async () => { await getAppPool().end(); await pool.end() })
const brief = { outcome: 'Finish canonical task', verification: 'Check task', approach: 'Work task', judgeReason: 'Actionable' }
type InitialPartition='private'|'assistant'|'project'|'multi-department'
async function fixture(partition?:InitialPartition) {
  const workspaceId = randomUUID(), owner = randomUUID(), userId = randomUUID(), assistantId = randomUUID(), teamId = randomUUID()
  const compartment = `team:${teamId}`
  for (const id of [owner, userId]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Single connection workflow',$2)", [workspaceId, owner])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential'),($1,$3,'member','internal')", [workspaceId, owner, userId])
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
  const projectId=partition==='project'?randomUUID():undefined
  if(projectId){
    await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Project','project',$3)",[projectId,workspaceId,owner])
    await pool.query('INSERT INTO workspace_project_members(project_id,user_id) VALUES($1,$2)',[projectId,userId])
  }
  const otherCompartment=partition==='multi-department'?'fixture:second-department':undefined
  if(otherCompartment)await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,created_by) VALUES($1,$2,'Second department',$3)",[workspaceId,otherCompartment,owner])
  const access = { workspaceId, userId, clearance: 'internal' as const, compartments: [compartment], mutationCompartments: [compartment], projectIds: projectId?[projectId]:[] as string[], visibilityAssistantIds: [assistantId] }
  // Automatic triage follows the selected executor (migration 753), so the
  // fixture task is executed by the fixture assistant.
  const task = await createTask(partition==='private'?userId:owner, { workspaceId, title: 'Canonical title',
    executorAssistantId:assistantId,compartments: otherCompartment?[compartment,otherCompartment]:[compartment],
    projectIds:projectId?[projectId]:[],
    ...(partition==='private'?{visibility:{userId,assistantId:null}}:{}),
    ...(partition==='assistant'?{visibility:{userId:null,assistantId}}:{}) })
  const input = { workspaceId, userId, assistantId, taskId: task.id }
  const run = <T>(fn: () => T) => runWithAgentAccess(access, fn)
  const capture = () => run(() => captureTaskGoalSource(input))
  const params = { workspaceId, createdByUserId: userId, host: { type: 'task' as const, id: task.id }, outcome: 'Finish', doneWhen: { kind: 'subtasks' as const }, confirmed: false }
  const insert = (token: object, patch = {}) => run(() => createGoal({ ...params, ...patch }, undefined, token))
  return { workspaceId, userId, owner, assistantId, teamId, compartment, projectId, access, task, input, run, capture, params, insert }
}

// An independent, authorized human source owner contracts the source through the
// real nonowner SQL role. No producer ceiling, credentials, grants or guards are borrowed.
async function bindSourceOwner(client:Pick<pg.Client,'query'>,f:Awaited<ReturnType<typeof fixture>>){
  await client.query("SELECT set_config('app.current_user_id',$1,true),set_config('app.agent_actor_id',$1,true),set_config('app.agent_workspace_id',$2,true)",[f.owner,f.workspaceId])
}
async function mutateSource(f:Awaited<ReturnType<typeof fixture>>,sql:string,values:unknown[]){
  const client=new pg.Client({connectionString:process.env.DATABASE_URL_APP});await client.connect()
  try{await client.query('BEGIN');await bindSourceOwner(client,f);await client.query(sql,values);await client.query('COMMIT')}
  finally{await client.query('ROLLBACK');await client.end()}
}

describe('[COMP:api/task-responsibility] task goal source admission, real production roles and producer, max:1 per pool', () => {
  it('uses executing actor, canonical input and finite durable consent, not historical creator', async () => {
    const f = await fixture()
    expect(getAppPool()).not.toBe(pool)
    expect(pool.options.max).toBe(1);expect(getAppPool().options.max).toBe(1)
    expect((await getAppPool().query("SELECT r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE') AS bypass FROM pg_roles r JOIN pg_class c ON c.oid='tasks'::regclass WHERE r.rolname=current_user")).rows).toEqual([{bypass:false}])
    const judge = vi.fn(async (task: { title: string }) => {
      expect(task.title).toBe('Canonical title')
      // Proves no checkout is held during the producer.
      await pool.query('SELECT 1');await getAppPool().query('SELECT 1')
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
  it('original source Task callback persists a field-selected Goal and restores actual nonowner driver authority',async()=>{
    const f=await fixture(),sessionId=randomUUID()
    await pool.query(`INSERT INTO sessions(id,workspace_id,assistant_id,user_id,channel_type,channel_id,status,visibility,context_locked_at,context_group_id,context_compartments,effective_clearance)
      VALUES($1::uuid,$2,$3,$4,'web',$1::text,'idle','personal',clock_timestamp(),$5,$6,'internal')`,[sessionId,f.workspaceId,f.assistantId,f.userId,f.teamId,[f.compartment]])
    const assistant=(await findAssistantById(f.assistantId))!,session={...(await findSessionAuthorityById(sessionId))!,...(await pool.query("SELECT visibility,mode,effective_clearance AS \"effectiveClearance\",context_compartments AS \"contextCompartments\" FROM sessions WHERE id=$1",[sessionId])).rows[0]}
    const ceiling=await resolveLiveAccessCeilingSystem({userId:f.userId,workspaceId:f.workspaceId,assistant,session,memberMode:'member'})
    const lease=createSessionAuthorityLease({starting:ceiling,session,executingAssistantId:f.assistantId,userId:f.userId,memberMode:'member',durableSessionSource:true})
    const execution=createExecutionContext({identity:{kind:'attended',principal:{kind:'workspace_member',userId:f.userId,authenticationKind:'native_session'}},ownership:{kind:'workspace',workspaceId:f.workspaceId},
      access:{...ceiling,assistantId:f.assistantId,assistantKind:assistant.kind},authority:lease,writeDefaults:{compartments:[f.compartment],projectIds:[]},
      lifecycle:{sessionId,channelType:'web',channelId:sessionId,abortSignal:new AbortController().signal,sessionPersisted:true}})
    const authority={execution,accumulator:new ContextScopeAccumulator()}
    const captured=await readRetainedContextFrame(authority,[],client=>readLegacyCanonicalCrmPoint(execution.security.access,'task',f.task.id,['title','attributes'],client))
    expect(captured).not.toBeNull();authority.accumulator.note({sources:captured!.sources})
    let completion:ReturnType<typeof triageTaskForGoal>|undefined
    const judge=vi.fn(async(input:{title:string})=>{expect(input.title).toBe('Protected retained task');return brief})
    const notifications=vi.spyOn(goalNotifications,'notifyWorkspaceChange')
    const tasks=createDbTaskStore({onTaskCreate:(task,actor,_assignment,original)=>{
      completion=triageTaskForGoal(task,actor,{goalStore:createDbGoalStore(),resolveAssistantId:async()=>f.assistantId,publicCoreCapabilities:['Public task capability'],summariseCapabilities:async()=>[],judge},original)
    }})
    const task=await runWithAgentAccess(execution.security.access,()=>tasks.create({userId:f.userId,workspaceId:f.workspaceId,title:'Protected retained task',executorAssistantId:f.assistantId,createdByAssistantId:f.assistantId,sourceSessionId:sessionId,compartments:[f.compartment],authority}))
    expect(task.sourceContinuation?.goalDraft).toBe('requested')
    const goal=await completion
    expect(goal).toMatchObject({host:{type:'task',id:task.id},createdByUserId:f.userId,confirmedAt:null})
    expect(judge).toHaveBeenCalledOnce()
    expect(notifications.mock.calls.filter(([,primitive,action])=>primitive==='goal'&&action==='create')).toEqual([])
    const legacyGoal=randomUUID()
    await pool.query(`INSERT INTO goals(id,workspace_id,host_type,host_id,outcome,done_when,created_by_user_id)
      VALUES($1,$2,'task',$3,'Unadmitted derived outcome','{"kind":"subtasks"}'::jsonb,$4)`,[legacyGoal,f.workspaceId,task.id,f.userId])
    expect(await getGoalById(f.userId,legacyGoal)).toBeNull()
    expect(await getGoalByIdSystem(legacyGoal)).toBeNull()
    expect(await getGoalForExecutionSystem(legacyGoal)).toBeNull()
    expect(await getGoalById(f.userId,goal!.id)).toBeNull()
    expect(await getGoalByIdSystem(goal!.id)).toBeNull()
    expect(await listGoals(f.userId,f.workspaceId)).toEqual([])
    expect(await listGoalsByHostSystem({type:'task',id:task.id})).toEqual([])
    expect(await getRetainedGoalById(f.userId,goal!.id,authority)).toMatchObject({outcome:brief.outcome})
    const auth=await authSessionStore.create(f.userId,{deviceLabel:'Fictional Goal review device',userAgent:'Fixture',ipAddress:'127.0.0.1'})
    expect(auth).not.toBeNull()
    const secret='fictional-goal-review-secret',token=createTokens(f.userId,secret,auth!).accessToken
    const app=express();app.use(express.json());app.use('/api/goals',requireAuth(secret),goalsRoutes({goalStore:createDbGoalStore(),workspaceStore:createWorkspaceStore()}))
    app.use((error:Error,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{res.status(409).json({error:error.message})})
    const discovery=await request(app).get('/api/goals').query({workspaceId:f.workspaceId,hostType:'task',hostId:task.id,includeTerminal:'true'}).auth(token,{type:'bearer'})
    expect(discovery.status,JSON.stringify(discovery.body)).toBe(200)
    expect(discovery.body.goals.map((row:{id:string})=>row.id)).toEqual([goal!.id])
    const detail=await request(app).get(`/api/goals/${goal!.id}`).auth(token,{type:'bearer'})
    expect(detail.status,JSON.stringify(detail.body)).toBe(200);expect(detail.body.goal.outcome).toBe(brief.outcome)
    const revokedAuth=await authSessionStore.create(f.userId,{deviceLabel:'Fictional revoked review device',userAgent:'Fixture',ipAddress:'127.0.0.1'})
    expect(revokedAuth).not.toBeNull()
    const revokedToken=createTokens(f.userId,secret,revokedAuth!).accessToken
    const revokedApp=express();revokedApp.use(express.json());revokedApp.use('/api/goals',requireAuth(secret),goalsRoutes({goalStore:createDbGoalStore(),workspaceStore:createWorkspaceStore(),assessClarity:async()=>{
      await authSessionStore.revokeForUser(f.userId,revokedAuth!.id);return{clear:true}
    }}))
    const refused=await request(revokedApp).post(`/api/goals/${goal!.id}/confirm`).auth(revokedToken,{type:'bearer'}).send({})
    expect(refused.status).toBe(409)
    expect((await pool.query('SELECT confirmed_at FROM goals WHERE id=$1',[goal!.id])).rows[0].confirmed_at).toBeNull()
    const otherAuth=await authSessionStore.create(f.owner,{deviceLabel:'Fictional other reviewer',userAgent:'Fixture',ipAddress:'127.0.0.1'})
    expect(otherAuth).not.toBeNull()
    const otherToken=createTokens(f.owner,secret,otherAuth!).accessToken
    const other=await request(app).get('/api/goals').query({workspaceId:f.workspaceId,hostType:'task',hostId:task.id,includeTerminal:'true'}).auth(otherToken,{type:'bearer'})
    expect(other.status).toBe(200);expect(other.body.goals).toEqual([])
    const confirmed=await request(app).post(`/api/goals/${goal!.id}/confirm`).auth(token,{type:'bearer'}).send({outcome:'Finish canonical reviewed task'})
    expect(confirmed.status,JSON.stringify(confirmed.body)).toBe(200)
    expect(confirmed.body.goal.confirmedAt).toBeTruthy()
    expect(confirmed.body.goal.hasWorkflow).toBe(false)
    expect((await pool.query('SELECT authoring_authority,means FROM goals WHERE id=$1',[goal!.id])).rows[0]).toEqual({authoring_authority:goal!.authoringAuthority,means:{}})
    const restored=await getGoalForExecutionSystem(goal!.id)
    expect(restored).toMatchObject({outcome:'Finish canonical reviewed task'})
    expect(await tryClaimGoalForTick(goal!.id)).toBe(false)
    expect(await claimGoalRollupTerminalSystem(restored!)).toBe(false)
    expect((await pool.query('SELECT status FROM goals WHERE id=$1',[goal!.id])).rows[0].status).toBe('active')

    const driver=await resolveGoalAuthoritySystem(JSON.parse(JSON.stringify(restored)))
    let effects=0
    await driver.executeWithAuthority(async()=>{await assertCurrentAuthority();effects++;await assertCurrentAuthority()})
    expect(effects).toBe(1)
    await expect(driver.executeWithAuthority(async()=>{
      await assertCurrentAuthority()
      await pool.query('DELETE FROM workspace_group_members WHERE group_id=$1 AND user_id=$2',[f.teamId,f.userId])
      await assertCurrentAuthority();effects++
    })).rejects.toMatchObject({reason:'authority_changed'})
    expect(effects).toBe(1)
    await expect(getRetainedGoalById(f.userId,goal!.id,authority)).rejects.toThrow()
    const revoked=await request(app).get(`/api/goals/${goal!.id}`).auth(token,{type:'bearer'})
    expect(revoked.status).toBe(409);expect(JSON.stringify(revoked.body)).not.toContain('Finish canonical reviewed task')

    await abandonGoalsForHostTaskSystem(task.id,'host_task_closed',{draftsOnly:true})
    expect(notifications.mock.calls.filter(([,primitive])=>primitive==='goal')).toEqual([])
    notifications.mockRestore()
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
    let committed=false
    const attempt=f.run(() => produceTaskGoalDraft(f.input, async () => {
      const sql = { private: 'user_id=$2', sensitivity: "sensitivity='confidential'", version: 'valid_to=now()', held: 'scope_held=true' }[kind]!
      if(kind==='held'){
        const preview=await executeWorkspaceScopeReview(f.workspaceId,f.owner,{type:'scope.review.preview',resourceKind:'task',resourceIds:[f.task.id],action:'hold',targetTeamId:null,reason:'Explicit fictional source hold'})
        const applied=await executeWorkspaceScopeReview(f.workspaceId,f.owner,{type:'scope.review.apply',reviewId:preview.id,expectedVersion:preview.version,payloadHash:preview.payloadHash})
        expect(applied.status).toBe('complete')
        expect(applied.items).toEqual([expect.objectContaining({resourceId:f.task.id,status:'applied'})])
      }else await mutateSource(f,`UPDATE tasks SET ${sql} WHERE id=$1`,kind==='private'?[f.task.id,f.owner]:[f.task.id])
      committed=true
      return brief
    })).then(value=>({status:'fulfilled' as const,value}),error=>({status:'rejected' as const,error}))
    const result=await attempt
    const mutationError=result.status==='rejected'?{code:result.error?.code,routine:result.error?.routine,message:result.error?.message}:null
    expect(committed,`The intended source mutation must commit before Goal rejection: ${JSON.stringify(mutationError)}`).toBe(true)
    const current=(await pool.query('SELECT user_id,sensitivity,valid_to,scope_held FROM tasks WHERE id=$1',[f.task.id])).rows[0]
    if(kind==='private')expect(current.user_id).toBe(f.owner)
    if(kind==='sensitivity')expect(current.sensitivity).toBe('confidential')
    if(kind==='version')expect(current.valid_to).not.toBeNull()
    if(kind==='held')expect(current.scope_held).toBe(true)
    expect(result).toMatchObject({status:'rejected',error:expect.objectContaining({code:'goal_source_unsupported'})})
    expect((await pool.query('SELECT count(*)::int n FROM goals WHERE workspace_id=$1',[f.workspaceId])).rows[0].n).toBe(0)
  })
  it('distinguishes denied owner-profile Task setup from an actual source contraction',async()=>{
    const f=await fixture()
    for(const sql of ['user_id=$2',"sensitivity='confidential'"]){
      const ownerConnection=await pool.connect()
      try{
        await ownerConnection.query('BEGIN');await bindSourceOwner(ownerConnection,f)
        await expect(ownerConnection.query(`UPDATE tasks SET ${sql} WHERE id=$1`,sql==='user_id=$2'?[f.task.id,f.owner]:[f.task.id]))
          .rejects.toMatchObject({code:'42501',message:'access_unavailable: canonical task field unavailable'})
      }finally{await ownerConnection.query('ROLLBACK');ownerConnection.release()}
    }
    expect((await pool.query('SELECT user_id,sensitivity FROM tasks WHERE id=$1',[f.task.id])).rows).toEqual([{user_id:null,sensitivity:'internal'}])
    expect(await f.insert(await f.capture())).toMatchObject({host:{type:'task',id:f.task.id}})
  })
  it('workspace barrier observes a winning source update; no stale source capture', async () => {
    const f = await fixture(), token = await f.capture()
    const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL_APP })
    await blocker.connect()
    try {
      await blocker.query('BEGIN');await bindSourceOwner(blocker,f)
      await blocker.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[f.workspaceId])
      const pending=f.insert(token).then(value=>({status:'fulfilled' as const,value}),error=>({status:'rejected' as const,error}))
      await blocker.query("UPDATE tasks SET title='Racing replacement' WHERE id=$1",[f.task.id])
      await blocker.query('COMMIT')
      expect(await pending).toMatchObject({status:'rejected',error:expect.objectContaining({code:'goal_source_unsupported'})})
      expect((await pool.query('SELECT title FROM tasks WHERE id=$1',[f.task.id])).rows[0].title).toBe('Racing replacement')
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
    const f = await fixture('project'), project = f.projectId!
    expect((await pool.query('SELECT project_ids FROM tasks WHERE id=$1',[f.task.id])).rows[0].project_ids).toEqual([project])
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
    const f=await fixture(kind==='multi-project'?undefined:kind as InitialPartition), judge=vi.fn(async()=>brief)
    if(kind==='multi-project') {
      const ids=[randomUUID(),randomUUID()]
      for(const id of ids) await pool.query('INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,$1::uuid::text,$1::uuid::text,$3)',[id,f.workspaceId,f.owner])
      const before=(await pool.query('SELECT count(*)::int n FROM tasks WHERE workspace_id=$1',[f.workspaceId])).rows[0].n
      await expect(createTask(f.owner,{workspaceId:f.workspaceId,title:'Fictional invalid multi-project task',projectIds:ids,compartments:[f.compartment]})).rejects.toThrow('context_not_available: project')
      expect((await pool.query('SELECT count(*)::int n FROM tasks WHERE workspace_id=$1',[f.workspaceId])).rows[0].n).toBe(before)
      expect(judge).not.toHaveBeenCalled()
      return
    }

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


describe('[COMP:api/task-responsibility] boot task-triage adapter: canonical mode selection and actual task callback', () => {
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
  it('legacy retains the original judge/store path for the selected executor and no saved proof', async () => {
    const f = await fixture(), d = deps(f)
    await pool.query("UPDATE workspace_access_policies SET setup_state='legacy' WHERE workspace_id=$1", [f.workspaceId])
    const legacyCreate = vi.spyOn(d.goalStore, 'create')
    const goal = await triageTaskForGoal({ ...f.task, title: 'Original legacy callback' }, f.userId, d)
    expect(d.resolveAssistantId).toHaveBeenCalledWith(f.userId, f.workspaceId, f.assistantId)
    expect(d.judge).toHaveBeenCalledWith(expect.objectContaining({ title: 'Original legacy callback', assistantId: f.assistantId, userId: f.userId }))
    expect(legacyCreate).toHaveBeenCalledOnce()
    expect(goal).toMatchObject({ createdByUserId: f.userId, authoringAuthority: null, confirmedAt: null })
    expect((await pool.query('SELECT count(*)::int n FROM goal_task_source_authority WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
  })
  it.each(['ready', 'legacy'] as const)('%s drafts nothing for human-executed or unassigned work', async setupState => {
    const f = await fixture(), d = deps(f)
    await pool.query('UPDATE workspace_access_policies SET setup_state=$2 WHERE workspace_id=$1', [f.workspaceId, setupState])
    expect(await f.run(() => triageTaskForGoal({ ...f.task, executorAssistantId: null }, f.userId, d))).toBeNull()
    expect(d.resolveAssistantId).not.toHaveBeenCalled()
    expect(d.judge).not.toHaveBeenCalled()
    expect((await pool.query('SELECT count(*)::int n FROM goals WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
  })
  it('legacy drafts nothing when the selected executor is not usable, and never substitutes another assistant', async () => {
    const f = await fixture(), d = deps(f)
    await pool.query("UPDATE workspace_access_policies SET setup_state='legacy' WHERE workspace_id=$1", [f.workspaceId])
    d.resolveAssistantId = vi.fn(async () => undefined)
    expect(await triageTaskForGoal(f.task, f.userId, d)).toBeNull()
    expect(d.judge).not.toHaveBeenCalled()
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
    const input = { workspaceId: f.workspaceId, userId: f.userId, title: 'Actual task writer', compartments: [f.compartment], executorAssistantId: f.assistantId }
    const task = await f.run(() => tasks.create(input))
    const goal = await completion
    expect(goal).toMatchObject({ host: { type: 'task', id: task.id }, createdByUserId: f.userId })
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), f.userId, undefined)
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

async function retainedWaitFixture(profile:'wait'|'branch-wait'|'branch'='wait'){
 const f=await fixture(),sessionId=randomUUID(),credential=(await authSessionStore.create(f.userId,{deviceLabel:'Fictional retained workflow',userAgent:'Fixture',ipAddress:'127.0.0.1'}))!
 await pool.query(`INSERT INTO sessions(id,workspace_id,assistant_id,user_id,channel_type,channel_id,status,visibility,context_locked_at,context_group_id,context_compartments,effective_clearance)
  VALUES($1::uuid,$2,$3,$4,'web',$1::text,'idle','personal',clock_timestamp(),$5,$6,'internal')`,[sessionId,f.workspaceId,f.assistantId,f.userId,f.teamId,[f.compartment]])
 const assistant=(await findAssistantById(f.assistantId))!,session={...(await findSessionAuthorityById(sessionId))!,...(await pool.query('SELECT visibility,mode,effective_clearance AS "effectiveClearance",context_compartments AS "contextCompartments" FROM sessions WHERE id=$1',[sessionId])).rows[0]}
 const ceiling=await resolveLiveAccessCeilingSystem({userId:f.userId,workspaceId:f.workspaceId,assistant,session,memberMode:'member'})
 const lease=createSessionAuthorityLease({starting:ceiling,session,executingAssistantId:f.assistantId,userId:f.userId,memberMode:'member',durableSessionSource:true,nativeSessionCredential:{userId:f.userId,sessionId:credential.id,authVersion:credential.authVersion}})
 const execution=createExecutionContext({identity:{kind:'attended',principal:{kind:'workspace_member',userId:f.userId,authenticationKind:'native_session'}},ownership:{kind:'workspace',workspaceId:f.workspaceId},access:{...ceiling,assistantId:f.assistantId,assistantKind:assistant.kind},authority:lease,writeDefaults:{compartments:[f.compartment],projectIds:[]},lifecycle:{sessionId,channelType:'web',channelId:sessionId,abortSignal:new AbortController().signal,sessionPersisted:true}})
 const authority={execution,accumulator:new ContextScopeAccumulator()},goal=(await runWithAgentAccess(execution.security.access,()=>produceTaskGoalDraft({...f.input,authority},async()=>brief)))!
 await confirmRetainedGoal(f.userId,(await getRetainedGoalById(f.userId,goal.id,authority))!,{},authority)
 const definition:WorkflowDefinition={startStepId:'wait',steps:[{id:'wait',type:'wait' as const,at:{datetime:'2026-01-01T00:00:00',timezone:'UTC'},nextStepId:'finish'},{id:'finish',type:'branch' as const,condition:{'==':[1,1]},nextStepIdIfTrue:null,nextStepIdIfFalse:null}]}
 if(profile!=='wait'){
  const branch={id:'begin',type:'branch' as const,condition:{'==':[1,1]},nextStepIdIfTrue:profile==='branch'?null:'wait',nextStepIdIfFalse:null}
  definition.startStepId='begin'
  definition.steps=profile==='branch'?[branch]:[branch,...definition.steps]
 }
 const workflows=createDbWorkflowStore(),runs=createDbWorkflowRunStore(),jobs=createDbJobStore()
 const workflow=await runWithAgentAccess(execution.security.access,()=>workflows.create({workspaceId:f.workspaceId,userId:f.userId,name:'Fictional deterministic retained workflow',definition,authoringAuthority:goal.authoringAuthority!,contextGroupId:f.teamId,contextProjectId:null},{authoring:{kind:'internal-human',userId:f.userId,assistantId:f.assistantId}}))
 const deps:ExecutorDeps={workflowStore:workflows,runStore:runs,resolvePrimary:async()=>f.assistantId,resolveRunScope:resolveWorkflowRunScope,buildToolRegistry:async()=>new Map(),consultTransport:{async send(){throw new Error('Unexpected model call')}},pauseRunForWait:params=>pauseWorkflowRunForWait(params,{jobStore:jobs,runStore:runs,resolvePrimary:async()=>f.assistantId})}
 const dispatch=vi.fn((id:string,claim:Parameters<typeof advanceRetainedGoalWorkflow>[2])=>advanceRetainedGoalWorkflow(id,deps,claim))
 const tools=createGoalWorkTools({createCompletionWorkflow:async()=>{throw new Error('Explicit workflow required')},kickoffGoal:async()=>{throw new Error('Recurring Goal driver remains held')},advanceRetainedWorkflowRun:dispatch})
 const work=()=>tools.workTask.execute({goal_id:goal.id,workflow_id:workflow.id},{...executionToolContext(execution,{appId:'native'}),scopeAccumulator:authority.accumulator})
 return{...f,credential,authority,goal,workflow,definition,runs,jobs,deps,dispatch,work}
}

describe('[COMP:api/task-responsibility] actual retained Goal deterministic workflow handoff',()=>{
 it('recovers real initial and completed-branch checkpoints through the same workTask without replay',async()=>{
  const f=await retainedWaitFixture('branch-wait'),persist=f.runs.updateRun
  const stop=vi.spyOn(f.runs,'updateRun').mockImplementationOnce(async(...args)=>{
   const result=await persist(...args);expect(args[1].status).toBe('running');throw new Error('Fictional process stop after initial running checkpoint')
  })
  expect((await f.work()).isError).toBe(true);stop.mockRestore()
  const runId=(await pool.query('SELECT id FROM workflow_runs WHERE source_goal_id=$1',[f.goal.id])).rows[0].id
  const original=(await pool.query('SELECT input,execution_authority,claim_attempts FROM workflow_runs WHERE id=$1',[runId])).rows[0]
  expect((await f.work()).data).toMatchObject({workflowRunId:runId,status:'running'})
  expect((await pool.query('SELECT count(*)::int AS n FROM workflow_step_runs WHERE run_id=$1',[runId])).rows[0].n).toBe(0)
  await pool.query("UPDATE workflow_runs SET claimed_at=clock_timestamp()-interval '11 minutes' WHERE id=$1",[runId])
  const stale=(await resolveRetainedGoalWorkflowRuntime(runId))!
  // A real arm-to-dispatch delay must retain its own generation. It cannot
  // adopt the next claimant's run after an awaited handoff.
  const advance=f.dispatch.getMockImplementation()!
  let entered!:()=>void,releaseDispatch!:()=>void
  const ready=new Promise<void>(resolve=>{entered=resolve}),delayed=new Promise<void>(resolve=>{releaseDispatch=resolve})
  f.dispatch.mockImplementationOnce(async(...args)=>{entered();await delayed;return advance(...args)})
  const delayedWork=f.work();await ready
  expect((await f.work()).data).toMatchObject({workflowRunId:runId,status:'running'})
  await pool.query("UPDATE workflow_runs SET claimed_at=clock_timestamp()-interval '11 minutes' WHERE id=$1",[runId])
  const stopSettlement=vi.spyOn(f.runs,'updateRun').mockImplementation(async(...args)=>{
   if(JSON.stringify(args[1].vars?.__frontier)==='["wait"]')throw new Error('Fictional process stop after completed branch before frontier settlement')
   return persist(...args)
  })
  try{expect((await f.work()).isError).toBe(true)}finally{releaseDispatch()}
  expect((await delayedWork).isError).toBe(true);stopSettlement.mockRestore()
  expect((await pool.query("SELECT vars->'__frontier' AS frontier FROM workflow_runs WHERE id=$1",[runId])).rows[0].frontier).toEqual(['begin'])
  expect((await pool.query('SELECT step_id,status FROM workflow_step_runs WHERE run_id=$1',[runId])).rows).toEqual([{step_id:'begin',status:'completed'}])
  await expect(stale.executeWithAuthority(async()=> 'stale pre-recovery attempt')).rejects.toThrow()
  await pool.query("UPDATE workflow_runs SET claimed_at=clock_timestamp()-interval '11 minutes' WHERE id=$1",[runId])
  const previous=(await resolveRetainedGoalWorkflowRuntime(runId))!
  for(const malformed of [[4],['unknown-step'],['begin','begin'],[]]){
   await pool.query("UPDATE workflow_runs SET vars=jsonb_set(vars,'{__frontier}',$2::jsonb) WHERE id=$1",[runId,JSON.stringify(malformed)])
   const before=(await pool.query('SELECT claim_attempts,claimed_at FROM workflow_runs WHERE id=$1',[runId])).rows[0]
   await expect(f.work()).rejects.toThrow()
   expect((await pool.query('SELECT claim_attempts,claimed_at FROM workflow_runs WHERE id=$1',[runId])).rows[0]).toEqual(before)
  }
  await pool.query("UPDATE workflow_runs SET vars=jsonb_set(vars,'{__frontier}','[\"begin\"]'::jsonb) WHERE id=$1",[runId])
  let resumeOld!:()=>void,startedOld!:()=>void
  const parkedOld=new Promise<void>(resolve=>{resumeOld=resolve}),oldStarted=new Promise<void>(resolve=>{startedOld=resolve})
  const oldWrite=previous.executeWithAuthority(async()=>{startedOld();await parkedOld;return f.runs.updateRun(runId,{currentStepId:'begin'})})
  await oldStarted
  let recovered:Awaited<ReturnType<typeof f.work>>
  try{recovered=await f.work()}finally{resumeOld()}
  await expect(oldWrite).rejects.toThrow()
  expect(recovered!.isError).toBeFalsy();expect(recovered!.data).toMatchObject({workflowRunId:runId,status:'paused'})
  const jobs=(await f.jobs.getDueJobs()).filter(job=>job.channelId===runId);expect(jobs).toHaveLength(1)
  await pool.query("UPDATE workflow_runs SET claimed_at=clock_timestamp()-interval '11 minutes' WHERE id=$1",[runId])
  expect((await f.work()).data).toMatchObject({workflowRunId:runId,status:'awaiting_wait'})
  // Scheduler discovery leases this ordinary once-job on its first read.
  expect((await f.jobs.getDueJobs()).filter(job=>job.channelId===runId)).toHaveLength(0)
  expect((await pool.query('SELECT count(*)::int AS n FROM scheduled_jobs WHERE channel_id=$1',[runId])).rows[0].n).toBe(1)
  expect(await resumeWorkflowWaitJob(jobs[0],{jobStore:f.jobs,runStore:f.runs,workflowStore:createDbWorkflowStore(),executorDeps:f.deps})).toBe('workflow wait wake-up: completed')
  expect((await pool.query('SELECT step_id,status FROM workflow_step_runs WHERE run_id=$1 ORDER BY started_at',[runId])).rows).toEqual([{step_id:'begin',status:'completed'},{step_id:'wait',status:'completed'},{step_id:'finish',status:'completed'}])
  const after=(await pool.query('SELECT input,execution_authority,claim_attempts FROM workflow_runs WHERE id=$1',[runId])).rows[0]
  expect(after.input).toEqual(original.input);expect(after.execution_authority).toEqual(original.execution_authority)
  expect(after.claim_attempts).toBe(original.claim_attempts+4)
  expect((await pool.query('SELECT count(*)::int AS n FROM workflow_runs WHERE source_goal_id=$1',[f.goal.id])).rows[0].n).toBe(1)
  expect((await pool.query('SELECT status FROM goals WHERE id=$1',[f.goal.id])).rows[0].status).toBe('active')
  expect((await pool.query('SELECT status FROM tasks WHERE id=$1',[f.task.id])).rows[0].status).toBe('todo')
 })
 it('recovers a terminal empty checkpoint without replaying the completed final branch',async()=>{
  // After the final branch's frontier save, an empty checkpoint must finish
  // the same run instead of falling back to its completed currentStepId.
  const terminal=await retainedWaitFixture('branch'),saveTerminal=terminal.runs.updateRun
  const stopTerminal=vi.spyOn(terminal.runs,'updateRun').mockImplementation(async(...args)=>{
   if(args[1].status==='completed')throw new Error('Fictional process stop before terminal run update')
   return saveTerminal(...args)
  })
  expect((await terminal.work()).isError).toBe(true);stopTerminal.mockRestore()
  const terminalId=(await pool.query('SELECT id FROM workflow_runs WHERE source_goal_id=$1',[terminal.goal.id])).rows[0].id
  expect((await pool.query("SELECT vars ? '__frontier' AS frontier FROM workflow_runs WHERE id=$1",[terminalId])).rows[0].frontier).toBe(false)
  await pool.query("UPDATE workflow_runs SET claimed_at=clock_timestamp()-interval '11 minutes' WHERE id=$1",[terminalId])
  expect((await terminal.work()).data).toMatchObject({workflowRunId:terminalId,status:'completed'})
  expect((await pool.query('SELECT step_id,status FROM workflow_step_runs WHERE run_id=$1',[terminalId])).rows).toEqual([{step_id:'begin',status:'completed'}])
 })
 it.each(['source','credential'] as const)('holds expired initial running recovery after awaited %s contraction',async kind=>{
  const f=await retainedWaitFixture('branch-wait'),persist=f.runs.updateRun
  const stop=vi.spyOn(f.runs,'updateRun').mockImplementationOnce(async(...args)=>{await persist(...args);throw new Error('Fictional stop after initial running')})
  expect((await f.work()).isError).toBe(true);stop.mockRestore()
  const runId=(await pool.query('SELECT id FROM workflow_runs WHERE source_goal_id=$1',[f.goal.id])).rows[0].id
  const runtime=(await resolveRetainedGoalWorkflowRuntime(runId))!
  await expect(runtime.executeWithAuthority(async()=>{
   await Promise.resolve()
   if(kind==='credential')await authSessionStore.revokeForUser(f.userId,f.credential.id)
   else await mutateSource(f,"UPDATE tasks SET title='Fictional contracted recovery source' WHERE id=$1",[f.task.id])
   await f.runs.updateRun(runId,{currentStepId:'wait'})
   return 'withheld source result'
  })).rejects.toThrow()
  await pool.query("UPDATE workflow_runs SET claimed_at=clock_timestamp()-interval '11 minutes' WHERE id=$1",[runId])
  const before=(await pool.query('SELECT to_jsonb(r) AS row FROM workflow_runs r WHERE id=$1',[runId])).rows
  if(kind==='source')expect(await f.work()).toMatchObject({isError:true})
  else await expect(f.work()).rejects.toThrow()
  expect((await pool.query('SELECT to_jsonb(r) AS row FROM workflow_runs r WHERE id=$1',[runId])).rows).toEqual(before)
  expect((await pool.query('SELECT count(*)::int AS n FROM workflow_step_runs WHERE run_id=$1',[runId])).rows[0].n).toBe(0)
  expect((await pool.query("SELECT count(*)::int AS n FROM scheduled_jobs WHERE channel_id=$1",[runId])).rows[0].n).toBe(0)
 })

 it('starts through workTask, persists a due wait job and resumes only the saved successor frontier',async()=>{
  const f=await retainedWaitFixture(),attempts=await Promise.allSettled([f.work(),f.work()])
  const result=attempts.flatMap(value=>value.status==='fulfilled'?[value.value]:[]).find(value=>(value.data as {status:string}).status==='paused')
  if(!result)throw attempts.find(value=>value.status==='rejected')?.reason??new Error('No actual workflow dispatch')
  const data=result.data as {workflowRunId:string;status:string}
  expect((await pool.query('SELECT count(*)::int AS n FROM workflow_runs WHERE source_goal_id=$1',[f.goal.id])).rows[0].n).toBe(1)
  expect(result.isError).toBeFalsy();expect(data.status).toBe('paused')
  const run=await f.runs.getRunSystem(data.workflowRunId);expect(run?.status).toBe('awaiting_wait')
  const jobs=(await f.jobs.getDueJobs()).filter(job=>job.channelId===run!.id);expect(jobs).toHaveLength(1)
  expect(await f.jobs.get(jobs[0].id)).toBeNull();expect(await f.jobs.list(f.assistantId,f.userId)).toEqual([])
  expect(await f.runs.getRunById(f.userId,run!.id)).toBeNull();expect(await f.runs.listStepRuns(f.userId,run!.id)).toEqual([])
  expect((await f.work()).data).toMatchObject({workflowRunId:run!.id,status:'awaiting_wait'})
  const stale=(await resolveRetainedGoalWorkflowRuntime(run!.id))!;expect(stale.authority.execution.identity).toEqual({kind:'system',purpose:'workflow',jobId:run!.id})
  const actual=stale.authority.execution,unbranded=createExecutionContext({identity:actual.identity,ownership:actual.ownership,access:actual.security.access,authority:actual.security.authority,provenance:actual.security.provenance,writeDefaults:actual.security.writeDefaults,lifecycle:actual.lifecycle})
  let forgedWrite=false
  await expect(writeRetainedGoalWorkflowContextFrame({execution:unbranded,accumulator:new ContextScopeAccumulator(stale.evidence)},stale.evidence.sources??[],async()=>{forgedWrite=true})).rejects.toThrow()
  expect(forgedWrite).toBe(false)
  await expect(stale.executeWithAuthority(async()=>{await pool.query('UPDATE workflows SET definition=$2 WHERE id=$1',[f.workflow.id,JSON.stringify({...f.definition,steps:[...f.definition.steps].reverse()})]);return 'withheld'})).rejects.toThrow()
  await pool.query('UPDATE workflows SET definition=$2 WHERE id=$1',[f.workflow.id,JSON.stringify(f.definition)])
  await expect(stale.executeWithAuthority(async()=> 'still stale')).rejects.toThrow()
  await pool.query('UPDATE scheduled_jobs SET enabled=false WHERE id=$1',[jobs[0].id])
  expect(await resumeWorkflowWaitJob(jobs[0],{jobStore:f.jobs,runStore:f.runs,workflowStore:createDbWorkflowStore(),executorDeps:f.deps})).toBe('workflow wait wake-up: disabled')
  expect((await pool.query("SELECT status FROM workflow_step_runs WHERE run_id=$1",[run!.id])).rows[0].status).toBe('running')
  await pool.query('UPDATE scheduled_jobs SET enabled=true WHERE id=$1',[jobs[0].id])
  // Simulate the real crash window after the canonical consume commits: stop
  // before the actual executor's first load, leaving its saved frontier intact.
  const load=f.runs.getRunSystem,crash=vi.spyOn(f.runs,'getRunSystem').mockImplementationOnce(async()=>{throw new Error('Fictional process stop after wait consume')})
  await expect(resumeWorkflowWaitJob(jobs[0],{jobStore:f.jobs,runStore:f.runs,workflowStore:createDbWorkflowStore(),executorDeps:f.deps})).rejects.toThrow('Fictional process stop')
  crash.mockRestore();f.runs.getRunSystem=load
  expect((await pool.query("SELECT vars->'__frontier' AS frontier FROM workflow_runs WHERE id=$1",[run!.id])).rows[0].frontier).toEqual(['finish'])
  const replaced=(await resolveRetainedGoalWorkflowRuntime(run!.id))!
  expect(await resumeWorkflowWaitJob(jobs[0],{jobStore:f.jobs,runStore:f.runs,workflowStore:createDbWorkflowStore(),executorDeps:f.deps})).toBe('workflow wait wake-up: claimed')
  // Existing scheduler lease expiry permits one recovery generation; its new
  // native frame fences the older still-live advance lease.
  await pool.query("UPDATE workflow_runs SET claimed_at=clock_timestamp()-interval '11 minutes' WHERE id=$1",[run!.id])
  for(const malformed of [[4],['unknown-step']]){
   await pool.query("UPDATE workflow_runs SET vars=jsonb_set(vars,'{__frontier}',$2::jsonb) WHERE id=$1",[run!.id,JSON.stringify(malformed)])
   await expect(resumeWorkflowWaitJob(jobs[0],{jobStore:f.jobs,runStore:f.runs,workflowStore:createDbWorkflowStore(),executorDeps:f.deps})).rejects.toThrow()
  }
  await pool.query("UPDATE workflow_runs SET vars=jsonb_set(vars,'{__frontier}',$2::jsonb) WHERE id=$1",[run!.id,JSON.stringify(['finish'])])
  const outcomes=await Promise.all([resumeWorkflowWaitJob(jobs[0],{jobStore:f.jobs,runStore:f.runs,workflowStore:createDbWorkflowStore(),executorDeps:f.deps}),resumeWorkflowWaitJob(jobs[0],{jobStore:f.jobs,runStore:f.runs,workflowStore:createDbWorkflowStore(),executorDeps:f.deps})])
  expect(outcomes).toContain('workflow wait wake-up: completed');expect(outcomes.some(value=>value==='workflow wait wake-up: claimed'||value==='workflow wait wake-up: disabled'||value==='workflow wait wake-up: terminal')).toBe(true)
  await expect(replaced.executeWithAuthority(async()=> 'stale prior generation')).rejects.toThrow()
  expect((await f.runs.getRunSystem(run!.id))?.status).toBe('completed')
  expect((await pool.query('SELECT step_id,status FROM workflow_step_runs WHERE run_id=$1 ORDER BY started_at',[run!.id])).rows).toEqual([{step_id:'wait',status:'completed'},{step_id:'finish',status:'completed'}])
  expect((await pool.query('SELECT enabled FROM scheduled_jobs WHERE id=$1',[jobs[0].id])).rows[0].enabled).toBe(false)
  await pool.query("UPDATE workflow_runs SET status='failed',error='{"+ '"reason":"workflow_cancelled"' +"}'::jsonb WHERE id=$1",[run!.id])
  await expect(f.runs.getRunSystem(run!.id)).rejects.toThrow()
  await pool.query('DELETE FROM goals WHERE id=$1',[f.goal.id])
  await expect(f.runs.getRunSystem(run!.id)).rejects.toThrow()
 })
 it.each(['source','credential'] as const)('withholds after awaited %s contraction before durable wait wake-up',async kind=>{
  const f=await retainedWaitFixture(),result=await f.work(),runId=(result.data as {workflowRunId:string}).workflowRunId
  const job=(await f.jobs.getDueJobs()).find(job=>job.channelId===runId)!,runtime=(await resolveRetainedGoalWorkflowRuntime(runId))!
  const before=(await pool.query('SELECT to_jsonb(step) AS row FROM workflow_step_runs step WHERE run_id=$1',[runId])).rows
  await expect(runtime.executeWithAuthority(async()=>{if(kind==='credential')await authSessionStore.revokeForUser(f.userId,f.credential.id);else await mutateSource(f,"UPDATE tasks SET title='Fictional changed source' WHERE id=$1",[f.task.id]);return 'protected result'})).rejects.toThrow()
  if(kind==='source')expect((await pool.query('SELECT title FROM tasks WHERE id=$1',[f.task.id])).rows[0].title).toBe('Fictional changed source')
  await expect(resumeWorkflowWaitJob(job,{jobStore:f.jobs,runStore:f.runs,workflowStore:createDbWorkflowStore(),executorDeps:f.deps})).rejects.toThrow()
  expect((await pool.query('SELECT to_jsonb(step) AS row FROM workflow_step_runs step WHERE run_id=$1',[runId])).rows).toEqual(before)
  expect((await pool.query('SELECT status FROM workflow_runs WHERE id=$1',[runId])).rows[0].status).toBe('awaiting_wait')
 })
})
