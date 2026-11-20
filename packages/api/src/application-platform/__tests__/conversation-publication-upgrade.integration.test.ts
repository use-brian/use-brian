/** Executed at the maintained pre-8269 boundary and after upgrade. [COMP:api/native-turn-frame] */
import {readFile,writeFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it,vi} from 'vitest'
import type {PoolClient} from 'pg'
import type {ScopeSource} from '@use-brian/agent-runtime/security/derived-scope.js'
import {bindScopeSources, boundScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import {getAppPool,getPool} from '../../db/client.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {addSessionMessage,createPersonalWebSession} from '../../db/sessions.js'
import {readAdmittedSessionQuery} from '../../db/conversation-store.js'
import {readSessionQueryFrame} from '../../db/session-context-revisions.js'
import {publishNativeSessionMessageBatch} from '../../db/conversation-store.js'
import {resolveSessionTitleAuthority} from '../../routes/session-title-authority.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
// The historical runtime has no public turn-correlation function. Adapt only
// that nullable display projection in the before-phase driver's real snapshot
// read; all original recording, session and permission predicates still execute.
// No production runtime fallback or fabricated correlation is installed.
vi.mock('../../db/client.js',async importOriginal=>{
 const current=await importOriginal<typeof import('../../db/client.js')>()
 if(process.env.BRIAN_CONVERSATION_UPGRADE_PHASE!=='before')return current
 const projection='native_session_public_turn_id(workspace_id,id,last_turn_lease_token) AS "turnId"'
 const query:typeof current.query=(text,params)=>current.query(text.replace(projection,'NULL::text AS "turnId"'),params)
 return{...current,query}
})
// The before phase runs the installed predecessor SQL through the test driver.
// This adapter exists only in the upgrade fixture; the product has no legacy RPC fallback.
vi.mock('../conversation-evidence.js',async importOriginal=>{
 const current=await importOriginal<typeof import('../conversation-evidence.js')>()
 if(process.env.BRIAN_CONVERSATION_UPGRADE_PHASE!=='before')return current
 const historical=(client:Pick<PoolClient,'query'>)=>({query:(sql:string,args:unknown[])=>
  client.query(sql.replaceAll('capture_conversation_evidence(', 'read_native_turn_scope_evidence('),args)}) as Pick<PoolClient,'query'>
 return{...current,
  readConversationEvidence:(client:Pick<PoolClient,'query'>,...args:Parameters<typeof current.readConversationEvidence> extends [unknown,...infer Rest]?Rest:never)=>
   current.readConversationEvidence(historical(client),...args),
  // The predecessor exposes two independent captures. Adapt their real SQL
  // packets only inside this before-phase fixture; no permission is mocked.
  readConversationPublicationCohorts:(client:Pick<PoolClient,'query'>,...args:Parameters<typeof current.readConversationPublicationCohorts> extends [unknown,...infer Rest]?Rest:never)=>
   current.readConversationPublicationCohorts({query:async(_sql:string,values:unknown[])=>{
    const rows=(await client.query('SELECT read_native_turn_scope_evidence($1,roots) AS value FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY cohort(roots,position) ORDER BY position',values)).rows
    return{rows:[{value:rows.some(row=>row.value===null)?null:{admitted:true,cohorts:rows.map(row=>({immutable:row.value.immutable,current:row.value.current}))}}]}
   }} as Pick<PoolClient,'query'>,...args),
 }
})
// The installed predecessor has no canonical metadata facade. Execute its
// original real SQL in the before phase; never mock a permission decision.
vi.mock('../../context-scope/session-authority-facts.js',async importOriginal=>{
 const current=await importOriginal<typeof import('../../context-scope/session-authority-facts.js')>()
 if(process.env.BRIAN_CONVERSATION_UPGRADE_PHASE!=='before')return current
 const {readFile}=await import('node:fs/promises'),{getPool}=await import('../../db/client.js')
 const statement=await readFile(new URL('../../__tests__/fixtures/pre-canonical-session-authority.sql',import.meta.url),'utf8')
 return{...current,readSessionAuthorityFacts:async(input:Parameters<typeof current.readSessionAuthorityFacts>[0])=>{
  const result=await getPool().query(statement,current.sessionAuthorityFactsParameters(input))
  if(result.rows.length!==1)throw new Error('Predecessor authority unavailable')
  return current.decodeSessionAuthorityFacts(input,result.rows[0].facts)
 }}
})
vi.mock('../../context-scope/authority-lease.js',async importOriginal=>{
 const current=await importOriginal<typeof import('../../context-scope/authority-lease.js')>()
 // Without the new SQL facade the full source owner and real live lease execute.
 return process.env.BRIAN_CONVERSATION_UPGRADE_PHASE==='before'?{...current,captureSessionAuthority:async()=>null}:current
})
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const phase=process.env.BRIAN_CONVERSATION_UPGRADE_PHASE,statePath=process.env.BRIAN_CONVERSATION_UPGRADE_STATE
const sql=await readFile(new URL('../../../migrations/8269_canonical_conversation_publication.sql',import.meta.url),'utf8')
const upgrade=sql.replace(/^BEGIN;\n/m,'').replace(/\nCOMMIT;\s*$/,'')
type Saved={workspaceId:string;users:string[];claims:{userId:string;sessionId:string;authVersion:number};sessionId:string;assistantId:string;private:boolean;firstReply:string}
afterAll(async()=>{await getAppPool().end();await getPool().end()})
describe.skipIf(!phase||!statePath).sequential('[COMP:api/native-turn-frame] populated conversation publication upgrade',()=>{
 it('preserves existing private and shared history across a restarted runtime',async()=>{
  if(phase==='before'){
   const saved:Saved[]=[]
   for(const personal of [false,true]){
    const f=await persistentContextFixture(),device=(await authSessionStore.create(f.ownerId,{deviceLabel:'Fictional upgrade client',userAgent:null,ipAddress:null}))!
    const claims={userId:f.ownerId,sessionId:device.id,authVersion:device.authVersion}
    const session=personal?await createPersonalWebSession({assistantId:f.assistantId,userId:f.ownerId,workspaceId:f.workspaceId,
     channelType:'web',channelId:randomUUID(),appOrigin:'chat'},{actorUserId:f.ownerId,authSessionId:device.id,authVersion:device.authVersion}):f.session
    const scope={...f.envelope,userId:personal?f.ownerId:null}
    const input=await addSessionMessage({sessionId:session.id,role:'user',content:[{type:'text',text:'Remember the fictional amber notebook.'}],senderUserId:f.ownerId,scope})
    const authority=await resolveSessionTitleAuthority({claims,sessionId:session.id,readOnly:false})
    // Only the pre-migration fixture uses the retired SQL ports. They create
    // genuine old observations; the restarted after phase uses the new reader.
    const captured=personal?await readAdmittedSessionQuery({sessionId:session.id,throughSequence:input.sequenceNum,authority})
     :await readSessionQueryFrame(authority,[],async client=>{
       const rows=(await client.query<{value:{sources:ScopeSource[]}}>(
        'SELECT value FROM read_native_application_session_history($1,$2,$3) UNION ALL SELECT value FROM read_native_application_session_topics($1,$2,$3)',
        [f.workspaceId,session.id,input.sequenceNum])).rows
       const sources=rows.flatMap(row=>row.value.sources)
       return{value:bindScopeSources({},sources),sources}
      })
    const replies=await publishNativeSessionMessageBatch({sessionId:session.id,authority,derivationTarget:scope,
     derivation:{producer:'fixture:conversation-upgrade',sources:boundScopeSources(captured)},
     messages:[{role:'assistant',senderAssistantId:f.assistantId,content:[{type:'text',text:'The notebook is amber.'}]}]})
    saved.push({workspaceId:f.workspaceId,users:[f.ownerId,f.firstId,f.secondId],claims,sessionId:session.id,assistantId:f.assistantId,private:personal,firstReply:replies[0].id})
   }
   await writeFile(statePath!,JSON.stringify(saved))
  }else{
   expect((await getPool().query("SELECT to_regprocedure('publish_native_session_message(uuid,uuid,jsonb,text,jsonb,jsonb)') AS retired")).rows).toEqual([{retired:null}])
   expect((await getPool().query("SELECT to_regprocedure('publish_native_turn_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)') AS retired")).rows).toEqual([{retired:null}])
   expect((await getPool().query("SELECT to_regprocedure('native_turn_prepare_publication(uuid,uuid,text,jsonb,jsonb)') AS retired")).rows).toEqual([{retired:null}])
   expect((await getPool().query("SELECT to_regprocedure('publish_native_turn_annotation(uuid,uuid,uuid,uuid,jsonb,text,jsonb,uuid,bigint)') AS retired")).rows).toEqual([{retired:null}])
   expect((await getPool().query("SELECT to_regprocedure('read_native_covered_session_evidence(uuid,text[],uuid[],text[])') AS retired")).rows).toEqual([{retired:null}])
   expect((await getPool().query('SELECT application_native_title_group_helpers_current() grouped,application_native_title_acquisition_helpers_current() acquisition')).rows)
    .toEqual([{grouped:true,acquisition:true}])
   for(const signature of ['read_native_private_title_acquisition(uuid,uuid,uuid)','read_native_empty_query_session_title_revision(uuid,uuid,uuid)'])
    expect((await getPool().query('SELECT to_regprocedure($1) retired',[signature])).rows).toEqual([{retired:null}])
   const saved=JSON.parse(await readFile(statePath!,'utf8')) as Saved[]
   for(const row of saved){
    const authority=await resolveSessionTitleAuthority({claims:row.claims,sessionId:row.sessionId,readOnly:false})
    const captured=await readAdmittedSessionQuery({sessionId:row.sessionId,throughSequence:2,authority})
    expect(captured.history.map(message=>message.id)).toContain(row.firstReply)
    expect(JSON.stringify(captured.history)).toContain('The notebook is amber.')
    if(!row.private)expect((await getPool().query('SELECT format FROM native_turn_frames WHERE workspace_id=$1',[row.workspaceId])).rows).toEqual([{format:1}])
    const replies=await publishNativeSessionMessageBatch({sessionId:row.sessionId,authority,
     derivationTarget:{workspaceId:row.workspaceId,userId:row.private?row.claims.userId:null,assistantId:null,sensitivity:'internal',compartments:[],projectIds:[]},
     derivation:{producer:'fixture:conversation-upgrade',sources:boundScopeSources(captured)},
     messages:[{role:'assistant',senderAssistantId:row.assistantId,content:[{type:'text',text:'Continuing with the same notebook.'}]}]})
    const reopened=await readAdmittedSessionQuery({sessionId:row.sessionId,throughSequence:replies[0].sequenceNum,
     authority:await resolveSessionTitleAuthority({claims:row.claims,sessionId:row.sessionId,readOnly:false})})
    expect(JSON.stringify(reopened.history)).toContain('Continuing with the same notebook.')
    expect((await getPool().query('SELECT format FROM native_turn_frames WHERE workspace_id=$1 ORDER BY format',[row.workspaceId])).rows)
     .toEqual(row.private?[{format:2}]:[{format:1},{format:2}])
    await getPool().query('DELETE FROM workspaces WHERE id=$1',[row.workspaceId])
    await getPool().query('DELETE FROM users WHERE id=ANY($1::uuid[])',[row.users])
   }
  }
 },120_000)
 it.skipIf(phase!=='before').each(['guard','writer','single-writer','covered-reader','unknown-consumer'] as const)('refuses %s drift without changing installed authority',async drift=>{
  const client=await getPool().connect()
  try{
   await client.query('BEGIN')
   if(drift==='unknown-consumer')await client.query(`DO $test$ DECLARE pin text;BEGIN
    SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO pin FROM pg_proc p WHERE p.oid='native_turn_page_event(jsonb)'::regprocedure;
    EXECUTE format('CREATE FUNCTION public.fictional_conversation_consumer() RETURNS text LANGUAGE sql AS %L','SELECT '||quote_literal(pin)||'::text');
   END $test$`)
   else await client.query(`ALTER FUNCTION ${drift==='guard'?'native_turn_helpers_current()':drift==='covered-reader'?'read_native_covered_session_evidence(uuid,text[],uuid[],text[])':drift==='single-writer'?'publish_native_session_message(uuid,uuid,jsonb,text,jsonb,jsonb)':'prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)'} COST 101`)
   await expect(client.query(upgrade)).rejects.toThrow(/predecessor|unreviewed_pin_consumer|untrusted_consumer/)
  }finally{await client.query('ROLLBACK');client.release()}
 },120_000)
 it.skipIf(phase!=='before').each(['native_field_dependency_batches','native_field_dependency_work'] as const)('refuses retirement with pending %s and rolls the migration back',async table=>{
  const client=await getPool().connect()
  try{
   await client.query('BEGIN')
   if(table==='native_field_dependency_batches')await client.query(`INSERT INTO native_field_dependency_batches(transaction_id,workspace_id,derivation_id,pending_events)
    VALUES(txid_current(),gen_random_uuid(),gen_random_uuid(),1)`)
   else await client.query(`INSERT INTO native_field_dependency_work(transaction_id,workspace_id,derivation_id,source)
    VALUES(txid_current(),gen_random_uuid(),gen_random_uuid(),'{}')`)
   await expect(client.query(upgrade)).rejects.toThrow('conversation_legacy_field_work_not_empty')
  }finally{await client.query('ROLLBACK');client.release()}
  expect((await getPool().query('SELECT to_regclass($1) relation',[table])).rows[0].relation).not.toBeNull()
 },120_000)

 it.skipIf(phase!=='before').each(['body-pin','private-grant'] as const)('refuses unreviewed portable prerequisite %s',async drift=>{
  const client=await getPool().connect()
  try{
   await client.query('BEGIN')
   if(drift==='body-pin')await client.query(`DO $fixture$ DECLARE definition text;body text;BEGIN
    SELECT pg_get_functiondef(oid),prosrc INTO definition,body FROM pg_proc WHERE oid='session_context_file_revision_allowed(uuid,uuid)'::regprocedure;
    EXECUTE replace(definition,body,regexp_replace(body,'[a-f0-9]{64}',repeat('0',64)));
   END $fixture$`)
   else await client.query('GRANT EXECUTE ON FUNCTION read_native_session_query_cohort_nodes(uuid,jsonb) TO app_user')
   await expect(client.query(upgrade)).rejects.toThrow(/predecessor|dependency_changed/)
  }finally{await client.query('ROLLBACK');client.release()}
 },120_000)

 it.skipIf(phase!=='before')('refuses a changed recovery-capture executable before expanding its trigger contract',async()=>{
  const client=await getPool().connect()
  try{
   await client.query('BEGIN')
   await client.query('ALTER FUNCTION crm_capture_erasure_effect() COST 101')
   await expect(client.query(upgrade)).rejects.toThrow(/predecessor_changed/)
  }finally{await client.query('ROLLBACK');client.release()}
 },120_000)

})
