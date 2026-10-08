import {readSessionById} from '../sessions.js'
import {resolveBrowserTaskExecutionAuthority} from '../../sandbox/task-execution-authority.js'
import {resolveExecutionContextSystem} from '../../context-scope/execution-context.js'
import {findAssistantById} from '../users.js'
import {createLocalTaskAdmission} from '../../sandbox/local-task-authority.js'
import {createLocalBrowserProvider,BrowserProfileAuthoritySchema,createSandboxOrchestrator,createCloudBrowserProvider,StubSandboxProvider} from '@use-brian/core'
import {createSandboxTaskStore} from '../sandbox-task-store.js'
import {resolveHumanBrowserProfileDepartmentRead} from '../../sandbox/profile-authority.js'
import request from 'supertest'
import {computerRoutes,createInMemoryLocalComputerTaskStore} from '../../routes/computer.js'
import {createTestApp} from '../../routes/__tests__/helpers.js'
import {getWorkspaceMembershipWithReadScopeSystem} from '../workspace-store.js'
import {resolveDepartmentReadGrant} from '../../context-scope/department-resolver.js'
import {randomUUID} from 'node:crypto'
import {afterAll,describe,it,expect,vi} from 'vitest'
import {query,getPool,getAppPool} from '../client.js'
import {createBrowserProfileStore} from '../browser-profile-store.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
afterAll(async()=>{await getAppPool().end();await getPool().end()})
describe('[COMP:sandbox/profiles] persisted single-department identity',()=>{
 it('round-trips one department and refuses a foreign-workspace binding or silent deletion',async()=>{
  const custodian=randomUUID(),owner=randomUUID(),workspace=randomUUID(),foreign=randomUUID(),department=randomUUID()
  for(const user of [owner,custodian])await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)",[user])
  for(const id of [workspace,foreign])await query("INSERT INTO workspaces(id,name,purpose,owner_user_id) VALUES($1,'Fictional browser fixture','test',$2)",[id,owner])
  await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[workspace,owner])
  await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','confidential')",[workspace,custodian])
  await query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Research',$3,'team',$1::text,$4)",[department,workspace,custodian,`team:${department}`])
  const store=createBrowserProfileStore()
  const profile=await store.create({workspaceId:workspace,ownerUserId:owner,name:'Department browser',scope:'workspace',departmentId:department})
  expect((await store.get(profile.id))?.departmentId).toBe(department)
  expect((await store.list({workspaceId:workspace}))[0]?.departmentId).toBe(department)
  await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store') ON CONFLICT DO NOTHING",[workspace,department,owner])
  const changed=await store.update(profile.id,{scope:'owner'})
  expect(await store.update(profile.id,{name:'Stale edit'},profile)).toBeNull()
  expect(await store.update(profile.id,{},profile)).toBeNull()
  expect((await store.get(profile.id))?.name).toBe('Department browser')
  expect(await store.update(profile.id,{scope:'workspace'},changed!)).toMatchObject({scope:'workspace'})
  await expect(store.create({workspaceId:foreign,ownerUserId:owner,name:'Foreign browser',departmentId:department})).rejects.toMatchObject({code:'23503'})
  await expect(query('DELETE FROM workspace_groups WHERE id=$1',[department])).rejects.toThrow('Teams archive instead of delete')
  expect((await store.get(profile.id))?.departmentId).toBe(department)
  await query('UPDATE workspaces SET department_read_v2=true WHERE id=$1',[workspace])
  await query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2',[workspace,owner])
  expect(await store.update(profile.id,{name:'Revoked edit'},profile)).toBeNull()
  expect(await store.delete(profile.id,profile)).toBe(false)
  expect(await store.get(profile.id)).not.toBeNull()
  const createParams={workspaceId:workspace,ownerUserId:owner,name:'Guarded creation',scope:'workspace' as const,departmentId:department}
  await expect(store.create(createParams,{userId:owner})).rejects.toMatchObject({code:'profile_authority_denied'})
  expect(await store.getByName({workspaceId:workspace,name:createParams.name})).toBeNull()
  await expect(store.create({...createParams,departmentId:null},{userId:owner})).rejects.toMatchObject({code:'profile_authority_denied'})
  await expect(store.create(createParams,{userId:custodian})).rejects.toMatchObject({code:'profile_authority_denied'})
  const tasks=createInMemoryLocalComputerTaskStore()
  tasks.touch({userId:owner,workspaceId:workspace,sessionId:'fixture-session',profileId:profile.id,profileAuthority:BrowserProfileAuthoritySchema.parse(await store.get(profile.id))})
  const app=createTestApp('/api/computer',computerRoutes({
    orchestrator:null,provider:null,vault:null,profileStore:store,localTasks:tasks,
    getWorkspaceRole:async(userId,workspaceId)=>(await getWorkspaceMembershipWithReadScopeSystem(userId,workspaceId))?.role??null,
    getProfileReadGrant:async(userId,workspaceId)=>{
      const member=await getWorkspaceMembershipWithReadScopeSystem(userId,workspaceId)
      if(!member)throw new Error('authority_unavailable')
      if(!member.departmentAccess)return null
      return resolveDepartmentReadGrant(member.departmentAccess.snapshot,member.departmentAccess.principal,{userId,workspaceId,assistantId:null},new Date())
    },
  }),{userId:owner})
  const list=()=>request(app).get(`/api/computer/profiles?workspaceId=${workspace}`)
  expect((await list()).body.profiles).toEqual([])
  await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')",[workspace,department,owner])
  // Hold the profile row so the guarded update pauses after locking authority.
  const blocker=await getPool().connect()
  let pending: ReturnType<typeof store.update>|undefined
  try {
    await blocker.query('BEGIN')
    const blockerPid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    await blocker.query('SELECT id FROM browser_profiles WHERE id=$1 FOR UPDATE',[profile.id])
    pending=store.update(profile.id,{name:'Department browser'},profile)
    let waiting=false
    for(let attempt=0;attempt<100&&!waiting;attempt++) {
      waiting=(await query('SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))',[blockerPid])).rows.length>0
      if(!waiting) await new Promise(resolve=>setTimeout(resolve,10))
    }
    expect(waiting).toBe(true)
    const revoker=await getPool().connect()
    try {
      await revoker.query('BEGIN')
      await revoker.query("SET LOCAL lock_timeout='100ms'")
      await expect(revoker.query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2',[workspace,owner])).rejects.toMatchObject({code:'55P03'})
      await revoker.query('ROLLBACK')
      await revoker.query('BEGIN')
      await revoker.query("SET LOCAL lock_timeout='100ms'")
      await expect(revoker.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner])).rejects.toMatchObject({code:'55P03'})
    } finally { await revoker.query('ROLLBACK');revoker.release() }
    await blocker.query('COMMIT')
    expect(await pending).toMatchObject({name:'Department browser'})
  } finally {
    await blocker.query('ROLLBACK');blocker.release()
    if(pending) await pending
  }
  await query("UPDATE department_edges SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner])
  const expiryBlocker=await getPool().connect()
  let expiring: ReturnType<typeof store.update>|undefined
  try {
    await expiryBlocker.query('BEGIN')
    await expiryBlocker.query('SELECT id FROM browser_profiles WHERE id=$1 FOR UPDATE',[profile.id])
    expiring=store.update(profile.id,{name:'Expired while waiting'},profile)
    await new Promise(resolve=>setTimeout(resolve,400))
    await expiryBlocker.query('COMMIT')
    expect(await expiring).toBeNull()
    expect((await store.get(profile.id))?.name).toBe('Department browser')
  } finally {
    await expiryBlocker.query('ROLLBACK');expiryBlocker.release()
    if(expiring)await expiring
  }
  await query('UPDATE department_edges SET expires_at=NULL WHERE workspace_id=$1 AND user_id=$2',[workspace,owner])
  expect((await list()).body.profiles.map((p:{id:string})=>p.id)).toEqual([profile.id])
  expect((await request(app).get('/api/computer/tasks/fixture-session')).status).toBe(200)
  await query("UPDATE department_edges SET expires_at=now()-interval '1 second' WHERE workspace_id=$1 AND user_id=$2",[workspace,owner])
  expect(await store.update(profile.id,{name:'Expired edit'},profile)).toBeNull()
  expect((await list()).body.profiles).toEqual([])
  expect((await request(app).patch(`/api/computer/profiles/${profile.id}`).send({name:'Changed'})).status).toBe(404)
  expect((await store.get(profile.id))?.name).toBe('Department browser')
  expect((await request(app).get(`/api/computer/tasks?workspaceId=${workspace}`)).body.tasks).toEqual([])
  expect((await request(app).get('/api/computer/tasks/fixture-session')).status).toBe(404)
  expect((await request(app).get('/api/computer/tasks/fixture-session/frame')).status).toBe(404)
  expect((await request(app).post('/api/computer/tasks/fixture-session/complete')).status).toBe(404)
  expect(tasks.getActiveBySession('fixture-session')).not.toBeNull()
  await query('UPDATE department_edges SET expires_at=NULL WHERE workspace_id=$1 AND user_id=$2',[workspace,owner])
  expect((await request(app).get('/api/computer/tasks/fixture-session')).status).toBe(200)
  const created=await store.create(createParams,{userId:owner})
  expect(created).toMatchObject({departmentId:department,ownerUserId:owner,scope:'workspace'})
  const reclassified=await store.update(created.id,{scope:'owner'})
  expect(await store.delete(created.id,created)).toBe(false)
  expect(await store.delete(created.id,reclassified!)).toBe(true)
  expect(await store.get(created.id)).toBeNull()
  const removed=randomUUID()
  await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)",[removed])
  await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','public')",[workspace,removed])
  await query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspace,removed])
  await expect(store.create({workspaceId:workspace,ownerUserId:removed,name:'Removed member personal'},{userId:removed})).rejects.toMatchObject({code:'profile_authority_denied'})
 })
 it('does not reclassify a persisted live task when its browser profile transfers departments',async()=>{
  const owner=randomUUID(),custodian=randomUUID(),workspace=randomUUID(),original=randomUUID(),destination=randomUUID()
  for(const user of [owner,custodian])await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)",[user])
  await query("INSERT INTO workspaces(id,name,purpose,owner_user_id) VALUES($1,'Fictional task floor fixture','test',$2)",[workspace,owner])
  for(const user of [owner,custodian])await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,'confidential')",[workspace,user,user===owner?'owner':'member'])
  for(const department of [original,destination]){
   await query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Fixture department',$3,'team',$1::text,$4)",[department,workspace,custodian,`team:${department}`])
   await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store') ON CONFLICT DO NOTHING",[workspace,department,owner])
  }
  await query('UPDATE workspaces SET department_read_v2=true WHERE id=$1',[workspace])
  const profileStore=createBrowserProfileStore(),provider=new StubSandboxProvider(),taskStore=createSandboxTaskStore()
  const profile=await profileStore.create({workspaceId:workspace,ownerUserId:owner,name:'Fictional department browser',scope:'workspace',clearance:'internal',departmentId:original},{userId:owner})
  const sessionId=randomUUID(),ctx={userId:owner,workspaceId:workspace,sessionId,profileId:profile.id}
  const initial=createSandboxOrchestrator({provider,taskStore,profileStore})
  await createCloudBrowserProvider({provider,binding:initial.binding}).navigate(ctx,'https://portal.example/account')
  const orchestrator=createSandboxOrchestrator({provider,taskStore:createSandboxTaskStore(),profileStore})
  const localTasks=createInMemoryLocalComputerTaskStore(),localSession=randomUUID()
  const localCtx={...ctx,sessionId:localSession}
  let transferDuringFrame=false,localCalls=0
  const localProvider=createLocalBrowserProvider({
   admit:createLocalTaskAdmission({profiles:profileStore,tasks:localTasks,resolveHumanRead:resolveHumanBrowserProfileDepartmentRead}),
   transport:{send:async({op})=>{
    localCalls++
    if(transferDuringFrame){
     transferDuringFrame=false
     await profileStore.classifyDepartment!(profile.id,{userId:owner,expected:profile,departmentId:destination,confirmed:true,reason:'Move fictional identity to destination'})
     await query('DELETE FROM department_edges WHERE workspace_id=$1 AND department_id=$2 AND user_id=$3',[workspace,original,owner])
    }
    return {ok:true,data:op==='captureFrame'?{data:'protected-pixels',mimeType:'image/jpeg'}:{url:'https://portal.example/account'}}
   }},
  })
  await localProvider.navigate(localCtx,'https://portal.example/account')
  expect(await localProvider.nextTakeoverFrame!(localCtx)).toMatchObject({data:'protected-pixels'})
  const app=createTestApp('/api/computer',computerRoutes({orchestrator,provider,vault:null,profileStore,localTasks,localProvider,
   getWorkspaceRole:async(userId,workspaceId)=>(await getWorkspaceMembershipWithReadScopeSystem(userId,workspaceId))?.role??null,
   getProfileReadGrant:resolveHumanBrowserProfileDepartmentRead,
  }),{userId:owner})
  expect((await request(app).get(`/api/computer/tasks/${sessionId}/frame`)).status).toBe(200)
  transferDuringFrame=true
  await expect(localProvider.nextTakeoverFrame!(localCtx)).rejects.toMatchObject({code:'profile_authority_denied'})
  const previousLocalCalls=localCalls
  await expect(localProvider.snapshot(localCtx)).rejects.toMatchObject({code:'profile_authority_denied'})
  expect(localCalls).toBe(previousLocalCalls)
  expect(localTasks.getActiveBySession(localSession)?.profileAuthority?.departmentId).toBe(original)
  for(const suffix of ['', '/frame'])expect((await request(app).get(`/api/computer/tasks/${localSession}${suffix}`)).status).toBe(404)
  const grant=await resolveHumanBrowserProfileDepartmentRead(owner,workspace)
  expect(grant?.departments[original]).toBeUndefined()
  expect(grant?.departments[destination]).toBe('confidential')
  expect((await request(app).get(`/api/computer/profiles?workspaceId=${workspace}`)).body.profiles.map((row:{id:string})=>row.id)).toContain(profile.id)
  const task=await orchestrator.getActiveTask(sessionId)
  const actionCount=provider.sandboxes.get(task!.sandboxId)!.actions.length
  expect((await request(app).get(`/api/computer/tasks?workspaceId=${workspace}`)).body.tasks).toEqual([])
  for(const suffix of ['', '/frame'])expect((await request(app).get(`/api/computer/tasks/${sessionId}${suffix}`)).status).toBe(404)
  for(const suffix of ['/input','/stream-session','/resume'])expect((await request(app).post(`/api/computer/tasks/${sessionId}${suffix}`).send({kind:'key',text:'fictional'})).status).toBe(404)
  expect(provider.sandboxes.get(task!.sandboxId)!.actions).toHaveLength(actionCount)
  // Recovery is a genuinely new task under the currently admitted destination.
  const freshSession=randomUUID()
  await createCloudBrowserProvider({provider,binding:orchestrator.binding}).navigate({...ctx,sessionId:freshSession},'https://portal.example/account')
  expect((await request(app).get(`/api/computer/tasks/${freshSession}/frame`)).status).toBe(200)
  expect((await request(app).get(`/api/computer/tasks?workspaceId=${workspace}`)).body.tasks.map((row:{sessionId:string})=>row.sessionId)).toEqual([freshSession])
  // A readable human profile must not replace a revoked acting assistant's ceiling.
  const actingAssistant=randomUUID(),agentSession=randomUUID()
  await query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance,compartments) VALUES($1,'Fictional browser assistant',$2,$3,'standard','internal',NULL)",[actingAssistant,owner,workspace])
  await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,assistant_id,clearance,origin) VALUES($1,$2,'assistant',$3,'internal','store') ON CONFLICT DO NOTHING",[workspace,destination,actingAssistant])
  // As in production, the agent's locked owner-only web chat is the browser task's session and its source.
  const agentCloudSession=randomUUID()
  await query("INSERT INTO sessions(id,workspace_id,assistant_id,user_id,channel_type,channel_id,status,visibility,context_locked_at,context_group_id,context_compartments,effective_clearance) VALUES($1::uuid,$2,$3,$4,'web',$1::text,'idle','owner',now(),$5,$6,'confidential')",
    [agentCloudSession,workspace,actingAssistant,owner,destination,[`team:${destination}`]])
  const agentChat=(await readSessionById(agentCloudSession))!
  const execution=await resolveExecutionContextSystem({userId:owner,workspaceId:workspace,assistant:(await findAssistantById(actingAssistant))!,session:agentChat,
   identity:{kind:'attended',principal:{kind:'workspace_member',userId:owner}},ownership:{kind:'workspace',workspaceId:workspace},
   lifecycle:{sessionId:agentCloudSession,channelType:'web',channelId:agentCloudSession,abortSignal:new AbortController().signal},
   sessionAuthority:agentChat})
  await profileStore.update(profile.id,{enabledAssistantIds:[actingAssistant]})
  const floor={version:1 as const,assistantId:actingAssistant,ceiling:execution.executionContext.security.ceiling}
  const agentOrchestrator=createSandboxOrchestrator({provider,taskStore:createSandboxTaskStore(),profileStore,resolveExecutionAuthority:resolveBrowserTaskExecutionAuthority})
  // Production calls attach the host-owned source snapshot alongside the frozen execution floor.
  const agentCloudCtx={...ctx,sessionId:agentCloudSession,executionAuthority:floor,authority:execution.executionContext.security.authority,
    sourceAuthority:execution.executionContext.security.authority.snapshotSource?.()}
  await createCloudBrowserProvider({provider,binding:agentOrchestrator.binding}).navigate(agentCloudCtx,'https://portal.example/account')
  const persisted=await createSandboxTaskStore().getActiveBySession(agentCloudSession)
  expect(persisted?.executionAuthority).toEqual(floor)
  for(const replacement of [null,floor,{...floor,assistantId:randomUUID()}]){
   await expect(createSandboxTaskStore().update(persisted!.taskId,{executionAuthority:replacement})).rejects.toMatchObject({code:'profile_authority_denied'})
  }
  const coldStore=createSandboxTaskStore()
  const compute={...persisted!,taskId:randomUUID(),sessionId:randomUUID(),browserStartedAt:null,executionAuthority:null,sourceAuthority:null}
  await coldStore.create(compute)
  const bindings=await Promise.allSettled([coldStore.update(compute.taskId,{executionAuthority:floor}),coldStore.update(compute.taskId,{executionAuthority:floor})])
  expect(bindings.filter(result=>result.status==='fulfilled')).toHaveLength(1)
  const coldAgent=createSandboxOrchestrator({provider,taskStore:coldStore,profileStore,resolveExecutionAuthority:resolveBrowserTaskExecutionAuthority,
   saveDownload:async()=>{throw new Error('revoked task must not publish')}})
  const coldApp=createTestApp('/api/computer',computerRoutes({orchestrator:coldAgent,provider,vault:null,profileStore,
   getWorkspaceRole:async(userId,workspaceId)=>(await getWorkspaceMembershipWithReadScopeSystem(userId,workspaceId))?.role??null,
   getProfileReadGrant:resolveHumanBrowserProfileDepartmentRead,
  }),{userId:owner})
  expect((await request(coldApp).get(`/api/computer/tasks/${agentCloudSession}/frame`)).status).toBe(200)
  let revokeAssistant=false,agentDispatches=0
  const agentLocal=createLocalBrowserProvider({
   admit:createLocalTaskAdmission({profiles:profileStore,tasks:localTasks,resolveHumanRead:resolveHumanBrowserProfileDepartmentRead}),
   transport:{send:async({taskId})=>{agentDispatches++
    expect(localTasks.listActiveByWorkspace(workspace).some(task=>task.taskId===taskId)).toBe(true)
    if(revokeAssistant)await query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND department_id=$2 AND assistant_id=$3",[workspace,destination,actingAssistant])
    return {ok:true,data:{url:'https://portal.example/account',title:'Protected result',nodes:[]}}
   }},
  })
  const agentCtx={...ctx,sessionId:agentSession,executionAuthority:floor,
   sourceAuthority:execution.executionContext.security.authority.snapshotSource!(),authority:execution.executionContext.security.authority}
  await agentLocal.navigate(agentCtx,'https://portal.example/account')
  const localAgentApp=createTestApp('/api/computer',computerRoutes({orchestrator:null,provider:null,vault:null,profileStore,
   localProvider:agentLocal,localTasks,getWorkspaceRole:async(userId,workspaceId)=>(await getWorkspaceMembershipWithReadScopeSystem(userId,workspaceId))?.role??null,
   getProfileReadGrant:resolveHumanBrowserProfileDepartmentRead,
  }),{userId:owner})
  expect((await request(localAgentApp).get(`/api/computer/tasks/${agentSession}`)).status).toBe(200)
  expect(localTasks.getActiveBySession(agentSession)?.executionAuthority).toEqual(floor)
  revokeAssistant=true
  await expect(agentLocal.snapshot(agentCtx)).rejects.toMatchObject({reason:'authority_changed'})
  const priorDispatches=agentDispatches
  await expect(agentLocal.snapshot(agentCtx)).rejects.toMatchObject({reason:'authority_changed'})
  expect(agentDispatches).toBe(priorDispatches)
  for(const suffix of ['', '/frame'])expect((await request(localAgentApp).get(`/api/computer/tasks/${agentSession}${suffix}`)).status).toBe(404)
  for(const suffix of ['/input','/resume','/complete'])expect((await request(localAgentApp).post(`/api/computer/tasks/${agentSession}${suffix}`).send({kind:'key',text:'fictional'})).status).toBe(404)
  expect(agentDispatches).toBe(priorDispatches)
  expect((await resolveHumanBrowserProfileDepartmentRead(owner,workspace))?.departments[destination]).toBe('confidential')
  const priorActions=provider.sandboxes.get(persisted!.sandboxId)!.actions.length
  for(const suffix of ['', '/frame'])expect((await request(coldApp).get(`/api/computer/tasks/${agentCloudSession}${suffix}`)).status).toBe(404)
  for(const suffix of ['/input','/stream-session','/resume'])expect((await request(coldApp).post(`/api/computer/tasks/${agentCloudSession}${suffix}`).send({kind:'key',text:'fictional'})).status).toBe(404)
  await expect(createCloudBrowserProvider({provider,binding:coldAgent.binding}).snapshot({...ctx,sessionId:agentCloudSession})).rejects.toMatchObject({reason:'authority_changed'})
  await expect(coldAgent.captureSession(agentCloudSession,'portal.example')).rejects.toMatchObject({reason:'authority_changed'})
  expect(provider.sandboxes.get(persisted!.sandboxId)!.actions).toHaveLength(priorActions)
  await coldAgent.completeTask(agentCloudSession)
  expect(provider.sandboxes.get(persisted!.sandboxId)?.status).toBe('killed')
  // Source deletion must deny even when both principals retain department access.
  await query('UPDATE department_edges SET expires_at=NULL WHERE workspace_id=$1 AND assistant_id=$2',[workspace,actingAssistant])
  const sourceSession=randomUUID()
  await query("INSERT INTO sessions(id,workspace_id,assistant_id,user_id,channel_type,channel_id,status,visibility,context_locked_at) VALUES($1::uuid,$2,$3,$4,'web',$1::text,'idle','owner',clock_timestamp())",[sourceSession,workspace,actingAssistant,owner])
  const sourceSnapshot=(await readSessionById(sourceSession))!
  const sourceRun=await resolveExecutionContextSystem({userId:owner,workspaceId:workspace,assistant:(await findAssistantById(actingAssistant))!,
   session:sourceSnapshot,sessionAuthority:sourceSnapshot,
   identity:{kind:'attended',principal:{kind:'workspace_member',userId:owner}},ownership:{kind:'workspace',workspaceId:workspace},
   lifecycle:{sessionId:sourceSession,channelType:'web',channelId:'fixture',abortSignal:new AbortController().signal}})
  await sourceRun.executionContext.security.authority.assertCurrent()
  const sourceCtx={...ctx,sessionId:sourceSession,authority:sourceRun.executionContext.security.authority,
   executionAuthority:{version:1 as const,assistantId:actingAssistant,ceiling:sourceRun.executionContext.security.ceiling},
   sourceAuthority:sourceRun.executionContext.security.authority.snapshotSource!()}
  expect(sourceCtx.sourceAuthority.kind).toBe('session')
  revokeAssistant=false
  await agentLocal.navigate(sourceCtx,'https://portal.example/account')
  expect((await request(localAgentApp).get(`/api/computer/tasks/${sourceSession}`)).status).toBe(200)
  await createCloudBrowserProvider({provider,binding:coldAgent.binding}).navigate(sourceCtx,'https://portal.example/account')
  const sourceTask=(await createSandboxTaskStore().getActiveBySession(sourceSession))!
  expect(sourceTask.sourceAuthority).toEqual(sourceCtx.sourceAuthority)
  await expect(coldStore.update(sourceTask.taskId,{sourceAuthority:null})).rejects.toMatchObject({code:'profile_authority_denied'})
  const afterRestart=createSandboxOrchestrator({provider,taskStore:createSandboxTaskStore(),profileStore,resolveExecutionAuthority:resolveBrowserTaskExecutionAuthority,saveDownload:async()=>{}})
  await expect(afterRestart.assertTaskAuthority(sourceTask)).resolves.toBeUndefined()
  await profileStore.update(profile.id,{enabledAssistantIds:[]})
  expect((await resolveHumanBrowserProfileDepartmentRead(owner,workspace))?.departments[destination]).toBe('confidential')
  await expect(afterRestart.assertTaskAuthority(sourceTask)).rejects.toMatchObject({code:'profile_authority_denied'})
  expect((await request(coldApp).get(`/api/computer/tasks/${sourceSession}/frame`)).status).toBe(404)
  expect((await request(localAgentApp).get(`/api/computer/tasks/${sourceSession}/frame`)).status).toBe(404)
  const dispatchesBeforeDisabledRead=agentDispatches
  await expect(agentLocal.snapshot({...ctx,sessionId:sourceSession})).rejects.toMatchObject({code:'profile_authority_denied'})
  expect(agentDispatches).toBe(dispatchesBeforeDisabledRead)
  await profileStore.update(profile.id,{enabledAssistantIds:[actingAssistant]})
  await expect(afterRestart.assertTaskAuthority(sourceTask)).resolves.toBeUndefined()
  await query('DELETE FROM sessions WHERE id=$1',[sourceSession])
  expect((await request(localAgentApp).get(`/api/computer/tasks/${sourceSession}/frame`)).status).toBe(404)
  await expect(agentLocal.snapshot({...ctx,sessionId:sourceSession})).rejects.toMatchObject({code:'profile_authority_denied'})
  expect(await createSandboxTaskStore().getActiveBySession(sourceSession)).not.toBeNull()
  expect((await resolveHumanBrowserProfileDepartmentRead(owner,workspace))?.departments[destination]).toBe('confidential')
  await expect(afterRestart.assertTaskAuthority(sourceTask)).rejects.toMatchObject({reason:'authority_changed'})
  await expect(createCloudBrowserProvider({provider,binding:afterRestart.binding}).snapshot({...ctx,sessionId:sourceSession})).rejects.toMatchObject({reason:'authority_changed'})
  const pull=vi.spyOn(provider.bridge,'pullDownloads')
  await afterRestart.completeTask(sourceSession)
  expect(pull).not.toHaveBeenCalled()
  expect(provider.sandboxes.get(sourceTask.sandboxId)?.status).toBe('killed')
  pull.mockRestore()
  await orchestrator.completeTask(sessionId,'failed')
  await orchestrator.completeTask(freshSession,'completed')
 })

})
