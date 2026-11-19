import {randomUUID} from 'node:crypto'
import {afterAll,afterEach,describe,expect,it,vi} from 'vitest'
import type {TopicClassification} from '@use-brian/core/memory/topic-classifier.js'
import {ContextScopeAccumulator} from '@use-brian/agent-runtime/security/context-scope.js'
import {bindScopeSources, boundScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import {readSessionMessageScopeSource} from '../../db/sessions.js'
import {getAppPool,getPool} from '../../db/client.js'
import {readAdmittedSessionQuery} from '../../db/conversation-store.js'
import {prepareSessionMessageAnnotation,writeSessionMessageAnnotation} from '../../db/session-message-annotations.js'
import {publishNativeSessionMessageBatch} from '../../db/conversation-store.js'
import {withSessionMessagePublication} from '../../db/session-context-revisions.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
import * as nativeEvidence from '../conversation-evidence.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/native-turn-frame] annotation publication cohort',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 afterEach(async()=>{vi.restoreAllMocks();await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function setup(topicThroughSequence=2){
  fixture=await persistentContextFixture();const f=fixture;await f.history();const authority=await f.modelContext(f.firstId)
  const capture=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:3,topicThroughSequence,authority})
  const sources=boundScopeSources(capture),messageId=capture.history[2].id
  const classification=bindScopeSources<TopicClassification>({topic_label:'Planning',confidence:0.9,state:'shift'},sources)
  const annotation={sessionId:f.session.id,messageId,classification,replyToText:null,authority}
  const pendingAnnotation=await prepareSessionMessageAnnotation(annotation)
  const command={sessionId:f.session.id,authority,derivationTarget:f.envelope,derivation:{producer:'fixture:annotation-turn',sources},messages:[{role:'assistant',content:'Fictional saved reply'}]}
  return{f,authority,sources,messageId,pendingAnnotation,command,annotation,firstId:capture.history[0].id}
 }
 it('retains only canonical message-source fields after evaluating lifecycle metadata',async()=>{
  const {f,messageId}=await setup()
  const source=await readSessionMessageScopeSource(f.workspaceId,messageId)
  expect(source).not.toBeNull()
  expect(Object.keys(source!).sort()).toEqual(['workspaceId','userId','assistantId','sensitivity','compartments','projectIds','resourceKind','resourceId','version'].sort())
  await f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[messageId])
  expect(await readSessionMessageScopeSource(f.workspaceId,messageId)).toBeNull()
 })
 it.each(['commit','application_field_derivation_dependencies','ALL'])('saves the annotation and reply with independent cohorts through %s',async flush=>{
  const {f,authority,sources,messageId,pendingAnnotation,command}=await setup()
  const generation=Number((await f.pool.query('SELECT session_context_generation FROM sessions WHERE id=$1',[f.session.id])).rows[0].session_context_generation)
  const measurements:string[]=[],jointRead=vi.spyOn(nativeEvidence,'readConversationPublicationCohorts')
  const replies=await withSessionMessagePublication(authority,sources,async db=>{
   const rows=await publishNativeSessionMessageBatch(command,db)
   if(flush!=='commit')await db.query(`SET CONSTRAINTS ${flush} IMMEDIATE`)
   return rows
  },{pendingAnnotation,measure:async(counter,run)=>{
   try{return await run()}finally{measurements.push(counter)}
  }})
  expect(jointRead).toHaveBeenCalledTimes(1)
  const acquired=await jointRead.mock.results[0].value
  expect(acquired).not.toBeNull()
  expect(measurements).toContain('publication_validate')
  expect(measurements.filter(name=>name.startsWith('publication_annotation_'))).toEqual([])
  const heads=(await f.pool.query(`SELECT r.id,r.parent_id,c.content FROM session_message_annotation_heads h JOIN session_context_scope_revisions r ON r.workspace_id=h.workspace_id AND r.id=h.scope_revision_id JOIN session_context_revision_contents c ON c.workspace_id=r.workspace_id AND c.revision_id=r.id WHERE h.message_id=$1`,[messageId])).rows
  expect(heads).toHaveLength(1);expect(heads[0].content).toEqual({topicLabel:'Planning',topicConfidence:0.9,replyToText:null})
  const edges=(await f.pool.query(`SELECT d.resource_kind,d.resource_id,e.source_kind,e.source_id FROM scope_derivations d JOIN scope_derivation_sources e ON e.workspace_id=d.workspace_id AND e.derivation_id=d.id WHERE d.workspace_id=$1 AND d.resource_id=ANY($2::uuid[])`,[f.workspaceId,[heads[0].id,replies[0].id]])).rows
  expect(edges).toHaveLength(2);expect(edges.every(row=>row.source_kind==='session_context_revision')).toBe(true)
  expect(edges[0].source_id).not.toBe(edges[1].source_id)
  expect((await f.pool.query('SELECT count(*)::int n FROM native_turn_frames WHERE workspace_id=$1',[f.workspaceId])).rows[0].n).toBe(2)
  expect(Number((await f.pool.query('SELECT session_context_generation FROM sessions WHERE id=$1',[f.session.id])).rows[0].session_context_generation)).toBe(generation+1)
  expect((await f.pool.query('SELECT count(*)::int n FROM native_turn_publication_debt')).rows[0].n).toBe(0)
 })
 it.each(['deferred','immediate'] as const)('owns exactly two independent cohorts and two graph preparations with %s constraints',async mode=>{
  const {f,authority,sources,pendingAnnotation,command}=await setup()
  const name=`compound_stats_${randomUUID().replaceAll('-','')}`
  await f.pool.query(`CREATE FUNCTION ${name}(enable boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
   BEGIN IF enable THEN PERFORM set_config('track_functions','all',true);END IF;
   RETURN jsonb_build_object('preparations',coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid='conversation_prepare_publications(uuid,uuid,jsonb)'::regprocedure),0),
    'works',(SELECT count(*) FROM native_turn_publication_work WHERE transaction_id=txid_current()),
    'owners',(SELECT count(DISTINCT completion_owner) FROM native_turn_publication_work WHERE transaction_id=txid_current()),
    'seals',(SELECT count(*) FROM native_turn_publication_seals WHERE transaction_id=txid_current()),
    'debts',(SELECT count(*) FROM native_turn_publication_debt WHERE transaction_id=txid_current()));END $fixture$`)
  try{
   await withSessionMessagePublication(authority,sources,async db=>{
    if(mode==='immediate')await db.query('SET CONSTRAINTS ALL IMMEDIATE')
    const before=(await db.query(`SELECT ${name}(true) value`)).rows[0].value
    await publishNativeSessionMessageBatch(command,db)
    if(mode==='deferred'){
     expect((await db.query(`SELECT ${name}(false) value`)).rows[0].value).toMatchObject({works:2,owners:1,seals:1,debts:2})
     await db.query('SET CONSTRAINTS application_field_derivation_dependencies IMMEDIATE')
    }
    const after=(await db.query(`SELECT ${name}(false) value`)).rows[0].value
    expect(after.preparations-before.preparations).toBe(2)
    expect(after).toMatchObject({works:0,owners:0,seals:0,debts:0})
   },{pendingAnnotation})
  }finally{await f.pool.query(`DROP FUNCTION ${name}(boolean)`)}
 })
 it.each(['member','owner','seal-member','child-debt'] as const)('rolls both effects back when compound completion loses its %s',async missing=>{
  const {f,authority,sources,pendingAnnotation,command}=await setup(),name=`compound_fault_${randomUUID().replaceAll('-','')}`
  const mutation=missing==='member'?'DELETE FROM native_turn_publication_work WHERE transaction_id=txid_current() AND frame_id<>completion_owner'
   :missing==='owner'?'UPDATE native_turn_publication_work SET completion_owner=NULL WHERE transaction_id=txid_current() AND frame_id<>completion_owner'
   :missing==='seal-member'?"UPDATE native_turn_publication_seals SET outputs=outputs-0 WHERE transaction_id=txid_current()"
   :'DELETE FROM native_turn_publication_debt WHERE transaction_id=txid_current() AND frame_id IN(SELECT frame_id FROM native_turn_publication_work WHERE frame_id<>completion_owner)'
  await f.pool.query(`CREATE FUNCTION ${name}() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$ BEGIN ${mutation};END $fixture$`)
  try{
   await expect(withSessionMessagePublication(authority,sources,async db=>{
    await publishNativeSessionMessageBatch(command,db);await db.query(`SELECT ${name}()`)
   },{pendingAnnotation})).rejects.toThrow()
   expect((await f.pool.query('SELECT id FROM native_turn_frames WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
   expect((await f.pool.query('SELECT message_id FROM session_message_annotation_heads WHERE session_id=$1',[f.session.id])).rows).toEqual([])
  }finally{await f.pool.query(`DROP FUNCTION ${name}()`)}
 })
 it('owns the detached reply command and pending annotation before asynchronous publication',async()=>{
  const {f,messageId,pendingAnnotation,command}=await setup()
  const publication:{pendingAnnotation:object;turnToken?:string}={pendingAnnotation}
  let changed=false
  const replies=await publishNativeSessionMessageBatch({...command,publication,measure:async(name,run)=>{
   if(name==='publication_pool_wait'&&!changed){
    changed=true
    command.messages[0].content='Fictional changed after submission'
    command.derivation.sources.length=0
    publication.pendingAnnotation={};publication.turnToken=randomUUID()
   }
   return run()
  }})
  expect(changed).toBe(true)
  expect(replies).toHaveLength(1);expect(replies[0].content).toBe('Fictional saved reply')
  const reopened=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:replies[0].sequenceNum,authority:await f.modelContext(f.firstId)})
  expect(reopened.history.find(row=>row.id===replies[0].id)?.content).toBe('Fictional saved reply')
  expect((await f.pool.query('SELECT message_id FROM session_message_annotation_heads WHERE session_id=$1',[f.session.id])).rows).toEqual([{message_id:messageId}])
 })
 it('publishes an empty reply annotation without inventing a transcript message',async()=>{
  const {f,messageId,pendingAnnotation,command}=await setup()
  await expect(publishNativeSessionMessageBatch({...command,messages:[],publication:{pendingAnnotation}})).resolves.toEqual([])
  expect((await f.pool.query('SELECT count(*)::int n FROM session_messages WHERE session_id=$1',[f.session.id])).rows[0].n).toBe(3)
  expect((await f.pool.query('SELECT message_id FROM session_message_annotation_heads WHERE session_id=$1',[f.session.id])).rows).toEqual([{message_id:messageId}])
  expect((await f.pool.query('SELECT count(*)::int n FROM native_turn_frames WHERE workspace_id=$1',[f.workspaceId])).rows[0].n).toBe(1)
  expect((await f.pool.query('SELECT count(*)::int n FROM native_turn_publication_debt')).rows[0].n).toBe(0)
 })
 it('rolls the annotation head, frame and generation back when the reply transaction fails',async()=>{
  const {f,authority,sources,messageId,pendingAnnotation,command}=await setup()
  const before=(await f.pool.query('SELECT session_context_generation FROM sessions WHERE id=$1',[f.session.id])).rows[0]
  await expect(withSessionMessagePublication(authority,sources,async db=>{await publishNativeSessionMessageBatch(command,db);throw new Error('Fictional publication failure')},{pendingAnnotation})).rejects.toThrow('Fictional publication failure')
  expect((await f.pool.query('SELECT scope_revision_id FROM session_message_annotation_heads WHERE message_id=$1',[messageId])).rows).toEqual([])
  expect((await f.pool.query('SELECT id FROM native_turn_frames WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
  expect((await f.pool.query('SELECT session_context_generation FROM sessions WHERE id=$1',[f.session.id])).rows[0]).toEqual(before)
  expect((await f.pool.query('SELECT count(*)::int n FROM session_messages WHERE session_id=$1',[f.session.id])).rows[0].n).toBe(3)
 })
 it('refuses a stale expected annotation head before publishing another frame',async()=>{
  const {f,annotation}=await setup()
  const saved=await writeSessionMessageAnnotation(annotation);expect(saved).not.toBeNull()
  const before=(await f.pool.query('SELECT count(*)::int n FROM native_turn_frames WHERE workspace_id=$1',[f.workspaceId])).rows[0].n
  expect(before).toBe(1)
  expect(await writeSessionMessageAnnotation({...annotation,expectedRevision:randomUUID()})).toBeNull()
  expect((await f.pool.query('SELECT count(*)::int n FROM native_turn_frames WHERE workspace_id=$1',[f.workspaceId])).rows[0].n).toBe(before)
 })
 async function directAnnotation(db:Parameters<Parameters<typeof withSessionMessagePublication>[2]>[0],input:Awaited<ReturnType<typeof setup>>,parentId:string,sources:unknown){
  return (await db.query('SELECT publish_native_session_context_revision($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) value',
   [input.f.workspaceId,input.f.session.id,'message_annotation',parentId,randomUUID(),{topicLabel:'Planning',topicConfidence:0.9,replyToText:null},'fixture:annotation-cohort',JSON.stringify(sources),null,null,null])).rows[0].value
 }
 it('commits two distinct annotation parents while each write advances generation once',async()=>{
  const input=await setup(0),{f,authority,messageId,firstId}=input
  const parents=await Promise.all([firstId,messageId].map(id=>readSessionMessageScopeSource(f.workspaceId,id)))
  expect(parents.every(Boolean)).toBe(true)
  const sources=new ContextScopeAccumulator({sources:[...input.sources,...parents.filter((source):source is NonNullable<typeof source>=>source!==null)]}).evidence.sources??[]
  const before=Number((await f.pool.query('SELECT session_context_generation FROM sessions WHERE id=$1',[f.session.id])).rows[0].session_context_generation)
  await withSessionMessagePublication(authority,sources,async db=>{
   expect(await directAnnotation(db,input,firstId,sources)).not.toBeNull()
   expect(await directAnnotation(db,input,messageId,sources)).not.toBeNull()
  })
  expect((await f.pool.query('SELECT message_id FROM session_message_annotation_heads WHERE session_id=$1',[f.session.id])).rows).toHaveLength(2)
  expect((await f.pool.query('SELECT id FROM native_turn_frames WHERE workspace_id=$1',[f.workspaceId])).rows).toHaveLength(2)
  expect(Number((await f.pool.query('SELECT session_context_generation FROM sessions WHERE id=$1',[f.session.id])).rows[0].session_context_generation)).toBe(before+2)
 })
 it('publishes a complete annotation with immediate constraints and no completion debt',async()=>{
  const input=await setup(),{f,authority,messageId}=input
  const parent=await readSessionMessageScopeSource(f.workspaceId,messageId);expect(parent).not.toBeNull()
  const sources=[...input.sources,parent!]
  const annotation=await withSessionMessagePublication(authority,sources,async db=>{
   await db.query('SET CONSTRAINTS ALL IMMEDIATE')
   return directAnnotation(db,input,messageId,sources)
  })
  expect(annotation).not.toBeNull()
  expect((await f.pool.query('SELECT id FROM native_turn_frames WHERE workspace_id=$1',[f.workspaceId])).rows).toHaveLength(1)
  expect((await f.pool.query('SELECT message_id FROM session_message_annotation_heads WHERE session_id=$1',[f.session.id])).rows).toEqual([{message_id:messageId}])
  expect((await f.pool.query('SELECT count(*)::int count FROM native_turn_publication_debt')).rows[0].count).toBe(0)
 })
 it('cannot commit an annotation when its completion trigger is removed',async()=>{
  const input=await setup(),{f,authority,messageId}=input,name=`annotation_debt_${randomUUID().replaceAll('-','')}`
  const parent=await readSessionMessageScopeSource(f.workspaceId,messageId);expect(parent).not.toBeNull()
  const sources=[...input.sources,parent!]
  await f.pool.query(`CREATE FUNCTION ${name}() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$ BEGIN DROP TRIGGER application_field_derivation_dependencies ON native_turn_publication_seals;END $fixture$`)
  try{
   await expect(withSessionMessagePublication(authority,sources,async db=>{
    expect(await directAnnotation(db,input,messageId,sources)).not.toBeNull()
    await db.query(`SELECT ${name}()`)
   })).rejects.toThrow()
   expect((await f.pool.query('SELECT id FROM native_turn_frames WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
   expect((await f.pool.query('SELECT message_id FROM session_message_annotation_heads WHERE session_id=$1',[f.session.id])).rows).toEqual([])
  }finally{await f.pool.query(`DROP FUNCTION ${name}()`)}
 })
 it.each(['body','head','grant'] as const)('refuses actual %s changes during the annotation write',async change=>{
  const {f,authority,sources,pendingAnnotation,command,firstId}=await setup(),name=`annotation_${randomUUID().replaceAll('-','')}`
  const mutation=`UPDATE session_messages SET content='"Fictional source replacement"'::jsonb WHERE id='${firstId}'::uuid;`
  // A head mutation is attached after its insert and deletes the actual head;
  // the pair and completion validators must both refuse that unpublished result.
  const body=change==='head'?'DELETE FROM session_message_annotation_heads WHERE message_id=NEW.message_id;':change==='grant'?`UPDATE workspace_members SET clearance='public' WHERE workspace_id='${f.workspaceId}'::uuid AND user_id='${f.firstId}'::uuid;`:mutation
  await f.pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$ BEGIN ${body} RETURN NEW;END $fixture$`)
  try{
   await f.pool.query(`CREATE TRIGGER ${name} AFTER INSERT ON session_message_annotation_heads FOR EACH ROW WHEN (NEW.session_id='${f.session.id}'::uuid) EXECUTE FUNCTION ${name}()`)
   await expect(publishNativeSessionMessageBatch({...command,publication:{pendingAnnotation}})).rejects.toThrow()
   expect((await f.pool.query('SELECT id FROM native_turn_frames WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
  }finally{await f.pool.query(`DROP TRIGGER IF EXISTS ${name} ON session_message_annotation_heads;DROP FUNCTION ${name}()`)}
 })
})
