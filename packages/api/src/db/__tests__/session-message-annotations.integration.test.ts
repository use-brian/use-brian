import { afterAll,afterEach,describe,expect,it,vi } from 'vitest'
import { bindScopeSources,boundScopeSources,classifyTopic,executionToolContext,type LLMProvider,type StreamFn,type TopicClassifierOptions } from '@use-brian/core'
import { persistentContextFixture } from '../../application-platform/__tests__/fixtures/persistent-context.js'
import { persistentSourceFixture } from '../../application-platform/__tests__/fixtures/persistent-source.js'
import { assertSourceModelInputAuthority } from '../../application-platform/model-source-authority.js'
import { applyRLSGucs,getAppPool,getPool } from '../client.js'
import { addSessionMessage,getSessionMessages } from '../sessions.js'
import { bindSessionContextRetainedAuthority,writeSessionContextRevision } from '../session-context-revisions.js'
import { readSessionMessageAnnotation,writeSessionMessageAnnotation } from '../session-message-annotations.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/session-message-annotations] actual immutable message annotations',()=>{
 let f:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 let independent:Awaited<ReturnType<typeof persistentSourceFixture>>|undefined
 afterEach(async()=>{await independent?.cleanup();independent=undefined;await f?.cleanup();f=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function input(userId?:Parameters<NonNullable<typeof f>['modelContext']>[0]) {
  const history=await f!.history(),authority=await f!.modelContext(userId),message=history.at(-1)!
  const context={...executionToolContext(authority.execution,{appId:'fixture'}),scopeAccumulator:authority.accumulator}
  const stream=vi.fn<StreamFn>(async function*(){yield {type:'text_delta',text:'{"topic_label":"fictional current request","state":"continue","confidence":0.9}'}})
  const provider:LLMProvider={name:'fixture',models:['fixture'],stream,createSession(){throw new Error('Unused synthetic provider session')}}
  const options=bindScopeSources<TopicClassifierOptions>({provider,model:'fixture',currentMessage:(message.content as Array<{text:string}>)[0].text,
   recentUserTurns:[],knownTopicsThisSession:[],replyToText:null,authority,assertInputAuthority:()=>assertSourceModelInputAuthority(context)},history.flatMap(boundScopeSources))
  return {authority,message,history,classification:await classifyTopic(options)}
 }
 it('publishes actual guarded classifier output separately from the native authored body',async()=>{
  f=await persistentContextFixture();const current=await input()
  const original=(await f.history()).flatMap(boundScopeSources)
  const annotation=await writeSessionMessageAnnotation({sessionId:f.session.id,messageId:current.message.id,classification:current.classification,
   replyToText:'Fictional earlier response',authority:current.authority})
  expect(annotation).toMatchObject({messageId:current.message.id,topicLabel:'fictional current request',topicConfidence:0.9,replyToText:'Fictional earlier response'})
  expect(boundScopeSources(annotation!)).toMatchObject([{resourceKind:'session_context_revision',resourceId:annotation!.revisionId}])
  const raw=(await f.pool.query('SELECT topic_label,topic_confidence,reply_to_text,content FROM session_messages WHERE id=$1',[current.message.id])).rows[0]
  expect(raw).toMatchObject({topic_label:null,topic_confidence:null,reply_to_text:null,content:current.message.content})
  expect(await readSessionMessageAnnotation(f.session.id,current.message.id,await f.modelContext(f.secondId))).toMatchObject({revisionId:annotation!.revisionId,topicLabel:'fictional current request'})
  expect((await f.history()).flatMap(boundScopeSources)).toEqual(original)
  const edges=(await f.pool.query(`SELECT edge.source_id FROM scope_derivations d JOIN scope_derivation_sources edge ON edge.workspace_id=d.workspace_id AND edge.derivation_id=d.id
   WHERE d.workspace_id=$1 AND d.resource_kind='session_context_revision' AND d.resource_id=$2`,[f.workspaceId,annotation!.revisionId])).rows.map(row=>row.source_id)
  for(const source of original)expect(edges).toContain(source.resourceId)
  expect((await f.pool.query('SELECT read_session_context_revision($1,$2) AS value',[f.workspaceId,annotation!.revisionId])).rows[0].value).toBeNull()
 })
 it('holds historical scalar fields and refuses unbound classifier JSON before publication',async()=>{
  f=await persistentContextFixture();const current=await input()
  const legacy=await addSessionMessage({sessionId:f.session.id,role:'user',content:[{type:'text',text:'Fictional authored body'}],
   topicLabel:'Fictional uncertified label',replyToText:'Fictional uncertified quote',scope:f.envelope})
  expect(await readSessionMessageAnnotation(f.session.id,legacy.id,await f.modelContext())).toBeNull()
  expect(await readSessionMessageAnnotation(f.session.id,current.message.id)).toBeNull()
  await expect(writeSessionMessageAnnotation({sessionId:f.session.id,messageId:current.message.id,classification:JSON.parse(JSON.stringify(current.classification)),
   replyToText:null,authority:current.authority})).rejects.toThrow('scope_evidence_missing')
  expect((await f.pool.query('SELECT count(*)::int AS n FROM session_message_annotation_heads WHERE workspace_id=$1',[f.workspaceId])).rows[0].n).toBe(0)
 })
 it('refuses a withdrawn actor before publication while a different current actor remains usable',async()=>{
  f=await persistentContextFixture();const current=await input(f.firstId)
  await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.firstId])
  await expect(writeSessionMessageAnnotation({sessionId:f.session.id,messageId:current.message.id,classification:current.classification,replyToText:null,authority:current.authority})).rejects.toMatchObject({reason:'authority_changed'})
  expect((await f.pool.query('SELECT count(*)::int AS n FROM session_message_annotation_heads WHERE workspace_id=$1',[f.workspaceId])).rows[0].n).toBe(0)
  const other=await input(f.secondId)
  expect(await writeSessionMessageAnnotation({sessionId:f.session.id,messageId:other.message.id,classification:other.classification,replyToText:null,authority:other.authority})).toBeTruthy()
 })
 it('serializes competing heads and replaces only an explicitly expected immutable revision',async()=>{
  f=await persistentContextFixture();const a=await input(),b=await input()
  const results=await Promise.all([a,b].map(current=>writeSessionMessageAnnotation({sessionId:f!.session.id,messageId:current.message.id,
   classification:current.classification,replyToText:null,authority:current.authority})))
  expect(results.filter(Boolean)).toHaveLength(1);const winner=results.find(Boolean)!
  const next=await input()
  expect(await writeSessionMessageAnnotation({sessionId:f.session.id,messageId:next.message.id,classification:next.classification,replyToText:null,authority:next.authority})).toBeNull()
  const updated=await writeSessionMessageAnnotation({sessionId:f.session.id,messageId:next.message.id,classification:next.classification,replyToText:'Fictional updated quote',authority:next.authority,expectedRevision:winner.revisionId})
  expect(updated!.revisionId).not.toBe(winner.revisionId)
  expect((await f.pool.query("SELECT count(*)::int AS n FROM session_context_scope_revisions WHERE workspace_id=$1 AND parent_kind='message_annotation'",[f.workspaceId])).rows[0].n).toBe(2)
  expect((await f.pool.query('SELECT content FROM session_context_revision_contents WHERE revision_id=$1',[winner.revisionId])).rows[0].content.replyToText).toBeNull()
 })
 it('purges annotation bytes and holds descendants without changing the authored message source',async()=>{
  f=await persistentContextFixture();const current=await input(),original=(await f.history()).flatMap(boundScopeSources)
  const annotation=(await writeSessionMessageAnnotation({sessionId:f.session.id,messageId:current.message.id,classification:current.classification,replyToText:null,authority:current.authority}))!
  const descendant=await writeSessionContextRevision({sessionId:f.session.id,kind:'session_state',authority:current.authority,expectedGeneration:(await f.pool.query('SELECT session_context_generation::text AS n FROM sessions WHERE id=$1',[f.session.id])).rows[0].n,
   content:{key:'Fictional annotation child',status:'open',summary:'Fictional protected child',detail:null,source:'tool',createdAt:1,updatedAt:1,resolvedAt:null},derivation:{producer:'fixture:annotation-child',sources:boundScopeSources(annotation)}})
  await f.pool.query('DELETE FROM session_context_revision_contents WHERE workspace_id=$1 AND revision_id=$2',[f.workspaceId,annotation.revisionId])
  expect(await readSessionMessageAnnotation(f.session.id,current.message.id,await f.modelContext())).toBeNull()
  expect((await f.history()).flatMap(boundScopeSources)).toEqual(original)
  expect((await f.pool.query("SELECT read_scope_source($1,'session_context_revision',$2) AS source",[f.workspaceId,descendant!.id])).rows[0].source.held).toBe(true)
 })
 it('withholds a withdrawn independent annotation and keeps another reader and the authored body usable',async()=>{
  f=await persistentContextFixture();const current=await input(),original=(await f.history()).flatMap(boundScopeSources)
  independent=await persistentSourceFixture(f)
  bindSessionContextRetainedAuthority(current.authority.execution,(execution,sources,action)=>independent!.coordinator.prepare(execution,sources,action))
  const generated=bindScopeSources({...current.classification},[...boundScopeSources(current.classification),independent.root])
  const annotation=(await writeSessionMessageAnnotation({sessionId:f.session.id,messageId:current.message.id,classification:generated,replyToText:'Fictional independent quote',authority:current.authority}))!
  const first=await f.modelContext();bindSessionContextRetainedAuthority(first.execution,(execution,sources,action)=>independent!.coordinator.prepare(execution,sources,action))
  expect(await readSessionMessageAnnotation(f.session.id,current.message.id,first)).toBeTruthy()
  await independent.pool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[f.ownerId])
  expect(await readSessionMessageAnnotation(f.session.id,current.message.id,await f.modelContext())).toBeNull()
  const denied=await f.modelContext();bindSessionContextRetainedAuthority(denied.execution,(execution,sources,action)=>independent!.coordinator.prepare(execution,sources,action))
  expect(await readSessionMessageAnnotation(f.session.id,current.message.id,denied)).toBeNull()
  const second=await f.modelContext(f.secondId);bindSessionContextRetainedAuthority(second.execution,(execution,sources,action)=>independent!.coordinator.prepare(execution,sources,action))
  expect(await readSessionMessageAnnotation(f.session.id,current.message.id,second)).toMatchObject({revisionId:annotation.revisionId,replyToText:'Fictional independent quote'})
  expect((await f.history()).flatMap(boundScopeSources)).toEqual(original)
  expect((await f.pool.query("SELECT read_scope_source($1,'session_context_revision',$2) AS source",[f.workspaceId,annotation.revisionId])).rows[0].source).toMatchObject({held:false,version:'1'})
 })
 it('rejects direct head identity changes, uncertified replacement and private-table reads',async()=>{
  f=await persistentContextFixture();const current=await input()
  const annotation=(await writeSessionMessageAnnotation({sessionId:f.session.id,messageId:current.message.id,classification:current.classification,replyToText:null,authority:current.authority}))!
  const other=await addSessionMessage({sessionId:f.session.id,role:'user',content:[{type:'text',text:'Fictional later authored body'}],scope:f.envelope})
  await expect(f.pool.query('UPDATE session_message_annotation_heads SET message_id=$2 WHERE message_id=$1',[current.message.id,other.id])).rejects.toThrow('scope_evidence_immutable')
  await expect(f.pool.query('DELETE FROM session_message_annotation_heads WHERE message_id=$1',[current.message.id])).rejects.toThrow('scope_evidence_immutable')
  const state=await writeSessionContextRevision({sessionId:f.session.id,kind:'session_state',authority:current.authority,
   expectedGeneration:(await f.pool.query('SELECT session_context_generation::text AS n FROM sessions WHERE id=$1',[f.session.id])).rows[0].n,
   content:{key:'Fictional alternative parent',status:'open',summary:'Fictional separate state',detail:null,source:'tool',createdAt:1,updatedAt:1,resolvedAt:null},
   derivation:{producer:'fixture:annotation-head-conflict',sources:boundScopeSources(current.classification)}})
  await expect(f.pool.query('UPDATE session_message_annotation_heads SET scope_revision_id=$2 WHERE message_id=$1',[current.message.id,state!.id])).rejects.toThrow('scope_source_changed')
  expect((await f.pool.query('SELECT scope_revision_id FROM session_message_annotation_heads WHERE message_id=$1',[current.message.id])).rows[0].scope_revision_id).toBe(annotation.revisionId)
  // Actual runtime ACLs deny raw annotation metadata before any row is read.
  const direct=await getAppPool().connect()
  try {
   await direct.query('BEGIN');await applyRLSGucs(direct,f.ownerId)
   expect((await direct.query("SELECT has_table_privilege(current_user,'session_message_annotation_heads','SELECT') AS allowed")).rows[0].allowed).toBe(false)
   await expect(direct.query('SELECT * FROM session_message_annotation_heads')).rejects.toMatchObject({code:'42501'})
  } finally {await direct.query('ROLLBACK');direct.release()}
  // Independently prove RLS defense using a transaction-local nonlogin probe.
  // The real runtime gets no grant; rollback removes this fixture-only role.
  const probe=await f.pool.connect(),probeRole='annotation_probe_'+crypto.randomUUID().replaceAll('-','')
  try {
   await probe.query('BEGIN');await applyRLSGucs(probe,f.ownerId)
   await probe.query(`CREATE ROLE ${probeRole} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`)
   await probe.query(`GRANT USAGE ON SCHEMA public TO ${probeRole}`)
   await probe.query(`GRANT SELECT ON session_message_annotation_heads TO ${probeRole}`)
   await probe.query(`SET LOCAL ROLE ${probeRole}`)
   expect((await probe.query("SELECT has_table_privilege(current_user,'session_message_annotation_heads','SELECT') AS allowed")).rows[0].allowed).toBe(true)
   expect((await probe.query('SELECT * FROM session_message_annotation_heads')).rows).toEqual([])
  } finally {await probe.query('ROLLBACK');probe.release()}
 })
 it('refuses a fabricated parent or another invocation session without partial annotation effects',async()=>{
  f=await persistentContextFixture();const current=await input()
  await expect(writeSessionMessageAnnotation({sessionId:f.session.id,messageId:'00000000-0000-4000-8000-000000000099',classification:current.classification,replyToText:null,authority:current.authority})).rejects.toThrow('scope_source_changed')
  await expect(writeSessionMessageAnnotation({sessionId:'00000000-0000-4000-8000-000000000098',messageId:current.message.id,classification:current.classification,replyToText:null,authority:current.authority})).rejects.toThrow('scope_source_changed')
  expect((await f.pool.query("SELECT count(*)::int AS n FROM session_context_scope_revisions WHERE workspace_id=$1 AND parent_kind='message_annotation'",[f.workspaceId])).rows[0].n).toBe(0)
 })
 it('bounds a stored quote without dropping its full source closure and purges on actual message deletion',async()=>{
  f=await persistentContextFixture();const current=await input()
  const annotation=(await writeSessionMessageAnnotation({sessionId:f.session.id,messageId:current.message.id,classification:current.classification,replyToText:'Fictional '.repeat(2000),authority:current.authority}))!
  expect(annotation.replyToText).toHaveLength(8000);expect(annotation.replyToText!.endsWith('[truncated]')).toBe(true)
  await expect(f.pool.query('UPDATE session_context_revision_contents SET content=$2 WHERE revision_id=$1',[annotation.revisionId,{topicLabel:'Fictional replacement'}])).rejects.toThrow('scope_evidence_immutable')
  await f.pool.query('DELETE FROM session_messages WHERE id=$1',[current.message.id])
  expect((await f.pool.query('SELECT count(*)::int AS n FROM session_context_revision_contents WHERE revision_id=$1',[annotation.revisionId])).rows[0].n).toBe(0)
  expect((await f.pool.query("SELECT read_scope_source($1,'session_context_revision',$2) AS source",[f.workspaceId,annotation.revisionId])).rows[0].source.held).toBe(true)
 })
})
