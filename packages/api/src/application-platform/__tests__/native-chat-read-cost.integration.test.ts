import {readFile,writeFile} from 'node:fs/promises'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import express from 'express'
import request from 'supertest'
import {bindScopeSources,boundScopeSources,type ScopeSource,type SessionContextAuthority,type TopicClassification} from '@use-brian/core'
import {requireAuth} from '../../auth/middleware.js'
import {createTokens} from '../../auth/jwt.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {getAppPool,getPool} from '../../db/client.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {publishNativeSessionMessage,publishNativeSessionMessageBatch} from '../../db/session-message-publication.js'
import {writeSessionMessageAnnotation} from '../../db/session-message-annotations.js'
import {addSessionMessage,createPersonalWebSession} from '../../db/sessions.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {readRetainedContextFrame} from '../../db/session-context-revisions.js'
import {publishSessionTitle} from '../../db/session-title-store.js'
import {sessionRoutes} from '../../routes/sessions.js'
import {resolveSessionTitleAuthority} from '../../routes/session-title-authority.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const profiling=process.env.BRIAN_CHAT_PROFILE==='1'
const warmed=profiling&&process.env.BRIAN_CHAT_PROFILE_WARM==='1'
// This is only the new, marker-verified disposable cluster. Instrument both
// runtime and owner metadata queries before the first runtime connection.
if(profiling){
 await getPool().query("ALTER ROLE app_user SET track_functions='all'")
 await getPool().query("ALTER ROLE assurance_owner SET track_functions='all'")
 await getPool().query("SET track_functions='all'")
}

type FunctionStat={funcid:string;name:string;calls:number;totalMs:number;selfMs:number}
type Profile={operation:'browser-history'|'browser-title'|'browser-list'|'native-snapshots'|'native-publication';warmed:boolean;elapsedMs:number;functions:FunctionStat[]}
type Fixture=Awaited<ReturnType<typeof persistentContextFixture>>
type Scenario={
 f:{pool:Fixture['pool'];workspaceId:string;ownerId:string;assistantId:string;memory:Fixture['memory']};
 session:{id:string};original:{id:string};reply:{id:string};title:{title:string;revisionId:string};
 sources:ScopeSource[];authority:()=>Promise<SessionContextAuthority>;
 get:(path:string)=>ReturnType<ReturnType<typeof request>['get']>;
}
const profiles:Profile[]=[]
const secret='fictional-native-chat-cost-secret'

/** Flush every backend used by the operation, rather than a different idle one. */
async function flushStats(){
 for(const pool of [getAppPool(),getPool()]){
  const clients=await Promise.all(Array.from({length:Math.max(1,pool.totalCount)},()=>pool.connect()))
  try{for(const client of clients)await client.query('SELECT pg_stat_force_next_flush()')}
  finally{for(const client of clients)client.release()}
 }
 await getPool().query('SELECT pg_stat_clear_snapshot()')
}
async function functionStats(){
 await flushStats()
 const rows=(await getPool().query<{funcid:string;name:string;calls:string;totalMs:number;selfMs:number}>(
  `SELECT funcid::text AS funcid,funcname AS name,calls,total_time AS "totalMs",self_time AS "selfMs"
   FROM pg_stat_user_functions`)).rows
 return new Map(rows.map(row=>[row.funcid,{...row,calls:Number(row.calls)}]))
}
// Explicit performance regression, using a fresh marker-verified local DB:
// node scripts/crm/local-fixture.mjs --pg-bin /opt/homebrew/opt/postgresql@18/bin -- \
// env BRIAN_CHAT_PROFILE=1 BRIAN_CHAT_PROFILE_WARM=1 BRIAN_CHAT_PROFILE_BUDGET=1 pnpm --filter @use-brian/api exec vitest run --config vitest.integration.config.ts src/application-platform/__tests__/native-chat-read-cost.integration.test.ts
async function profile<T>(operation:Profile['operation'],run:()=>Promise<T>):Promise<T>{
 if(!profiling)return run()
 const before=await functionStats(),start=performance.now()
 try{return await run()}
 finally{
  const elapsedMs=performance.now()-start,after=await functionStats()
  const functions=[...after.values()].map(row=>{
   const prior=before.get(row.funcid)
   return{...row,calls:row.calls-(prior?.calls??0),totalMs:row.totalMs-(prior?.totalMs??0),selfMs:row.selfMs-(prior?.selfMs??0)}
  }).filter(row=>row.calls>0).sort((a,b)=>b.selfMs-a.selfMs)
  profiles.push({operation,warmed,elapsedMs,functions})
  console.info('native-chat-read-profile',JSON.stringify({operation,warmed,elapsedMs,
   topSelf:functions.slice(0,12),topTotal:[...functions].sort((a,b)=>b.totalMs-a.totalMs).slice(0,8)}))
  if(process.env.BRIAN_CHAT_PROFILE_BUDGET==='1'){
   // This counts the complete fixed-fixture read, not an authorization result
   // or a particular implementation. Save evidence before asserting the bound.
   await writeFile(process.env.BRIAN_CHAT_PROFILE_OUTPUT??'/tmp/native-chat-read-cost-profile.json',JSON.stringify(profiles,null,2))
   const budgets:Record<Profile['operation'],number>={'browser-history':32000,'browser-title':15000,'browser-list':30000,'native-snapshots':6000,'native-publication':60000}
   expect(functions.reduce((sum,fn)=>sum+fn.calls,0),operation+' total SQL function calls').toBeLessThanOrEqual(budgets[operation])
  }
 }
}

describe.sequential('[COMP:api/native-chat-read-cost] actual personal transcript read work',()=>{
 let fixture:Fixture|undefined
 const fixtures:Fixture[]=[]
 let current:Scenario
 async function setup():Promise<Scenario>{
  fixture=await persistentContextFixture();const f=fixture;fixtures.push(f)
  expect((await getAppPool().query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('15s')
  if(profiling)expect((await getAppPool().query('SHOW track_functions')).rows[0].track_functions).toBe('all')
  const device=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional cost browser',userAgent:null,ipAddress:null}))!
  const claims={userId:f.ownerId,sessionId:device.id,authVersion:device.authVersion}
  const session=await createPersonalWebSession({assistantId:f.assistantId,userId:f.ownerId,workspaceId:f.workspaceId,
   channelType:'web',channelId:crypto.randomUUID(),appOrigin:'chat'},
   {actorUserId:f.ownerId,authSessionId:device.id,authVersion:device.authVersion})
  const envelope={...f.envelope,userId:f.ownerId}
  const original=await addSessionMessage({sessionId:session.id,role:'user',
   content:[{type:'text',text:'Fictional ordinary opening request'}],scope:envelope})
  const authority=()=>resolveSessionTitleAuthority({claims,sessionId:session.id,readOnly:false})
  const classifierAuthority=await authority()
  const classification=bindScopeSources<TopicClassification>({topic_label:'fictional opening topic',state:'continue',confidence:0.9},boundScopeSources(original))
  expect(await writeSessionMessageAnnotation({sessionId:session.id,messageId:original.id,classification,replyToText:null,authority:classifierAuthority})).not.toBeNull()
  const inputAuthority=await authority(),store=createDbMemoryStore()
  const input=await readAdmittedSessionQuery({sessionId:session.id,throughSequence:1,authority:inputAuthority})
  expect(input.annotations).toHaveLength(1)
  const index=await store.getIndex(inputAuthority.execution.security.access,false,inputAuthority)
  const search=await store.search(inputAuthority.execution.security.access,{query:'Fictional'},inputAuthority)
  expect(index).toEqual([]);expect(search).toEqual([])
  inputAuthority.accumulator.note({sources:[...boundScopeSources(index),...boundScopeSources(search)]})
  const sources:ScopeSource[]=structuredClone(inputAuthority.accumulator.evidence.sources??[])
  const domains=(await f.pool.query(`SELECT id FROM application_field_resources
   WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND type_key='memory' AND selection='query_domain'`,
   [f.workspaceId,sources.filter(source=>source.resourceKind==='application_field').map(source=>source.resourceId)])).rows
  expect(domains).toHaveLength(2)
  expect((await f.pool.query('SELECT count(*)::int AS count FROM memories WHERE workspace_id=$1',[f.workspaceId])).rows[0].count).toBe(0)
  const reply=await publishNativeSessionMessage({sessionId:session.id,role:'assistant',
   content:[{type:'text',text:'Fictional query-backed reply'}],authority:inputAuthority,derivationTarget:envelope,
   derivation:{producer:'fixture:native-chat-read',sources}})
  // Automatic titles consumed this original model input, before the reply was
  // appended. Preserve those exact immutable observations under fresh authority.
  const title=await publishSessionTitle({sessionId:session.id,title:'Fictional query-backed conversation title',manual:false,
   expectedRevision:null,authority:await authority(),derivation:{producer:'fixture:native-chat-title',sources}})
  expect(title).not.toBeNull()
  const app=express();app.use('/sessions',requireAuth(secret),sessionRoutes())
  const token=createTokens(f.ownerId,secret,device).accessToken
  const get=(path:string)=>request(app).get('/sessions'+path).set('Authorization','Bearer '+token)
  return{f:{pool:f.pool,workspaceId:f.workspaceId,ownerId:f.ownerId,assistantId:f.assistantId,memory:f.memory},session:{id:session.id},
   original:{id:original.id},reply:{id:reply.id},title:{title:title!.title,revisionId:title!.revisionId},sources,authority,get}
 }
 async function reuse():Promise<Scenario>{
  const saved=JSON.parse(await readFile(process.env.BRIAN_CHAT_PROFILE_REUSE!,'utf8')) as {
   workspaceId:string;userId:string;assistantId:string;sessionId:string;messageId:string;titleId:string;sources:ScopeSource[]}
  const device=(await getPool().query<{id:string;authVersion:number}>(`SELECT id,auth_version AS "authVersion" FROM auth_sessions
   WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,[saved.userId])).rows[0]
  expect(device).toBeDefined()
  const claims={userId:saved.userId,sessionId:device.id,authVersion:device.authVersion}
  const authority=()=>resolveSessionTitleAuthority({claims,sessionId:saved.sessionId,readOnly:false})
  const messages=(await getPool().query<{id:string;role:string}>('SELECT id,role FROM session_messages WHERE session_id=$1 ORDER BY sequence_num',[saved.sessionId])).rows
  expect(messages.map(row=>row.role)).toEqual(['user','assistant'])
  expect(messages[1].id).toBe(saved.messageId)
  expect((await getPool().query('SELECT count(*)::int AS count FROM memories WHERE workspace_id=$1',[saved.workspaceId])).rows[0].count).toBe(0)
  const app=express();app.use('/sessions',requireAuth(secret),sessionRoutes())
  const token=createTokens(saved.userId,secret,device).accessToken
  const get=(path:string)=>request(app).get('/sessions'+path).set('Authorization','Bearer '+token)
  return{f:{pool:getPool(),workspaceId:saved.workspaceId,ownerId:saved.userId,assistantId:saved.assistantId,
   memory:async()=>{throw new Error('Retained profile reuse cannot mutate its original graph')}},session:{id:saved.sessionId},
   original:{id:messages[0].id},reply:{id:saved.messageId},title:{title:'Fictional query-backed conversation title',revisionId:saved.titleId},
   sources:saved.sources,authority,get}
 }
 beforeAll(async()=>{
  current=profiling&&process.env.BRIAN_CHAT_PROFILE_REUSE?await reuse():await setup()
  if(warmed){
   const c=current,baseline:unknown[]=[]
   for(let round=0;round<3;round++){
    const responses=[await c.get('/'+c.session.id+'/messages'),await c.get('/'+c.session.id),
     await c.get('?'+new URLSearchParams({assistantId:c.f.assistantId,workspaceId:c.f.workspaceId}))]
    for(let index=0;index<responses.length;index++){
     const response=responses[index]
     expect(response.status,JSON.stringify(response.body)).toBe(200)
     if(round===0)baseline[index]=response.body
     else expect(response.body).toEqual(baseline[index])
    }
    expect(responses[0].body.map((row:{id:string})=>row.id)).toEqual([c.original.id,c.reply.id])
    expect(responses[1].body).toMatchObject({title:c.title.title,titleRevisionId:c.title.revisionId})
    expect(responses[2].body.find((row:{id:string})=>row.id===c.session.id)).toMatchObject({title:c.title.title,titleRevisionId:c.title.revisionId})
   }
   // Reset statistics only after every measured backend has flushed warm-up
   // work. Prepared plans remain warm; every request still does real admission.
   await flushStats();await getPool().query('SELECT pg_stat_reset()')
  }
 })
 afterAll(async()=>{
  try{
   if(profiling)await writeFile(process.env.BRIAN_CHAT_PROFILE_OUTPUT??'/tmp/native-chat-read-cost-profile.json',JSON.stringify(profiles,null,2))
   // Explicit diagnostic runs may keep this marker-verified synthetic graph
   // until the owning local-fixture runner disposes its entire cluster.
   if(profiling&&process.env.BRIAN_CHAT_PROFILE_RETAIN==='1'&&current)await writeFile(process.env.BRIAN_CHAT_PROFILE_SCENARIO??'/tmp/native-chat-profile-scenario.json',JSON.stringify({
    workspaceId:current.f.workspaceId,userId:current.f.ownerId,assistantId:current.f.assistantId,
    sessionId:current.session.id,messageId:current.reply.id,titleId:current.title.revisionId,sources:current.sources,
   },null,2))
   else for(const owned of fixtures)await owned.cleanup()
  }
  finally{await getAppPool().end();await getPool().end()}
 })

 it('publishes a query-backed reply with bounded SQL work',async()=>{
  const c=await setup(),authority=await c.authority()
  authority.accumulator.note({sources:c.sources})
  const input=await readAdmittedSessionQuery({sessionId:c.session.id,throughSequence:2,authority})
  authority.accumulator.note({sources:boundScopeSources(input)})
  const reply=await profile('native-publication',()=>publishNativeSessionMessageBatch({sessionId:c.session.id,
   messages:[{role:'assistant',content:[{type:'text',text:'Fictional second query-backed reply'}]}],authority,
   derivationTarget:{workspaceId:c.f.workspaceId,userId:c.f.ownerId,assistantId:null,sensitivity:'internal',compartments:[],projectIds:[]},
   derivation:{producer:'fixture:native-chat-publication',sources:authority.accumulator.evidence.sources??[]}}))
  expect(reply[0].role).toBe('assistant')
  expect((await c.get('/'+c.session.id+'/messages')).body.map((row:{id:string})=>row.id)).toContain(reply[0].id)
 })

 it('loads both canonical messages through the attended browser route',async()=>{
  const c=current,response=await profile('browser-history',async()=>await c.get('/'+c.session.id+'/messages'))
  expect(response.status,JSON.stringify(response.body)).toBe(200)
  expect(response.body.map((row:{id:string})=>row.id)).toEqual([c.original.id,c.reply.id])
  expect(response.body).toMatchObject([
   {role:'user',content:[{type:'text',text:'Fictional ordinary opening request'}]},
   {role:'assistant',content:[{type:'text',text:'Fictional query-backed reply'}]},
  ])
 })

 it('revalidates publication after an insert-time source hold and rolls the whole batch back',async()=>{
  const c=await setup(),authority=await c.authority()
  authority.accumulator.note({sources:c.sources})
  const input=await readAdmittedSessionQuery({sessionId:c.session.id,throughSequence:2,authority})
  authority.accumulator.note({sources:boundScopeSources(input)})
  await c.f.pool.query(`CREATE FUNCTION fixture_publication_source_hold() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
   SET search_path=pg_catalog,public,pg_temp AS $fixture$ BEGIN
   IF NEW.session_id='${c.session.id}'::uuid AND NEW.role='assistant' THEN
    UPDATE session_messages SET scope_held=true WHERE id='${c.original.id}'::uuid;
   END IF;RETURN NEW;END $fixture$`)
  await c.f.pool.query('REVOKE ALL ON FUNCTION fixture_publication_source_hold() FROM PUBLIC')
  await c.f.pool.query('CREATE TRIGGER fixture_publication_source_hold AFTER INSERT ON session_messages FOR EACH ROW EXECUTE FUNCTION fixture_publication_source_hold()')
  try{
   await expect(publishNativeSessionMessageBatch({sessionId:c.session.id,
    messages:[{role:'assistant',content:[{type:'text',text:'Fictional withheld reply'}]}],authority,
    derivationTarget:{workspaceId:c.f.workspaceId,userId:c.f.ownerId,assistantId:null,sensitivity:'internal',compartments:[],projectIds:[]},
    derivation:{producer:'fixture:publication-source-hold',sources:authority.accumulator.evidence.sources??[]}})).rejects.toMatchObject({name:'DerivedScopeError',code:'scope_source_changed'})
   expect((await c.f.pool.query('SELECT id FROM session_messages WHERE session_id=$1 ORDER BY sequence_num',[c.session.id])).rows)
    .toEqual([{id:c.original.id},{id:c.reply.id}])
   expect((await c.f.pool.query('SELECT scope_held AS held FROM session_messages WHERE id=$1',[c.original.id])).rows[0].held).toBe(false)
  }finally{
   await c.f.pool.query('DROP TRIGGER fixture_publication_source_hold ON session_messages')
   await c.f.pool.query('DROP FUNCTION fixture_publication_source_hold()')
  }
 })
 it('loads the immutable current title through the browser header',async()=>{
  const c=current,response=await profile('browser-title',async()=>await c.get('/'+c.session.id))
  expect(response.status,JSON.stringify(response.body)).toBe(200)
  expect(response.body).toMatchObject({title:c.title.title,titleRevisionId:c.title.revisionId})
 })
 it('loads the saved title through the personal list',async()=>{
  const c=current,response=await profile('browser-list',async()=>await c.get('?'+new URLSearchParams({assistantId:c.f.assistantId,workspaceId:c.f.workspaceId})))
  expect(response.status,JSON.stringify(response.body)).toBe(200)
  expect(response.body.find((row:{id:string})=>row.id===c.session.id)).toMatchObject({title:c.title.title,titleRevisionId:c.title.revisionId})
 })
 it('retains actual native snapshot admission inside the original source frame',async()=>{
  const c=current,authority=await c.authority()
  const snapshots=await profile('native-snapshots',()=>readRetainedContextFrame(authority,c.sources,async client=>{
   const rows=(await client.query<{message:{held:boolean};title:{held:boolean}}>(`SELECT
    read_admitted_native_scope_snapshot($1,'session_message',$2) AS message,
    read_admitted_native_scope_snapshot($1,'session_context_revision',$3) AS title`,
    [c.f.workspaceId,c.reply.id,c.title.revisionId])).rows[0]
   return rows
  }))
  expect(snapshots.message).toMatchObject({held:false})
  expect(snapshots.title).toMatchObject({held:false})
  expect(snapshots.message).not.toHaveProperty('memo')
  expect(snapshots.title).not.toHaveProperty('memo')
 })

 it('keeps the complete internal frame private and preserves the public evidence contract',async()=>{
  const signature='public.read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'
  const permissions=(await getPool().query<{app:boolean;public:boolean}>(`SELECT
   has_function_privilege('app_user',$1::regprocedure,'EXECUTE') AS app,
   EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    WHERE p.oid=$1::regprocedure AND acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public`,[signature])).rows[0]
  expect(permissions).toEqual({app:false,public:false})
  const c=current
  await expect(getAppPool().query('SELECT read_native_session_cohort_frame($1,$2,$3,$4,true)',
   [c.f.workspaceId,['session_message'],[c.reply.id],['1']])).rejects.toMatchObject({code:'42501'})
  const authority=await c.authority()
  const proof=await readRetainedContextFrame(authority,c.sources,async client=>(await client.query<{value:Record<string,unknown>}>(
   'SELECT read_native_attended_memory_evidence($1,$2,$3,$4) AS value',
   [c.f.workspaceId,c.sources.map(source=>source.resourceKind),c.sources.map(source=>source.resourceId),c.sources.map(source=>source.version)])).rows[0].value)
  expect(proof.admitted).toBe(true)
  expect(Object.keys(proof).sort()).toEqual(['admitted','current','immutable'])
  const response=await c.get('/'+c.session.id+'/messages')
  expect(response.status,JSON.stringify(response.body)).toBe(200)
  expect(JSON.stringify(response.body)).not.toContain('"memo"')
 })

 it('keeps independently readable rows after one saved reply becomes held',async()=>{
  const c=await setup()
  await c.f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[c.reply.id])
  const response=await c.get('/'+c.session.id+'/messages')
  expect(response.status,JSON.stringify(response.body)).toBe(200)
  expect(response.body.map((row:{id:string})=>row.id)).toEqual([c.original.id])
  const title=await c.get('/'+c.session.id)
  expect(title.status,JSON.stringify(title.body)).toBe(200)
  expect(title.body).toMatchObject({title:c.title.title,titleRevisionId:c.title.revisionId})
 })

 it('keeps valid snapshot slots independent of a bad version and preserves duplicate ordinals',async()=>{
  const c=await setup(),source=(await c.f.pool.query<{id:string}>(`SELECT id FROM application_field_resources
   WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND type_key='session_message' AND selection='query'`,
   [c.f.workspaceId,c.sources.map(item=>item.resourceId)])).rows[0]
  expect(source).toBeDefined()
  const selected=c.sources.find(item=>item.resourceId===source.id)!
  const authority=await c.authority()
  const rows=await readRetainedContextFrame(authority,c.sources,async client=>(await client.query<{ord:number;snapshot:Record<string,unknown>|null}>(
   'SELECT ord,snapshot FROM read_native_session_field_snapshots($1,$2,$3)',
   [c.f.workspaceId,[selected.resourceId,selected.resourceId,selected.resourceId],
    [selected.version,'fictional-unrecorded-version',selected.version]])).rows)
  expect(rows.map(row=>row.ord)).toEqual([1,2,3])
  expect(rows[0].snapshot).toMatchObject({held:false,version:selected.version})
  expect(rows[1].snapshot?.held).not.toBe(false)
  expect(rows[2].snapshot).toEqual(rows[0].snapshot)
 })

 for(const mutation of ['source hold','content edit','annotation head'] as const)it(`refuses stale capture after a materialization-time ${mutation}`,async()=>{
  const c=await setup(),beforeHead=(await c.f.pool.query<{id:string}>(
   'SELECT scope_revision_id AS id FROM session_message_annotation_heads WHERE message_id=$1',[c.original.id])).rows[0].id
  let replacement:string|undefined
  if(mutation==='annotation head'){
   const authority=await c.authority(),input=await readAdmittedSessionQuery({sessionId:c.session.id,throughSequence:1,topicThroughSequence:0,authority})
   const classification=bindScopeSources<TopicClassification>({topic_label:'fictional replacement topic',state:'continue',confidence:0.8},boundScopeSources(input))
   const annotation=await writeSessionMessageAnnotation({sessionId:c.session.id,messageId:c.original.id,classification,
    replyToText:null,expectedRevision:beforeHead,authority})
   expect(annotation).not.toBeNull();replacement=annotation!.revisionId
   await c.f.pool.query('UPDATE session_message_annotation_heads SET scope_revision_id=$2 WHERE message_id=$1',[c.original.id,beforeHead])
  }
  // Verify the original title is readable without materializing the new reply
  // field. That new field's INSERT is the real boundary under test below.
  const initialTitle=await c.get('/'+c.session.id)
  expect(initialTitle.status,JSON.stringify(initialTitle.body)).toBe(200)
  expect(initialTitle.body).toMatchObject({title:c.title.title,titleRevisionId:c.title.revisionId})
  const change=mutation==='source hold'
   ?`UPDATE session_messages SET scope_held=true WHERE id='${c.original.id}'::uuid;`
   :mutation==='content edit'
    ?`UPDATE session_messages SET content='[{"type":"text","text":"Fictional changed source during capture"}]'::jsonb WHERE id='${c.original.id}'::uuid;`
    :`UPDATE session_message_annotation_heads SET scope_revision_id='${replacement}'::uuid WHERE message_id='${c.original.id}'::uuid;`
  await c.f.pool.query('CREATE SEQUENCE fixture_native_chat_race_hit')
  await c.f.pool.query(`CREATE FUNCTION fixture_native_chat_capture_race() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
   SET search_path=pg_catalog,public,pg_temp AS $fixture$ BEGIN
   IF NEW.workspace_id='${c.f.workspaceId}'::uuid AND NEW.source_kind='session_message' AND NEW.source_id='${c.reply.id}'::uuid
    AND (SELECT is_called FROM public.fixture_native_chat_race_hit) IS FALSE THEN
    PERFORM nextval('public.fixture_native_chat_race_hit');${change}
   END IF;RETURN NEW;END $fixture$`)
  await c.f.pool.query('REVOKE ALL ON FUNCTION fixture_native_chat_capture_race() FROM PUBLIC')
  await c.f.pool.query('CREATE TRIGGER fixture_native_chat_capture_race AFTER INSERT ON application_field_observations FOR EACH ROW EXECUTE FUNCTION fixture_native_chat_capture_race()')
  try{
   expect((await c.f.pool.query('SELECT application_memory_statement_helpers_current() AS current')).rows[0].current).toBe(true)
   const response=await c.get('/'+c.session.id+'/messages')
   expect(response.status,JSON.stringify(response.body)).toBe(403)
   expect(response.body.code).toBe('session_history_unavailable')
   expect(JSON.stringify(response.body)).not.toContain('Fictional query-backed reply')
   expect((await c.f.pool.query('SELECT is_called FROM fixture_native_chat_race_hit')).rows[0].is_called).toBe(true)
   // Failed capture rolls both the observation and synthetic mutation back.
   const original=(await c.f.pool.query<{held:boolean;content:unknown}>('SELECT scope_held AS held,content FROM session_messages WHERE id=$1',[c.original.id])).rows[0]
   expect(original).toEqual({held:false,content:[{type:'text',text:'Fictional ordinary opening request'}]})
   expect((await c.f.pool.query('SELECT scope_revision_id AS id FROM session_message_annotation_heads WHERE message_id=$1',[c.original.id])).rows[0].id).toBe(beforeHead)
  }finally{
   await c.f.pool.query('DROP TRIGGER fixture_native_chat_capture_race ON application_field_observations')
   await c.f.pool.query('DROP FUNCTION fixture_native_chat_capture_race()')
   await c.f.pool.query('DROP SEQUENCE fixture_native_chat_race_hit')
  }
  const recovered=await c.get('/'+c.session.id+'/messages')
  expect(recovered.status,JSON.stringify(recovered.body)).toBe(200)
  expect(recovered.body.map((row:{id:string})=>row.id)).toEqual([c.original.id,c.reply.id])
 })

 it('withholds every descendant after an original source becomes held',async()=>{
  const c=await setup()
  await c.f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[c.original.id])
  const response=await c.get('/'+c.session.id+'/messages')
  // A protected original makes the personal window unavailable, rather than
  // certifying absence. This is the pre-existing typed refusal contract.
  expect(response.status,JSON.stringify(response.body)).toBe(403)
  expect(response.body.code).toBe('session_history_unavailable')
  expect(JSON.stringify(response.body)).not.toContain('Fictional query-backed reply')
  const title=await c.get('/'+c.session.id)
  expect(title.status,JSON.stringify(title.body)).toBe(200)
  expect(JSON.stringify(title.body)).not.toContain(c.title.title)
 })

 it('refuses the recording privacy hold at every browser read boundary',async()=>{
  const c=await setup()
  await c.f.pool.query('UPDATE sessions SET recording_privacy_held=true WHERE id=$1',[c.session.id])
  for(const path of ['/'+c.session.id,'/'+c.session.id+'/messages']){
   const response=await c.get(path)
   expect([403,404]).toContain(response.status)
  }
  const response=await c.get('?'+new URLSearchParams({assistantId:c.f.assistantId,workspaceId:c.f.workspaceId}))
  expect(response.status,JSON.stringify(response.body)).toBe(200)
  expect(response.body.some((row:{id:string})=>row.id===c.session.id)).toBe(false)
 })

 it('keeps the original read contract when a contended policy epoch prevents private-frame seeding',async()=>{
  const c=await setup(),fence=await c.f.pool.connect()
  try{
   await fence.query('BEGIN')
   await fence.query('SELECT singleton FROM application_policy_contract_epoch WHERE singleton FOR UPDATE')
   expect((await c.f.pool.query('SELECT application_memory_statement_helpers_current() AS current')).rows[0].current).toBe(true)
   const history=await c.get('/'+c.session.id+'/messages')
   expect(history.status,JSON.stringify(history.body)).toBe(200)
   expect(history.body.map((row:{id:string})=>row.id)).toEqual([c.original.id,c.reply.id])
   const title=await c.get('/'+c.session.id)
   expect(title.status,JSON.stringify(title.body)).toBe(200)
   expect(title.body).toMatchObject({title:c.title.title,titleRevisionId:c.title.revisionId})
  }finally{await fence.query('ROLLBACK');fence.release()}
  const recovered=await c.get('/'+c.session.id+'/messages')
  expect(recovered.status,JSON.stringify(recovered.body)).toBe(200)
  expect(recovered.body.map((row:{id:string})=>row.id)).toEqual([c.original.id,c.reply.id])
 })

 it('withholds original empty-domain descendants after the current Memory cohort changes',async()=>{
  const c=await setup()
  await c.f.memory('Fictional first assistant memory changes the empty cohort')
  const response=await c.get('/'+c.session.id+'/messages')
  expect(response.status,JSON.stringify(response.body)).toBe(200)
  expect(response.body.map((row:{id:string})=>row.id)).toEqual([c.original.id])
  const title=await c.get('/'+c.session.id)
  expect(title.status,JSON.stringify(title.body)).toBe(200)
  expect(JSON.stringify(title.body)).not.toContain(c.title.title)
 })
})
