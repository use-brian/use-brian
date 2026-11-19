/** [COMP:api/conversation-visibility] Real receiving proof of the unactivated
 * canonical read/metadata template. Existing 8294 readers and policies remain
 * unchanged until the authenticated successor transfers every consumer. */
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const {getPool,getAppPool,applyRLSGucs,rollbackAndRelease}=await import('../../db/client.js')
const {persistentContextFixture}=await import('../../application-platform/__tests__/fixtures/persistent-context.js')
const {findOrCreateSession,addSessionMessage}=await import('../../db/sessions.js')
const {authSessionStore}=await import('../../db/auth-session-store.js')
const {readConversationVisibility}=await import('../../db/conversation-visibility.js')
const {captureNativeConversationRecord,parseConversationRecord}=await import('../../db/conversation-record.js')
const {boundScopeSources}=await import('@use-brian/agent-runtime/security/source-evidence.js')
const {ContextScopeAccumulator}=await import('@use-brian/agent-runtime/security/context-scope.js')
const {readAdmittedSessionQuery}=await import('../../db/conversation-store.js')
const {writeSessionContextRevision}=await import('../../db/session-context-revisions.js')
const signatures=['guard_conversation_record_capture()','withdraw_conversation_record_rows()','withdraw_conversation_record_targets(jsonb)',
 'conversation_record_rows(conversation_envelopes,integer,integer,boolean,uuid,boolean)',
 'capture_native_conversation_record(uuid,uuid,uuid,integer,integer,integer,integer)',
 'capture_conversation_record_current(uuid,uuid,integer,integer,integer,jsonb)','conversation_record_member_allowed(uuid,uuid,uuid)',
 'read_conversation_record_source(uuid,uuid)','conversation_test_two_principals(uuid,uuid,uuid)','read_conversation_visibility(uuid,uuid,integer)','conversation_visibility_metadata_current(uuid,uuid)',
 'conversation_member_read_allowed(uuid,uuid,uuid)','conversation_member_read_current(uuid,uuid,uuid)',
 'conversation_member_tier_current(uuid,uuid,uuid)','read_conversation_member_tiers(uuid[],boolean)',
 'conversation_envelope_for_reader(uuid,uuid)',
 'conversation_consent_current(uuid)','conversation_authority_state(uuid)','conversation_hard_project_ids(text[])',
 'conversation_office_anchor_current(uuid,uuid)']
beforeAll(async()=>{
 await getPool().query(await readFile(new URL('../../../scripts/conversation-store/conversation-authority.sql',import.meta.url),'utf8'))
 await getPool().query(await readFile(new URL('../../../scripts/conversation-store/conversation-legacy-enrollment.sql',import.meta.url),'utf8'))
 await getPool().query(await readFile(new URL('../../../scripts/conversation-store/conversation-record.sql',import.meta.url),'utf8'))
 // The receiving test exposes only the native metadata wrapper, exactly as the
 // authenticated successor will. Inner owner functions stay non-callable.
 await getPool().query('GRANT EXECUTE ON FUNCTION read_conversation_visibility(uuid,uuid,integer) TO app_user')
 await getPool().query('GRANT EXECUTE ON FUNCTION capture_native_conversation_record(uuid,uuid,uuid,integer,integer,integer,integer) TO app_user')
 await getPool().query(`CREATE FUNCTION conversation_test_two_principals(w uuid,sid uuid,recipient uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $test$
 DECLARE caller uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 BEGIN
  RETURN conversation_member_read_allowed(w,sid,caller) AND conversation_member_read_allowed(w,sid,recipient);
 END $test$;
 REVOKE ALL ON FUNCTION conversation_test_two_principals(uuid,uuid,uuid) FROM PUBLIC;
 GRANT EXECUTE ON FUNCTION conversation_test_two_principals(uuid,uuid,uuid) TO app_user;`)
})
afterAll(async()=>{
 await getPool().query('DROP TRIGGER IF EXISTS conversation_record_capture_immutable ON private_transcript_observations')
 for(const [name,table] of [['message','session_messages'],['annotation','session_message_annotation_heads'],
  ['quarantine','conversation_message_quarantine'],['review','scope_resource_states'],
  ['revision','session_context_scope_revisions'],['revision_content','session_context_revision_contents']])
  await getPool().query(`DROP TRIGGER IF EXISTS conversation_record_${name}_withdrawal ON ${table}`)
 for(const signature of signatures)await getPool().query(`DROP FUNCTION IF EXISTS ${signature}`)
 await getPool().query('DROP FUNCTION enroll_conversation_legacy_history(uuid),conversation_legacy_enrolled(uuid,uuid,uuid,uuid)')
 await getPool().query('DROP TABLE conversation_legacy_history_enrollments')
 await getAppPool().end();await getPool().end()
})
const read=async(w:string,s:string,u:string)=>(await getPool().query<{allowed:boolean}>(
 'SELECT conversation_member_read_allowed($1,$2,$3) AS allowed',[w,s,u])).rows[0].allowed

describe.sequential('[COMP:api/conversation-visibility] canonical native read authority',()=>{
 it('requires current membership/cap even for a private owner and never gives an administrator a member 1:1',async()=>{
  const f=await persistentContextFixture('internal')
  try{
   expect(await read(f.workspaceId,f.session.id,f.firstId)).toBe(true)
   const dm=await findOrCreateSession({assistantId:f.assistantId,userId:f.firstId,workspaceId:f.workspaceId,
    channelType:'telegram',channelId:randomUUID()})
   expect(await read(f.workspaceId,dm.id,f.firstId)).toBe(true)
   expect(await read(f.workspaceId,dm.id,f.ownerId)).toBe(false)
   expect(await read(f.workspaceId,dm.id,f.secondId)).toBe(false)
   await f.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.firstId])
   expect(await read(f.workspaceId,dm.id,f.firstId)).toBe(false)
   await f.pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','public')",[f.workspaceId,f.firstId])
   expect(await read(f.workspaceId,dm.id,f.firstId)).toBe(false)
  }finally{await f.cleanup()}
 })
 it('does not grant private participant or migrated public access from unaudited current rows',async()=>{
  const f=await persistentContextFixture('internal')
  try{
   await f.pool.query("UPDATE conversation_envelopes SET visibility='configured_private',version=2 WHERE session_id=$1",[f.session.id])
   await f.pool.query('INSERT INTO conversation_participants(session_id,user_id) VALUES($1,$2)',[f.session.id,f.firstId])
   expect(await read(f.workspaceId,f.session.id,f.ownerId)).toBe(true)
   expect(await read(f.workspaceId,f.session.id,f.firstId)).toBe(false)
   // A historical private row needs actual audited widening, not a current
   // workspace flag. No authorized mutation is simulated by this negative case.
   await f.pool.query("UPDATE conversation_envelopes SET classification='legacy_personal',visibility='workspace',version=3 WHERE session_id=$1",[f.session.id])
   expect(await read(f.workspaceId,f.session.id,f.firstId)).toBe(false)
  }finally{await f.cleanup()}
 })
 it('returns only capability/settings metadata through a live native credential and does not leak inner owner ports',async()=>{
  const f=await persistentContextFixture('internal')
  try{
   const device=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional metadata browser',userAgent:null,ipAddress:null}))!
   const claims={userId:f.ownerId,authSessionId:device.id,authVersion:device.authVersion}
   const metadata=await readConversationVisibility(claims,f.session.id)
   expect(metadata).toMatchObject({conversationVisibility:'workspace',conversationCap:'internal',participantUserIds:[],
    capabilities:{canNarrow:true,canWiden:true,canManageParticipants:true,canRaiseCap:true,canMoveProject:true}})
   expect(metadata).not.toHaveProperty('title');expect(metadata).not.toHaveProperty('content')
   const app=await getAppPool().connect()
   try{
    await app.query('BEGIN');await applyRLSGucs(app,f.ownerId)
    await expect(app.query('SELECT conversation_member_read_allowed($1,$2,$3)',[f.workspaceId,f.session.id,f.secondId]))
     .rejects.toMatchObject({code:'42501'})
   }finally{await rollbackAndRelease(app)}
   await authSessionStore.revokeForUser(f.ownerId,device.id)
   await expect(readConversationVisibility(claims,f.session.id)).rejects.toMatchObject({code:'conversation_access_denied',status:403})
  }finally{await f.cleanup()}
 })
 it('restores the system connection actor after an explicit-principal operation',async()=>{
  const f=await persistentContextFixture('internal')
  const client=await getPool().connect()
  try{
   await client.query('BEGIN')
   await client.query("SELECT set_config('app.current_user_id',$1,true)",[f.ownerId])
   expect((await client.query('SELECT conversation_member_read_allowed($1,$2,$3) AS allowed',[f.workspaceId,f.session.id,f.firstId])).rows[0].allowed).toBe(true)
   expect((await client.query("SELECT current_setting('app.current_user_id',true) AS actor")).rows[0].actor).toBe(f.ownerId)
  }finally{await rollbackAndRelease(client);await f.cleanup()}
 })
 it('checks both principals through a trusted app-role operation without exposing the owner-only port',async()=>{
  const f=await persistentContextFixture('internal')
  const client=await getAppPool().connect()
  try{
   const dm=await findOrCreateSession({assistantId:f.assistantId,userId:f.firstId,workspaceId:f.workspaceId,
    channelType:'telegram',channelId:randomUUID()})
   await client.query('BEGIN');await applyRLSGucs(client,f.ownerId)
   expect((await client.query('SELECT conversation_test_two_principals($1,$2,$3) AS allowed',[f.workspaceId,f.session.id,f.firstId])).rows[0].allowed).toBe(true)
   expect((await client.query('SELECT conversation_test_two_principals($1,$2,$3) AS allowed',[f.workspaceId,dm.id,f.firstId])).rows[0].allowed).toBe(false)
   expect((await client.query("SELECT current_setting('app.current_user_id',true) AS actor")).rows[0].actor).toBe(f.ownerId)
   await client.query('ROLLBACK')
  }finally{await rollbackAndRelease(client);await f.cleanup()}
 })
 it('captures ordered dialogue once, reuses the immutable selector after append, and binds changed original versions',async()=>{
  const f=await persistentContextFixture('internal')
  try{
   const history=await f.history()
   const device=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional record browser',userAgent:null,ipAddress:null}))!
   const claims={userId:f.ownerId,authSessionId:device.id,authVersion:device.authVersion}
   const selection={workspaceId:f.workspaceId,sessionId:f.session.id,afterSequence:0,throughSequence:3,topicThroughSequence:3}
   const first=await captureNativeConversationRecord(claims,selection)
   expect(first.rows.map(row=>row.id)).toEqual(history.map(row=>row.id))
   expect(boundScopeSources(first.rows)).toEqual([first.source])
   for(const row of first.rows)expect(boundScopeSources(row)).toEqual([first.source])
   expect(first.source).toMatchObject({resourceKind:'conversation_record',userId:null,version:'1'})
   expect((await captureNativeConversationRecord(claims,selection)).source.resourceId).toBe(first.source.resourceId)
   await addSessionMessage({sessionId:f.session.id,role:'user',content:[{type:'text',text:'Fictional appended request'}],scope:f.envelope})
   expect((await captureNativeConversationRecord(claims,selection)).source.resourceId).toBe(first.source.resourceId)
   // A row version/label change changes the immutable capture identity even
   // with identical delivered bytes. It does not rewrite the prior capture.
   const changedVersion=await f.pool.query("UPDATE session_messages SET sensitivity='public' WHERE id=$1 RETURNING scope_version",[history[0].id])
   expect(Number(changedVersion.rows[0].scope_version)).toBeGreaterThan(1)
   const changed=await captureNativeConversationRecord(claims,selection)
   expect(changed.rows.map(row=>row.content)).toEqual(first.rows.map(row=>row.content))
   expect(changed.manifest.payloadDigest).toBe(first.manifest.payloadDigest)
   expect(changed.manifest.rowIdentityDigest).not.toBe(first.manifest.rowIdentityDigest)
   expect(changed.source.resourceId).not.toBe(first.source.resourceId)
   expect((await f.pool.query('SELECT read_conversation_record_source($1,$2) AS source',[f.workspaceId,first.source.resourceId])).rows[0].source.held).toBe(false)
  }finally{await f.cleanup()}
 })
 it('delivers only the fixed dialogue model recipe, excluding tool/host/file bodies and private rows in a new public lane',async()=>{
  const f=await persistentContextFixture('internal')
  try{
   await f.history()
   await f.pool.query("UPDATE conversation_envelopes SET classification='new_public' WHERE session_id=$1",[f.session.id])
   for(const [role,content,privateOwner] of [
    ['user',[{type:'text',text:'Read <attached_file id="fictional-file" name="notes.txt" type="text/plain">FILE_BODY_SECRET</attached_file>'}],false],
    ['user',[{type:'text',text:'TOOL_BODY_SECRET'},{type:'tool_result',toolUseId:'fictional-tool',content:'TOOL_BODY_SECRET'}],false],
    ['assistant',[{type:'text',text:'HIDDEN_TOOL_SECRET'},{type:'tool_use',id:'fictional-tool',name:'fictional_read',input:{}}],false],
    ['user',[{type:'text',text:'PRIVATE_D4_SECRET'}],true],
    ['assistant',[{type:'text',text:'Fictional delivered final answer.'}],false],
   ] as const)await addSessionMessage({sessionId:f.session.id,role,content,scope:{...f.envelope,userId:privateOwner?f.ownerId:null}})
   const device=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional model browser',userAgent:null,ipAddress:null}))!
   const record=await captureNativeConversationRecord({userId:f.ownerId,authSessionId:device.id,authVersion:device.authVersion},
    {workspaceId:f.workspaceId,sessionId:f.session.id,afterSequence:0,throughSequence:8,topicThroughSequence:0})
   await expect(addSessionMessage({sessionId:f.session.id,role:'user',content:[{type:'host_observation',content:'HOST_BODY_SECRET'}],scope:f.envelope}))
    .rejects.toThrow('Host observations require the native executor batch publisher')
   const delivered=JSON.stringify(record.rows)
   expect(delivered).toContain('[Attached file:');expect(delivered).toContain('Fictional delivered final answer.')
   for(const secret of ['FILE_BODY_SECRET','TOOL_BODY_SECRET','HOST_BODY_SECRET','HIDDEN_TOOL_SECRET','PRIVATE_D4_SECRET'])expect(delivered).not.toContain(secret)
   expect(record.manifest.modelRecipe).toBe('dialogue_text_v1')
   // Actual provider dispatch remains unactivated until the successor installs
   // this source in admission, publication and withdrawal owners together.
  }finally{await f.cleanup()}
 })
 it('refuses credential substitution/revocation and keeps owner-only record internals inaccessible',async()=>{
  const f=await persistentContextFixture('internal')
  try{
   await f.history()
   const device=(await authSessionStore.create(f.firstId,{deviceLabel:'Fictional current reader',userAgent:null,ipAddress:null}))!
   const selection={workspaceId:f.workspaceId,sessionId:f.session.id,afterSequence:0,throughSequence:3,topicThroughSequence:0}
   await expect(captureNativeConversationRecord({userId:f.ownerId,authSessionId:device.id,authVersion:device.authVersion},selection))
    .rejects.toMatchObject({code:'conversation_access_denied'})
   const captured=await captureNativeConversationRecord({userId:f.firstId,authSessionId:device.id,authVersion:device.authVersion},selection)
   const client=await getAppPool().connect()
   try{
    await client.query('BEGIN');await applyRLSGucs(client,f.firstId)
    await expect(client.query('SELECT read_conversation_record_source($1,$2)',[f.workspaceId,captured.source.resourceId])).rejects.toMatchObject({code:'42501'})
   }finally{await rollbackAndRelease(client)}
   await authSessionStore.revokeForUser(f.firstId,device.id)
   await expect(captureNativeConversationRecord({userId:f.firstId,authSessionId:device.id,authVersion:device.authVersion},selection))
    .rejects.toMatchObject({code:'conversation_access_denied'})
  }finally{await f.cleanup()}
 })
 it('withdraws edited, held, released, deleted and historical-inserted captured dialogue without resurrecting an old capture',async()=>{
  const f=await persistentContextFixture('internal')
  try{
   const rows=await f.history()
   const device=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional withdrawal reader',userAgent:null,ipAddress:null}))!
   const claims={userId:f.ownerId,authSessionId:device.id,authVersion:device.authVersion}
   const selection={workspaceId:f.workspaceId,sessionId:f.session.id,afterSequence:0,throughSequence:3,topicThroughSequence:0}
   const capture=()=>captureNativeConversationRecord(claims,selection)
   const live=async(id:string)=>(await f.pool.query('SELECT read_conversation_record_source($1,$2) AS value',[f.workspaceId,id])).rows[0].value.held===false
   const first=await capture()
   await f.pool.query('UPDATE session_messages SET content=$2 WHERE id=$1',[rows[0].id,JSON.stringify([{type:'text',text:'Fictional edited request'}])])
   expect(await live(first.source.resourceId)).toBe(false)
   const edited=await capture();expect(JSON.stringify(edited.rows)).toContain('Fictional edited request')
   await f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[rows[0].id])
   expect(await live(edited.source.resourceId)).toBe(false)
   expect((await capture()).rows.map(row=>row.id)).not.toContain(rows[0].id)
   await f.pool.query('UPDATE session_messages SET scope_held=false WHERE id=$1',[rows[0].id])
   expect(await live(edited.source.resourceId)).toBe(false)
   const released=await capture()
   await f.pool.query('DELETE FROM session_messages WHERE id=$1',[rows[2].id])
   expect(await live(released.source.resourceId)).toBe(false)
   const before=(await f.pool.query('SELECT version FROM conversation_envelopes WHERE session_id=$1',[f.session.id])).rows[0].version
   await addSessionMessage({sessionId:f.session.id,role:'user',content:[{type:'text',text:'Fictional historical replacement'}],scope:f.envelope})
   const after=(await f.pool.query('SELECT version FROM conversation_envelopes WHERE session_id=$1',[f.session.id])).rows[0].version
   expect(BigInt(after)).toBeGreaterThan(BigInt(before))
  }finally{await f.cleanup()}
 })
 it('serializes two concurrent first captures and keeps a later append outside the captured bounds',async()=>{
  const f=await persistentContextFixture('internal')
  try{
   await f.history()
   const device=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional concurrent reader',userAgent:null,ipAddress:null}))!
   const claims={userId:f.ownerId,authSessionId:device.id,authVersion:device.authVersion}
   const selection={workspaceId:f.workspaceId,sessionId:f.session.id,afterSequence:0,throughSequence:3,topicThroughSequence:0}
   const [left,right]=await Promise.all([captureNativeConversationRecord(claims,selection),captureNativeConversationRecord(claims,selection)])
   expect(left.source.resourceId).toBe(right.source.resourceId)
   const before=(await f.pool.query('SELECT version,record_captured_through AS high FROM conversation_envelopes WHERE session_id=$1',[f.session.id])).rows[0]
   expect(before.high).toBe(3)
   await addSessionMessage({sessionId:f.session.id,role:'user',content:[{type:'text',text:'Fictional new append'}],scope:f.envelope})
   const after=(await f.pool.query('SELECT version FROM conversation_envelopes WHERE session_id=$1',[f.session.id])).rows[0]
   expect(after.version).toBe(before.version)
   expect((await captureNativeConversationRecord(claims,selection)).source.resourceId).toBe(left.source.resourceId)
  }finally{await f.cleanup()}
 })
 it.each(['edit','hold'] as const)('withdraws a capture after a concurrent %s waits behind its original envelope lock',async change=>{
  const f=await persistentContextFixture('internal'),app=await getAppPool().connect(),writer=await getPool().connect()
  let mutation:Promise<unknown>|undefined
  try{
   const rows=await f.history()
   const device=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional racing reader',userAgent:null,ipAddress:null}))!
   const selection={workspaceId:f.workspaceId,sessionId:f.session.id,afterSequence:0,throughSequence:3,topicThroughSequence:0}
   await app.query('BEGIN');await applyRLSGucs(app,f.ownerId)
   const captured=parseConversationRecord((await app.query('SELECT capture_native_conversation_record($1,$2,$3,$4,0,3,0) AS value',
    [f.workspaceId,f.session.id,device.id,device.authVersion])).rows[0].value,selection)
   const pid=(await writer.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid
   mutation=writer.query(change==='edit'?'UPDATE session_messages SET content=$2 WHERE id=$1':'UPDATE session_messages SET scope_held=true WHERE id=$1',
    change==='edit'?[rows[0].id,JSON.stringify([{type:'text',text:'Fictional racing edit'}])]:[rows[0].id])
   let blocked=false
   for(let attempt=0;attempt<100;attempt++){
    blocked=(await f.pool.query<{blocked:boolean}>("SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.blocked===true
    if(blocked)break
    await delay(10)
   }
   expect(blocked).toBe(true)
   await app.query('COMMIT');await mutation
   expect((await f.pool.query('SELECT read_conversation_record_source($1,$2) AS value',[f.workspaceId,captured.source.resourceId])).rows[0].value.held).toBe(true)
  }finally{
   await rollbackAndRelease(app)
   try{await mutation}finally{writer.release();await f.cleanup()}
  }
 })
 it('withdraws quarantine/review hold and release, and rejects mutation of an immutable capture',async()=>{
  const f=await persistentContextFixture('internal')
  try{
   const rows=await f.history()
   const device=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional review reader',userAgent:null,ipAddress:null}))!
   const claims={userId:f.ownerId,authSessionId:device.id,authVersion:device.authVersion}
   const selection={workspaceId:f.workspaceId,sessionId:f.session.id,afterSequence:0,throughSequence:3,topicThroughSequence:0}
   const capture=()=>captureNativeConversationRecord(claims,selection)
   const live=async(id:string)=>(await f.pool.query('SELECT read_conversation_record_source($1,$2) AS value',[f.workspaceId,id])).rows[0].value.held===false
   const first=await capture()
   await expect(f.pool.query("UPDATE private_transcript_observations SET manifest='{}' WHERE id=$1",[first.source.resourceId])).rejects.toMatchObject({code:'42501',message:'conversation_record_immutable'})
   await f.pool.query("INSERT INTO conversation_message_quarantine(session_id,message_id,reason) VALUES($1,$2,'outside_boundary')",[f.session.id,rows[0].id])
   expect(await live(first.source.resourceId)).toBe(false)
   expect((await capture()).rows.map(row=>row.id)).not.toContain(rows[0].id)
   await f.pool.query('DELETE FROM conversation_message_quarantine WHERE message_id=$1',[rows[0].id])
   expect(await live(first.source.resourceId)).toBe(false)
   const restored=await capture()
   await f.pool.query(`INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
    VALUES($1,'session_message',$2,'1','held',1,'Fictional explicit review hold')`,[f.workspaceId,rows[0].id])
   expect(await live(restored.source.resourceId)).toBe(false)
   expect((await capture()).rows.map(row=>row.id)).not.toContain(rows[0].id)
   await f.pool.query("UPDATE scope_resource_states SET review_state='reviewed' WHERE workspace_id=$1 AND resource_id=$2",[f.workspaceId,rows[0].id])
   expect(await live(restored.source.resourceId)).toBe(false)
  }finally{await f.cleanup()}
 })
 it('retains shared capture provenance after deleting its incidental reader, denies that reader and cascades on conversation deletion',async()=>{
  const f=await persistentContextFixture('internal')
  try{
   await f.history()
   const device=(await authSessionStore.create(f.firstId,{deviceLabel:'Fictional leaving reader',userAgent:null,ipAddress:null}))!
   const claims={userId:f.firstId,authSessionId:device.id,authVersion:device.authVersion}
   const selection={workspaceId:f.workspaceId,sessionId:f.session.id,afterSequence:0,throughSequence:3,topicThroughSequence:0}
   const captured=await captureNativeConversationRecord(claims,selection)
   expect((await f.pool.query('SELECT user_id,binding FROM private_transcript_observations WHERE id=$1',[captured.source.resourceId])).rows[0])
    .toMatchObject({user_id:f.ownerId,binding:{readerUserId:f.firstId}})
   await f.pool.query('DELETE FROM users WHERE id=$1',[f.firstId])
   expect((await f.pool.query('SELECT read_conversation_record_source($1,$2) AS value',[f.workspaceId,captured.source.resourceId])).rows[0].value.held).toBe(false)
   expect((await f.pool.query('SELECT conversation_record_member_allowed($1,$2,$3) AS value',[f.workspaceId,captured.source.resourceId,f.firstId])).rows[0].value).toBe(false)
   expect((await f.pool.query('SELECT conversation_record_member_allowed($1,$2,$3) AS value',[f.workspaceId,captured.source.resourceId,f.secondId])).rows[0].value).toBe(true)
   await expect(captureNativeConversationRecord(claims,selection)).rejects.toMatchObject({code:'conversation_access_denied'})
   await f.pool.query('DELETE FROM sessions WHERE id=$1',[f.session.id])
   expect((await f.pool.query('SELECT count(*)::int AS count FROM private_transcript_observations WHERE id=$1',[captured.source.resourceId])).rows[0].count).toBe(0)
  }finally{await f.cleanup()}
 })
 it('preserves acquired authority across first annotation despite another reader advancing the global topic watermark, while advancing exact-copy freshness',async()=>{
  const f=await persistentContextFixture('internal')
  try{
   const rows=await f.history()
   const device=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional annotation reader',userAgent:null,ipAddress:null}))!
   const claims={userId:f.ownerId,authSessionId:device.id,authVersion:device.authVersion}
   const selection={workspaceId:f.workspaceId,sessionId:f.session.id,afterSequence:0,throughSequence:3,topicThroughSequence:2}
   const classification=await captureNativeConversationRecord(claims,selection)
   // Another reader may observe the current input before its first annotation.
   // The shared maintenance maximum must be tested, not assumed turn-local.
   await captureNativeConversationRecord(claims,{...selection,topicThroughSequence:3})
   const authority={execution:await f.execution(),accumulator:new ContextScopeAccumulator()}
   const input=await readAdmittedSessionQuery({authority,sessionId:f.session.id,throughSequence:3,topicThroughSequence:2})
   const annotation=await writeSessionContextRevision({authority,sessionId:f.session.id,parentId:rows[2].id,kind:'message_annotation',
    content:{topicLabel:'Fictional captured topic',topicConfidence:0.9,replyToText:null},
    derivation:{producer:'fixture:record-annotation',sources:boundScopeSources(input)}})
   expect(annotation).not.toBeNull()
   expect((await f.pool.query('SELECT read_conversation_record_source($1,$2) AS value',
    [f.workspaceId,classification.source.resourceId])).rows[0].value.held).toBe(false)
   const renewed=await captureNativeConversationRecord(claims,selection)
   expect(renewed.manifest.payloadDigest).toBe(classification.manifest.payloadDigest)
   expect(renewed.source.resourceId).toBe(classification.source.resourceId)
   expect(BigInt(renewed.dataRevision)).toBeGreaterThan(BigInt(classification.dataRevision))
   const evidence=new ContextScopeAccumulator({sources:[classification.source]})
   evidence.note({sources:[renewed.source]})
   // Additive metadata does not require dropping consumed immutable evidence;
   // exact compiled selection uses the independently advanced data revision.
   expect(evidence.evidence.sources).toHaveLength(1)
   const final=await captureNativeConversationRecord(claims,{...selection,topicThroughSequence:3})
   expect(final.rows.at(-1)?.topicLabel).toBe('Fictional captured topic')
  }finally{await f.cleanup()}
 })
})
