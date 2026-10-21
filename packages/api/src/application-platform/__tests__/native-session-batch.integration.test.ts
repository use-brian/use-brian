import {randomUUID} from 'node:crypto'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {boundScopeSources} from '@use-brian/core'
import {getAppPool,getPool,applyRLSGucs,runWithAgentAccess,rollbackAndRelease} from '../../db/client.js'
import {createWorkspaceChatSession} from '../../db/sessions.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {publishNativeSessionMessage,publishNativeSessionMessageBatch} from '../../db/session-message-publication.js'
import {withSessionMessagePublication} from '../../db/session-context-revisions.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
describe.sequential('[COMP:api/application-persistence] actual canonical native transcript batches',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 afterEach(async()=>{await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function setup(){
  fixture=await persistentContextFixture();const f=fixture,history=await f.history(),authority=await f.modelContext(f.firstId)
  const input=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:history.at(-1)!.sequenceNum,authority})
  const memory=await f.memory('Fictional batch source'),row=await createDbMemoryStore().getById(authority.execution.security.access,memory.id)
  if(!row)throw new Error('Missing actual batch memory')
  const sources=[...boundScopeSources(input),...boundScopeSources(row)]
  return{f,authority,memory,sources,batch:{sessionId:f.session.id,authority,derivationTarget:f.envelope,
   derivation:{producer:'fixture:canonical-batch',sources},messages:[{role:'assistant',content:'Fictional paired tool request'},{role:'user',content:'Fictional paired tool response'}]}}
 }
 it('publishes seventeen actual pairs with complete immutable ancestry and ordered sequence numbers',async()=>{
  const {f,batch,sources}=await setup(),messages=Array.from({length:17},()=>batch.messages).flat(),rows=await publishNativeSessionMessageBatch({...batch,messages})
  expect(rows).toHaveLength(34)
  expect(rows.map(row=>row.sequenceNum)).toEqual(Array.from({length:34},(_,n)=>n+4))
  for(const row of rows){
   expect(boundScopeSources(row)).toMatchObject([{resourceKind:'session_message',resourceId:row.id}])
   const edges=(await f.pool.query(`SELECT source_kind,source_id,source_version FROM scope_derivations d JOIN scope_derivation_sources edge
    ON edge.workspace_id=d.workspace_id AND edge.derivation_id=d.id WHERE d.workspace_id=$1 AND d.resource_kind='session_message' AND d.resource_id=$2`,[f.workspaceId,row.id])).rows
   expect(edges.map(edge=>[edge.source_kind,edge.source_id,edge.source_version]).sort()).toEqual(sources.map(source=>[source.resourceKind,source.resourceId,source.version]).sort())
  }
 })
 it('rejects a malformed later SQL payload before writing any member of the batch',async()=>{
  const {f,authority,sources,batch}=await setup()
  await expect(withSessionMessagePublication(authority,sources,db=>db.query('SELECT publish_native_session_message_batch($1,$2,$3,$4,$5,$6)',
   [f.workspaceId,f.session.id,JSON.stringify(batch.messages.map((row,n)=>({role:n?'invalid':row.role,content:row.content,channelMessageId:null,senderUserId:null,senderAssistantId:null,attachments:[]}))),
    batch.derivation.producer,JSON.stringify(sources),f.envelope]))).rejects.toMatchObject({code:'22023',message:'scope_evidence_missing'})
  expect((await f.pool.query('SELECT count(*)::int AS count FROM session_messages WHERE session_id=$1',[f.session.id])).rows[0].count).toBe(3)
 })
 it('refuses a revoked original writer while preserving current independent access and observations',async()=>{
  const {f,authority,sources,batch}=await setup(),before=structuredClone(sources)
  await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.firstId])
  await expect(publishNativeSessionMessageBatch(batch)).rejects.toMatchObject({reason:'authority_changed'})
  const other=await f.modelContext(f.secondId)
  expect(await publishNativeSessionMessageBatch({...batch,authority:other})).toHaveLength(2)
  expect(sources).toEqual(before)
  await expect(authority.execution.security.authority.assertCurrent()).rejects.toMatchObject({reason:'authority_changed'})
 })
 it.each(['single','batch'] as const)('rolls the entire %s effect back when a real source contracts during its inserts',async mode=>{
  const {f,memory,batch}=await setup(),name='r3_batch_'+randomUUID().replaceAll('-','')
  // Guarded synthetic DB only: the trigger performs a real source mutation,
  // without replacing a canonical policy, evaluator or lineage guard.
  await f.pool.query(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
   BEGIN UPDATE memories SET sensitivity='confidential' WHERE id='${memory.id}'::uuid AND sensitivity='internal';RETURN NEW;END $fixture$`)
  try{
   await f.pool.query(`CREATE TRIGGER ${name} AFTER INSERT ON session_messages FOR EACH ROW WHEN (NEW.session_id='${f.session.id}'::uuid) EXECUTE FUNCTION public.${name}()`)
   const write=mode==='batch'?publishNativeSessionMessageBatch(batch):publishNativeSessionMessage({sessionId:batch.sessionId,authority:batch.authority,derivation:batch.derivation,derivationTarget:batch.derivationTarget,...batch.messages[0]})
   await expect(write).rejects.toMatchObject({code:'scope_source_changed'})
   expect((await f.pool.query('SELECT count(*)::int AS count FROM session_messages WHERE session_id=$1',[f.session.id])).rows[0].count).toBe(3)
   expect((await f.pool.query('SELECT sensitivity FROM memories WHERE id=$1',[memory.id])).rows[0].sensitivity).toBe('internal')
  }finally{await f.pool.query(`DROP TRIGGER IF EXISTS ${name} ON session_messages`);await f.pool.query(`DROP FUNCTION public.${name}()`)}
 })
 it('does not turn a raw non-owner connection or owner context into a batch frame',async()=>{
  const {f,authority,batch}=await setup(),db=await getAppPool().connect()
  try{await runWithAgentAccess(authority.execution.security.access,async()=>{
   await db.query('BEGIN');await applyRLSGucs(db,f.firstId)
   await expect(publishNativeSessionMessageBatch(batch,db)).rejects.toMatchObject({code:'scope_evidence_missing'})
   await expect(db.query('SELECT prepare_native_session_message_batch($1,$2,$3,$4,$5)',[f.workspaceId,f.session.id,batch.derivation.producer,JSON.stringify(batch.derivation.sources),f.envelope])).rejects.toMatchObject({code:'42501'})
  })}finally{await rollbackAndRelease(db)}
 })
 it.each(['single','batch'] as const)('keeps the original target pinned when the caller mutates a %s command during admission',async mode=>{
  fixture=await persistentContextFixture();const f=fixture;await f.history()
  const other=await createWorkspaceChatSession({assistantId:f.assistantId,starterUserId:f.ownerId,workspaceId:f.workspaceId,effectiveClearance:'internal',authenticatedHuman:true})
  const authority=await f.modelContext(f.firstId),input=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:3,authority})
  const common={sessionId:f.session.id,authority,derivationTarget:f.envelope,derivation:{producer:'fixture:original-publication-target',sources:boundScopeSources(input)}}
  const message={role:'assistant',content:'Fictional original-target response'}
  let rows
  if(mode==='single'){
   const command={...common,...message},pending=publishNativeSessionMessage(command)
   command.sessionId=other.id;rows=[await pending]
  }else{
   const command={...common,messages:[message,{role:'user',content:'Fictional original-target result'}]},pending=publishNativeSessionMessageBatch(command)
   command.sessionId=other.id;rows=await pending
  }
  expect(rows.map(row=>row.sessionId)).toEqual(rows.map(()=>f.session.id))
  expect((await f.pool.query('SELECT id FROM session_messages WHERE session_id=$1',[other.id])).rows).toEqual([])
  expect((await f.pool.query('SELECT count(*)::int AS count FROM session_messages WHERE session_id=$1',[f.session.id])).rows[0].count).toBe(mode==='single'?4:5)
 })
})
