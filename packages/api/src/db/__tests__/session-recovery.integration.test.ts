import {randomUUID} from 'node:crypto'
import {afterAll,afterEach,describe,expect,it,vi} from 'vitest'
import express from 'express'
import request from 'supertest'
import {getAppPool,getPool,applyRLSGucs} from '../client.js'
import {authSessionStore} from '../auth-session-store.js'
import {createPersonalWebSession} from '../sessions.js'
import {inspectSessionRecovery,recoverSession} from '../session-recovery.js'
import {persistentContextFixture} from '../../application-platform/__tests__/fixtures/persistent-context.js'
import {requireAuth} from '../../auth/middleware.js'
import {createTokens} from '../../auth/jwt.js'
import {sessionRoutes} from '../../routes/sessions.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
type Fixture=Awaited<ReturnType<typeof persistentContextFixture>>
const secret='fictional-private-recovery-secret'
describe.sequential('[COMP:api/session-recovery] actual private continuation transactions',()=>{
 let fixture:Fixture|undefined
 afterEach(async()=>{await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function setup(scoped=false){
  fixture=await persistentContextFixture();const f=fixture
  const auth=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional recovery device',userAgent:null,ipAddress:null}))!
  const claims={userId:f.ownerId,sessionId:auth.id,authVersion:auth.authVersion}
  const group=scoped?randomUUID():null,project=scoped?randomUUID():null
  if(scoped){
   await f.pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1,$2,'Fictional department',$3,'team',$1::uuid::text,$4)",[group,f.workspaceId,f.ownerId,`team:${group}`])
   await f.pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Fictional project','fictional project',$3)",[project,f.workspaceId,f.ownerId])
  }
  const source=await createPersonalWebSession({assistantId:f.assistantId,userId:f.ownerId,workspaceId:f.workspaceId,
   channelType:'web',channelId:randomUUID(),appOrigin:'chat',contextGroupId:group,contextProjectId:project},
  {actorUserId:f.ownerId,authSessionId:auth.id,authVersion:auth.authVersion})
  await f.pool.query(`INSERT INTO session_messages(session_id,role,content,sequence_num) VALUES($1,'assistant',$2,1)`,
   [source.id,JSON.stringify([{type:'text',text:'Fictional unproved historical response'}])])
  if(!scoped)await f.pool.query("UPDATE sessions SET workspace_id=NULL WHERE id=$1",[source.id])
  await f.pool.query("UPDATE sessions SET channel_type='slack',channel_id=$2 WHERE id=$1",[source.id,'C_FICTIONAL_RECOVERY'])
  const input={claims,workspaceId:f.workspaceId,sessionId:source.id}
  const app=express();app.use(express.json());app.use('/sessions',requireAuth(secret),sessionRoutes())
  const token=createTokens(f.ownerId,secret,auth).accessToken
  return{f,claims,source,input,app,token,group,project}
 }
 it('recovers a legacy NULL-workspace chat without reading, copying or changing its historical rows',async()=>{
  const c=await setup()
  const before=(await c.f.pool.query('SELECT to_jsonb(s) AS value FROM sessions s WHERE id=$1',[c.source.id])).rows[0].value
  const messages=(await c.f.pool.query('SELECT to_jsonb(m) AS value FROM session_messages m WHERE session_id=$1',[c.source.id])).rows
  await request(c.app).get(`/sessions/${c.source.id}/messages`).set('Authorization','Bearer '+c.token).expect(403)
  const inspected=await request(c.app).get(`/sessions/${c.source.id}/recovery?workspaceId=${c.f.workspaceId}`).set('Authorization','Bearer '+c.token).expect(200)
  expect(inspected.headers['cache-control']).toBe('no-store')
  const preview=inspected.body
  expect(preview.status).toBe('available')
  expect(JSON.stringify(preview)).not.toContain('Fictional unproved historical response')
  const applied=await request(c.app).post(`/sessions/${c.source.id}/recovery`).set('Authorization','Bearer '+c.token)
   .send({workspaceId:c.f.workspaceId,expectedRevision:preview.revision}).expect(200)
  const result=applied.body
  expect(result).toMatchObject({workspaceId:c.f.workspaceId,assistantId:c.f.assistantId,replayed:false})
  expect(result.policy).toMatchObject({addressing:"every_message",post:false,presence:false})
  expect(result.sessionId).not.toBe(c.source.id)
  expect((await c.f.pool.query('SELECT to_jsonb(s) AS value FROM sessions s WHERE id=$1',[c.source.id])).rows[0].value).toEqual(before)
  expect((await c.f.pool.query('SELECT to_jsonb(m) AS value FROM session_messages m WHERE session_id=$1',[c.source.id])).rows).toEqual(messages)
  expect((await c.f.pool.query('SELECT id FROM session_messages WHERE session_id=$1',[result.sessionId])).rows).toEqual([])
  expect((await c.f.pool.query('SELECT visibility,channel_type,app_origin,workspace_id FROM sessions WHERE id=$1',[result.sessionId])).rows[0])
   .toEqual({visibility:'personal',channel_type:'web',app_origin:'chat',workspace_id:c.f.workspaceId})
  await request(c.app).get(`/sessions/${c.source.id}/messages`).set('Authorization','Bearer '+c.token).expect(403)
  await request(c.app).get(`/sessions/${result.sessionId}/messages`).set('Authorization','Bearer '+c.token).expect(200,[])
  const summary=await request(c.app).get(`/sessions/${result.sessionId}`).set('Authorization','Bearer '+c.token).expect(200)
  expect(summary.body.recoveredFromSessionId).toBe(c.source.id)
 })
 it('serializes concurrent clicks and replays a lost response as the same private chat',async()=>{
  const c=await setup(),preview=await inspectSessionRecovery(c.input),command={...c.input,expectedRevision:preview.revision}
  const results=await Promise.all([recoverSession(command),recoverSession(command),recoverSession(command)])
  expect(new Set(results.map(row=>row.sessionId)).size).toBe(1)
  expect(results.filter(row=>!row.replayed)).toHaveLength(1)
  expect((await c.f.pool.query('SELECT target_session_id FROM session_recoveries WHERE source_session_id=$1',[c.source.id])).rows).toHaveLength(1)
  expect(await recoverSession(command)).toMatchObject({sessionId:results[0].sessionId,replayed:true})
 })
 it('fences a changed source binding or policy before creating anything',async()=>{
  const c=await setup(),preview=await inspectSessionRecovery(c.input)
  await c.f.pool.query("UPDATE sessions SET channel_id='C_FICTIONAL_CHANGED' WHERE id=$1",[c.source.id])
  await expect(recoverSession({...c.input,expectedRevision:preview.revision})).rejects.toMatchObject({code:'session_recovery_changed'})
  expect((await c.f.pool.query('SELECT * FROM session_recoveries WHERE source_session_id=$1',[c.source.id])).rows).toEqual([])
 })
 it('refuses running turns and forged revisions without creating a continuation',async()=>{
  const c=await setup(),preview=await inspectSessionRecovery(c.input)
  await expect(recoverSession({...c.input,expectedRevision:'a'.repeat(64)})).rejects.toMatchObject({code:'session_recovery_changed'})
  await c.f.pool.query("UPDATE sessions SET status='running' WHERE id=$1",[c.source.id])
  const busy=await inspectSessionRecovery(c.input);expect(busy.status).toBe('busy')
  await expect(recoverSession({...c.input,expectedRevision:busy.revision})).rejects.toMatchObject({code:'session_recovery_busy'})
  expect((await c.f.pool.query('SELECT target_session_id FROM session_recoveries WHERE source_session_id=$1',[c.source.id])).rows).toEqual([])
 })
 it('rechecks a revoked device and current assistant authority even on replay',async()=>{
  const c=await setup(),preview=await inspectSessionRecovery(c.input),command={...c.input,expectedRevision:preview.revision}
  await recoverSession(command)
  await authSessionStore.revokeForUser(c.f.ownerId,c.claims.sessionId)
  await expect(recoverSession(command)).rejects.toMatchObject({code:'authenticated_session_required'})
 })
 it('does not let another member, a foreign workspace or a workspace-room creator recover private history',async()=>{
  const c=await setup(),other=(await authSessionStore.create(c.f.firstId,{deviceLabel:'Fictional other device',userAgent:null,ipAddress:null}))!
  await expect(inspectSessionRecovery({...c.input,claims:{userId:c.f.firstId,sessionId:other.id,authVersion:other.authVersion}}))
   .rejects.toMatchObject({code:'session_recovery_unavailable'})
  await expect(inspectSessionRecovery({...c.input,workspaceId:randomUUID()})).rejects.toMatchObject({code:'session_recovery_unavailable'})
  await expect(inspectSessionRecovery({...c.input,sessionId:c.f.session.id})).rejects.toMatchObject({code:'session_recovery_unavailable'})
 })
 it('preserves the exact selected Department and Project rather than adopting current defaults',async()=>{
  const c=await setup(true),preview=await inspectSessionRecovery(c.input)
  const result=await recoverSession({...c.input,expectedRevision:preview.revision})
  expect((await c.f.pool.query('SELECT context_group_id,context_project_id,context_compartments FROM sessions WHERE id=$1',[result.sessionId])).rows[0])
   .toEqual({context_group_id:c.group,context_project_id:c.project,context_compartments:[`team:${c.group}`]})
 })
 it('rechecks an actual policy revision change and does not return a changed target audience',async()=>{
  const c=await setup(),preview=await inspectSessionRecovery(c.input)
  await c.f.pool.query('INSERT INTO workspace_access_policies(workspace_id) VALUES($1) ON CONFLICT DO NOTHING',[c.f.workspaceId])
  await c.f.pool.query('UPDATE workspace_access_policies SET revision=revision+1 WHERE workspace_id=$1',[c.f.workspaceId])
  await expect(recoverSession({...c.input,expectedRevision:preview.revision})).rejects.toMatchObject({code:'session_recovery_changed'})
  const current=await inspectSessionRecovery(c.input),result=await recoverSession({...c.input,expectedRevision:current.revision})
  await c.f.pool.query("UPDATE sessions SET visibility='workspace',effective_clearance='internal' WHERE id=$1",[result.sessionId])
  await expect(recoverSession({...c.input,expectedRevision:current.revision})).rejects.toMatchObject({code:'session_recovery_unavailable'})
  expect((await c.f.pool.query('SELECT target_session_id FROM session_recoveries WHERE source_session_id=$1',[c.source.id])).rows).toEqual([{target_session_id:result.sessionId}])
 })
 it('never releases a privacy-held source or target through recovery',async()=>{
  const c=await setup(),preview=await inspectSessionRecovery(c.input),result=await recoverSession({...c.input,expectedRevision:preview.revision})
  await c.f.pool.query('UPDATE sessions SET recording_privacy_held=true WHERE id=$1',[result.sessionId])
  await expect(recoverSession({...c.input,expectedRevision:preview.revision})).rejects.toMatchObject({code:'session_recovery_unavailable'})
  await c.f.pool.query('UPDATE sessions SET recording_privacy_held=true WHERE id=$1',[c.source.id])
  await expect(inspectSessionRecovery(c.input)).rejects.toMatchObject({code:'session_recovery_unavailable'})
 })
 it('rolls the new chat back if the immutable recovery receipt cannot commit',async()=>{
  const c=await setup(),preview=await inspectSessionRecovery(c.input)
  await c.f.pool.query("CREATE FUNCTION fixture_private_recovery_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fictional recovery receipt failure'; END $$")
  await c.f.pool.query('CREATE TRIGGER zzzz_fixture_private_recovery_fail BEFORE INSERT ON session_recoveries FOR EACH ROW EXECUTE FUNCTION fixture_private_recovery_fail()')
  try{
   await expect(recoverSession({...c.input,expectedRevision:preview.revision})).rejects.toThrow('Fictional recovery receipt failure')
   expect((await c.f.pool.query("SELECT id FROM sessions WHERE assistant_id=$1 AND visibility='personal' AND channel_type='web'",[c.f.assistantId])).rows).toEqual([])
   expect((await c.f.pool.query('SELECT target_session_id FROM session_recoveries WHERE source_session_id=$1',[c.source.id])).rows).toEqual([])
  }finally{
   await c.f.pool.query('DROP TRIGGER zzzz_fixture_private_recovery_fail ON session_recoveries')
   await c.f.pool.query('DROP FUNCTION fixture_private_recovery_fail()')
  }
 })
 it('keeps the mapping across credential deletion and permits a new recovery only after its continuation is deleted',async()=>{
  const c=await setup(),preview=await inspectSessionRecovery(c.input),first=await recoverSession({...c.input,expectedRevision:preview.revision})
  const device=(await authSessionStore.create(c.f.ownerId,{deviceLabel:'Fictional replacement device',userAgent:null,ipAddress:null}))!
  await c.f.pool.query('DELETE FROM auth_sessions WHERE id=$1',[c.claims.sessionId])
  const input={...c.input,claims:{userId:c.f.ownerId,sessionId:device.id,authVersion:device.authVersion}}
  expect(await recoverSession({...input,expectedRevision:preview.revision})).toMatchObject({sessionId:first.sessionId,replayed:true})
  await c.f.pool.query('DELETE FROM sessions WHERE id=$1',[first.sessionId])
  const current=await inspectSessionRecovery(input),second=await recoverSession({...input,expectedRevision:current.revision})
  expect(second.sessionId).not.toBe(first.sessionId);expect(second.replayed).toBe(false)
 })
 it('rejects expiry during a blocked replay at the final credential boundary',async()=>{
  const c=await setup(),preview=await inspectSessionRecovery(c.input),command={...c.input,expectedRevision:preview.revision}
  await recoverSession(command)
  const pool=getAppPool(),client=await pool.connect(),original=client.query.bind(client)
  let enter!:()=>void,release!:()=>void
  const entered=new Promise<void>(yes=>{enter=yes}),gate=new Promise<void>(yes=>{release=yes})
  let paused=false
  const querySpy=vi.spyOn(client,'query').mockImplementation((async(sql:string,values:unknown[]=[])=>{
   const value=await original(sql,values)
   if(!paused&&sql.includes('FROM sessions s JOIN assistants a')){paused=true;enter();await gate}
   return value
  }) as typeof client.query)
  const connectSpy=vi.spyOn(pool,'connect').mockImplementationOnce((()=>Promise.resolve(client)) as typeof pool.connect)
  await c.f.pool.query("UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '5 seconds' WHERE id=$1",[c.claims.sessionId])
  const pending=recoverSession(command).then(value=>({value,error:null}),error=>({value:null,error}))
  try{
   await entered
   await c.f.pool.query('SELECT pg_sleep(5.1)')
  }finally{release()}
  try{expect((await pending).error).toMatchObject({code:'authenticated_session_required'})}
  finally{connectSpy.mockRestore();querySpy.mockRestore()}
 })
 it('requires an actual non-owner connection when sharing the canonical creation transaction',async()=>{
  const c=await setup(),owner=await c.f.pool.connect()
  try{
   await owner.query('BEGIN')
   await expect(createPersonalWebSession({assistantId:c.f.assistantId,userId:c.f.ownerId,workspaceId:c.f.workspaceId,
    channelType:'web',channelId:randomUUID(),appOrigin:'chat',contextGroupId:null,contextProjectId:null},
   {actorUserId:c.f.ownerId,authSessionId:c.claims.sessionId,authVersion:c.claims.authVersion},owner)).rejects.toMatchObject({code:'scope_evidence_missing'})
  }finally{await owner.query('ROLLBACK');owner.release()}
 })
 it('refuses application profiles and keeps recovery receipts immutable and owner-local',async()=>{
  const c=await setup(),preview=await inspectSessionRecovery(c.input),result=await recoverSession({...c.input,expectedRevision:preview.revision})
  const client=await getAppPool().connect()
  try{
   await client.query('BEGIN');await applyRLSGucs(client,c.f.ownerId)
   await client.query("SELECT set_config('app.application_id',$1,true)",[randomUUID()])
   await expect(client.query('SELECT read_native_session_recovery_parent($1,$2,$3,$4)',[c.f.workspaceId,c.source.id,c.claims.sessionId,c.claims.authVersion]))
    .rejects.toMatchObject({code:'42501'})
   await client.query('ROLLBACK');await client.query('BEGIN');await applyRLSGucs(client,c.f.firstId)
   expect((await client.query('SELECT source_session_id FROM session_recoveries WHERE target_session_id=$1',[result.sessionId])).rows).toEqual([])
   await client.query('ROLLBACK');await client.query('BEGIN');await applyRLSGucs(client,c.f.ownerId)
   await expect(client.query("UPDATE session_recoveries SET source_revision=$1 WHERE target_session_id=$2",['b'.repeat(64),result.sessionId])).rejects.toMatchObject({code:'42501'})
  }finally{await client.query('ROLLBACK');client.release()}
 })
})
