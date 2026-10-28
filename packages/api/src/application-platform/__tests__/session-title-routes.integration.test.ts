import {createDbSavedViewStore} from '../../db/saved-views-store.js'
import {createDbCommentThreadStore} from '../../db/comment-thread-store.js'
import {afterAll,afterEach,describe,expect,it,vi} from 'vitest'
import express from 'express'
import request from 'supertest'
import {boundScopeSources} from '@use-brian/core'
import {sessionRoutes} from '../../routes/sessions.js'
import {requireAuth} from '../../auth/middleware.js'
import {createTokens} from '../../auth/jwt.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {getPool,getAppPool} from '../../db/client.js'
import {addSessionMessage,createPersonalWebSession} from '../../db/sessions.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {publishSessionTitle} from '../../db/session-title-store.js'
import {pinSessionTitleClaims,readCurrentSessionTitle,renameCurrentSessionTitle,resolveSessionTitleAuthority,sessionTitleProjection} from '../../routes/session-title-authority.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const{assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const secret='fictional-native-title-route-secret'
type Fixture=Awaited<ReturnType<typeof persistentContextFixture>>
describe.sequential('[COMP:api/application-persistence] actual browser title DTO and authored rename',()=>{
 let fixture:Fixture|undefined
 afterEach(async()=>{vi.restoreAllMocks();await getPool().query('DROP TRIGGER IF EXISTS fixture_r3_browser_title_actor ON session_context_scope_revisions');await getPool().query('DROP FUNCTION IF EXISTS fixture_r3_browser_title_actor()');await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function setup(){
  fixture=await persistentContextFixture();const f=fixture
  const auth=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional title device',userAgent:null,ipAddress:null}))!
  const claims={userId:f.ownerId,sessionId:auth.id,authVersion:auth.authVersion}
  const session=await createPersonalWebSession({assistantId:f.assistantId,userId:f.ownerId,workspaceId:f.workspaceId,channelType:'web',channelId:crypto.randomUUID(),appOrigin:'chat'},
   {actorUserId:f.ownerId,authSessionId:auth.id,authVersion:auth.authVersion})
  const app=express();app.use(express.json());app.use('/sessions',requireAuth(secret),sessionRoutes())
  const token=createTokens(f.ownerId,secret,auth).accessToken
  const get=(url:string)=>request(app).get('/sessions'+url).set('Authorization','Bearer '+token)
  const patch=(title:string)=>request(app).patch('/sessions/'+session.id).set('Authorization','Bearer '+token).send({title})
  const byChannel=()=>get('/by-channel?'+new URLSearchParams({assistantId:f.assistantId,channelId:session.channelId,channelType:'web'}))
  const list=()=>get('?'+new URLSearchParams({assistantId:f.assistantId,workspaceId:f.workspaceId}))
  return{f,session,auth,claims,app,token,get,patch,byChannel,list}
 }
 /** Pause after a real owner metadata read, with no source transaction or allow-result double. */
 function pauseMetadataRead(matches:(sql:string,values:unknown[])=>boolean){
  const pool=getPool(),original=pool.query.bind(pool)
  let enter!:()=>void,release!:()=>void,paused=false
  const entered=new Promise<void>(resolve=>{enter=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
  const spy=vi.spyOn(pool,'query').mockImplementation((async(sql:string,values:unknown[]=[])=>{
   const result=await original(sql,values)
   if(!paused&&matches(sql,values)){paused=true;enter();await gate}
   return result
  }) as typeof pool.query)
  return{entered,release,restore:()=>spy.mockRestore()}
 }
 it('holds legacy scalar bytes on the actual header, personal list and channel lookup',async()=>{
  const c=await setup()
  await c.f.pool.query("UPDATE sessions SET title='Fictional unproved private title' WHERE id=$1",[c.session.id])
  for(const response of [await c.get('/'+c.session.id),await c.list(),await c.byChannel()]){
   expect(response.status,JSON.stringify(response.body)).toBe(200)
   expect(response.headers['cache-control']).toBe('no-store')
   expect(JSON.stringify(response.body)).not.toContain('Fictional unproved private title')
   const row=Array.isArray(response.body)?response.body.find((row:{id:string})=>row.id===c.session.id):response.body
   expect(row).toMatchObject({id:c.session.id,titleRevisionId:null})
  }
 })
 it('labels existing personal and shared chats from admitted user text without promoting legacy names or writing a title',async()=>{
  const c=await setup()
  await c.f.pool.query("UPDATE sessions SET title='Fictional held historical name' WHERE id=$1",[c.session.id])
  await addSessionMessage({sessionId:c.session.id,role:'assistant',content:[{type:'text',text:'Fictional private model planning'}],scope:{...c.f.envelope,userId:c.f.ownerId}})
  await addSessionMessage({sessionId:c.session.id,role:'user',content:[{type:'tool_result',toolUseId:'fictional-preview-tool',name:'fictionalTool',content:'Fictional tool result'}],scope:{...c.f.envelope,userId:c.f.ownerId}})
  await addSessionMessage({sessionId:c.session.id,role:'user',content:[{type:'text',text:'  **Fictional launch checklist**\nAdditional details'}],scope:{...c.f.envelope,userId:c.f.ownerId}})
  for(const response of [await c.get('/'+c.session.id),await c.list(),await c.byChannel()]){
   expect(response.status,JSON.stringify(response.body)).toBe(200)
   const row=Array.isArray(response.body)?response.body.find((row:{id:string})=>row.id===c.session.id):response.body
   expect(row).toMatchObject({title:'Fictional launch checklist',titleRevisionId:null})
   expect(JSON.stringify(response.body)).not.toContain('Fictional held historical name')
  }
  const preview=await sessionTitleProjection({claims:c.claims,sessionId:c.session.id})
  expect(boundScopeSources(preview).some(source=>source.resourceKind==='application_field')).toBe(true)
  expect(await readCurrentSessionTitle({claims:c.claims,sessionId:c.session.id})).toBeNull()
  expect((await c.f.pool.query('SELECT title FROM sessions WHERE id=$1',[c.session.id])).rows).toEqual([{title:'Fictional held historical name'}])
  await c.f.history()
  const shared=await c.get('/workspace?workspaceId='+c.f.workspaceId)
  expect(shared.status,JSON.stringify(shared.body)).toBe(200)
  expect(shared.body.find((row:{id:string})=>row.id===c.f.session.id)).toMatchObject({title:'Fictional earlier request',titleRevisionId:null})
  expect((await c.f.pool.query('SELECT session_id FROM session_title_heads WHERE workspace_id=$1',[c.f.workspaceId])).rows).toEqual([])
  expect((await c.patch('Fictional explicit saved choice')).status).toBe(200)
  expect((await c.get('/'+c.session.id)).body).toMatchObject({title:'Fictional explicit saved choice',titleRevisionId:expect.any(String)})
 })
 it('keeps tool-only and assistant-only histories as placeholders',async()=>{
  const c=await setup()
  await addSessionMessage({sessionId:c.session.id,role:'assistant',content:[{type:'text',text:'Fictional model narration'}],scope:{...c.f.envelope,userId:c.f.ownerId}})
  await addSessionMessage({sessionId:c.session.id,role:'user',content:[{type:'tool_result',toolUseId:'fictional-only-tool',name:'fictionalTool',content:'Fictional tool output'}],scope:{...c.f.envelope,userId:c.f.ownerId}})
  expect((await c.get('/'+c.session.id)).body).toMatchObject({title:'New Chat',titleRevisionId:null})
 })
 it('does not read user text beyond the first ten physical message keys',async()=>{
  const c=await setup()
  for(let n=0;n<10;n++)await addSessionMessage({sessionId:c.session.id,role:'assistant',content:[{type:'text',text:'Fictional earlier assistant text'}],scope:{...c.f.envelope,userId:c.f.ownerId}})
  await addSessionMessage({sessionId:c.session.id,role:'user',content:[{type:'text',text:'Fictional eleventh message'}],scope:{...c.f.envelope,userId:c.f.ownerId}})
  expect((await c.get('/'+c.session.id)).body).toMatchObject({title:'New Chat',titleRevisionId:null})
 })
 it('publishes a manual immutable revision through the actual PATCH and all title DTO readers',async()=>{
  const c=await setup(),response=await c.patch('Fictional authored current title')
  expect(response.status,JSON.stringify(response.body)).toBe(200)
  expect(response.body).toMatchObject({ok:true,title:'Fictional authored current title',titleRevisionId:expect.any(String)})
  for(const read of [await c.get('/'+c.session.id),await c.list(),await c.byChannel()]){
   expect(read.status,JSON.stringify(read.body)).toBe(200)
   const row=Array.isArray(read.body)?read.body.find((row:{id:string})=>row.id===c.session.id):read.body
   expect(row).toMatchObject({title:response.body.title,titleRevisionId:response.body.titleRevisionId})
  }
  expect(await readCurrentSessionTitle({claims:c.claims,sessionId:c.session.id})).toMatchObject({title:response.body.title,manual:true,revisionId:response.body.titleRevisionId})
  expect((await c.f.pool.query('SELECT title FROM sessions WHERE id=$1',[c.session.id])).rows).toEqual([{title:null}])
 })
 it('holds a contracted title before every actual DTO and admits a fresh authored replacement without adopting old source bytes',async()=>{
  const c=await setup(),authority=await resolveSessionTitleAuthority({claims:c.claims,sessionId:c.session.id,readOnly:false})
  await addSessionMessage({sessionId:c.session.id,role:'user',content:[{type:'text',text:'Fictional readable alternate label'}],scope:{...c.f.envelope,userId:c.f.ownerId}})
  await readAdmittedSessionQuery({sessionId:c.session.id,throughSequence:0,topicThroughSequence:0,authority})
  const memory=await c.f.memory('Fictional consumed title source',c.f.ownerId)
  const admitted=await createDbMemoryStore().getById(authority.execution.security.access,memory.id);expect(admitted).not.toBeNull()
  authority.accumulator.note({sources:boundScopeSources(admitted!)})
  const title=await publishSessionTitle({sessionId:c.session.id,title:'Fictional source derived title',manual:false,expectedRevision:null,authority,
   derivation:{producer:'fixture:actual-route-title',sources:authority.accumulator.evidence.sources??[]}});expect(title).not.toBeNull()
  expect((await c.get('/'+c.session.id)).body).toMatchObject({title:title!.title,titleRevisionId:title!.revisionId})
  await c.f.pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[memory.id])
  for(const response of [await c.get('/'+c.session.id),await c.list(),await c.byChannel()]){
   expect(response.status,JSON.stringify(response.body)).toBe(200)
   expect(JSON.stringify(response.body)).not.toContain(title!.title)
   const row=Array.isArray(response.body)?response.body.find((row:{id:string})=>row.id===c.session.id):response.body
   expect(row).toMatchObject({titleRevisionId:null})
  }
  const fresh=await c.patch('Fictional fresh authored replacement')
  expect(fresh.status,JSON.stringify(fresh.body)).toBe(200)
  expect((await c.get('/'+c.session.id)).body).toMatchObject({title:fresh.body.title,titleRevisionId:fresh.body.titleRevisionId})
 })
 it('uses the actual workspace participant for a shared rename and current workspace-list title',async()=>{
  const c=await setup(),device=(await authSessionStore.create(c.f.firstId,{deviceLabel:'Fictional workspace participant',userAgent:null,ipAddress:null}))!
  const token=createTokens(c.f.firstId,secret,device).accessToken
  // An additional rejecting SQL assertion observes the actual writer GUC.
  // It grants no ACL and fails if the creator is substituted for this member.
  await c.f.pool.query(`CREATE FUNCTION fixture_r3_browser_title_actor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
   IF NEW.session_id='${c.f.session.id}'::uuid AND current_setting('app.current_user_id',true) IS DISTINCT FROM '${c.f.firstId}' THEN
    RAISE EXCEPTION 'Fictional original actor mismatch';END IF;RETURN NEW;END $$`)
  await c.f.pool.query('CREATE TRIGGER fixture_r3_browser_title_actor BEFORE INSERT ON session_context_scope_revisions FOR EACH ROW EXECUTE FUNCTION fixture_r3_browser_title_actor()')
  const renamed=await request(c.app).patch('/sessions/'+c.f.session.id).set('Authorization','Bearer '+token).send({title:'Fictional shared participant title'})
  expect(renamed.status,JSON.stringify(renamed.body)).toBe(200)
  const list=await request(c.app).get('/sessions/workspace?'+new URLSearchParams({workspaceId:c.f.workspaceId})).set('Authorization','Bearer '+token)
  expect(list.status,JSON.stringify(list.body)).toBe(200)
  expect(list.body.find((row:{id:string})=>row.id===c.f.session.id)).toMatchObject({title:renamed.body.title,titleRevisionId:renamed.body.titleRevisionId})
 })
 it('lets a current reader who did not start a real doc thread rename it through the actual HTTP writer',async()=>{
  const c=await setup(),page=await createDbSavedViewStore().createDraft({userId:c.f.ownerId,workspaceId:c.f.workspaceId,name:'Fictional authored discussion page',
   entity:'tasks',viewType:'table',binding:{entity:'tasks',viewType:'table'},page:{blocks:[]}},
   {provenance:{kind:'human-authored',actorId:c.f.ownerId}})
  const thread=await createDbCommentThreadStore().createThread({userId:c.f.ownerId,workspaceId:c.f.workspaceId,pageId:page.id,assistantId:c.f.assistantId,anchorKind:'human_range'})
  const device=(await authSessionStore.create(c.f.secondId,{deviceLabel:'Fictional document participant',userAgent:null,ipAddress:null}))!
  const token=createTokens(c.f.secondId,secret,device).accessToken
  const renamed=await request(c.app).patch('/sessions/'+thread.sessionId).set('Authorization','Bearer '+token).send({title:'Fictional current discussion title'})
  expect(renamed.status,JSON.stringify(renamed.body)).toBe(200)
  expect(renamed.body).toMatchObject({ok:true,title:'Fictional current discussion title',titleRevisionId:expect.any(String)})
  const title=await readCurrentSessionTitle({claims:{userId:c.f.secondId,sessionId:device.id,authVersion:device.authVersion},sessionId:thread.sessionId})
  expect(title).toMatchObject({title:renamed.body.title,manual:true,revisionId:renamed.body.titleRevisionId})
 })
 it('rechecks an earlier title after a second real list row blocks and the first source is withdrawn',async()=>{
  const c=await setup(),authority=await resolveSessionTitleAuthority({claims:c.claims,sessionId:c.session.id,readOnly:false})
  await readAdmittedSessionQuery({sessionId:c.session.id,throughSequence:0,topicThroughSequence:0,authority})
  const memory=await c.f.memory('Fictional list title source',c.f.ownerId)
  const admitted=await createDbMemoryStore().getById(authority.execution.security.access,memory.id);expect(admitted).not.toBeNull()
  authority.accumulator.note({sources:boundScopeSources(admitted!)})
  const first=await publishSessionTitle({sessionId:c.session.id,title:'Fictional revoked list title',manual:false,expectedRevision:null,authority,
   derivation:{producer:'fixture:list-output-race',sources:authority.accumulator.evidence.sources??[]}});expect(first).not.toBeNull()
  const other=await createPersonalWebSession({assistantId:c.f.assistantId,userId:c.f.ownerId,workspaceId:c.f.workspaceId,channelType:'web',channelId:crypto.randomUUID(),appOrigin:'chat'},
   {actorUserId:c.f.ownerId,authSessionId:c.auth.id,authVersion:c.auth.authVersion})
  const second=await renameCurrentSessionTitle({claims:c.claims,sessionId:other.id,title:'Fictional independent list title'});expect(second).not.toBeNull()
  // The first projection is selected before the paused row, with no SQL
  // frame held across the actual source withdrawal.
  await c.f.pool.query("UPDATE sessions SET last_active_at=clock_timestamp()+interval '1 second' WHERE id=$1",[c.session.id])
  const pause=pauseMetadataRead((sql,values)=>sql.includes('LEFT JOIN session_title_heads title')&&values[1]===other.id)
  const pending=c.list().then(response=>response)
  let response:Awaited<typeof pending>|undefined
  try{
   await pause.entered
   await c.f.pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[memory.id])
  }finally{pause.release();response=await pending;pause.restore()}
  expect(response.status,JSON.stringify(response.body)).toBe(200)
  const rows=response.body as Array<{id:string;title:string;titleRevisionId:string|null}>
  expect(rows.find(row=>row.id===c.session.id)).toMatchObject({title:'New Chat',titleRevisionId:null})
  expect(JSON.stringify(response.body)).not.toContain(first!.title)
  expect(rows.find(row=>row.id===other.id)).toMatchObject({title:second!.title,titleRevisionId:second!.revisionId})
 })
 it.each(['message edit','saved title'] as const)('withholds an earlier preview after a concurrent %s before list output',async(change)=>{
  const c=await setup(),message=await addSessionMessage({sessionId:c.session.id,role:'user',content:[{type:'text',text:'Fictional original preview label'}],scope:{...c.f.envelope,userId:c.f.ownerId}})
  const other=await createPersonalWebSession({assistantId:c.f.assistantId,userId:c.f.ownerId,workspaceId:c.f.workspaceId,channelType:'web',channelId:crypto.randomUUID(),appOrigin:'chat'},
   {actorUserId:c.f.ownerId,authSessionId:c.auth.id,authVersion:c.auth.authVersion})
  const second=await renameCurrentSessionTitle({claims:c.claims,sessionId:other.id,title:'Fictional independent current title'})
  expect(second).not.toBeNull()
  await c.f.pool.query("UPDATE sessions SET last_active_at=clock_timestamp()+interval '1 second' WHERE id=$1",[c.session.id])
  const pause=pauseMetadataRead((sql,values)=>sql.includes('LEFT JOIN session_title_heads title')&&values[1]===other.id)
  const pending=c.list().then(response=>response)
  let response:Awaited<typeof pending>|undefined
  try{
   await pause.entered
   if(change==='message edit')await c.f.pool.query('UPDATE session_messages SET content=$2 WHERE id=$1',[message.id,JSON.stringify([{type:'text',text:'Fictional updated preview label'}])])
   else expect(await renameCurrentSessionTitle({claims:c.claims,sessionId:c.session.id,title:'Fictional concurrent saved title'})).not.toBeNull()
  }finally{pause.release();response=await pending;pause.restore()}
  expect(response.status,JSON.stringify(response.body)).toBe(200)
  expect(response.body.find((row:{id:string})=>row.id===c.session.id)).toMatchObject({title:'New Chat',titleRevisionId:null})
  expect(response.body.find((row:{id:string})=>row.id===other.id)).toMatchObject({title:second!.title,titleRevisionId:second!.revisionId})
  expect(JSON.stringify(response.body)).not.toContain('Fictional original preview label')
  expect((await c.get('/'+c.session.id)).body).toMatchObject({title:change==='message edit'?'Fictional updated preview label':'Fictional concurrent saved title'})
 })
 it('checks saved-head absence inside the final source frame after a completed absence query races a rename',async()=>{
  const c=await setup()
  await addSessionMessage({sessionId:c.session.id,role:'user',content:[{type:'text',text:'Fictional superseded preview'}],scope:{...c.f.envelope,userId:c.f.ownerId}})
  let reads=0
  const pause=pauseMetadataRead((sql,values)=>sql.startsWith('SELECT 1 FROM session_title_heads')&&values[1]===c.session.id&&++reads===2)
  const pending=sessionTitleProjection({claims:c.claims,sessionId:c.session.id})
  try{
   await pause.entered
   expect(await renameCurrentSessionTitle({claims:c.claims,sessionId:c.session.id,title:'Fictional saved winner'})).not.toBeNull()
  }finally{pause.release()}
  expect(await pending).toEqual({title:null,titleRevisionId:null});pause.restore()
  expect((await c.get('/'+c.session.id)).body).toMatchObject({title:'Fictional saved winner',titleRevisionId:expect.any(String)})
 })
 it('pins original middleware claims and authored command before any asynchronous boundary',async()=>{
  const c=await setup(),carrier={userId:c.f.ownerId,authSessionId:c.auth.id,authVersion:c.auth.authVersion}
  const claims=pinSessionTitleClaims(carrier)!
  carrier.userId=c.f.firstId;carrier.authSessionId=crypto.randomUUID();carrier.authVersion++
  const command={claims:{...claims},sessionId:c.session.id,title:'Fictional original authored command'}
  const pending=renameCurrentSessionTitle(command)
  command.claims.userId=c.f.firstId;command.sessionId=c.f.session.id;command.title='Fictional mutated command'
  expect(await pending).toMatchObject({title:'Fictional original authored command',manual:true})
  expect(await readCurrentSessionTitle({claims,sessionId:c.session.id})).toMatchObject({title:'Fictional original authored command'})
  expect((await c.f.pool.query('SELECT scope_revision_id FROM session_title_heads WHERE session_id=$1',[c.f.session.id])).rows).toEqual([])
 })
 it('refuses a revoked original device while another real current device can still read and rename',async()=>{
  const c=await setup();expect((await c.patch('Fictional device bound title')).status).toBe(200)
  expect(await authSessionStore.revokeForUser(c.f.ownerId,c.auth.id)).toBe(true)
  await expect(readCurrentSessionTitle({claims:c.claims,sessionId:c.session.id})).rejects.toMatchObject({code:'scope_evidence_missing'})
  expect((await c.patch('Fictional revoked device command')).status).toBe(401)
  const device=(await authSessionStore.create(c.f.ownerId,{deviceLabel:'Fictional independent device',userAgent:null,ipAddress:null}))!
  const claims={userId:c.f.ownerId,sessionId:device.id,authVersion:device.authVersion}
  expect(await readCurrentSessionTitle({claims,sessionId:c.session.id})).toMatchObject({title:'Fictional device bound title'})
  expect(await renameCurrentSessionTitle({claims,sessionId:c.session.id,title:'Fictional independently authored title'})).toMatchObject({manual:true})
 })
 it('never substitutes the session creator for another actual member attempting the HTTP rename',async()=>{
  const c=await setup(),device=(await authSessionStore.create(c.f.firstId,{deviceLabel:'Fictional other member',userAgent:null,ipAddress:null}))!
  const token=createTokens(c.f.firstId,secret,device).accessToken
  const response=await request(c.app).patch('/sessions/'+c.session.id).set('Authorization','Bearer '+token).send({title:'Fictional unauthorized choice'})
  expect(response.status,JSON.stringify(response.body)).toBe(403)
  expect((await c.f.pool.query('SELECT scope_revision_id FROM session_title_heads WHERE session_id=$1',[c.session.id])).rows).toEqual([])
 })
})
