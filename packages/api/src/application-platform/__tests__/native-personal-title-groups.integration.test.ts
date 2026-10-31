import {randomUUID} from 'node:crypto'
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest'
import type {PoolClient} from 'pg'
import pg from 'pg'
import {ContextScopeAccumulator,boundScopeSources,type ScopeSource} from '@use-brian/core'
import {applyRLSGucs,getAppPool,getPool,rollbackAndRelease,runWithAgentAccess} from '../../db/client.js'
import {findAssistantById} from '../../db/users.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {createPersonalWebSession,readSessionById} from '../../db/sessions.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {listWorkspaceFilesIndexRanked} from '../../db/workspace-files.js'
import * as titles from '../../db/session-title-store.js'
import {resolveSessionTitleAuthority,sessionTitleProjections} from '../../routes/session-title-authority.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
import * as executionContexts from '../../context-scope/execution-context.js'
import * as queries from '../../db/session-query-reader.js'
import {readValidatedNativeTitleGroup} from '../../context-scope/caller-evidence.js'
import {readNativeTitleGroupFrame,readRetainedContextFrame} from '../../db/session-context-revisions.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
let f:Awaited<ReturnType<typeof persistentContextFixture>>
let claims:{userId:string;sessionId:string;authVersion:number}
const heads:{sessionId:string;revisionId:string;title:string}[]=[]
let files:ScopeSource[]
let singleTitleFile:ScopeSource
let guardDefinition:string
const originalGrouped=titles.readSessionTitlesGrouped
async function authority(sessionId=heads[0].sessionId,readOnly=true){return resolveSessionTitleAuthority({claims,sessionId,readOnly})}
async function frame<T>(run:(client:PoolClient)=>Promise<T>){
 const a=await authority(),client=await getAppPool().connect()
 try{return await runWithAgentAccess(a.execution.security.access,async()=>{
  await client.query('BEGIN');await applyRLSGucs(client,f.ownerId)
  await client.query("SELECT set_config('app.v2_assistant_id',$1,true)",[f.assistantId]);return run(client)
 })}finally{await rollbackAndRelease(client)}
}
async function group(client:PoolClient,sessions=heads.map(h=>h.sessionId),revisions=heads.map(h=>h.revisionId)){
 return(await client.query('SELECT read_native_personal_title_group($1,$2,$3) AS value',[f.workspaceId,sessions,revisions])).rows[0].value
}
async function baseline(ids=heads.map(h=>h.sessionId)){
 const spy=vi.spyOn(titles,'readSessionTitlesGrouped').mockResolvedValue(null)
 try{return await sessionTitleProjections({claims,sessionIds:ids})}finally{spy.mockRestore()}
}
async function hold(){await f.pool.query(`INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
 VALUES($1,'workspace_file',$2,$3,'held',1,'Fictional grouped title hold')`,[f.workspaceId,files[0].resourceId,files[0].version])}
async function unhold(){await f.pool.query("DELETE FROM scope_resource_states WHERE workspace_id=$1 AND resource_kind='workspace_file' AND resource_id=$2",[f.workspaceId,files[0].resourceId])}
async function traced<T>(run:()=>Promise<T>){
 const sql:string[]=[],query=pg.Client.prototype.query
 const spy=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:Parameters<typeof query>){
  sql.push(typeof args[0]==='string'?args[0]:String((args[0]as{text?:string})?.text??''))
  return query.apply(this,args)
 }as typeof query)
 try{return{value:await run(),sql}}finally{spy.mockRestore()}
}
async function withoutAcquisition<T>(run:()=>Promise<T>){
 const original=(await f.pool.query("SELECT pg_get_functiondef(oid) definition,prosrc FROM pg_proc WHERE oid='application_native_title_acquisition_helpers_current()'::regprocedure")).rows[0]
 await f.pool.query(original.definition.replace(original.prosrc,'BEGIN RETURN false;END'))
 try{return await run()}finally{await f.pool.query(original.definition)}
}

describe.sequential('[COMP:api/application-persistence] current personal title groups',()=>{
 beforeAll(async()=>{
  f=await persistentContextFixture()
  const auth=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional grouped title browser',userAgent:null,ipAddress:null}))!
  claims={userId:f.ownerId,sessionId:auth.id,authVersion:auth.authVersion}
  await f.pool.query(`INSERT INTO workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity)
   SELECT $1,'/fictional/group-'||n||'.txt','Fictional group file '||n,'fixture://group-'||n,$2,'user','internal' FROM generate_series(1,50) n`,[f.workspaceId,f.ownerId])
  for(let index=0;index<6;index++){
   const session=await createPersonalWebSession({assistantId:f.assistantId,userId:f.ownerId,workspaceId:f.workspaceId,channelType:'web',channelId:randomUUID(),appOrigin:'chat'},
    {actorUserId:f.ownerId,authSessionId:auth.id,authVersion:auth.authVersion})
   const a=await authority(session.id,false)
   if(index===0){
    files=(await listWorkspaceFilesIndexRanked(a.execution.security.access,50)).flatMap(file=>boundScopeSources(file));expect(files).toHaveLength(50)
    const id=(await f.pool.query(`INSERT INTO workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity)
     VALUES($1,'/fictional/individual-title.txt','Fictional individual title file','fixture://individual-title',$2,'user','internal') RETURNING id`,[f.workspaceId,f.ownerId])).rows[0].id
    const source=(await f.pool.query("SELECT read_scope_source($1,'workspace_file',$2) AS source",[f.workspaceId,id])).rows[0].source
    singleTitleFile={workspaceId:source.workspaceId,userId:source.userId,assistantId:source.assistantId,sensitivity:source.sensitivity,
     compartments:source.compartments,projectIds:source.projectIds,resourceKind:'workspace_file',resourceId:id,version:source.version}
   }
   const memory=await createDbMemoryStore().getIndex(a.execution.security.access,false,a)
   const title=await titles.publishSessionTitle({sessionId:session.id,title:'Fictional shared-source title '+index,manual:false,expectedRevision:null,authority:a,
    derivation:{producer:'fixture:grouped-title',sources:[...boundScopeSources(memory),...files,...(index===0?[singleTitleFile]:[])]}})
   expect(title).not.toBeNull();heads.push({sessionId:session.id,revisionId:title!.revisionId,title:title!.title})
  }
  guardDefinition=(await f.pool.query("SELECT pg_get_functiondef('application_native_title_group_helpers_current()'::regprocedure) AS definition")).rows[0].definition
 },120_000)
 afterEach(async()=>{vi.restoreAllMocks();await unhold();await f.pool.query(guardDefinition);await f.pool.query('UPDATE auth_sessions SET revoked_at=NULL WHERE id=$1',[claims.sessionId])})
 afterAll(async()=>{try{await f?.cleanup()}finally{await getAppPool().end();await getPool().end()}})
 it('admits the exact ordered identities under the real non-owner context and matches individual readers',async()=>{
  await frame(async client=>{
   const value=await group(client);expect(value).toHaveLength(heads.length)
   for(const [index,row]of value.entries()){
    expect(row).toMatchObject({sessionId:heads[index].sessionId,revisionId:heads[index].revisionId,content:{title:heads[index].title,manual:false}})
    const original=(await client.query('SELECT read_native_empty_query_session_title_revision($1,$2,$3) AS value',[f.workspaceId,heads[index].sessionId,heads[index].revisionId])).rows[0].value
    expect(row.content).toEqual(original)
   }
  })
 },60_000)
 it('uses one actual group for the full title collection and preserves every bound source',async()=>{
  const baselineStarted=performance.now(),expected=await baseline();console.info('individual-title-collection-ms',performance.now()-baselineStarted)
  const spy=vi.spyOn(titles,'readSessionTitlesGrouped')
  const started=performance.now(),actual=await sessionTitleProjections({claims,sessionIds:heads.map(h=>h.sessionId)})
  console.info('grouped-title-collection-ms',performance.now()-started)
  expect(actual).toEqual(expected);expect(spy).toHaveBeenCalledTimes(1)
  const admitted=await spy.mock.results[0].value;expect(admitted?.size).toBe(heads.length)
  for(const head of heads)expect(boundScopeSources(actual.get(head.sessionId)!)).toMatchObject([{resourceKind:'session_context_revision',resourceId:head.revisionId,version:'1'}])
 },90_000)
 it('shares one acquisition proof with caller validation and retains the separate final output proof',async()=>{
  const ids=heads.slice(0,2).map(head=>head.sessionId)
  const expected=await withoutAcquisition(()=>sessionTitleProjections({claims,sessionIds:ids}))
  const actual=await traced(()=>sessionTitleProjections({claims,sessionIds:ids}))
  expect(actual.value).toEqual(expected)
  expect(actual.sql.filter(sql=>sql.includes('SELECT read_native_personal_title_group_evidence('))).toHaveLength(1)
  expect(actual.sql.filter(sql=>sql.includes('SELECT read_native_personal_title_group('))).toHaveLength(0)
  expect(actual.sql.filter(sql=>sql.includes('SELECT read_native_file_session_evidence('))).toHaveLength(1)
  for(const id of ids)expect(boundScopeSources(actual.value.get(id)!)).toEqual(boundScopeSources(expected.get(id)!))
 },90_000)
 it('retains the original caller scalar floor before invoking identity-only acquisition',async()=>{
  const selected=heads.slice(0,2),a=await authority()
  const sources=(await f.pool.query("SELECT read_scope_source($1,'session_context_revision',id) AS source FROM unnest($2::uuid[]) id",
   [f.workspaceId,selected.map(head=>head.revisionId)])).rows.map(row=>{
    const{held,validTo,retractedAt,...source}=row.source;return source as ScopeSource
   })
  expect(sources.every(source=>source.compartments.length===0)).toBe(true)
  await frame(async client=>{
   const result=await traced(async()=>{
    await expect(readValidatedNativeTitleGroup(selected,{sources,compartments:['fictional-ungranted']},
     {...a.execution.security.ceiling,compartments:[],departmentRead:undefined},client)).rejects.toMatchObject({reason:'caller_evidence_unavailable'})
   })
   expect(result.sql.some(sql=>sql.includes('read_native_personal_title_group_evidence'))).toBe(false)
  })
 })
 it('declines acquisition before payload selection when SQL access exceeds the original caller ceiling',async()=>{
  const selected:{sessionId:string;revisionId:string}[]=[]
  const fileId=(await f.pool.query(`INSERT INTO workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity)
   VALUES($1,'/fictional/narrow-title.txt','Fictional narrow title file','fixture://narrow-title',$2,'user','internal') RETURNING id`,[f.workspaceId,f.ownerId])).rows[0].id
  for(let index=0;index<2;index++){
   const created=await createPersonalWebSession({assistantId:f.assistantId,userId:f.ownerId,workspaceId:f.workspaceId,channelType:'web',channelId:randomUUID(),appOrigin:'chat'},
    {actorUserId:f.ownerId,authSessionId:claims.sessionId,authVersion:claims.authVersion})
   const original=await authority(created.id,false),session=(await readSessionById(created.id))!
   const maximumAccess={...original.execution.security.ceiling,clearance:'internal' as const}
   const execution=(await executionContexts.resolveExecutionContextSystem({userId:f.ownerId,workspaceId:f.workspaceId,
    assistant:(await findAssistantById(f.assistantId))!,memberMode:'member',sharedAudience:false,session,sessionAuthority:session,
    identity:original.execution.identity,ownership:original.execution.ownership,lifecycle:original.execution.lifecycle,
    maximumAccess,maximumAccessCurrent:async()=>maximumAccess,credentialCurrent:()=>authSessionStore.validateAccess(claims)})).executionContext
   const bounded={execution,accumulator:new ContextScopeAccumulator(execution.security.provenance)}
   const memory=await createDbMemoryStore().getIndex(execution.security.access,false,bounded)
   const file=(await listWorkspaceFilesIndexRanked(execution.security.access,100)).find(row=>boundScopeSources(row).some(source=>source.resourceId===fileId))!
   expect(file).toBeDefined()
   const title=await titles.publishSessionTitle({sessionId:created.id,title:'Fictional internal title '+index,manual:false,expectedRevision:null,authority:bounded,
    derivation:{producer:'fixture:narrow-title',sources:[...boundScopeSources(memory),...boundScopeSources(file)]}})
   expect(title).not.toBeNull();selected.push({sessionId:created.id,revisionId:title!.revisionId})
  }
  const a=await authority(selected[0].sessionId)
  const sources=(await f.pool.query("SELECT read_scope_source($1,'session_context_revision',id) AS source FROM unnest($2::uuid[]) id",
   [f.workspaceId,selected.map(head=>head.revisionId)])).rows.map(row=>{
    const{held,validTo,retractedAt,...source}=row.source;return source as ScopeSource
   })
  expect(sources.every(source=>source.sensitivity!=='confidential')).toBe(true)
  const narrowed={...a,execution:{...a.execution,security:{...a.execution.security,ceiling:{...a.execution.security.ceiling,clearance:'internal' as const}}}}
  await f.pool.query("UPDATE workspace_files SET sensitivity='confidential' WHERE workspace_id=$1 AND id=$2",[f.workspaceId,fileId])
  try{
   const actual=await traced(()=>readNativeTitleGroupFrame(narrowed,selected,sources))
   expect(actual.value).toBeNull();expect(actual.sql.some(sql=>sql.includes('read_native_personal_title_group_evidence'))).toBe(false)
   const payloadReader=vi.fn(async()=>null)
   await expect(readRetainedContextFrame(narrowed,sources,payloadReader)).rejects.toBeDefined()
   expect(payloadReader).not.toHaveBeenCalled()
   expect(await titles.readSessionTitlesGrouped(selected,narrowed)).toBeNull()
  }finally{await f.pool.query("UPDATE workspace_files SET sensitivity='internal' WHERE workspace_id=$1 AND id=$2",[f.workspaceId,fileId])}
 })
 for(const signature of ['native_personal_title_group_acquisition(uuid,uuid[],uuid[])','application_native_title_acquisition_helpers_current()']){
  it(`rejects unknown ${signature} code before invoking it and preserves original title fallback`,async()=>{
   const ids=heads.slice(0,2).map(head=>head.sessionId),expected=await withoutAcquisition(()=>sessionTitleProjections({claims,sessionIds:ids}))
   const original=(await f.pool.query('SELECT pg_get_functiondef(oid) definition,prosrc FROM pg_proc WHERE oid=$1::regprocedure',[signature])).rows[0]
   try{
    await f.pool.query(original.definition.replace(original.prosrc,"BEGIN RAISE EXCEPTION 'fictional_unknown_title_helper_invoked';END"))
    const actual=await traced(()=>sessionTitleProjections({claims,sessionIds:ids}))
    expect(actual.value).toEqual(expected)
    expect(actual.sql.some(sql=>sql.includes('SELECT read_native_personal_title_group('))).toBe(true)
   }finally{await f.pool.query(original.definition)}
  },90_000)
 }
 it('keeps acquisition internals private and declines owner identity-only calls',async()=>{
  for(const signature of ['native_personal_title_group_acquisition(uuid,uuid[],uuid[])','application_native_title_acquisition_helpers_current()']){
   expect((await getAppPool().query("SELECT has_function_privilege(current_user,$1,'EXECUTE') allowed",[signature])).rows[0].allowed).toBe(false)
  }
  expect((await f.pool.query('SELECT read_native_personal_title_group_evidence($1,$2,$3) value',
   [f.workspaceId,heads.map(head=>head.sessionId),heads.map(head=>head.revisionId)])).rows[0].value).toBeNull()
 })
 it('does not widen the original reader audience after a facade-only ACL grant',async()=>{
  const a=await authority(),client=await getPool().connect()
  try{
   await client.query('BEGIN')
   await client.query('CREATE ROLE fictional_title_extra NOLOGIN')
   await client.query('GRANT USAGE ON SCHEMA public TO fictional_title_extra')
   await client.query('GRANT EXECUTE ON FUNCTION read_native_personal_title_group_evidence(uuid,uuid[],uuid[]) TO fictional_title_extra')
   await runWithAgentAccess(a.execution.security.access,()=>applyRLSGucs(client,f.ownerId))
   await client.query("SELECT set_config('app.v2_assistant_id',$1,true)",[f.assistantId])
   expect((await client.query('SELECT application_native_title_acquisition_helpers_current() allowed')).rows[0].allowed).toBe(true)
   await client.query('SET SESSION AUTHORIZATION fictional_title_extra')
   expect((await client.query("SELECT has_function_privilege(session_user,'read_native_personal_title_group(uuid,uuid[],uuid[])','EXECUTE') allowed")).rows[0].allowed).toBe(false)
   expect((await client.query('SELECT read_native_personal_title_group_evidence($1,$2,$3) value',
    [f.workspaceId,heads.map(head=>head.sessionId),heads.map(head=>head.revisionId)])).rows[0].value).toBeNull()
  }finally{await client.query('ROLLBACK');await client.query('RESET SESSION AUTHORIZATION');client.release()}
 })
 it('refuses malformed, duplicate, stale, cross-session and oversized identity groups',async()=>frame(async client=>{
  expect(await group(client,[],[])).toBeNull()
  expect(await group(client,[heads[0].sessionId],[heads[0].revisionId])).toBeNull()
  expect(await group(client,[heads[0].sessionId,heads[0].sessionId],[heads[0].revisionId,heads[0].revisionId])).toBeNull()
  expect(await group(client,heads.map(h=>h.sessionId),[heads[1].revisionId,heads[0].revisionId,heads[2].revisionId])).toBeNull()
  expect(await group(client,heads.map(h=>h.sessionId),[randomUUID(),heads[1].revisionId,heads[2].revisionId])).toBeNull()
  expect(await group(client,Array.from({length:51},()=>randomUUID()),Array.from({length:51},()=>randomUUID()))).toBeNull()
 }))
 it('keeps the guard private, rejects owner calls and does not cache a source hold',async()=>{
  expect((await getAppPool().query("SELECT has_function_privilege(current_user,'application_native_title_group_helpers_current()','EXECUTE') AS allowed")).rows[0].allowed).toBe(false)
  expect((await f.pool.query('SELECT read_native_personal_title_group($1,$2,$3) AS value',[f.workspaceId,heads.map(h=>h.sessionId),heads.map(h=>h.revisionId)])).rows[0].value).toBeNull()
  await frame(async client=>expect(await group(client)).not.toBeNull())
  await hold();await frame(async client=>expect(await group(client)).toBeNull())
  const spy=vi.spyOn(titles,'readSessionTitlesGrouped'),actual=await sessionTitleProjections({claims,sessionIds:heads.map(h=>h.sessionId)})
  expect(spy.mock.calls.length).toBeLessThanOrEqual(3);spy.mockRestore()
  expect(actual).toEqual(await baseline())
 },90_000)
 it('revalidates files after grouped payload capture before collection delivery',async()=>{
  let admitted=false
  vi.spyOn(titles,'readSessionTitlesGrouped').mockImplementation(async(...args)=>{const value=await originalGrouped(...args);if(value){admitted=true;await hold()}return value})
  const actual=await sessionTitleProjections({claims,sessionIds:heads.map(h=>h.sessionId)})
  expect(admitted).toBe(true);expect([...actual.values()].every(value=>value.title===null)).toBe(true)
 },90_000)
 it('revalidates each original credential after grouped payload capture',async()=>{
  vi.spyOn(titles,'readSessionTitlesGrouped').mockImplementation(async(...args)=>{const value=await originalGrouped(...args);if(!value)return value;await f.pool.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1',[claims.sessionId]);return value})
  const actual=await sessionTitleProjections({claims,sessionIds:heads.map(h=>h.sessionId)})
  expect([...actual.values()].every(value=>value.title===null)).toBe(true)
 },90_000)

 it('checks sources after the final awaited original-binding verification',async()=>{
  let captured=false,changed=false
  const resolve=executionContexts.resolveExecutionContextSystem
  vi.spyOn(executionContexts,'resolveExecutionContextSystem').mockImplementation(async(...args)=>{
   const resolved=await resolve(...args)
   if(args[0].lifecycle.sessionId===heads[1].sessionId){
    const lease=resolved.executionContext.security.authority,assertCurrent=lease.assertCurrent.bind(lease)
    vi.spyOn(lease,'assertCurrent').mockImplementation(async()=>{
     await assertCurrent()
     if(captured&&!changed){changed=true;await hold()}
    })
   }
   return resolved
  })
  vi.spyOn(titles,'readSessionTitlesGrouped').mockImplementation(async(...args)=>{
   const value=await originalGrouped(...args)
   if(value)captured=true
   return value
  })
  const actual=await sessionTitleProjections({claims,sessionIds:heads.map(h=>h.sessionId)})
  expect(captured).toBe(true);expect(changed).toBe(true)
  expect([...actual.values()].every(value=>value.title===null)).toBe(true)
 },90_000)

 it('falls back without suppressing unaffected rows when one original title is held',async()=>{
  await f.pool.query(`INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
   VALUES($1,'workspace_file',$2,$3,'held',1,'Fictional individual source hold')`,[f.workspaceId,singleTitleFile.resourceId,singleTitleFile.version])
  try{
   const actual=await sessionTitleProjections({claims,sessionIds:heads.map(h=>h.sessionId)})
   expect(actual.get(heads[0].sessionId)?.title).toBeNull()
   for(const head of heads.slice(1))expect(actual.get(head.sessionId)?.title).toBe(head.title)
   expect(actual).toEqual(await baseline())
  }finally{await f.pool.query("DELETE FROM scope_resource_states WHERE workspace_id=$1 AND resource_kind='workspace_file' AND resource_id=$2",[f.workspaceId,singleTitleFile.resourceId])}
 },90_000)
 it('rechecks all heads after capture and preserves unaffected rows on a real replacement',async()=>{
  const original={...heads[0]};const replacement:{value:titles.SessionTitle|null}={value:null}
  vi.spyOn(titles,'readSessionTitlesGrouped').mockImplementation(async(...args)=>{
   const value=await originalGrouped(...args);if(!value||replacement.value)return value
   expect(value.size).toBe(heads.length)
   replacement.value=await titles.publishSessionTitle({sessionId:original.sessionId,title:'Fictional replacement title',manual:true,expectedRevision:original.revisionId,
    authority:await authority(original.sessionId,false),derivation:{producer:'fixture:title-replacement',sources:boundScopeSources(value!.get(original.sessionId)!)}})
   expect(replacement.value).not.toBeNull();return value
  })
  try{
   const actual=await sessionTitleProjections({claims,sessionIds:heads.map(h=>h.sessionId)})
   expect(actual.get(original.sessionId)?.title).toBeNull()
   for(const head of heads.slice(1))expect(actual.get(head.sessionId)?.title).toBe(head.title)
  }finally{if(replacement.value)heads[0]={sessionId:original.sessionId,revisionId:replacement.value.revisionId,title:replacement.value.title}}
 },90_000)
 it('collects saved titles together after an intervening preview and preserves request order',async()=>{
  await f.history()
  const ids=[heads[0].sessionId,f.session.id,heads[1].sessionId],expected=await baseline(ids)
  const spy=vi.spyOn(titles,'readSessionTitlesGrouped')
  const actual=await sessionTitleProjections({claims,sessionIds:ids})
  expect(spy).toHaveBeenCalledTimes(1);expect((await spy.mock.results[0].value)?.size).toBe(2)
  expect(actual).toEqual(expected);expect([...actual.keys()]).toEqual(ids)
  expect(actual.get(f.session.id)?.title).toBe('Fictional earlier request')
 },90_000)
 it('rechecks saved sources after the intervening preview work before collecting their group',async()=>{
  await f.history()
  const read=queries.readAdmittedSessionQuery
  let changed=false
  vi.spyOn(queries,'readAdmittedSessionQuery').mockImplementation(async input=>{
   const result=await read(input)
   if(input.sessionId===f.session.id&&!changed){changed=true;await hold()}
   return result
  })
  const ids=[heads[0].sessionId,f.session.id,heads[1].sessionId]
  const actual=await sessionTitleProjections({claims,sessionIds:ids})
  expect(changed).toBe(true);expect([...actual.keys()]).toEqual(ids)
  expect(actual.get(heads[0].sessionId)?.title).toBeNull();expect(actual.get(heads[1].sessionId)?.title).toBeNull()
  expect(actual.get(f.session.id)?.title).toBe('Fictional earlier request')
 },90_000)
 it('keeps a metadata-held saved head individual while grouping the remaining current heads',async()=>{
  const session=await createPersonalWebSession({assistantId:f.assistantId,userId:f.ownerId,workspaceId:f.workspaceId,channelType:'web',channelId:randomUUID(),appOrigin:'chat'},
   {actorUserId:f.ownerId,authSessionId:claims.sessionId,authVersion:claims.authVersion})
  const a=await authority(session.id,false),memory=await createDbMemoryStore().getIndex(a.execution.security.access,false,a)
  const held=await titles.publishSessionTitle({sessionId:session.id,title:'Fictional held saved title',manual:false,expectedRevision:null,authority:a,
   derivation:{producer:'fixture:held-title',sources:[...boundScopeSources(memory),...files]}})
  expect(held).not.toBeNull()
  // Canonical retirement is monotonic; this disposable title is not revived.
  await f.pool.query('UPDATE session_context_scope_revisions SET scope_held=true WHERE workspace_id=$1 AND id=$2',[f.workspaceId,held!.revisionId])
  expect((await f.pool.query("SELECT read_scope_source($1,'session_context_revision',$2) AS source",[f.workspaceId,held!.revisionId])).rows[0].source).toEqual({held:true})
  const ids=[heads[0].sessionId,f.session.id,session.id,heads[2].sessionId]
  const expected=await baseline(ids),spy=vi.spyOn(titles,'readSessionTitlesGrouped')
  const actual=await sessionTitleProjections({claims,sessionIds:ids})
  expect(actual).toEqual(expected);expect([...actual.keys()]).toEqual(ids)
  expect(actual.get(session.id)?.title).toBeNull();expect(spy).toHaveBeenCalledTimes(1)
  expect(spy.mock.calls[0][0].map(head=>head.sessionId)).toEqual([heads[0].sessionId,heads[2].sessionId])
  expect((await spy.mock.results[0].value)?.size).toBe(2)
 },90_000)
 it('withholds a saved head replaced during preview work while keeping other grouped titles',async()=>{
  await f.history()
  const original={...heads[0]},read=queries.readAdmittedSessionQuery,replacement:{value:titles.SessionTitle|null}={value:null}
  vi.spyOn(queries,'readAdmittedSessionQuery').mockImplementation(async input=>{
   const result=await read(input)
   if(input.sessionId===f.session.id&&!replacement.value){
    const current=await titles.readSessionTitle(original.sessionId,await authority(original.sessionId))
    expect(current).not.toBeNull()
    replacement.value=await titles.publishSessionTitle({sessionId:original.sessionId,title:'Fictional later collected title',manual:true,
     expectedRevision:original.revisionId,authority:await authority(original.sessionId,false),
     derivation:{producer:'fixture:title-list-replacement',sources:boundScopeSources(current!)}})
    expect(replacement.value).not.toBeNull()
   }
   return result
  })
  try{
   const ids=[heads[0].sessionId,f.session.id,heads[1].sessionId],actual=await sessionTitleProjections({claims,sessionIds:ids})
   expect(replacement.value).not.toBeNull();expect([...actual.keys()]).toEqual(ids)
   expect(actual.get(original.sessionId)?.title).toBeNull();expect(actual.get(heads[1].sessionId)?.title).toBe(heads[1].title)
   expect(actual.get(f.session.id)?.title).toBe('Fictional earlier request')
  }finally{if(replacement.value)heads[0]={sessionId:original.sessionId,revisionId:replacement.value.revisionId,title:replacement.value.title}}
 },90_000)
 it('rejects an unsupported no-file title group and retains all individual title values',async()=>{
  const session=await createPersonalWebSession({assistantId:f.assistantId,userId:f.ownerId,workspaceId:f.workspaceId,channelType:'web',channelId:randomUUID(),appOrigin:'chat'},
   {actorUserId:f.ownerId,authSessionId:claims.sessionId,authVersion:claims.authVersion})
  const a=await authority(session.id,false),memory=await createDbMemoryStore().getIndex(a.execution.security.access,false,a)
  const title=await titles.publishSessionTitle({sessionId:session.id,title:'Fictional no-file title',manual:false,expectedRevision:null,authority:a,
   derivation:{producer:'fixture:no-file-title',sources:boundScopeSources(memory)}})
  expect(title).not.toBeNull()
  const ids=[heads[0].sessionId,session.id],revisions=[heads[0].revisionId,title!.revisionId]
  await frame(async client=>expect(await group(client,ids,revisions)).toBeNull())
  const expected=await baseline(ids),spy=vi.spyOn(titles,'readSessionTitlesGrouped')
  expect(await sessionTitleProjections({claims,sessionIds:ids})).toEqual(expected)
  expect(spy).toHaveBeenCalledTimes(1);expect(await spy.mock.results[0].value).toBeNull()
 },90_000)
 for(const change of ['body','ACL']as const)it(`rejects canonical helper ${change} drift before grouped payload selection`,async()=>{
  const signature='read_session_title_revision(uuid,uuid,uuid)',original=(await f.pool.query('SELECT pg_get_functiondef(oid) AS definition,prosrc FROM pg_proc WHERE oid=$1::regprocedure',[signature])).rows[0]
  try{
   if(change==='body')await f.pool.query(original.definition.replace(original.prosrc,()=>"BEGIN RAISE EXCEPTION 'Unknown canonical helper invoked';END"))
   else await f.pool.query('GRANT EXECUTE ON FUNCTION '+signature+' TO PUBLIC')
   await frame(async client=>expect(await group(client)).toBeNull())
  }finally{await f.pool.query(original.definition);if(change==='ACL')await f.pool.query('REVOKE EXECUTE ON FUNCTION '+signature+' FROM PUBLIC')}
 })
 it('falls back through the real individual readers when the group guard rejects a changed helper',async()=>{
  await f.pool.query("ALTER FUNCTION read_native_personal_title_group(uuid,uuid[],uuid[]) COST 101")
  try{await frame(async client=>expect(await group(client)).toBeNull());expect(await sessionTitleProjections({claims,sessionIds:heads.map(h=>h.sessionId)})).toEqual(await baseline())}
  finally{await f.pool.query("ALTER FUNCTION read_native_personal_title_group(uuid,uuid[],uuid[]) COST 100")}
 },90_000)
})
