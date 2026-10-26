import express from 'express'
import request from 'supertest'
import {requireAuth} from '../../auth/middleware.js'
import {createTokens} from '../../auth/jwt.js'
import {goalsRoutes} from '../../routes/goals.js'
import {createWorkspaceStore} from '../../db/workspace-store.js'
import {afterAll,describe,expect,it} from 'vitest'
import {createTaskTools,ContextScopeAccumulator,boundScopeSources,type TaskRecord} from '@use-brian/core'
import {getPool,getAppPool} from '../../db/client.js'
import {createTask,getTaskByIdSystem,findTasksByExternalRefSystem} from '../../db/tasks.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {addSessionMessage} from '../../db/sessions.js'
import {sessionMessageInputScope} from '../../context-scope/resolve-turn-scope.js'
import {createGoal,confirmRetainedGoal,getGoalForExecutionSystem,getRetainedGoalById} from '../../db/goals.js'
import {configureConnectorSourceRuntimeFactory} from '../source-runtime.js'
import {createDbGoalStore} from '../../db/goals-store.js'
import {createGoalWorkTools} from '../../goals/work-tools.js'
import {triageTaskForGoal} from '../../db/goal-task-triage.js'
import {captureAuthoringAuthoritySystem} from '../../context-scope/workflow-authority.js'
import {createDbTaskStore} from '../../db/tasks-store.js'
import {bindSessionContextRetainedAuthority} from '../../db/session-context-revisions.js'
import {sourceModeFixture} from './fixtures/source-modes.js'
import {saveOriginalMemory,originalMemoryAuthority} from './fixtures/retained-memory.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/application-persistence] [COMP:tasks/tools] original native Task source ancestry',()=>{
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 it('independent source read flows through actual Task callback into a Goal and Brian confirmation; source withdrawal holds later read',async()=>{
  const x=await sourceModeFixture()
  configureConnectorSourceRuntimeFactory(x.factory,{instances:x.instances})
  try{
   await x.f.pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[x.f.workspaceId,x.f.ownerId])
   await x.f.pool.query("UPDATE workspace_access_policies SET access_mode='departments',setup_state='ready' WHERE workspace_id=$1",[x.f.workspaceId])
   let current=await originalMemoryAuthority(x)
   await addSessionMessage({sessionId:current.session.id,role:'user',content:[{type:'text',text:'Review the permitted source record as a Task.'}],scope:sessionMessageInputScope({scope:current.turnScope,workspaceId:x.f.workspaceId,userId:x.f.ownerId})})
   const read=await current.runtime.read!('readRecord',{id:'record-1',fields:['description']},'governed')
   expect(JSON.stringify(read)).toContain('Fictional released fact')
   expect(current.accumulator.evidence.sources?.some(source=>source.resourceKind==='external_source')).toBe(true)
   const result=read.result as {content:Array<{type:string;text?:string}>},text=result.content.find(block=>block.type==='text')?.text
   const sourceText=JSON.parse(text!).description as string
   expect(sourceText).toBe('Fictional released fact')
   let title='Review '+sourceText
   let drafted:ReturnType<typeof triageTaskForGoal>|undefined,createdTask:TaskRecord|undefined,judges=0
   const tasks=createDbTaskStore({onTaskCreate:(task,actor,_assignment,authority)=>{
    createdTask=task
    drafted=triageTaskForGoal(task,actor,{goalStore:createDbGoalStore(),resolveAssistantId:async()=>x.f.assistantId,publicCoreCapabilities:[],summariseCapabilities:async()=>[],judge:async input=>{
     judges++;expect(input.title).toBe(title);return{outcome:'Finish '+input.title,verification:'Inspect the result',approach:'Use permitted records',judgeReason:'Concrete'}
    }},authority)
   }})
   const saved=await createTaskTools(tasks).saveTask.execute({title,executor_assistant_id:x.f.assistantId},current.context)
   expect(saved.isError,JSON.stringify(saved)).not.toBe(true)
   expect(saved.data).toContain('Goal drafting has been requested')
   const id=String(saved.data).match(/\[([a-f0-9-]{36})\]/)?.[1]
   expect(createdTask?.id).toBe(id)
   expect(createdTask?.sensitivity).toBe('confidential')
   let goal=await drafted;expect(goal).toBeTruthy();expect(judges).toBe(1)
   expect(await getRetainedGoalById(x.f.ownerId,goal!.id,current)).toMatchObject({outcome:'Finish '+title})
   let proof=(await x.f.pool.query('SELECT proof FROM goal_task_source_authority WHERE goal_id=$1',[goal!.id])).rows[0].proof
   expect(proof.retained.sourceAuthority.nativeCredential).toMatchObject({userId:x.f.ownerId,authVersion:expect.any(Number)})
   expect(await authSessionStore.validateAccess(proof.retained.sourceAuthority.nativeCredential)).toBe(true)
   await expect(getAppPool().query('SELECT retained_native_auth_session_current($1,$2)',[x.f.ownerId,proof.retained.sourceAuthority.nativeCredential])).rejects.toMatchObject({code:'42501'})
   expect(proof.retained.sources.some((source:{resourceKind:string})=>source.resourceKind==='external_source')).toBe(true)
   const viewerAuth=await authSessionStore.create(x.f.ownerId,{deviceLabel:'Fictional current Goal reviewer',userAgent:'Fixture',ipAddress:'127.0.0.1'})
   expect(viewerAuth).not.toBeNull()
   const secret='fictional-source-goal-secret',token=createTokens(x.f.ownerId,secret,viewerAuth!).accessToken
   const app=express();app.use(express.json());app.use('/api/goals',requireAuth(secret),goalsRoutes({goalStore:createDbGoalStore(),workspaceStore:createWorkspaceStore(),assessClarity:async()=>{
    await authSessionStore.revokeForUser(x.f.ownerId,proof.retained.sourceAuthority.nativeCredential.sessionId);return{clear:true}
   }}))
   const refused=await request(app).post(`/api/goals/${goal!.id}/confirm`).auth(token,{type:'bearer'}).send({})
   expect(refused.status,JSON.stringify(refused.body)).toBe(409)
   expect(await authSessionStore.validateAccess({userId:x.f.ownerId,sessionId:viewerAuth!.id,authVersion:viewerAuth!.authVersion})).toBe(true)
   expect((await x.f.pool.query('SELECT confirmed_at FROM goals WHERE id=$1',[goal!.id])).rows[0].confirmed_at).toBeNull()
   // A separate genuine request authors new work; revoked original consent is never revived.
   current=await originalMemoryAuthority(x)
   await addSessionMessage({sessionId:current.session.id,role:'user',content:[{type:'text',text:'Review the permitted source record in a new request.'}],scope:sessionMessageInputScope({scope:current.turnScope,workspaceId:x.f.workspaceId,userId:x.f.ownerId})})
   const nextRead=await current.runtime.read!('readRecord',{id:'record-1',fields:['description']},'governed')
   expect(JSON.stringify(nextRead.result)).toContain(sourceText)
   title+=' in a new request'
   const next=await createTaskTools(tasks).saveTask.execute({title,executor_assistant_id:x.f.assistantId},current.context)
   expect(next.isError,JSON.stringify(next)).not.toBe(true)
   goal=await drafted;expect(goal).toBeTruthy();expect(judges).toBe(2)
   proof=(await x.f.pool.query('SELECT proof FROM goal_task_source_authority WHERE goal_id=$1',[goal!.id])).rows[0].proof
   const tools=createGoalWorkTools({createCompletionWorkflow:async()=>{throw new Error('Unexpected dispatch')},kickoffGoal:async()=>{throw new Error('Unexpected dispatch')}})
   const confirmation=await tools.confirmGoal.execute({goal_id:goal!.id},current.context)
   expect(confirmation.isError,JSON.stringify(confirmation)).not.toBe(true)
   expect(confirmation.data).toContain('Confirmed goal')
   const after=await getRetainedGoalById(x.f.ownerId,goal!.id,current)
   expect(after?.confirmedAt).toBeTruthy();expect(after?.means).toEqual({})
   await current.runtime.read!('readRecord',{id:'record-1',fields:['cost']},'governed')
   const unchanged=await getRetainedGoalById(x.f.ownerId,goal!.id,current)
   await expect(confirmRetainedGoal(x.f.ownerId,unchanged!,{outcome:'A refinement using an additional protected field'},current)).rejects.toMatchObject({code:'goal_source_unsupported'})
   expect((await x.f.pool.query('SELECT outcome FROM goals WHERE id=$1',[goal!.id])).rows[0].outcome).toBe('Finish '+title)

   const originalSources=JSON.stringify(proof.retained.sources)
   await x.f.pool.query("UPDATE auth_sessions SET last_seen_at=clock_timestamp()-interval '6 minutes' WHERE id=$1",[proof.retained.sourceAuthority.nativeCredential.sessionId])
   expect(await getGoalForExecutionSystem(goal!.id)).toMatchObject({outcome:'Finish '+title})
   expect((await x.f.pool.query('SELECT last_seen_at<clock_timestamp()-interval \'5 minutes\' AS stale FROM auth_sessions WHERE id=$1',[proof.retained.sourceAuthority.nativeCredential.sessionId])).rows[0].stale).toBe(true)
   await x.sourcePool.query("UPDATE records SET withdrawn=true WHERE id='record-1'")
   const withdrawnReader=await originalMemoryAuthority(x)
   await expect(getRetainedGoalById(x.f.ownerId,goal!.id,withdrawnReader)).rejects.toMatchObject({code:'scope_source_changed'})
   await x.sourcePool.query("UPDATE records SET withdrawn=false WHERE id='record-1'")
   const restoredReader=await originalMemoryAuthority(x)
   expect(await getRetainedGoalById(x.f.ownerId,goal!.id,restoredReader)).toMatchObject({outcome:'Finish '+title})
   await authSessionStore.revokeForUser(x.f.ownerId,proof.retained.sourceAuthority.nativeCredential.sessionId)
   const freshReader=await originalMemoryAuthority(x)
   expect(await getRetainedGoalById(x.f.ownerId,goal!.id,freshReader)).toBeNull()
   await expect(getGoalForExecutionSystem(goal!.id)).rejects.toMatchObject({reason:'authority_changed'})
   expect(JSON.stringify((await x.f.pool.query('SELECT proof FROM goal_task_source_authority WHERE goal_id=$1',[goal!.id])).rows[0].proof.retained.sources)).toBe(originalSources)
  }finally{configureConnectorSourceRuntimeFactory(undefined);await x.cleanup()}
 })
 it('publishes an actual source-backed saveTask and immutable mixed ancestry atomically, reads under the original authority, and withholds after source revocation',async()=>{
  const x=await sourceModeFixture();let creates=0
  const tasks=createDbTaskStore({onTaskCreate(){creates++}}),tools=createTaskTools(tasks)
  try{
   // Genuine original member authority, without admin-only lineage visibility.
   await x.f.pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[x.f.workspaceId,x.f.ownerId])
   const mixed=await saveOriginalMemory(x),{current}=mixed
   const memorySource=(await x.f.pool.query("SELECT read_scope_source($1,'memory',$2) AS source",[x.f.workspaceId,mixed.id])).rows[0].source
   current.accumulator.note({sources:[memorySource]})
   const input={title:'Fictional independently sourced task',description:'Fictional protected task detail',executor_assistant_id:x.f.assistantId,external_ref:{fixture_key:'native-source-proof'}}
   const saved=await tools.saveTask.execute(input,current.context)
   expect(saved.isError,JSON.stringify(saved)).not.toBe(true)
   expect(saved.data).toContain('Goal drafting has been requested. Other workflow triggers are held')
   const id=String(saved.data).match(/\[([a-f0-9-]{36})\]/)?.[1];expect(id).toBeTruthy()
   expect(creates).toBe(1)
   const row=(await x.f.pool.query('SELECT id,user_id,assistant_id,sensitivity,scope_version::text AS version FROM tasks WHERE id=$1',[id])).rows[0]
   expect(row).toMatchObject({user_id:x.f.ownerId,assistant_id:null,sensitivity:'confidential',version:'1'})
   const ancestry=(await x.f.pool.query('SELECT source_kind,source_id,source_version FROM scope_derivation_sources s JOIN scope_derivations d ON d.id=s.derivation_id WHERE d.workspace_id=$1 AND d.resource_kind=\'task\' AND d.resource_id=$2',[x.f.workspaceId,id])).rows
   for(const source of current.accumulator.evidence.sources??[])expect(ancestry).toContainEqual({source_kind:source.resourceKind,source_id:source.resourceId,source_version:source.version})
   expect(ancestry.some(s=>s.source_kind==='external_source')).toBe(true);expect(ancestry.some(s=>s.source_kind==='application_field')).toBe(true);expect(ancestry.some(s=>s.source_kind==='memory'&&s.source_id===mixed.id)).toBe(true)
   expect((await x.f.pool.query('SELECT native_task_derivation_matches($1,$2,$3,$4::jsonb) AS matches',[x.f.workspaceId,id,'1',JSON.stringify(current.accumulator.evidence.sources)])).rows[0].matches).toBe(false)
   const read=await tools.getTask.execute({id:id!},current.context)
   expect(read.isError).not.toBe(true);expect(JSON.stringify(read.data)).toContain(input.title)
   expect(read.scopeEvidence?.sources?.some(s=>s.resourceKind==='task'&&s.resourceId===id)).toBe(true)
   expect(await getTaskByIdSystem(id!)).toBeNull()
   expect(await findTasksByExternalRefSystem(x.f.workspaceId,{fixture_key:'native-source-proof'})).toEqual([])
   let judges=0
   const triage={goalStore:{create:async()=>{throw new Error('Unexpected Goal write')}},resolveAssistantId:async()=>x.f.assistantId,publicCoreCapabilities:[],summariseCapabilities:async()=>[],judge:async()=>{judges++;return null}}
   const protectedTask=await tasks.getById(current.execution.security.access,id!,current)
   expect(protectedTask).not.toBeNull()
   await expect(triageTaskForGoal(protectedTask!,x.f.ownerId,triage)).rejects.toThrow('goal_source_unsupported')
   expect(judges).toBe(0)
   const authoringAuthority=await captureAuthoringAuthoritySystem({userId:x.f.ownerId,workspaceId:x.f.workspaceId,assistantId:x.f.assistantId})
   await expect(createGoal({workspaceId:x.f.workspaceId,createdByUserId:x.f.ownerId,host:{type:'task',id:id!},outcome:'Fictional held continuation',doneWhen:{kind:'subtasks'},authoringAuthority})).rejects.toThrow('goal_source_unsupported')
   expect((await x.f.pool.query('SELECT count(*)::int AS count FROM goals WHERE workspace_id=$1',[x.f.workspaceId])).rows[0].count).toBe(0)
   // A repeated same create keeps canonical deduplication and emits no second event.
   const duplicate=await tools.saveTask.execute(input,current.context)
   expect(String(duplicate.data)).toContain(id);expect(creates).toBe(1)
   expect((await x.f.pool.query('SELECT count(*)::int AS count FROM tasks WHERE workspace_id=$1',[x.f.workspaceId])).rows[0].count).toBe(1)
   const additional=await x.f.memory('Fictional different native input')
   const additionalSource=(await x.f.pool.query("SELECT read_scope_source($1,'memory',$2) AS source",[x.f.workspaceId,additional.id])).rows[0].source
   const differentAccumulator=new ContextScopeAccumulator({sources:[...(current.accumulator.evidence.sources??[]),additionalSource]})
   const differentContext={...current.context,scopeAccumulator:differentAccumulator}
   const different=await tools.saveTask.execute(input,differentContext)
   expect(different.isError,JSON.stringify(different)).not.toBe(true)
   const differentId=String(different.data).match(/\[([a-f0-9-]{36})\]/)?.[1]
   expect(differentId).toBeTruthy();expect(differentId).not.toBe(id)
   expect(String((await tools.saveTask.execute(input,differentContext)).data)).toContain(differentId)
   expect((await x.f.pool.query('SELECT count(*)::int AS count FROM tasks WHERE workspace_id=$1',[x.f.workspaceId])).rows[0].count).toBe(2)
   await x.sourcePool.query("UPDATE grants SET actions=array_remove(actions,'context') WHERE kind='human' AND account_id=$1",[x.f.ownerId])
   const revoked=await originalMemoryAuthority(x)
   await expect(tools.getTask.execute({id:id!},revoked.context)).rejects.toBeDefined()
   await expect(tools.saveTask.execute({title:'Fictional refused later task'},current.context)).rejects.toBeDefined()
   expect((await x.f.pool.query('SELECT count(*)::int AS count FROM tasks WHERE workspace_id=$1',[x.f.workspaceId])).rows[0].count).toBe(2)
   expect(creates).toBe(2)
   const other=await originalMemoryAuthority(x,x.f.secondId)
   const denied=await tools.getTask.execute({id:id!},other.context).catch(error=>({isError:true,data:String(error.message)}))
   expect(denied.isError).toBe(true)
   expect(JSON.stringify(denied.data)).not.toContain(input.title)
   expect((await x.f.pool.query('SELECT source_kind,source_id,source_version FROM scope_derivation_sources s JOIN scope_derivations d ON d.id=s.derivation_id WHERE d.workspace_id=$1 AND d.resource_kind=\'task\' AND d.resource_id=$2',[x.f.workspaceId,id])).rows).toEqual(ancestry)
   const control=await createTask(x.f.ownerId,{workspaceId:x.f.workspaceId,title:'Fictional source-free control',executorAssistantId:x.f.assistantId,externalRef:{fixture_key:'native-source-proof'}})
   expect(await getTaskByIdSystem(control.id)).not.toBeNull()
   expect((await findTasksByExternalRefSystem(x.f.workspaceId,{fixture_key:'native-source-proof'})).map(task=>task.id)).toEqual([control.id])
   expect(await triageTaskForGoal(control,x.f.ownerId,triage)).toBeNull();expect(judges).toBe(1)
   const nativeGoal=await createGoal({workspaceId:x.f.workspaceId,createdByUserId:x.f.ownerId,host:{type:'task',id:control.id},outcome:'Fictional native continuation',doneWhen:{kind:'subtasks'},authoringAuthority})
   expect(nativeGoal.host).toEqual({type:'task',id:control.id})
   const nativeOnly=await originalMemoryAuthority(x)
   nativeOnly.accumulator.note({sources:[additionalSource]})
   const nativeSaved=await tools.saveTask.execute({title:'Fictional native-only retained task',executor_assistant_id:x.f.assistantId},nativeOnly.context)
   expect(nativeSaved.isError,JSON.stringify(nativeSaved)).not.toBe(true)
   const nativeId=String(nativeSaved.data).match(/\[([a-f0-9-]{36})\]/)?.[1];expect(nativeId).toBeTruthy()
   expect(await getTaskByIdSystem(nativeId!)).not.toBeNull()
   const sourceFreeContext={...nativeOnly.context,scopeAccumulator:new ContextScopeAccumulator()}
   const sourceFreeInput={title:'Fictional native task after unrelated source revocation',executor_assistant_id:x.f.assistantId}
   const sourceFreeSaved=await tools.saveTask.execute(sourceFreeInput,sourceFreeContext)
   expect(sourceFreeSaved.isError,JSON.stringify(sourceFreeSaved)).not.toBe(true)
   const sourceFreeId=String(sourceFreeSaved.data).match(/\[([a-f0-9-]{36})\]/)?.[1];expect(sourceFreeId).toBeTruthy()
   expect(String((await tools.saveTask.execute(sourceFreeInput,sourceFreeContext)).data)).toContain(sourceFreeId)

   await expect(createGoal({workspaceId:x.f.workspaceId,createdByUserId:x.f.ownerId,host:{type:'task',id:nativeId!},outcome:'Fictional held native derivative',doneWhen:{kind:'subtasks'},authoringAuthority})).rejects.toThrow('goal_source_unsupported')


  }finally{await x.cleanup()}
 })
})
