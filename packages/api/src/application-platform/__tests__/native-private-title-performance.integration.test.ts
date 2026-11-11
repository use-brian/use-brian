/** Current-contract title-list regression; synthetic data, never an existing chat.
 * Function tracking is enabled on verified disposable fixture roles by default.
 * Set NATIVE_PRIVATE_TITLE_PROFILE=0 inside the fixture command to skip that gate.
 * Timings are diagnostic; CI gates database work rather than wall clock.
 * Owns no migrations and never changes the original helper/kernel contracts.
 */
import {randomUUID} from 'node:crypto'
import express from 'express'
import request from 'supertest'
import pg, {type PoolClient} from 'pg'
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest'
import {boundScopeSources} from '@use-brian/core'
import {applyRLSGucs,getAppPool,getPool,rollbackAndRelease,runWithAgentAccess} from '../../db/client.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {createTokens} from '../../auth/jwt.js'
import {requireAuth} from '../../auth/middleware.js'
import {sessionRoutes} from '../../routes/sessions.js'
import {addSessionMessage,createPersonalWebSession} from '../../db/sessions.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {publishNativeSessionMessageBatch} from '../../db/session-message-publication.js'
import {readAdmittedSessionQuery,sessionQueryRootMetadata} from '../../db/session-query-reader.js'
import {readJointSessionQueryFrame,readRetainedContextFrame} from '../../db/session-context-revisions.js'
import * as titles from '../../db/session-title-store.js'
import {resolveSessionTitleAuthority,sessionTitleProjections} from '../../routes/session-title-authority.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'

// Must precede every DB operation, including fixture creation and catalog probes.
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

type Fixture=Awaited<ReturnType<typeof persistentContextFixture>>
const fixtures:Fixture[]=[]
const guard='native_private_title_helpers_current()'
const profile=process.env.NATIVE_PRIVATE_TITLE_PROFILE!=='0'
const secret='fictional-private-title-performance-secret'

async function seed(populated:boolean,mixed:boolean){
 const f=await persistentContextFixture('confidential');fixtures.push(f)
 await f.pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1',[f.workspaceId])
 const device=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional title performance browser',userAgent:null,ipAddress:null}))!
 const claims={userId:f.ownerId,sessionId:device.id,authVersion:device.authVersion}
 const session=await createPersonalWebSession({assistantId:f.assistantId,userId:f.ownerId,workspaceId:f.workspaceId,
  channelType:'web',channelId:randomUUID(),appOrigin:'chat'},
 {actorUserId:f.ownerId,authSessionId:device.id,authVersion:device.authVersion})
 const fresh=()=>resolveSessionTitleAuthority({claims,sessionId:session.id,readOnly:false})
 const scope={...f.envelope,userId:f.ownerId,assistantId:null}
 const memory=populated?await f.memory('The fictional research notebook is amber.',f.ownerId):null
 const input=await addSessionMessage({sessionId:session.id,role:'user',senderUserId:f.ownerId,scope,
  content:[{type:'text',text:'Remember our fictional amber notebook.'}]})
 const a=await fresh()
 const query=await readAdmittedSessionQuery({sessionId:session.id,throughSequence:input.sequenceNum,topicThroughSequence:0,authority:a})
 expect(boundScopeSources(query).map(source=>source.resourceKind)).toEqual(['private_transcript'])
 expect(query.history.map(row=>row.id)).toEqual([input.id])
 const store=createDbMemoryStore(),index=await store.getIndex(a.execution.security.access,false,a)
 const search=await store.search(a.execution.security.access,{query:'fictional'},a)
 if(populated){
  expect(JSON.stringify(index)).toContain('The fictional research notebook is amber.')
  expect(JSON.stringify(search)).toContain('The fictional research notebook is amber.')
 }else{
  expect(JSON.stringify(index)).not.toContain('amber')
  expect(JSON.stringify(search)).not.toContain('amber')
 }
 // Direct current-Memory dependencies, not only historical utterance ancestry.
 const sources=[...boundScopeSources(query),...boundScopeSources(index),...boundScopeSources(search)]
 expect(sources.some(source=>source.resourceKind==='application_field')).toBe(true)
 const [reply]=await publishNativeSessionMessageBatch({sessionId:session.id,authority:a,derivationTarget:scope,
  messages:[{role:'assistant',content:[{type:'text',text:'We chose the fictional amber notebook.'}]}],
  derivation:{producer:'fixture:private-title-performance',sources}})
 expect(reply.sequenceNum).toBe(2)
 if(mixed){
  // Independent canonical field history is intentional. Do NOT substitute the
  // private-history API: that erases the measured mixed-ancestry regression.
  const fieldAuthority=await fresh(),roots=await sessionQueryRootMetadata(f.workspaceId,session.id,2,0)
  const fields=await readJointSessionQueryFrame(fieldAuthority,roots,{sessionId:session.id,throughSequence:2,topicThroughSequence:0})
  expect(fields.history.flatMap(row=>row.row?[row.row.id]:[])).toEqual([input.id,reply.id])
  const fieldSources=[...fields.history.flatMap(row=>row.sources),...fields.annotations.flatMap(row=>row.sources)]
  expect(fieldSources.some(source=>source.resourceKind==='application_field')).toBe(true)
  sources.push(...fieldSources)
 }
 const title=await titles.publishSessionTitle({sessionId:session.id,title:`Fictional ${mixed?'mixed':'private'} ${populated?'populated':'empty'} notebook`,
  manual:false,expectedRevision:null,authority:await fresh(),derivation:{producer:'fixture:private-title-performance',sources}})
 expect(title).not.toBeNull()
 const list=()=>sessionTitleProjections({claims,sessionIds:[session.id]})
 const app=express();app.use(express.json());app.use('/sessions',requireAuth(secret),sessionRoutes())
 const token=createTokens(f.ownerId,secret,device).accessToken
 const browserList=()=>request(app).get('/sessions?'+new URLSearchParams({assistantId:f.assistantId,workspaceId:f.workspaceId}))
  .set('Authorization','Bearer '+token)
 return{f,claims,device,session,fresh,memory,input,reply,sources,title:title!,list,browserList,populated,mixed}
}
type Case=Awaited<ReturnType<typeof seed>>

/** Change ONLY the new guard body; restore its exact catalog definition even
 * on assertion failure. The authenticated port must decline, then use fallback.
 */
async function withGuardBody<T>(body:string,run:()=>Promise<T>){
 const original=(await getPool().query<{definition:string;prosrc:string}>(
  'SELECT pg_get_functiondef(oid) definition,prosrc FROM pg_proc WHERE oid=$1::regprocedure',[guard])).rows[0]
 expect(original).toBeDefined()
 // pg_get_functiondef dollar-quotes the body; preserve ACL/security/volatility.
 const delimiter=original.definition.match(/AS (\$[^$]*\$)/)?.[1]
 if(!delimiter)throw new Error('Expected dollar-quoted private title guard')
 const oldBody=delimiter+original.prosrc+delimiter
 expect(original.definition.includes(oldBody)).toBe(true)
 await getPool().query(original.definition.replace(oldBody,delimiter+body+delimiter))
 try{return await run()}finally{await getPool().query(original.definition)}
}
const fallback=<T>(run:()=>Promise<T>)=>withGuardBody('BEGIN RETURN false; END',run)

async function traced<T>(run:()=>Promise<T>){
 const sql:string[]=[],query=pg.Client.prototype.query
 const spy=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:Parameters<typeof query>){
  sql.push(typeof args[0]==='string'?args[0]:String((args[0] as {text?:string})?.text??''))
  return query.apply(this,args)
 } as typeof query)
 const started=performance.now()
 try{return{value:await run(),sql,elapsedMs:performance.now()-started}}finally{spy.mockRestore()}
}
function assertFreshSingleton(sql:string[]){
 expect(sql.filter(text=>/SELECT\s+read_native_private_title_acquisition\(/i.test(text))).toHaveLength(1)
 expect(sql.filter(text=>/SELECT\s+read_native_private_title_evidence\(/i.test(text))).toHaveLength(1)
 // A successful complete proof must not fall through to per-field traversal.
 expect(sql.filter(text=>/\bread_native_session_field_(dependencies|snapshots)\s*\(/i.test(text))).toHaveLength(0)
 const acquisition=sql.findIndex(text=>/SELECT\s+read_native_private_title_acquisition\(/i.test(text))
 const output=sql.findIndex(text=>/SELECT\s+read_native_private_title_evidence\(/i.test(text))
 expect(output).toBeGreaterThan(acquisition)
 // Output is a fresh operation, not reuse of the acquisition transaction/proof.
 expect(sql.slice(acquisition+1,output).some(text=>/\b(COMMIT|ROLLBACK)\b/i.test(text))).toBe(true)
}
function assertProjection(c:Case,value:Awaited<ReturnType<Case['list']>>){
 const row=value.get(c.session.id)
 expect(row).toMatchObject({title:c.title.title,titleRevisionId:c.title.revisionId})
 expect(boundScopeSources(row!)).toEqual(boundScopeSources(c.title))
 expect(boundScopeSources(row!)).toMatchObject([{resourceKind:'session_context_revision',resourceId:c.title.revisionId,version:'1'}])
}
async function frame<T>(c:Case,run:(client:PoolClient)=>Promise<T>,userId=c.f.ownerId){
 const access=userId===c.f.ownerId?(await c.fresh()).execution.security.access:(await c.f.execution(userId)).security.access
 const client=await getAppPool().connect()
 try{return await runWithAgentAccess({...access,sharedAudience:false},async()=>{
  await client.query('BEGIN');await applyRLSGucs(client,userId)
  await client.query("SELECT set_config('app.v2_assistant_id',$1,true)",[c.f.assistantId])
  return run(client)
 })}finally{await rollbackAndRelease(client)}
}
async function flushStats(){
 // Flush each live backend; never reset shared fixture statistics or change role settings.
 for(const pool of [getAppPool(),getPool()]){
  const clients=await Promise.all(Array.from({length:Math.max(pool.totalCount,1)},()=>pool.connect()))
  try{for(const client of clients)await client.query('SELECT pg_stat_force_next_flush()')}
  finally{for(const client of clients)client.release()}
 }
 await getPool().query('SELECT pg_stat_clear_snapshot()')
 return(await getPool().query<{id:string;name:string;calls:string}>(
  'SELECT funcid::text id,funcname name,calls::text FROM pg_stat_user_functions')).rows
}
async function work(run:()=>Promise<unknown>){
 const before=new Map((await flushStats()).map(row=>[row.id,Number(row.calls)])),start=performance.now()
 await run();const elapsedMs=performance.now()-start
 const functions=(await flushStats()).map(row=>({name:row.name,calls:Number(row.calls)-(before.get(row.id)??0)})).filter(row=>row.calls>0)
 return{elapsedMs,calls:functions.reduce((sum,row)=>sum+row.calls,0),functions}
}

describe.sequential('[COMP:api/application-persistence] isolated private title list work and correctness',()=>{
 const cases:Case[]=[]
 beforeAll(async()=>{
  if(profile){
   // This file already verified the disposable marker above; never configure
   // profiling on an ambient/developer database. New app connections inherit it.
   await getPool().query("ALTER ROLE app_user SET track_functions='all'")
   await getPool().query("ALTER ROLE assurance_owner SET track_functions='all'")
   await getPool().query("SET track_functions='all'")
  }
  // Fail loudly if the required migration is missing, rather than silently skip.
  for(const signature of ['read_native_private_title_evidence(uuid,uuid)','read_native_private_title_acquisition(uuid,uuid,uuid)',guard]){
   expect((await getPool().query('SELECT to_regprocedure($1) IS NOT NULL installed',[signature])).rows[0].installed,signature).toBe(true)
  }
  for(const populated of [false,true])for(const mixed of [false,true])cases.push(await seed(populated,mixed))
 },180_000)
 afterEach(()=>vi.restoreAllMocks())
 afterAll(async()=>{
  try{for(const f of fixtures.reverse())await f.cleanup()}
  finally{await getAppPool().end();await getPool().end()}
 },60_000)

 for(const populated of [false,true])for(const mixed of [false,true]){
  it(`preserves ${mixed?'mixed canonical fields':'private dialogue'} / ${populated?'populated':'empty'} Memory with bounded fresh database work`,async()=>{
   const c=cases.find(row=>row.populated===populated&&row.mixed===mixed)!
   // The fallback is the unchanged canonical validator, not a TS allow-result double.
   await fallback(c.list) // bounded canonical warm-up, symmetric with native below
   const canonical=await fallback(()=>traced(c.list)),expected=canonical.value
   assertProjection(c,expected)
   expect(canonical.sql.filter(sql=>/\bread_native_session_field_dependencies\s*\(/i.test(sql))).toHaveLength(4)
   expect(canonical.sql.filter(sql=>/\bread_native_session_field_snapshots\s*\(/i.test(sql))).toHaveLength(2)
   await c.list() // one bounded warm-up, no wall-clock threshold
   const actual=await traced(c.list)
   expect(actual.value).toEqual(expected)
   assertProjection(c,actual.value);assertFreshSingleton(actual.sql)
   expect(boundScopeSources(actual.value.get(c.session.id)!)).toEqual(boundScopeSources(expected.get(c.session.id)!))
   expect(actual.sql.length).toBeLessThan(canonical.sql.length)
   console.info('private-title-work',JSON.stringify({populated,mixed,canonical:{sqlStatements:canonical.sql.length,elapsedMs:canonical.elapsedMs},
    native:{sqlStatements:actual.sql.length,elapsedMs:actual.elapsedMs}}))
  },90_000)
 }
 it('keeps titles without direct private evidence on the original acquisition, without a speculative frame',async()=>{
  const c=cases[3]
  const other=await createPersonalWebSession({assistantId:c.f.assistantId,userId:c.f.ownerId,workspaceId:c.f.workspaceId,
   channelType:'web',channelId:randomUUID(),appOrigin:'chat'},
  {actorUserId:c.f.ownerId,authSessionId:c.device.id,authVersion:c.device.authVersion})
  try{
   const authority=await resolveSessionTitleAuthority({claims:c.claims,sessionId:other.id,readOnly:false})
   const index=await createDbMemoryStore().getIndex(authority.execution.security.access,false,authority)
   const sources=boundScopeSources(index)
   expect(sources.length).toBeGreaterThan(0)
   expect(sources.some(source=>source.resourceKind==='private_transcript')).toBe(false)
   const title=await titles.publishSessionTitle({sessionId:other.id,title:'Fictional Memory-only title without private ancestry',manual:false,
    expectedRevision:null,authority,derivation:{producer:'fixture:non-private-title',sources}})
   expect(title).not.toBeNull()
   const actual=await traced(()=>sessionTitleProjections({claims:c.claims,sessionIds:[other.id]}))
   expect(actual.value.get(other.id)).toMatchObject({title:title!.title,titleRevisionId:title!.revisionId})
   expect(actual.sql.some(sql=>/SELECT\s+read_native_private_title_acquisition\(/i.test(sql))).toBe(false)
  }finally{await c.f.pool.query('DELETE FROM sessions WHERE id=$1',[other.id])}
 },60_000)
 it('serves the actual authenticated browser list DTO without reverting to the old ancestry work',async()=>{
  const c=cases.find(row=>row.populated&&row.mixed)!
  const expected=await fallback(async()=>c.browserList())
  const actual=await traced(async()=>c.browserList())
  expect(actual.value.status,JSON.stringify(actual.value.body)).toBe(200)
  expect(actual.value.headers['cache-control']).toBe('no-store')
  const select=(body:{id:string}[])=>body.find(row=>row.id===c.session.id)
  expect(select(actual.value.body)).toEqual(select(expected.body))
  expect(select(actual.value.body)).toMatchObject({title:c.title.title,titleRevisionId:c.title.revisionId})
  assertFreshSingleton(actual.sql)
 },90_000)
 it('declines a changed new guard without invoking unknown code and keeps complete fallback',async()=>{
  const c=cases[3],expected=await fallback(c.list)
  const actual=await withGuardBody("BEGIN RAISE EXCEPTION 'fictional_unknown_private_title_guard_invoked'; END",c.list)
  expect(actual).toEqual(expected);assertProjection(c,actual)
 },90_000)
 it('declines unchanged helper bodies after volatility or ACL drift, retaining canonical fallback',async()=>{
  const c=cases[3],expected=await fallback(c.list)
  const signature='private_transcript_message_fingerprint(session_messages)'
  const original=(await getPool().query<{definition:string}>(
   'SELECT pg_get_functiondef($1::regprocedure) definition',[signature])).rows[0].definition
  await getPool().query('ALTER FUNCTION private_transcript_message_fingerprint(session_messages) VOLATILE')
  try{
   const actual=await traced(c.list)
   expect(actual.value).toEqual(expected)
   expect(actual.sql.some(sql=>/\bread_native_session_field_dependencies\s*\(/i.test(sql))).toBe(true)
  }finally{await getPool().query(original)}
  await getPool().query('GRANT EXECUTE ON FUNCTION native_private_title_frame(uuid,jsonb) TO app_user')
  try{
   const actual=await traced(c.list)
   expect(actual.value).toEqual(expected)
   expect(actual.sql.some(sql=>/\bread_native_session_field_dependencies\s*\(/i.test(sql))).toBe(true)
  }finally{await getPool().query('REVOKE EXECUTE ON FUNCTION native_private_title_frame(uuid,jsonb) FROM app_user')}
  assertFreshSingleton((await traced(c.list)).sql)
 },90_000)
 it('keeps the new internal guard private and owner identity-only reads non-admitting',async()=>{
  expect((await getAppPool().query("SELECT has_function_privilege(current_user,$1,'EXECUTE') allowed",[guard])).rows[0].allowed).toBe(false)
  const c=cases[3]
  for(const [sql,args] of [
   ['SELECT read_native_private_title_evidence($1,$2) value',[c.f.workspaceId,c.title.revisionId]],
   ['SELECT read_native_private_title_acquisition($1,$2,$3) value',[c.f.workspaceId,c.session.id,c.title.revisionId]],
  ] as const)expect((await c.f.pool.query(sql,[...args])).rows[0].value).toBeNull()
  // Discover additional private implementation helpers without hard-coding their names.
  const internals=(await c.f.pool.query<{signature:string}>(`SELECT oid::regprocedure::text signature FROM pg_proc
   WHERE pronamespace='public'::regnamespace AND proname LIKE 'native_private_title_%'`)).rows
  expect(internals.length).toBeGreaterThan(0)
  for(const {signature} of internals)expect((await getAppPool().query(
   "SELECT has_function_privilege(current_user,$1,'EXECUTE') allowed",[signature])).rows[0].allowed,signature).toBe(false)
 })
 it('does not bind an owned revision to another session or expose it to a foreign member SQL frame',async()=>{
  const c=cases[3]
  const other=await createPersonalWebSession({assistantId:c.f.assistantId,userId:c.f.ownerId,workspaceId:c.f.workspaceId,
   channelType:'web',channelId:randomUUID(),appOrigin:'chat'},
  {actorUserId:c.f.ownerId,authSessionId:c.device.id,authVersion:c.device.authVersion})
  await frame(c,async client=>{
   expect((await client.query('SELECT read_native_private_title_acquisition($1,$2,$3) value',
    [c.f.workspaceId,c.session.id,c.title.revisionId])).rows[0].value).not.toBeNull()
   expect((await client.query('SELECT read_native_private_title_acquisition($1,$2,$3) value',
    [c.f.workspaceId,other.id,c.title.revisionId])).rows[0].value).toBeNull()
   expect((await client.query('SELECT read_native_private_title_acquisition($1,$2,$3) value',
    [c.f.workspaceId,c.session.id,randomUUID()])).rows[0].value).toBeNull()
  })
  await frame(c,async client=>{
   expect((await client.query('SELECT read_native_private_title_acquisition($1,$2,$3) value',
    [c.f.workspaceId,c.session.id,c.title.revisionId])).rows[0].value).toBeNull()
   expect((await client.query('SELECT read_native_private_title_evidence($1,$2) value',
    [c.f.workspaceId,c.title.revisionId])).rows[0].value).toBeNull()
  },c.f.secondId)
 },60_000)
 it('cannot select title payload when SQL access exceeds the original caller ceiling',async()=>{
  const c=cases[3],a=await c.fresh()
  // Confidential title, but a caller retained at internal. Neither the native
  // optional port nor canonical payload callback may widen that original floor.
  const narrowed={...a,execution:{...a.execution,security:{...a.execution.security,
   ceiling:{...a.execution.security.ceiling,clearance:'internal' as const,
    ...(a.execution.security.ceiling.departmentRead?{departmentRead:{...a.execution.security.ceiling.departmentRead,cap:'internal' as const}}:{})}}}}
  const payload=vi.fn(async()=>null)
  await expect(readRetainedContextFrame(narrowed,boundScopeSources(c.title),payload)).rejects.toBeDefined()
  expect(payload).not.toHaveBeenCalled()
  const attempted=await traced(async()=>{expect(await titles.readSessionTitle(c.session.id,narrowed)).toBeNull()})
  expect(attempted.sql.some(sql=>/SELECT\s+read_native_private_title_acquisition\(/i.test(sql))).toBe(false)
 },60_000)

 for(const change of ['edit','delete','hold','growth'] as const){
  it(`refuses a direct current-Memory title dependency after Memory ${change}`,async()=>{
   const c=await seed(true,true)
   assertProjection(c,await c.list())
   if(change==='edit')await c.f.pool.query('UPDATE memories SET summary=$2,scope_version=scope_version+1 WHERE id=$1',
    [c.memory!.id,'The fictional research notebook is now violet.'])
   if(change==='delete')await c.f.pool.query('DELETE FROM memories WHERE id=$1',[c.memory!.id])
   if(change==='hold')await c.f.pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[c.memory!.id])
   if(change==='growth')await c.f.memory('Another fictional research notebook is teal.',c.f.ownerId)
   const actual=await c.list(),expected=await fallback(c.list)
   expect(actual).toEqual(expected)
   expect(actual.get(c.session.id)?.titleRevisionId).toBeNull()
   expect(actual.get(c.session.id)?.title).not.toBe(c.title.title)
   // Historical utterance continuity is NOT a renewal of the old current fact.
   const dialogue=await readAdmittedSessionQuery({sessionId:c.session.id,throughSequence:2,topicThroughSequence:0,authority:await c.fresh()})
   expect(dialogue.history.map(row=>row.id)).toEqual([c.input.id,c.reply.id])
   expect(boundScopeSources(dialogue).map(source=>source.resourceKind)).toEqual(['private_transcript'])
   const currentAuthority=await c.fresh()
   const currentIndex=JSON.stringify(await createDbMemoryStore().getIndex(currentAuthority.execution.security.access,false,currentAuthority))
   if(change==='edit')expect(currentIndex).toContain('The fictional research notebook is now violet.')
   if(change==='growth')expect(currentIndex).toContain('Another fictional research notebook is teal.')
   else expect(currentIndex).not.toContain('The fictional research notebook is amber.')
  },90_000)
 }
 for(const change of ['edit','delete','hold'] as const){
  it(`withholds a saved title after transcript message ${change}`,async()=>{
   const c=await seed(false,true)
   assertProjection(c,await c.list())
   if(change==='edit')await c.f.pool.query('UPDATE session_messages SET content=$2 WHERE id=$1',
    [c.input.id,JSON.stringify([{type:'text',text:'Fictional changed utterance'}])])
   else if(change==='delete')await c.f.pool.query('DELETE FROM session_messages WHERE id=$1',[c.input.id])
   else await c.f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[c.input.id])
   const actual=await c.list()
   expect(actual).toEqual(await fallback(c.list))
   expect(actual.get(c.session.id)?.titleRevisionId).toBeNull()
   expect(actual.get(c.session.id)?.title).not.toBe(c.title.title)
  },90_000)
 }
 it('pins the workspace before the head in the independent output port, avoiding publisher lock inversion',async()=>{
  const c=cases[3],publisher=await getPool().connect()
  try{await frame(c,async client=>{
   const readerPid=(await client.query('SELECT pg_backend_pid() pid')).rows[0].pid
   const publisherPid=(await publisher.query('SELECT pg_backend_pid() pid')).rows[0].pid
   await publisher.query('BEGIN')
   await publisher.query("SET LOCAL lock_timeout='1s'")
   await publisher.query('SELECT id FROM workspaces WHERE id=$1 FOR NO KEY UPDATE',[c.f.workspaceId])
   const reading=client.query('SELECT read_native_private_title_evidence($1,$2) value',[c.f.workspaceId,c.title.revisionId])
   // Consume a possible cancellation even if the lock-order assertion fails.
   void reading.catch(()=>{})
   try{
    let blocked=false
    for(let attempt=0;attempt<100&&!blocked;attempt++){
     blocked=(await publisher.query('SELECT $2::int=ANY(pg_blocking_pids($1)) blocked',[readerPid,publisherPid])).rows[0].blocked
     if(!blocked)await new Promise(resolve=>setTimeout(resolve,10))
    }
    expect(blocked).toBe(true)
    // This must succeed while output waits for workspace, not deadlock on a
    // head SHARE lock taken in the opposite order by the output reader.
    await publisher.query('SELECT scope_revision_id FROM session_title_heads WHERE workspace_id=$1 AND session_id=$2 FOR UPDATE',
     [c.f.workspaceId,c.session.id])
   }finally{await publisher.query('ROLLBACK')}
   expect((await reading).rows[0].value).toMatchObject({admitted:true})
  })}finally{await publisher.query('ROLLBACK');publisher.release()}
 },30_000)
 for(const code of ['57014','55P03'])it(`withholds optional titles on a real final-proof database timeout ${code} and releases the frame`,async()=>{
  const c=cases[3],transcript=c.sources.find(source=>source.resourceKind==='private_transcript')!
  const blocker=await getPool().connect(),query=pg.Client.prototype.query
  const warning=vi.spyOn(console,'warn').mockImplementation(()=>{})
  let attempts=0
  const spy=vi.spyOn(pg.Client.prototype,'query').mockImplementation(function(this:pg.Client,...args:Parameters<typeof query>){
   if(typeof args[0]==='string'&&/^SELECT read_native_private_title_evidence\(/.test(args[0])){
    const connection=this
    return(async()=>{
     attempts++
     await blocker.query('BEGIN')
     await blocker.query('SELECT id FROM private_transcript_observations WHERE id=$1 FOR UPDATE',[transcript.resourceId])
     await connection.query(code==='57014'?"SET LOCAL statement_timeout='100ms'":"SET LOCAL lock_timeout='100ms'")
     return query.apply(connection,args)
    })()
   }
   return query.apply(this,args)
  } as typeof query)
  try{
   const value=await c.list()
   expect(value.get(c.session.id)).toEqual({title:null,titleRevisionId:null})
   expect(attempts).toBe(1)
   expect(warning).toHaveBeenCalledTimes(1)
   expect(warning.mock.calls[0][1]).toMatchObject({code})
  }finally{spy.mockRestore();warning.mockRestore();await blocker.query('ROLLBACK');blocker.release()}
  expect((await getAppPool().query('SELECT 1 value')).rows[0].value).toBe(1)
  expect(getAppPool().idleCount).toBe(getAppPool().totalCount)
 },60_000)
 it('rechecks the original credential after singleton capture before output',async()=>{
  const c=await seed(false,true),original=titles.readSessionTitle
  let captured=false
  vi.spyOn(titles,'readSessionTitle').mockImplementation(async(...args)=>{
   const value=await original(...args)
   if(args[0]===c.session.id&&value){captured=true;await c.f.pool.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1',[c.device.id])}
   return value
  })
  const actual=await c.list()
  expect(captured).toBe(true)
  expect(actual.get(c.session.id)?.titleRevisionId??null).toBeNull()
  expect(actual.get(c.session.id)?.title).not.toBe(c.title.title)
 },90_000)
 it('does not deliver a replaced head captured before the final output boundary',async()=>{
  const c=await seed(false,true),original=titles.readSessionTitle
  let replacement:titles.SessionTitle|null=null,captured=false
  vi.spyOn(titles,'readSessionTitle').mockImplementation(async(...args)=>{
   const value=await original(...args)
   if(args[0]===c.session.id&&value&&!captured){
    captured=true
    replacement=await titles.publishSessionTitle({sessionId:c.session.id,title:'Fictional replacement title',manual:false,
     expectedRevision:c.title.revisionId,authority:await c.fresh(),derivation:{producer:'fixture:replacement-private-title',sources:c.sources}})
   }
   return value
  })
  const actual=await c.list()
  expect(captured).toBe(true);expect(replacement).not.toBeNull()
  expect(actual.get(c.session.id)?.titleRevisionId).not.toBe(c.title.revisionId)
  expect(actual.get(c.session.id)?.title).not.toBe(c.title.title)
 },90_000)
 it.runIf(profile)('at least halves tracked mixed-closure work against unchanged fallback in both Memory cases',async()=>{
  expect((await getAppPool().query('SHOW track_functions')).rows[0].track_functions).toBe('all')
  for(const c of cases.filter(row=>row.mixed)){
   await c.list();await fallback(c.list)
   const canonical=await fallback(()=>work(c.list)),native=await work(c.list)
   expect(canonical.calls,'Function tracking must be enabled for fixture roles').toBeGreaterThan(0)
   expect(native.calls).toBeGreaterThan(0)
   expect(native.calls).toBeLessThan(canonical.calls/2)
   console.info('private-title-function-profile',JSON.stringify({populated:c.populated,canonical,native}))
  }
 },180_000)
})
