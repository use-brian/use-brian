import {randomUUID} from 'node:crypto'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import express from 'express'
import request from 'supertest'
import type {PoolClient} from 'pg'
import {boundScopeSources,executionToolContext,type SessionContextAuthority} from '@use-brian/core'
import {applyRLSGucs,getAppPool,getPool,rollbackAndRelease,runWithAgentAccess} from '../../db/client.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {addSessionMessage,createPersonalWebSession} from '../../db/sessions.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {listWorkspaceFilesIndexRanked} from '../../db/workspace-files.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {publishNativeSessionMessageBatch} from '../../db/session-message-publication.js'
import {resolveSessionTitleAuthority} from '../../routes/session-title-authority.js'
import {readAttendedSessionHistory} from '../../routes/attended-session-context.js'
import {assertSourceModelInputAuthority} from '../model-source-authority.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
import {createTokens} from '../../auth/jwt.js'
import {requireAuth} from '../../auth/middleware.js'
import {sessionDisplayHistoryRoutes} from '../../routes/session-display-history.js'
import {readPrivateSessionDisplay} from '../../db/session-display-history.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

type DisplayRow={id:string;sequence:number;role:'user'|'assistant';timestamp:string;available:boolean;content?:unknown}
type Display={sessionId:string;workspaceId:string;mode:'personal_transcript_display';rows:DisplayRow[];nextSequence:number|null}

describe.sequential('[COMP:api/session-display-history] durable personal transcript display',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 afterEach(async()=>{await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})

 async function setup(originalMemories=0,configure?:(f:Awaited<ReturnType<typeof persistentContextFixture>>)=>Promise<void>,member=false){
  fixture=await persistentContextFixture('confidential');const f=member?{...fixture,ownerId:fixture.secondId}:fixture
  await f.pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1',[f.workspaceId])
  const createdDevice=await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional transcript browser',userAgent:'Fixture',ipAddress:'127.0.0.1'})
  if(!createdDevice)throw new Error('Missing fixture device')
  const device=createdDevice
  const claims={userId:f.ownerId,sessionId:device.id,authVersion:device.authVersion}
  const session=await createPersonalWebSession({assistantId:f.assistantId,userId:f.ownerId,workspaceId:f.workspaceId,
   channelType:'web',channelId:randomUUID(),appOrigin:'chat'},
   {actorUserId:f.ownerId,authSessionId:device.id,authVersion:device.authVersion})
  const scope={...f.envelope,userId:f.ownerId,assistantId:null}
  const input=await addSessionMessage({sessionId:session.id,role:'user',content:[{type:'text',text:'Fictional authored request'}],
   senderUserId:f.ownerId,scope})
  const memories=[]
  for(let index=0;index<originalMemories;index++)memories.push(await f.memory(`Fictional original memory ${index}`,f.ownerId))
  await configure?.(f)
  const authority=await resolveSessionTitleAuthority({claims,sessionId:session.id,readOnly:false})
  const query=await readAdmittedSessionQuery({sessionId:session.id,throughSequence:input.sequenceNum,authority})
  const index=await createDbMemoryStore().getIndex(authority.execution.security.access,false,authority)
  expect(index).toHaveLength(originalMemories)
  const sources=[...boundScopeSources(query),...boundScopeSources(index)]
  authority.accumulator.note({sources})
  const [reply]=await publishNativeSessionMessageBatch({sessionId:session.id,authority,derivationTarget:scope,
   derivation:{producer:'fixture:personal-transcript',sources},
   messages:[{role:'assistant',senderAssistantId:f.assistantId,content:[{type:'text',text:'Fictional published reply'}]}]})
  async function fresh(){return resolveSessionTitleAuthority({claims,sessionId:session.id,readOnly:true})}
  async function display(options:{actor?:string;device?:string;version?:number;workspace?:string;session?:string;after?:number;limit?:number;authority?:SessionContextAuthority;ownerPool?:boolean}={}){
   const current=options.authority??authority,actor=options.actor??f.ownerId,db=await(options.ownerPool?getPool():getAppPool()).connect()
   try{return await runWithAgentAccess({...current.execution.security.access,userId:actor,
    ...(current.execution.security.access.departmentRead?{departmentRead:{...current.execution.security.access.departmentRead,userId:actor}}:{})},async()=>{
     await db.query('BEGIN');await applyRLSGucs(db,actor)
     await db.query("SELECT set_config('app.v2_assistant_id',$1,true)",[current.execution.assistant.id])
     return(await db.query<{value:Display|null}>('SELECT read_private_session_display($1,$2,$3,$4,$5,$6) AS value',
      [options.workspace??f.workspaceId,options.session??session.id,options.device??device.id,
       options.version??device.authVersion,options.after??0,options.limit??100])).rows[0].value
    })}finally{await rollbackAndRelease(db)}
  }
  return{f,device,claims,session,input,reply,memories,authority,fresh,display}
 }

 it.each([0,1])('keeps published replies after an original %s-memory cohort grows while model evidence stays current',async count=>{
  const c=await setup(count)
  expect((await readAttendedSessionHistory(await c.fresh(),c.session.id)).map(row=>row.id)).toContain(c.reply.id)
  const before=await c.display({authority:await c.fresh()})
  expect(before).toMatchObject({sessionId:c.session.id,workspaceId:c.f.workspaceId,mode:'personal_transcript_display',
   rows:[{id:c.input.id,available:true},{id:c.reply.id,available:true}]})
  await c.f.memory('Fictional later independent memory',c.f.ownerId)
  const after=await c.display({authority:await c.fresh()})
  expect(after?.rows).toEqual(before?.rows)
  expect(after?.rows[1].content).toEqual([{type:'text',text:'Fictional published reply'}])
  // Display is a separate purpose. A cached absence cannot authorize a new model turn.
  await expect(assertSourceModelInputAuthority({...executionToolContext(c.authority.execution,{appId:'fictional-current-model'}),
   scopeAccumulator:c.authority.accumulator})).rejects.toMatchObject({reason:'authority_changed'})
  const modelHistory=await readAttendedSessionHistory(await c.fresh(),c.session.id)
  expect(modelHistory.map(row=>row.id)).not.toContain(c.reply.id)
  expect(JSON.stringify(after)).not.toContain('resourceKind')
 })

 it('keeps delivered replies when an upstream memory is held',async()=>{
  const c=await setup(1)
  await c.f.memory('Fictional independent growth before source withdrawal',c.f.ownerId)
  expect((await c.display())?.rows.find(row=>row.id===c.reply.id)?.available).toBe(true)
  await c.f.pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[c.memories[0].id])
  const result=await c.display()
  expect(result?.rows.find(row=>row.id===c.input.id)?.available).toBe(true)
  expect(result?.rows.find(row=>row.id===c.reply.id)).toMatchObject({id:c.reply.id,sequence:c.reply.sequenceNum,role:'assistant',available:true,
   content:[{type:'text',text:'Fictional published reply'}]})
 })

 it('preserves later replies whose original history inherits an earlier empty memory cohort',async()=>{
  const c=await setup(),scope={...c.f.envelope,userId:c.f.ownerId,assistantId:null}
  for(const name of ['first','second'])await c.f.pool.query(`INSERT INTO workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity)
   VALUES($1,$2,$3,$4,$5,'user','internal')`,[c.f.workspaceId,`/fictional-${name}.txt`,`Fictional ${name} input`,`fixture://${name}`,c.f.ownerId])
  const laterInput=await addSessionMessage({sessionId:c.session.id,role:'user',content:[{type:'text',text:'Fictional later request'}],
   senderUserId:c.f.ownerId,scope})
  const authority=await resolveSessionTitleAuthority({claims:c.claims,sessionId:c.session.id,readOnly:false}),query=await readAdmittedSessionQuery({sessionId:c.session.id,
   throughSequence:laterInput.sequenceNum,authority})
  expect(query.history.map(row=>row.id)).toContain(c.reply.id)
  const files=await listWorkspaceFilesIndexRanked(authority.execution.security.access,10)
  expect(files).toHaveLength(2)
  const sources=[...boundScopeSources(query),...files.flatMap(boundScopeSources)]
  authority.accumulator.note({sources})
  const [laterReply]=await publishNativeSessionMessageBatch({sessionId:c.session.id,authority,derivationTarget:scope,
   derivation:{producer:'fixture:inherited-personal-transcript',sources},
   messages:[{role:'assistant',senderAssistantId:c.f.assistantId,content:[{type:'text',text:'Fictional later published reply'}]}]})
  await c.f.memory('Fictional memory added after both replies',c.f.ownerId)
  const display=await c.display({authority:await c.fresh()})
  expect(display?.rows.map(row=>row.id)).toEqual([c.input.id,c.reply.id,laterInput.id,laterReply.id])
  expect(display?.rows.every(row=>row.available)).toBe(true)
  expect(display?.rows.at(-1)?.content).toEqual([{type:'text',text:'Fictional later published reply'}])
  const modelHistory=await readAttendedSessionHistory(await c.fresh(),c.session.id)
  expect(modelHistory.map(row=>row.id)).toEqual([c.input.id,laterInput.id])
 })

 it('withholds an explicitly held message without erasing the rest of the conversation',async()=>{
  const c=await setup()
  await c.f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[c.input.id])
  const result=await c.display()
  expect(result?.rows).toHaveLength(2)
  expect(result?.rows.find(row=>row.id===c.input.id)).toMatchObject({available:false,content:null})
  expect(result?.rows.find(row=>row.id===c.reply.id)).toMatchObject({available:true})
 })

 it('keeps a delivered reply after the original request is edited',async()=>{
  const c=await setup()
  const before=(await c.f.pool.query('SELECT scope_version FROM session_messages WHERE id=$1',[c.input.id])).rows[0].scope_version
  await c.f.pool.query('UPDATE session_messages SET content=$2 WHERE id=$1',
   [c.input.id,JSON.stringify([{type:'text',text:'Fictional edited original request'}])])
  expect(Number((await c.f.pool.query('SELECT scope_version FROM session_messages WHERE id=$1',[c.input.id])).rows[0].scope_version)).toBeGreaterThan(Number(before))
  const display=await c.display()
  expect(display?.rows.find(row=>row.id===c.reply.id)).toMatchObject({available:true})
  expect(JSON.stringify(display)).toContain('Fictional published reply')
 })

 it('keeps a delivered reply after its memory source is edited',async()=>{
  const c=await setup(1)
  await c.f.pool.query('UPDATE memories SET summary=$2,scope_version=scope_version+1 WHERE id=$1',
   [c.memories[0].id,'Fictional replacement of the original memory'])
  const display=await c.display()
  expect(display?.rows.find(row=>row.id===c.input.id)?.available).toBe(true)
  expect(display?.rows.find(row=>row.id===c.reply.id)).toMatchObject({available:true})
  expect(JSON.stringify(display)).toContain('Fictional published reply')
 })

 it('keeps a delivered reply after its memory source is deleted',async()=>{
  const c=await setup(1)
  expect((await c.display())?.rows.find(row=>row.id===c.reply.id)?.available).toBe(true)
  await c.f.pool.query('DELETE FROM memories WHERE id=$1',[c.memories[0].id])
  const display=await c.display()
  const modelHistory=await readAttendedSessionHistory(await c.fresh(),c.session.id)
  expect(modelHistory.map(row=>row.id)).not.toContain(c.reply.id)
  expect(display?.rows.find(row=>row.id===c.input.id)?.available).toBe(true)
  expect(display?.rows.find(row=>row.id===c.reply.id)).toMatchObject({available:true})
  expect(JSON.stringify(display)).toContain('Fictional published reply')
 })

 it('keeps delivered replies when upstream READ policy changes',async()=>{
  let configured:Awaited<ReturnType<typeof persistentContextFixture>>|undefined,registered=false
  try{
   const c=await setup(1,async f=>{
    configured=f
    await f.pool.query(`CREATE TABLE display_memory_policy_fixture(workspace_id uuid PRIMARY KEY,fields jsonb NOT NULL);
     CREATE FUNCTION display_memory_policy_catalog(w uuid,o jsonb,t text) RETURNS jsonb
     LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
      SELECT jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion','display-memory-fixture-v1','policyVersion','1',
       'fieldKeys',to_jsonb(application_memory_field_keys()),'fields',p.fields,
       'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb))
      FROM display_memory_policy_fixture p WHERE p.workspace_id=w $$;
     CREATE FUNCTION display_memory_policy_record(w uuid,o jsonb,t text,i text) RETURNS jsonb
     LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
      SELECT (display_memory_policy_catalog(w,o,t)-'scope')||jsonb_build_object('recordVersion',m.scope_version::text,'source',read_scope_source(w,'memory',m.id))
      FROM memories m WHERE m.workspace_id=w AND m.id=i::uuid $$;
     REVOKE ALL ON FUNCTION display_memory_policy_catalog(uuid,jsonb,text),display_memory_policy_record(uuid,jsonb,text,text) FROM PUBLIC`)
    await f.pool.query(`INSERT INTO display_memory_policy_fixture(workspace_id,fields)
     SELECT $1,jsonb_agg(jsonb_build_object('key',key,'read',CASE WHEN key='summary' THEN '[["summary_reader"]]'::jsonb ELSE '[]'::jsonb END,
      'write','[]'::jsonb,'releaseReadTo','[]'::jsonb,'releaseWriteTo','[]'::jsonb)) FROM unnest(application_memory_field_keys()) key`,[f.workspaceId])
    await f.pool.query(`INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader)
     VALUES('native','1',ARRAY['summary_reader'],'display_memory_policy_record(uuid,jsonb,text,text)'::regprocedure,'display_memory_policy_catalog(uuid,jsonb,text)'::regprocedure)`)
    registered=true
    await f.pool.query(`INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key)
     VALUES($1,'{"kind":"native","moduleKey":"native"}','memory','native')`,[f.workspaceId])
    await f.pool.query(`INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id)
     VALUES($1,'native',$2,'summary_reader',$2)`,[f.workspaceId,f.ownerId])
   })
   expect((await c.display({authority:await c.fresh()}))?.rows.find(row=>row.id===c.reply.id)?.available).toBe(true)
   const sourceBefore=(await c.f.pool.query('SELECT scope_version,scope_held,summary FROM memories WHERE id=$1',[c.memories[0].id])).rows[0]
   await c.f.pool.query("UPDATE application_native_role_assignments SET status='revoked' WHERE workspace_id=$1 AND user_id=$2 AND module_key='native'",[c.f.workspaceId,c.f.ownerId])
   expect((await c.f.pool.query('SELECT scope_version,scope_held,summary FROM memories WHERE id=$1',[c.memories[0].id])).rows[0]).toEqual(sourceBefore)
   const display=await c.display({authority:await c.fresh()})
   expect(display?.rows.find(row=>row.id===c.input.id)?.available).toBe(true)
   expect(display?.rows.find(row=>row.id===c.reply.id)).toMatchObject({available:true})
   expect(JSON.stringify(display)).toContain('Fictional published reply')
  }finally{
   if(configured){
    await configured.pool.query("DELETE FROM application_native_resource_owners WHERE workspace_id=$1 AND module_key='native'",[configured.workspaceId])
    await configured.pool.query("DELETE FROM application_native_role_assignments WHERE workspace_id=$1 AND module_key='native'",[configured.workspaceId])
    if(registered)await configured.pool.query("DELETE FROM application_native_field_contracts WHERE module_key='native'")
    await configured.pool.query('DROP FUNCTION IF EXISTS display_memory_policy_record(uuid,jsonb,text,text); DROP FUNCTION IF EXISTS display_memory_policy_catalog(uuid,jsonb,text); DROP TABLE IF EXISTS display_memory_policy_fixture')
   }
  }
 })

 it('keeps an ordinary member own conversation readable after source changes without granting other members access',async()=>{
  const c=await setup(1,undefined,true)
  await c.f.pool.query('DELETE FROM memories WHERE id=$1',[c.memories[0].id])
  expect((await c.display({authority:await c.fresh()}))?.rows.every(row=>row.available)).toBe(true)
  const other=await authSessionStore.create(c.f.firstId,{deviceLabel:'Fictional member device',userAgent:null,ipAddress:null})
  if(!other)throw new Error('Missing other member device')
  await expect(c.display({actor:c.f.firstId,device:other.id,version:other.authVersion})).rejects.toMatchObject({code:'42501'})
 })

 it('keeps an older null-surface personal web conversation readable',async()=>{
  const c=await setup(1)
  await c.f.pool.query('UPDATE sessions SET app_origin=NULL WHERE id=$1',[c.session.id])
  await c.f.pool.query('DELETE FROM memories WHERE id=$1',[c.memories[0].id])
  expect((await c.display({authority:await c.fresh()}))?.rows.every(row=>row.available)).toBe(true)
 })

 it('refuses another member, another device owner, missing or revoked devices and stale device versions',async()=>{
  const c=await setup(),other=await authSessionStore.create(c.f.secondId,{deviceLabel:'Fictional other device',userAgent:null,ipAddress:null})
  if(!other)throw new Error('Missing other fixture device')
  await expect(c.display({actor:c.f.secondId,device:other.id,version:other.authVersion})).rejects.toMatchObject({code:'42501'})
  await expect(c.display({device:other.id,version:other.authVersion})).rejects.toMatchObject({code:'42501'})
  await expect(c.display({device:randomUUID()})).rejects.toMatchObject({code:'42501'})
  await expect(c.display({version:c.device.authVersion+1})).rejects.toMatchObject({code:'42501'})
  await authSessionStore.revokeForUser(c.f.ownerId,c.device.id)
  await expect(c.display()).rejects.toMatchObject({code:'42501'})
 })

 it('refuses a foreign workspace and a shared conversation without broadening the display purpose',async()=>{
  const c=await setup()
  await expect(c.display({workspace:randomUUID()})).rejects.toMatchObject({code:'42501'})
  await expect(c.display({session:c.f.session.id})).rejects.toMatchObject({code:'42501'})
 })

 it('still denies a message assigned to a different owner and a private chat under recording privacy hold',async()=>{
  const c=await setup()
  await c.f.pool.query('UPDATE session_messages SET user_id=$2 WHERE id=$1',[c.reply.id,c.f.firstId])
  expect((await c.display())?.rows.find(row=>row.id===c.reply.id)).toMatchObject({available:false,content:null})
  await c.f.pool.query('UPDATE sessions SET recording_privacy_held=true WHERE id=$1',[c.session.id])
  await expect(c.display()).rejects.toMatchObject({code:'42501'})
 })

 it('still denies historical display after workspace membership is revoked',async()=>{
  const c=await setup()
  await c.f.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[c.f.workspaceId,c.f.ownerId])
  await expect(c.display()).rejects.toMatchObject({code:'42501'})
 })

 it('keeps relaxed helpers private and refuses owner-role impersonation at the public entry',async()=>{
  const c=await setup()
  const helpers=(await getAppPool().query<{name:string;callable:boolean;public_execute:boolean}>(`SELECT p.proname AS name,
   has_function_privilege(current_user,p.oid,'EXECUTE') AS callable,
   EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND starts_with(p.proname,'private_session_display_') ORDER BY p.proname`)).rows
  expect(helpers.length).toBeGreaterThan(0)
  for(const helper of helpers)expect(helper,helper.name).toMatchObject({callable:false,public_execute:false})
  await expect(c.display({ownerPool:true})).rejects.toMatchObject({code:'42501'})
  expect((await c.display())?.rows.every(row=>row.available)).toBe(true)
 })

 it('paginates stable positions, including unavailable replies, without duplicating earlier rows',async()=>{
  const c=await setup(1)
  await c.f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[c.reply.id])
  const first=await c.display({limit:1})
  expect(first?.rows.map(row=>row.id)).toEqual([c.input.id])
  expect(first?.nextSequence).toBe(c.input.sequenceNum)
  const second=await c.display({after:first!.nextSequence!,limit:1})
  expect(second?.rows).toHaveLength(1)
  expect(second?.rows[0]).toMatchObject({id:c.reply.id,available:false})
  const end=await c.display({after:c.reply.sequenceNum,limit:1})
  expect(end?.rows).toEqual([])
 })

 it('serves the authenticated HTTP display as text after memory growth without exposing content blocks or source evidence',async()=>{
  const c=await setup(1),secret='fictional-transcript-http-secret'
  const token=createTokens(c.f.ownerId,secret,c.device).accessToken
  const app=express()
  app.use('/api/sessions/:id/display-history',requireAuth(secret),sessionDisplayHistoryRoutes())
  const read=()=>request(app).get(`/api/sessions/${c.session.id}/display-history`).query({workspaceId:c.f.workspaceId})
   .set('Authorization',`Bearer ${token}`)
  await c.f.memory('Fictional later memory for human HTTP display',c.f.ownerId)
  const visible=await read()
  expect(visible.status).toBe(200)
  expect(visible.headers['cache-control']).toBe('no-store')
  expect(visible.body).toMatchObject({mode:'personal_transcript_display',rows:[
   {id:c.input.id,available:true,text:'Fictional authored request'},
   {id:c.reply.id,available:true,text:'Fictional published reply'},
  ]})
  for(const row of visible.body.rows){expect(row).not.toHaveProperty('content');expect(row).not.toHaveProperty('source')}
  expect(JSON.stringify(visible.body)).not.toContain('resourceKind')
  await c.f.pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[c.memories[0].id])
  expect((await read()).body.rows.find((row:DisplayRow)=>row.id===c.reply.id)).toMatchObject({available:true,text:'Fictional published reply'})
  await c.f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[c.reply.id])
  const held=await read()
  expect(held.status).toBe(200)
  expect(held.body.rows.find((row:DisplayRow)=>row.id===c.reply.id)).toMatchObject({available:false,text:null})
  expect(JSON.stringify(held.body)).not.toContain('Fictional published reply')
  await authSessionStore.revokeForUser(c.f.ownerId,c.device.id)
  expect((await read()).status).toBe(401)
 })

 it('does not make human history depend on the current model evaluator implementation',async()=>{
  const c=await setup(),signature='public.application_session_eval_scope(uuid,text,uuid,text,jsonb)'
  const original=(await c.f.pool.query<{definition:string}>('SELECT pg_get_functiondef($1::regprocedure) AS definition',[signature])).rows[0].definition
  const changed=original.replace('\nBEGIN\n','\nBEGIN\n RETURN NULL;\n')
  expect(changed).not.toBe(original)
  try{
   await c.f.pool.query(changed)
   expect((await c.display())?.rows.every(row=>row.available)).toBe(true)
  }finally{await c.f.pool.query(original)}
  expect((await c.display())?.rows.every(row=>row.available)).toBe(true)
 })

 it('keeps direct message authority locked through the actual display store commit',async()=>{
  const c=await setup(1),writer=await getPool().connect()
  let release!:()=>void,captured!:()=>void,paused=false
  const gate=new Promise<void>(resolve=>{release=resolve}),capture=new Promise<void>(resolve=>{captured=resolve})
  const queries=new Map<PoolClient,PoolClient['query']>()
  const trace=(client:PoolClient)=>{
   if(queries.has(client))return
   const original=client.query;queries.set(client,original)
   client.query=function(...args:unknown[]){
    const result=Reflect.apply(original,client,args)
    if(!paused&&typeof args[0]==='string'&&args[0].includes('SELECT read_private_session_display(')){
     paused=true
     return Promise.resolve(result).then(async value=>{captured();await gate;return value})
    }
    return result
   } as typeof client.query
  }
  let reading:ReturnType<typeof readPrivateSessionDisplay>|undefined,holding:Promise<unknown>|undefined
  try{
   await writer.query('BEGIN')
   await writer.query("SET LOCAL statement_timeout='10s'")
   const pid=(await writer.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid
   getAppPool().on('acquire',trace)
   reading=readPrivateSessionDisplay({claims:c.claims,workspaceId:c.f.workspaceId,sessionId:c.session.id,afterSequence:0,limit:100})
   await Promise.race([capture,reading.then(()=>{throw new Error('Display completed without the capture boundary')})])
   holding=writer.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[c.reply.id])
   await expect.poll(async()=>(await c.f.pool.query<{blocked:boolean}>(
    'SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid])).rows[0].blocked,{timeout:3000}).toBe(true)
   release()
   expect((await reading).rows.find(row=>row.id===c.reply.id)).toMatchObject({available:true,text:'Fictional published reply'})
   await holding;await writer.query('COMMIT')
   const next=await readPrivateSessionDisplay({claims:c.claims,workspaceId:c.f.workspaceId,sessionId:c.session.id,afterSequence:0,limit:100})
   expect(next.rows.find(row=>row.id===c.reply.id)).toMatchObject({available:false,text:null})
  }finally{
   release();getAppPool().off('acquire',trace)
   for(const[client,query]of queries)client.query=query
   await reading?.catch(()=>{});await holding?.catch(()=>{});await rollbackAndRelease(writer)
  }
 })
})
