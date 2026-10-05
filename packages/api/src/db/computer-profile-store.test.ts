import { beforeAll,beforeEach,afterAll,it,expect,vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { nativeComputerRoutes } from '../routes/native-computer.js'
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { randomUUID,createHash } from 'node:crypto'
import type { NativeCommand,NativeProfileGrant } from '@use-brian/computer-control/protocol.js'
vi.mock('./client.js',()=>({query:vi.fn(),getPool:vi.fn()}))
import { query,getPool } from './client.js'
import { NativeComputerService } from '../computer-use/service.js'
import { composeComputerProfileTools } from '../computer-use/profile-tools.js'
import type { ToolContext } from '@use-brian/core'
const db=new PGlite()
let checkedOut=false
let nestedPoolAttempts=0
const u=randomUUID(),other=randomUUID(),w=randomUUID(),a=randomUUID(),chat=randomUUID(),chat2=randomUUID(),auth=randomUUID()
let service:NativeComputerService
const scope={userId:u,workspaceId:w,assistantId:a,conversationId:chat,toolName:'computerObserve'}
const context=(sessionId=chat):ToolContext=>({userId:u,workspaceId:w,assistantId:a,sessionId,appId:'chat',channelType:'web',channelId:'chat',activeCapabilities:new Set(['native_computer']),abortSignal:new AbortController().signal})
beforeAll(async()=>{
 await db.exec(`CREATE TABLE users(id uuid PRIMARY KEY,auth_version int DEFAULT 1);
 CREATE TABLE workspaces(id uuid PRIMARY KEY);
 CREATE TABLE assistants(id uuid PRIMARY KEY,workspace_id uuid,owner_user_id uuid,name text DEFAULT 'Workspace Assistant',blocked_user_ids uuid[] DEFAULT '{}');
 CREATE TABLE sessions(id uuid PRIMARY KEY,user_id uuid,assistant_id uuid,title text DEFAULT 'PRIVATE CHAT TITLE');
 CREATE TABLE tasks(id uuid PRIMARY KEY,workspace_id uuid,user_id uuid,assistant_id uuid,valid_to timestamptz,retracted_at timestamptz,scope_held boolean);
 CREATE TABLE auth_sessions(id uuid PRIMARY KEY,user_id uuid,revoked_at timestamptz,expires_at timestamptz,auth_version int);
 CREATE TABLE workspace_members(user_id uuid,workspace_id uuid);
 CREATE TABLE assistant_capabilities(assistant_id uuid,capability text,revoked_at timestamptz);
 CREATE TABLE mcp_tool_settings(assistant_id uuid,user_id uuid,server_name text,tool_name text,policy text);
 CREATE TABLE workspace_tool_policy(workspace_id uuid,server_name text,tool_name text,policy text);`)
 for(const migration of ['620_native_computer_sessions.sql','622_computer_profiles.sql']) await db.exec(await readFile(new URL(`../../migrations/${migration}`,import.meta.url),'utf8'))
 vi.mocked(query).mockImplementation(((sql:string,params:unknown[])=>{
   if(checkedOut) {nestedPoolAttempts++;throw new Error('PG_SINGLE_CONNECTION: nested global checkout')}
   return db.query(sql,params)
 }) as typeof query)
 vi.mocked(getPool).mockReturnValue({connect:async()=>{
   if(checkedOut) {nestedPoolAttempts++;throw new Error('PG_SINGLE_CONNECTION: nested transaction checkout')}
   checkedOut=true
   return {query:(sql:string,params:unknown[])=>db.query(sql,params),release(){checkedOut=false}}
 }} as never)
},30_000)
beforeEach(async()=>{
 expect(checkedOut).toBe(false)
 nestedPoolAttempts=0
 await db.exec('TRUNCATE users,workspaces,assistants,sessions,tasks,auth_sessions,workspace_members,assistant_capabilities,mcp_tool_settings,workspace_tool_policy CASCADE')
 await db.query('INSERT INTO users(id) VALUES($1),($2)',[u,other]);await db.query('INSERT INTO workspaces VALUES($1)',[w])
 await db.query('INSERT INTO assistants(id,workspace_id,owner_user_id) VALUES($1,$2,NULL)',[a,w])
 await db.query('INSERT INTO sessions(id,user_id,assistant_id) VALUES($1,$3,$4),($2,$3,$4)',[chat,chat2,u,a])
 await db.query("INSERT INTO auth_sessions VALUES($1,$2,NULL,now()+interval '1 hour',1)",[auth,u])
 await db.query('INSERT INTO workspace_members VALUES($1,$3),($2,$3)',[u,other,w])
 await db.query("INSERT INTO assistant_capabilities VALUES($1,'native_computer',NULL)",[a])
 service=new NativeComputerService({relayUrl:'http://relay',relaySecret:'test',jwtSecret:'test',deploymentId:'deployment'})
 vi.spyOn(service,'relay').mockResolvedValue({})
})
afterAll(()=>db.close())
async function connected() {
 const p=await service.profiles.create(u,w,'My Mac')
 await service.profiles.update(u,p.id,{enabledAssistantIds:[a],assistantRoutingNotes:{[a]:'Local work'}})
 const {connectionId}=await service.profiles.connect(u,auth,p.id,w,'device')
 return {p,connectionId}
}
async function paired() {
 const {p,connectionId}=await connected()
 const pending=await service.profiles.request(scope,p.id)
 const verifier='x'.repeat(43)
 const created=await service.acceptProfile(u,auth,p.id,connectionId,pending.requestId!,createHash('sha256').update(verifier).digest('base64url'))
 const grant:NativeProfileGrant={protocol:'native-computer-v1',identity:created.identity,purpose:'chat-tools',grantId:randomUUID(),epoch:1,
   expiresAt:Date.now()+60000,allowControl:true,allowCapture:false,requester:'Your chat',targets:[{appId:'app',processId:1,processInstanceId:'p',windowId:'w',windowInstanceId:'wi'}]}
 await service.exchange(created.identity.sessionId,u,verifier,grant,auth)
 return {p,connectionId,grant,created}
}
it('CRUD is owner-private even among workspace members; validates assistants and stores no tasks/goals',async()=>{
 const {p}=await connected()
 expect((await service.profiles.list(u,w))[0]).toMatchObject({name:'My Mac',canManage:true,connected:true})
 expect(await service.profiles.list(other,w)).toEqual([])
 await expect(service.profiles.update(other,p.id,{name:'steal'})).rejects.toThrow('unavailable')
 await expect(service.profiles.update(u,p.id,{enabledAssistantIds:[randomUUID()]})).rejects.toThrow('Assistant unavailable')
 await expect(service.profiles.update(u,p.id,{scope:'workspace'})).rejects.toThrow()
 expect((await db.query('SELECT * FROM tasks')).rows).toEqual([])
 const row=(await db.query<Record<string,unknown>>('SELECT * FROM computer_profiles')).rows[0]
 for(const key of ['goal','task_id','assistant_id','conversation_id'])expect(row).not.toHaveProperty(key)
 await service.profiles.delete(u,p.id);expect(await service.profiles.list(u,w)).toEqual([])
})
it('binds immutable device and exact authenticated connection, expiry cannot be heartbeated back to life',async()=>{
 const {p,connectionId}=await connected()
 await expect(service.profiles.poll(u,other,p.id,connectionId)).rejects.toThrow('Connection unavailable')
 await expect(service.profiles.connect(u,auth,p.id,w,'different-device')).rejects.toThrow('Device unavailable')
 const rotated=await service.profiles.connect(u,auth,p.id,w,'device')
 expect(rotated.connectionId).not.toBe(connectionId)
 await expect(service.profiles.poll(u,auth,p.id,connectionId)).rejects.toThrow()
 await db.query("UPDATE computer_profiles SET connection_expires_at=now()-interval '1 second'")
 expect((await service.profiles.request(scope,p.id)).code).toBe('offline')
 await expect(service.profiles.poll(u,auth,p.id,rotated.connectionId)).rejects.toThrow()
})
it('deduplicates consent, denies without reprompt, rejects forged chats, and requires explicit reconnect after Stop',async()=>{
 const {p,connectionId}=await connected()
 await expect(service.profiles.request({...scope,userId:other},p.id)).rejects.toThrow()
 await expect(service.profiles.request({...scope,conversationId:randomUUID()},p.id)).rejects.toThrow()
 const first=await service.profiles.request(scope,p.id)
 expect(first.code).toBe('local_consent_required');expect(await service.profiles.request(scope,p.id)).toEqual(first)
 expect((await service.profiles.request({...scope,conversationId:chat2},p.id)).code).toBe('busy')
 expect((await service.profiles.poll(u,auth,p.id,connectionId)).request).toMatchObject({id:first.requestId,conversationId:chat,assistantId:a,workspaceId:w})
 await service.profiles.deny(u,auth,p.id,connectionId,first.requestId!)
 expect((await service.profiles.request(scope,p.id)).code).toBe('reconnect_required')
 await service.profiles.disconnect(u,auth,p.id,connectionId)
 expect((await service.profiles.request(scope,p.id)).code).toBe('offline')
})
it('profile PKCE creates no fake task, isolates chat grants, requires fresh observe and releases for another chat',async()=>{
 const {p,grant,created}=await paired()
 expect(created.identity).not.toHaveProperty('taskId')
 expect((await db.query('SELECT * FROM tasks')).rows).toEqual([])
 expect(await service.profileBinding({...scope,conversationId:chat2},p.id)).toBeNull()
 expect((await service.profiles.request({...scope,conversationId:chat2},p.id)).code).toBe('busy')
 const tools=composeComputerProfileTools(service)
 const act=await tools.computerAct.execute({profile:p.id,observationId:'forged',action:{kind:'invoke',ref:'r'}},context())
 expect(act.data).toEqual({code:'fresh_observation_required'})
 expect((await tools.computerCapture.execute({profile:p.id,observationId:'forged'},context())).data).toEqual({code:'fresh_observation_required'})
 await service.releaseProfile(scope,p.id)
 expect(await service.profileBinding(scope,p.id)).toBeNull()
 expect((await service.profiles.request({...scope,conversationId:chat2},p.id)).code).toBe('local_consent_required')
 expect((await db.query<{revoked_at:unknown}>('SELECT revoked_at FROM native_computer_sessions WHERE id=$1',[grant.identity.sessionId])).rows[0].revoked_at).toBeTruthy()
})
it.each(['update','delete','disconnect','stop'] as const)('%s revokes pending and active grants fail closed',async(operation)=>{
 const {p,connectionId,grant}=await paired()
 if(operation==='update')await service.profiles.update(u,p.id,{enabledAssistantIds:[]})
 if(operation==='delete')await service.profiles.delete(u,p.id)
 if(operation==='disconnect')await service.profiles.disconnect(u,auth,p.id,connectionId)
 if(operation==='stop')await service.stop(grant.identity.sessionId,u)
 expect(await service.profileBinding(scope,p.id)).toBeNull()
 const row=(await db.query<{revoked_at:unknown}>('SELECT revoked_at FROM native_computer_sessions')).rows[0]
 expect(row.revoked_at).toBeTruthy()
 expect((await db.query<{state:string}>('SELECT state FROM computer_profile_requests')).rows[0].state).toBe('ended')
})
it('unknown outcome remains fenced through release, delete and a newly created profile on the same device',async()=>{
 const {p,grant}=await paired()
 await service.markUnknown(grant.identity.sessionId,u)
 expect((await service.profiles.request(scope,p.id)).code).toBe('execution_unknown')
 await service.profiles.delete(u,p.id)
 const replacement=await connected()
 expect((await service.profiles.request(scope,replacement.p.id)).code).toBe('execution_unknown')
 expect((await db.query<{state:string}>('SELECT state FROM native_computer_sessions')).rows[0].state).toBe('execution_unknown')
})
it('chat observe then act uses only trusted target, exact per-tool policy and fresh scoped observation',async()=>{
 const {p,grant}=await paired(),tools=composeComputerProfileTools(service)
 const commands:NativeCommand[]=[]
 vi.mocked(service.relay).mockImplementation(async(path,_method,raw)=>{
  if(path!=='/command')return {}
  const command=raw as NativeCommand;commands.push(command)
  const check={commandId:command.commandId,grantId:command.grantId,epoch:command.epoch,deadlineAt:command.deadlineAt,digest:createHash('sha256').update(JSON.stringify(command)).digest('hex')}
  expect(await service.revalidate(grant.identity.sessionId,u,auth,check)).toEqual({authorized:true})
  const mutations=[
    `UPDATE computer_profiles SET connection_expires_at=now()-interval '1 second'`,
    `UPDATE computer_profiles SET connection_id='${randomUUID()}'`,
    `UPDATE computer_profiles SET connection_auth_session_id=NULL`,
    `UPDATE computer_profiles SET device_id='other-device'`,
    `UPDATE computer_profiles SET owner_user_id='${other}'`,
    `UPDATE computer_profiles SET enabled_assistant_ids='{}'`,
    `UPDATE computer_profiles SET deleted_at=now()`,
    `UPDATE native_computer_sessions SET conversation_id='${chat2}'`,
    `UPDATE sessions SET user_id='${other}' WHERE id='${chat}'`,
    `UPDATE native_computer_sessions SET device_id='other-device'`,
    `UPDATE native_computer_sessions SET revoked_at=now()`,
    `UPDATE auth_sessions SET revoked_at=now()`,
    `UPDATE users SET auth_version=2 WHERE id='${u}'`,
    `DELETE FROM workspace_members WHERE user_id='${u}'`,
    `DELETE FROM assistant_capabilities`,
    `UPDATE assistants SET blocked_user_ids=ARRAY['${u}']::uuid[]`,
    `INSERT INTO workspace_tool_policy VALUES('${w}','native_computer','${command.action.kind==='observe'?'computerObserve':'computerAct'}','block')`,
    `INSERT INTO mcp_tool_settings VALUES('${a}','${u}','native_computer','${command.action.kind==='observe'?'computerObserve':'computerAct'}','block')`,
  ]
  for(const mutation of mutations) {
    await db.exec('BEGIN')
    try {await db.exec(mutation);await expect(service.revalidate(grant.identity.sessionId,u,auth,check),mutation).rejects.toThrow('Native execution denied')}
    finally {await db.exec('ROLLBACK')}
  }

  await expect(service.revalidate(grant.identity.sessionId,u,other,check)).rejects.toThrow()
  return {commandId:command.commandId,outcome:'executed',code:'ok',observation:{identity:grant.identity,epoch:1,id:randomUUID(),capturedAt:Date.now(),monotonicMs:1,target:grant.targets[0],foreground:true,bounds:{x:0,y:0,width:100,height:100},displayLayoutVersion:'1',completeness:'complete',nodes:[]}}
 })
 const observed=await tools.computerObserve.execute({profile:p.id},context())
 expect(observed.isError).not.toBe(true)
 const observationId=(observed.data as {observationId:string}).observationId
 expect(observationId).toBeTruthy()
 await db.query("INSERT INTO workspace_tool_policy VALUES($1,'native_computer','computerAct','block')",[w])
 expect((await tools.computerAct.execute({profile:p.id,observationId,action:{kind:'focus'}},context())).isError).toBe(true)
 expect(commands).toHaveLength(1)
 await db.query('DELETE FROM workspace_tool_policy')
 expect((await tools.computerAct.execute({profile:p.id,observationId,action:{kind:'focus'}},context())).isError).not.toBe(true)
 expect(commands).toHaveLength(2)
 expect(commands[1].action).toEqual({kind:'focus',target:grant.targets[0],observationId})
 expect(commands[1].identity).not.toHaveProperty('taskId')
})

it('real HTTP profile flow creates server-owned requests, pairs only exact desktop auth, and executes no deferred action',async()=>{
 let user=u,currentAuth=auth
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.userId=user;req.authSessionId=currentAuth;next()});app.use(nativeComputerRoutes(service))
 const created=await request(app).post('/profiles').send({workspaceId:w,name:'HTTP Mac'})
 expect(created.status).toBe(201)
 const id=created.body.profile.id as string,base=`/profiles/${id}`
 expect((await request(app).patch(base).send({enabledAssistantIds:[a]})).status).toBe(200)
 user=other
 expect((await request(app).get(`/profiles?workspaceId=${w}`)).body).toEqual({profiles:[]})
 expect((await request(app).patch(base).send({name:'stolen'})).status).toBe(403)
 user=u
 const connected=await request(app).post(base+'/connect').send({workspaceId:w,deviceId:'device'})
 const connectionId=connected.body.connectionId as string
 expect(connectionId).toBeTruthy()
 const tools=composeComputerProfileTools(service)
 const noLease=await tools.computerAct.execute({profile:id,observationId:'old',action:{kind:'focus'}},context())
 expect(noLease.data).toMatchObject({code:'local_consent_required'})
 const pending=(await request(app).post(base+'/poll').send({connectionId})).body.request
 expect(pending).toMatchObject({conversationId:chat,assistantId:a,workspaceId:w,requester:`Workspace Assistant · chat ${chat.slice(0,8)}`})
 const verifier='v'.repeat(43),challenge=createHash('sha256').update(verifier).digest('base64url')
 expect((await request(app).post(base+`/requests/${pending.id}/accept`).send({connectionId,challenge,conversationId:chat2})).status).toBe(400)
 const accepted=await request(app).post(base+`/requests/${pending.id}/accept`).send({connectionId,challenge})
 expect(accepted.status).toBe(200)
 expect(accepted.body.identity).toMatchObject({profileId:id,conversationId:chat})
 expect(accepted.body.identity).not.toHaveProperty('taskId')
 const grant={protocol:'native-computer-v1',identity:accepted.body.identity,purpose:'chat-tools',grantId:randomUUID(),epoch:1,
   expiresAt:Date.now()+60000,allowControl:true,allowCapture:false,requester:'Your chat',targets:[{appId:'app',processId:1,processInstanceId:'p',windowId:'w',windowInstanceId:'wi'}]}
 const path=`/sessions/${accepted.body.identity.sessionId}/exchange`
 currentAuth=other
 expect((await request(app).post(path).send({verifier,grant})).status).toBe(403)
 currentAuth=auth
 expect((await request(app).post(path).send({verifier:'wrong'.repeat(12),grant})).status).toBe(403)
 expect((await request(app).post(path).send({verifier,grant})).status).toBe(200)
 expect(vi.mocked(service.relay).mock.calls.map(c=>c[0])).not.toContain('/command')
 expect((await tools.computerAct.execute({profile:id,observationId:'old',action:{kind:'focus'}},context())).data).toEqual({code:'fresh_observation_required'})
 expect((await request(app).post(base+'/disconnect').send({connectionId})).body).toEqual({ok:true})
 expect(await service.profileBinding(scope,id)).toBeNull()
 expect((await request(app).delete(base)).body).toEqual({ok:true})
})

it('an explicitly reconnected chat gets a new lease; revoked cache entries cannot shadow it',async()=>{
 const {p,grant}=await paired()
 const {connectionId}=await service.profiles.connect(u,auth,p.id,w,'device')
 const pending=await service.profiles.request(scope,p.id)
 const verifier='r'.repeat(43)
 const created=await service.acceptProfile(u,auth,p.id,connectionId,pending.requestId!,createHash('sha256').update(verifier).digest('base64url'))
 const next={...grant,identity:created.identity,grantId:randomUUID()}
 await service.exchange(created.identity.sessionId,u,verifier,next,auth)
 expect((await service.profileBinding(scope,p.id))?.grant.identity.sessionId).toBe(created.identity.sessionId)
 expect(created.identity.sessionId).not.toBe(grant.identity.sessionId)
})

it.each(['delete','disconnect','disable-assistant','policy','context','rotate-connection'] as const)(
 'discards a deferred observation after %s and never caches its content',async(change)=>{
 const {p,connectionId,grant}=await paired(),tools=composeComputerProfileTools(service)
 let finish!:(value:unknown)=>void,command:NativeCommand|undefined
 let contextCurrent=true
 const ctx=context()
 ctx.authority={assertCurrent:async()=>{if(!contextCurrent)throw new Error('Context revoked')}} as ToolContext['authority']
 vi.mocked(service.relay).mockImplementation(async(path,_method,body)=>{
   if(path!=='/command')return {}
   command=body as NativeCommand
   return new Promise(resolve=>{finish=resolve})
 })
 const running=tools.computerObserve.execute({profile:p.id},ctx)
 await vi.waitFor(()=>expect(command).toBeDefined())
 if(change==='delete')await service.profiles.delete(u,p.id)
 if(change==='disconnect')await service.profiles.disconnect(u,auth,p.id,connectionId)
 if(change==='disable-assistant')await service.profiles.update(u,p.id,{enabledAssistantIds:[]})
 if(change==='policy')await db.query("INSERT INTO workspace_tool_policy VALUES($1,'native_computer','computerObserve','block')",[w])
 if(change==='context')contextCurrent=false
 if(change==='rotate-connection')await service.profiles.connect(u,auth,p.id,w,'device')
 const observationId=randomUUID()
 finish({commandId:command!.commandId,outcome:'executed',code:'ok',observation:{identity:grant.identity,epoch:grant.epoch,id:observationId,
   capturedAt:Date.now(),monotonicMs:1,target:grant.targets[0],foreground:true,bounds:{x:0,y:0,width:100,height:100},
   displayLayoutVersion:'1',completeness:'complete',nodes:[{ref:'secret',role:'AXStaticText',name:'PRIVATE-LATE-CONTENT',
     enabled:true,focused:false,selected:false,sensitive:false,actions:[]}]}})
 const returned=await running
 expect(returned.isError).toBe(true)
 expect(JSON.stringify(returned)).not.toMatch(/PRIVATE-LATE-CONTENT|observationId|nodes/)
 if(['delete','disconnect','disable-assistant','rotate-connection'].includes(change)) {
   const row=(await db.query<{state:string}>('SELECT state FROM native_computer_sessions WHERE id=$1',[grant.identity.sessionId])).rows[0]
   expect(row.state).toBe('execution_unknown') // Publication rejection never clears the revoked fence.
 } else {
   await db.exec('DELETE FROM workspace_tool_policy');contextCurrent=true
   const act=await tools.computerAct.execute({profile:p.id,observationId,action:{kind:'focus'}},ctx)
   expect(act.data).toEqual({code:'fresh_observation_required'})
 }
 expect(nestedPoolAttempts).toBe(0)
})
it('accept and intentional release use one checked-out connection; cleanup runs only after commit',async()=>{
 const {p,grant}=await paired()
 vi.mocked(service.relay).mockImplementation(async(path,method,body)=>{
   expect(checkedOut).toBe(false)
   expect(path).toBe(`/sessions/${grant.identity.sessionId}`);expect(method).toBe('DELETE');expect(body).toEqual({reason:'released'})
   const row=(await db.query<{revoked_at:unknown}>('SELECT revoked_at FROM native_computer_sessions WHERE id=$1',[grant.identity.sessionId])).rows[0]
   expect(row.revoked_at).toBeTruthy()
   return {}
 })
 await service.releaseProfile({...scope,toolName:'computerRelease'},p.id)
 expect(nestedPoolAttempts).toBe(0)
 expect(await service.profileBinding(scope,p.id)).toBeNull()
 expect((await service.profiles.list(u,w))[0].connected).toBe(true)
 expect((await service.profiles.request({...scope,conversationId:chat2},p.id)).code).toBe('local_consent_required')
})
it.each(['inflight','unknown','missing-grant'] as const)('%s release uses ordinary revoke without a reason and preserves fences',async(mode)=>{
 const {p,grant}=await paired()
 let finish!:(value:unknown)=>void,command:NativeCommand|undefined
 vi.mocked(service.relay).mockClear()
 vi.mocked(service.relay).mockImplementation(async(path,_method,body)=>{
   expect(checkedOut).toBe(false)
   if(path==='/command') {command=body as NativeCommand;return new Promise(resolve=>{finish=resolve})}
   expect(body).toBeUndefined();return {}
 })
 let running:Promise<unknown>|undefined
 if(mode==='inflight') {
   const binding=(await service.profileBinding(scope,p.id))!
   running=service.dispatch(binding.scope,{protocol:grant.protocol,identity:grant.identity,grantId:grant.grantId,epoch:grant.epoch,
     commandId:randomUUID(),deadlineAt:Date.now()+29000,action:{kind:'observe',target:grant.targets[0]}})
   await vi.waitFor(()=>expect(command).toBeDefined())
 } else if(mode==='unknown')await service.markUnknown(grant.identity.sessionId,u)
 else {
   // Another API process has durable metadata but no in-memory grant authority.
   service=new NativeComputerService({relayUrl:'http://relay',relaySecret:'test',jwtSecret:'test',deploymentId:'deployment'})
   vi.spyOn(service,'relay').mockImplementation(async(_path,_method,body)=>{expect(checkedOut).toBe(false);expect(body).toBeUndefined();return {}})
 }
 await service.releaseProfile({...scope,toolName:'computerRelease'},p.id)
 if(running) {finish({commandId:command!.commandId,outcome:'not_executed',code:'denied'});await running}
 const row=(await db.query<{state:string;revoked_at:unknown}>('SELECT state,revoked_at FROM native_computer_sessions WHERE id=$1',[grant.identity.sessionId])).rows[0]
 expect(row.revoked_at).toBeTruthy()
 if(mode!=='missing-grant')expect(row.state).toBe('execution_unknown')
 expect((await service.profiles.request(scope,p.id)).code).toBe(mode==='missing-grant'?'reconnect_required':'execution_unknown')
 expect(nestedPoolAttempts).toBe(0)
 expect(vi.mocked(service.relay).mock.calls.filter(c=>c[1]==='DELETE').every(c=>c.length===2)).toBe(true)
})
it('release from another chat does not revoke the active chat lease',async()=>{
 const {p}=await paired()
 vi.mocked(service.relay).mockClear()
 await service.releaseProfile({...scope,conversationId:chat2,toolName:'computerRelease'},p.id)
 expect(service.relay).not.toHaveBeenCalled()
 expect(await service.profileBinding(scope,p.id)).not.toBeNull()
})

it('intentional idle release permits fresh consent and a new lease in the SAME chat without reconnect, retaining history',async()=>{
 const {p,connectionId,grant}=await paired()
 const before=(await db.query<{id:string}>('SELECT id FROM computer_profile_requests')).rows[0]
 await service.releaseProfile({...scope,toolName:'computerRelease'},p.id)
 expect((await db.query<{state:string}>('SELECT state FROM computer_profile_requests WHERE id=$1',[before.id])).rows[0].state).toBe('released')
 const next=await service.profiles.request(scope,p.id)
 expect(next.code).toBe('local_consent_required');expect(next.requestId).not.toBe(before.id)
 expect(await service.profiles.request(scope,p.id)).toEqual(next) // Deduplication still applies to the new pending prompt.
 expect((await service.profiles.poll(u,auth,p.id,connectionId)).request?.id).toBe(next.requestId)
 expect(await service.profileBinding(scope,p.id)).toBeNull() // No authority carried forward.
 const verifier='n'.repeat(43)
 const accepted=await service.acceptProfile(u,auth,p.id,connectionId,next.requestId!,createHash('sha256').update(verifier).digest('base64url'))
 const nextGrant={...grant,grantId:randomUUID(),identity:accepted.identity}
 await service.exchange(accepted.identity.sessionId,u,verifier,nextGrant,auth)
 expect((await service.profileBinding(scope,p.id))?.grant.identity.sessionId).toBe(accepted.identity.sessionId)
 expect(accepted.identity.sessionId).not.toBe(grant.identity.sessionId)
 expect((await db.query<{connection_id:string}>('SELECT connection_id FROM computer_profiles WHERE id=$1',[p.id])).rows[0].connection_id).toBe(connectionId)
 expect((await db.query<{state:string}>('SELECT state FROM computer_profile_requests ORDER BY created_at')).rows.map(r=>r.state)).toEqual(['released','accepted'])
 expect(nestedPoolAttempts).toBe(0)
})
it('release cannot retire a denial or a cancelled pending request to permit repeated prompts',async()=>{
 const {p,connectionId}=await connected()
 const pending=await service.profiles.request(scope,p.id)
 await service.profiles.deny(u,auth,p.id,connectionId,pending.requestId!)
 await service.releaseProfile({...scope,toolName:'computerRelease'},p.id)
 expect((await service.profiles.request(scope,p.id)).code).toBe('reconnect_required')
 expect((await db.query<{state:string}>('SELECT state FROM computer_profile_requests')).rows[0].state).toBe('denied')
 const second=await service.profiles.request({...scope,conversationId:chat2},p.id)
 expect(second.code).toBe('local_consent_required')
 await service.releaseProfile({...scope,conversationId:chat2,toolName:'computerRelease'},p.id)
 expect((await service.profiles.request({...scope,conversationId:chat2},p.id)).code).toBe('reconnect_required')
 expect((await db.query<{state:string}>('SELECT state FROM computer_profile_requests WHERE id=$1',[second.requestId])).rows[0].state).toBe('ended')
})
it.each(['unknown','stop'] as const)('%s remains fenced after computerRelease; no released request or new consent',async(mode)=>{
 const {p,grant}=await paired()
 if(mode==='unknown')await service.markUnknown(grant.identity.sessionId,u)
 else await service.stop(grant.identity.sessionId,u)
 await service.releaseProfile({...scope,toolName:'computerRelease'},p.id)
 expect((await service.profiles.request(scope,p.id)).code).toBe(mode==='unknown'?'execution_unknown':'offline')
 expect((await db.query<{state:string}>('SELECT state FROM computer_profile_requests')).rows[0].state).toBe('ended')
 expect((await db.query('SELECT * FROM computer_profile_requests')).rows).toHaveLength(1)
})
it('poll identifies the assistant and short chat ID, bounded to 200 without private chat titles',async()=>{
 const {p,connectionId}=await connected()
 await service.profiles.request(scope,p.id)
 expect((await service.profiles.poll(u,auth,p.id,connectionId)).request?.requester).toBe(`Workspace Assistant · chat ${chat.slice(0,8)}`)
 await db.query('UPDATE assistants SET name=$1 WHERE id=$2',['😀'.repeat(250),a])
 const result=await service.profiles.poll(u,auth,p.id,connectionId)
 expect(result.request?.requester.length).toBeLessThanOrEqual(200)
 expect(result.request?.requester).toContain(`chat ${chat.slice(0,8)}`)
 expect(JSON.stringify(result)).not.toContain('PRIVATE CHAT TITLE')
 expect(result.request).not.toHaveProperty('assistantName')
})
it.each(['chat-owner','chat-assistant','assistant-workspace','request-owner','request-workspace','disabled','blocked','capability'] as const)(
 'poll does not disclose assistant names after %s authorization changes',async(change)=>{
 const {p,connectionId}=await connected()
 await service.profiles.request(scope,p.id)
 if(change==='chat-owner')await db.query('UPDATE sessions SET user_id=$1 WHERE id=$2',[other,chat])
 if(change==='chat-assistant')await db.query('UPDATE sessions SET assistant_id=$1 WHERE id=$2',[randomUUID(),chat])
 if(change==='assistant-workspace')await db.query('UPDATE assistants SET workspace_id=$1 WHERE id=$2',[randomUUID(),a])
 if(change==='request-owner')await db.query('UPDATE computer_profile_requests SET user_id=$1',[other])
 if(change==='request-workspace') {
   const different=randomUUID();await db.query('INSERT INTO workspaces VALUES($1)',[different])
   await db.query('UPDATE computer_profile_requests SET workspace_id=$1',[different])
 }
 if(change==='disabled')await db.exec("UPDATE computer_profiles SET enabled_assistant_ids='{}'")
 if(change==='blocked')await db.query('UPDATE assistants SET blocked_user_ids=ARRAY[$1]::uuid[]',[u])
 if(change==='capability')await db.exec('DELETE FROM assistant_capabilities')
 expect(await service.profiles.poll(u,auth,p.id,connectionId)).toEqual({request:null})
})

it('concurrent stale-view revoke A then enable B cannot resurrect A; unrelated notes and capability stay unchanged',async()=>{
 const {p}=await connected(),b=randomUUID()
 await db.query('INSERT INTO assistants(id,workspace_id) VALUES($1,$2)',[b,w])
 const stale=await service.profiles.list(u,w)
 expect(stale[0].enabledAssistantIds).toEqual([a])
 // PGlite has one backend: queue concurrent checkouts like PG_SINGLE_CONNECTION.
 // Both UI intents were formed from the same stale view, but each mutation
 // reads the committed row only after acquiring its transaction/row lock.
 const underlying=getPool();let tail=Promise.resolve()
 const serial={connect:async()=>{
   const previous=tail;let unlock!:()=>void
   tail=new Promise<void>(resolve=>{unlock=resolve});await previous
   const client=await underlying.connect()
   return {query:client.query.bind(client),release(){client.release();unlock()}}
 }}
 vi.mocked(getPool).mockReturnValueOnce(serial as never).mockReturnValueOnce(serial as never)
 const [revoked,enabled]=await Promise.all([
   service.profiles.updateAssistant(u,p.id,a,{enabled:false}),
   service.profiles.updateAssistant(u,p.id,b,{enabled:true,routingNote:'Use B'}),
 ])
 expect(revoked.enabledAssistantIds).toEqual([])
 expect(enabled.enabledAssistantIds).toEqual([b])
 expect(enabled.assistantRoutingNotes).toEqual({[a]:'Local work',[b]:'Use B'})
 expect((await service.profiles.list(u,w))[0].enabledAssistantIds).toEqual([b])
 expect((await db.query('SELECT * FROM assistant_capabilities WHERE assistant_id=$1',[b])).rows).toEqual([])
 expect(nestedPoolAttempts).toBe(0)
})
it('real atomic PATCH changes only its assistant note/grant and revokes active authority',async()=>{
 const {p,grant}=await paired(),b=randomUUID()
 await db.query('INSERT INTO assistants(id,workspace_id) VALUES($1,$2)',[b,w])
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.userId=u;req.authSessionId=auth;next()});app.use(nativeComputerRoutes(service))
 const first=await request(app).patch(`/profiles/${p.id}/assistants/${b}`).send({routingNote:'B note'})
 expect(first.status).toBe(200)
 expect(first.body.profile).toMatchObject({enabledAssistantIds:[a],assistantRoutingNotes:{[a]:'Local work',[b]:'B note'}})
 expect(await service.profileBinding(scope,p.id)).toBeNull()
 expect((await db.query<{revoked_at:unknown}>('SELECT revoked_at FROM native_computer_sessions WHERE id=$1',[grant.identity.sessionId])).rows[0].revoked_at).toBeTruthy()
 const second=await request(app).patch(`/profiles/${p.id}/assistants/${a}`).send({routingNote:'Updated A'})
 expect(second.body.profile.enabledAssistantIds).toEqual([a])
 expect(second.body.profile.assistantRoutingNotes).toEqual({[a]:'Updated A',[b]:'B note'})
 expect((await db.query<{assistant_id:string}>('SELECT assistant_id FROM assistant_capabilities')).rows).toEqual([{assistant_id:a}])
})
it.each(['cross-workspace','blocked','not-owner','not-member'] as const)('atomic assistant update denies %s without changing profile grants',async(denial)=>{
 const {p}=await connected(),b=randomUUID(),different=randomUUID()
 await db.query('INSERT INTO workspaces VALUES($1)',[different])
 await db.query('INSERT INTO assistants(id,workspace_id,blocked_user_ids) VALUES($1,$2,$3)',[b,denial==='cross-workspace'?different:w,denial==='blocked'?[u]:[]])
 if(denial==='not-member')await db.query('DELETE FROM workspace_members WHERE user_id=$1',[u])
 await expect(service.profiles.updateAssistant(denial==='not-owner'?other:u,p.id,b,{enabled:true,routingNote:'untrusted'})).rejects.toThrow('unavailable')
 const row=(await db.query<{enabled_assistant_ids:string[];assistant_routing_notes:Record<string,string>}>('SELECT enabled_assistant_ids,assistant_routing_notes FROM computer_profiles WHERE id=$1',[p.id])).rows[0]
 expect(row.enabled_assistant_ids).toEqual([a]);expect(row.assistant_routing_notes).toEqual({[a]:'Local work'})
})
it('atomic assistant update invalidates pending consent without changing connection metadata',async()=>{
 const {p,connectionId}=await connected()
 const pending=await service.profiles.request(scope,p.id)
 await service.profiles.updateAssistant(u,p.id,a,{routingNote:'Revised local instructions'})
 expect((await db.query<{state:string}>('SELECT state FROM computer_profile_requests WHERE id=$1',[pending.requestId])).rows[0].state).toBe('ended')
 expect(await service.profiles.poll(u,auth,p.id,connectionId)).toEqual({request:null})
 expect((await service.profiles.list(u,w))[0].enabledAssistantIds).toEqual([a])
})

function metadataApp(userId=u,sessionId:string|undefined=auth) {
 const app=express();app.use(express.json())
 app.use((req,_res,next)=>{req.userId=userId;req.authSessionId=sessionId;next()})
 app.use(nativeComputerRoutes(null))
 return app
}
it('disabled execution still supports production SQL metadata CRUD and atomic grants, without authority',async()=>{
 const app=metadataApp()
 const created=await request(app).post('/profiles').send({workspaceId:w,name:'Offline Mac'})
 expect(created.status).toBe(201)
 const p=created.body.profile
 expect(p).toEqual({id:expect.any(String),workspaceId:w,name:'Offline Mac',enabledAssistantIds:[],assistantRoutingNotes:{},deviceId:null,connected:false,canManage:true})
 const list=await request(app).get('/profiles').query({workspaceId:w})
 expect(list.headers['cache-control']).toBe('no-store');expect(list.body).toEqual({profiles:[p]})
 expect((await request(app).patch(`/profiles/${p.id}`).send({name:'Renamed'})).body.profile.name).toBe('Renamed')
 expect((await request(app).patch(`/profiles/${p.id}/assistants/${a}`).send({enabled:true,routingNote:'Local'})).body.profile).toMatchObject({enabledAssistantIds:[a],assistantRoutingNotes:{[a]:'Local'}})
 for(const suffix of ['connect','poll','disconnect',`requests/${chat}/accept`,`requests/${chat}/deny`]) {
  const body=suffix==='connect'?{workspaceId:w,deviceId:'device'}:suffix.endsWith('/accept')?{connectionId:chat,challenge:'x'.repeat(43)}:{connectionId:chat}
  const path=`/profiles/${p.id}/${suffix}`
  for(const header of ['Origin','Sec-Fetch-Site']) expect((await request(app).post(path).set(header,'renderer').send(body)).status).toBe(403)
  const result=await request(app).post(path).send(body)
  expect(result.status).toBe(503);expect(result.headers['cache-control']).toBe('no-store')
  expect(result.body).toEqual({code:'native_execution_unavailable',error:'Native computer execution unavailable'})
 }
 expect((await request(app).post(`/profiles/${p.id}/requests/${chat}/accept`).send({connectionId:chat,challenge:'bad'})).status).toBe(400)
 expect((await db.query('SELECT connection_id,device_id FROM computer_profiles')).rows).toEqual([{connection_id:null,device_id:null}])
 expect((await db.query('SELECT * FROM native_computer_sessions')).rows).toEqual([])
 expect((await db.query('SELECT * FROM computer_profile_requests')).rows).toEqual([])
 expect((await request(app).delete(`/profiles/${p.id}`)).body).toEqual({ok:true})
 expect((await request(app).get('/profiles').query({workspaceId:w})).body).toEqual({profiles:[]})
})
it('disabled metadata denies foreign owners, assistants, workspaces and former members without leaking details',async()=>{
 const p=await service.profiles.create(u,w,'Private')
 for(const [app,path,body] of [
  [metadataApp(other),`/profiles/${p.id}`,{name:'steal'}],
  [metadataApp(),`/profiles/${p.id}/assistants/${randomUUID()}`,{enabled:true}],
 ] as const) {
  const result=await request(app).patch(path).send(body)
  expect(result.status).toBe(403);expect(result.body).toEqual({code:'computer_profiles_forbidden',error:'Profile unavailable'})
 }
 expect((await request(metadataApp(other)).get('/profiles').query({workspaceId:w})).body).toEqual({profiles:[]})
 const foreign=await request(metadataApp()).post('/profiles').send({workspaceId:randomUUID(),name:'Forbidden'})
 expect(foreign.status).toBe(403);expect(foreign.body.code).toBe('computer_profiles_forbidden')
 await db.query('DELETE FROM workspace_members WHERE user_id=$1',[u])
 expect((await request(metadataApp()).delete(`/profiles/${p.id}`)).status).toBe(403)
 const noSession=metadataApp(u,'')
 expect((await request(noSession).get('/profiles').query({workspaceId:w})).body.code).toBe('computer_profiles_forbidden')
})
it('disabled metadata reports missing SQL migrations before permission evaluation and hides storage errors',async()=>{
 const app=metadataApp()
 for(const [original,renamed] of [['computer_profiles','missing_profiles'],['assistant_routing_notes','missing_notes']]) {
  const table=original==='computer_profiles'
  await db.exec(table?`ALTER TABLE ${original} RENAME TO ${renamed}`:`ALTER TABLE computer_profiles RENAME COLUMN ${original} TO ${renamed}`)
  try {
   // No matching owner/profile: schema failure must not become a permission denial.
   const result=await request(app).patch(`/profiles/${randomUUID()}`).send({name:'x'})
   expect(result.status).toBe(503)
   expect(result.body).toEqual({code:'computer_profiles_schema_unavailable',error:'Computer profiles schema unavailable'})
  } finally {
   await db.exec(table?`ALTER TABLE ${renamed} RENAME TO ${original}`:`ALTER TABLE computer_profiles RENAME COLUMN ${renamed} TO ${original}`)
  }
 }
 vi.mocked(query).mockRejectedValueOnce(new Error('SQL password=private SELECT secret'))
 const result=await request(app).post('/profiles').send({workspaceId:w,name:'x'})
 expect(result.status).toBe(503)
 expect(result.body).toEqual({code:'computer_profiles_unavailable',error:'Profiles unavailable'})
})
it('disabled metadata grant edits still revoke existing SQL execution authority',async()=>{
 const {p}=await paired()
 const result=await request(metadataApp()).patch(`/profiles/${p.id}/assistants/${a}`).send({enabled:false})
 expect(result.status).toBe(200)
 expect((await db.query('SELECT revoked_at FROM native_computer_sessions')).rows[0]).toMatchObject({revoked_at:expect.anything()})
 expect((await db.query('SELECT state FROM computer_profile_requests')).rows).toEqual([{state:'ended'}])
})
