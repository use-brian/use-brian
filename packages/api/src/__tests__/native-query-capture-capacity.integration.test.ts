/** [COMP:api/native-chat-read-cost] Genuine retained native turns cross the old estimate under the real graph limits. */
import {ContextScopeAccumulator,type SessionContextAuthority} from '@use-brian/core'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {getAppPool,getPool} from '../db/client.js'
import {addSessionMessage,readSessionById} from '../db/sessions.js'
import {readAdmittedSessionQuery} from '../db/session-query-reader.js'
import {writeSessionContextRevision} from '../db/session-context-revisions.js'
import {publishNativeSessionMessageBatch} from '../db/session-message-publication.js'
import {persistentContextFixture} from '../application-platform/__tests__/fixtures/persistent-context.js'
import {assertRetainedNativeQueryCapacity} from './fixtures/native-session-capacity.js'

const {assertLocalFixture}=await import(new URL('../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/native-chat-read-cost] real retained query capacity',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>
 let initialHistory:unknown
 const retainedRows=255
 const history=async()=>(await fixture.pool.query(`SELECT id,role,content,sequence_num,scope_version,
  user_id,assistant_id,sensitivity,compartments,project_ids,scope_held FROM session_messages
  WHERE session_id=$1 AND sequence_num<=$2 ORDER BY sequence_num`,[fixture.session.id,retainedRows])).rows
 async function authority():Promise<SessionContextAuthority>{
  const session=await readSessionById(fixture.session.id);expect(session).not.toBeNull()
  return{execution:await fixture.execution(fixture.ownerId,session!),accumulator:new ContextScopeAccumulator()}
 }
 beforeAll(async()=>{
  fixture=await persistentContextFixture()
  await fixture.pool.query('UPDATE workspaces SET department_read_v2=true,project_shared_spaces=false WHERE id=$1',[fixture.workspaceId])
  // Historical fixture rows carry no fabricated derivation. Every later
  // observation, annotation, reply and capacity proof uses canonical ports.
  await fixture.pool.query(`INSERT INTO session_messages(session_id,workspace_id,role,content,sequence_num,
   sender_user_id,sender_assistant_id,user_id,assistant_id,sensitivity,compartments,project_ids,scope_version,scope_held)
   SELECT $1,$2,CASE WHEN n%2=1 THEN 'user' ELSE 'assistant' END,
    jsonb_build_array(jsonb_build_object('type','text','text','Fictional retained capacity turn '||n)),n,
    CASE WHEN n%2=1 THEN $3::uuid ELSE NULL END,CASE WHEN n%2=0 THEN $4::uuid ELSE NULL END,
    NULL,NULL,'internal','{}','{}',1,false FROM generate_series(1,$5::int) n`,
  [fixture.session.id,fixture.workspaceId,fixture.ownerId,fixture.assistantId,retainedRows])
  initialHistory=await history();expect(initialHistory).toHaveLength(retainedRows)
 })
 // Retain a failing graph for diagnosis; the maintained owner disposes the
 // complete synthetic database after the suite, including immutable ancestry.
 afterAll(async()=>{await getAppPool().end();await getPool().end()})

 it.each([1,2,3,4,5,6,7,8])('retains genuine native annotation and reply %i',async(index)=>{
  const input=await addSessionMessage({sessionId:fixture.session.id,role:'user',senderUserId:fixture.ownerId,
   content:[{type:'text',text:`Fictional native capacity request ${index}.`}],scope:fixture.envelope})
  expect(input.sequenceNum).toBe(retainedRows+index*2-1)
  const current=await authority()
  await readAdmittedSessionQuery({sessionId:fixture.session.id,throughSequence:input.sequenceNum,
   topicThroughSequence:input.sequenceNum-1,currentMessageId:input.id,currentMessageSequence:input.sequenceNum,authority:current})
  const annotation=await writeSessionContextRevision({sessionId:fixture.session.id,parentId:input.id,kind:'message_annotation',
   content:{topicLabel:'Fictional native capacity',topicConfidence:1,replyToText:null},authority:current,
   derivation:{producer:'session:message-annotation',sources:current.accumulator.evidence.sources??[]}})
  expect(annotation).not.toBeNull()
  const parents=(await fixture.pool.query(`SELECT s.source_kind,f.id frame FROM scope_derivations d
   JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
   LEFT JOIN native_turn_frames f ON f.workspace_id=s.workspace_id AND f.id=s.source_id
   WHERE d.workspace_id=$1 AND d.resource_kind='session_context_revision' AND d.resource_id=$2`,
  [fixture.workspaceId,annotation!.id])).rows
  expect(parents).toEqual([{source_kind:'session_context_revision',frame:expect.any(String)}])
  // The answer reads the newly retained annotation under its current query
  // domain, retaining both earlier and current immutable capture versions.
  await readAdmittedSessionQuery({sessionId:fixture.session.id,throughSequence:input.sequenceNum,
   topicThroughSequence:input.sequenceNum,currentMessageId:input.id,currentMessageSequence:input.sequenceNum,authority:current})
  const [reply]=await publishNativeSessionMessageBatch({sessionId:fixture.session.id,
   messages:[{role:'assistant',senderAssistantId:fixture.assistantId,content:[{type:'text',text:`Fictional native capacity answer ${index}.`}]}],
   authority:current,derivationTarget:fixture.envelope,
   derivation:{producer:'fixture:retained-answer',sources:current.accumulator.evidence.sources??[]}})
  expect(reply.sequenceNum).toBe(retainedRows+index*2)
  expect(await history()).toEqual(initialHistory)
 },90_000)

 it('admits a fresh real query beyond the former estimate and rolls every staged capture back',async()=>{
  const input=await addSessionMessage({sessionId:fixture.session.id,role:'user',senderUserId:fixture.ownerId,
   content:[{type:'text',text:'Fictional pending capacity request.'}],scope:fixture.envelope})
  expect(input.sequenceNum).toBe(272)
  const result=await assertRetainedNativeQueryCapacity(await authority())
  console.info('[retained native capacity]',result)
  expect(result.oldSemanticEstimate).toBeGreaterThan(16_384)
  expect(await history()).toEqual(initialHistory)
 },90_000)
})
