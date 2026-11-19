/** Complete large-source capture and publication, without retired cover/reader oracles. [COMP:api/application-persistence] */
import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import type {PoolClient} from 'pg'
import {ContextScopeAccumulator, type ScopeEvidence} from '@use-brian/agent-runtime/security/context-scope.js'
import type {ScopeSource} from '@use-brian/agent-runtime/security/derived-scope.js'
import type {ExecutionContext} from '@use-brian/agent-runtime/security/execution-context.js'
import {boundScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import {getAppPool,getPool} from '../../db/client.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {listWorkspaceFilesIndexRanked} from '../../db/workspace-files.js'
import {addSessionMessage} from '../../db/sessions.js'
import {readAdmittedSessionQuery,publishNativeSessionMessage,publishNativeSessionMessageBatch} from '../../db/conversation-store.js'
import {readRetainedContextFrame,withSessionMessagePublication,writeSessionContextRevision} from '../../db/session-context-revisions.js'
import {validateCallerScopeEvidence} from '../../context-scope/caller-evidence.js'
import {tryNativeInvocationEvidence} from '../../context-scope/native-invocation-evidence.js'
import {readConversationEvidence} from '../conversation-evidence.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const mutation=`conversation_large_fixture_${randomUUID().replaceAll('-','')}`
let f:Awaited<ReturnType<typeof persistentContextFixture>>,execution:ExecutionContext,sources:ScopeSource[],files:ScopeSource[]
const authority=()=>({execution,accumulator:new ContextScopeAccumulator()})
const normalized=(value:ScopeEvidence)=>({...value,sources:[...value.sources??[]].sort((a,b)=>
 `${a.resourceKind}:${a.resourceId}:${a.version}`.localeCompare(`${b.resourceKind}:${b.resourceId}:${b.version}`))})
async function frame<T>(run:(client:PoolClient)=>Promise<T>){return readRetainedContextFrame(authority(),[],run)}
async function mutate(client:PoolClient,action:string){
 await client.query(`SELECT ${mutation}($1,$2,$3,$4)`,[f.workspaceId,action,files[0].resourceId,files[0].version])
}
async function assertDeclarations(messageId:string,expected=sources){
 const parents=(await f.pool.query(`SELECT s.source_kind,s.source_id FROM scope_derivations d
  JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
  JOIN native_turn_frames frame ON frame.workspace_id=s.workspace_id AND frame.id=s.source_id
  WHERE d.workspace_id=$1 AND d.resource_kind='session_message' AND d.resource_id=$2`,[f.workspaceId,messageId])).rows
 expect(parents).toHaveLength(1)
 expect(parents[0].source_kind).toBe('session_context_revision')
 const declarations=(await f.pool.query(`SELECT s.source_kind,s.source_id,s.source_version FROM scope_derivations d
  JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
  WHERE d.workspace_id=$1 AND d.resource_kind='session_context_revision' AND d.resource_id=$2`,[f.workspaceId,parents[0].source_id])).rows
 for(const source of expected)expect(declarations).toContainEqual({source_kind:source.resourceKind,source_id:source.resourceId,source_version:source.version})
 for(const table of ['native_turn_publication_work','native_turn_publication_events','native_turn_publication_seals','native_turn_publication_debt']){
  expect((await f.pool.query(`SELECT count(*)::int count FROM ${table}`)).rows[0].count).toBe(0)
 }
}
describe.sequential('[COMP:api/application-persistence] canonical large conversation evidence',()=>{
 beforeAll(async()=>{
  f=await persistentContextFixture()
  await f.pool.query(`INSERT INTO workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity)
   SELECT $1,'/fictional/large-'||n||'.txt','Fictional large file '||n,'fixture://large-'||n,$2,'user','internal'
   FROM generate_series(1,101) n`,[f.workspaceId,f.ownerId])
  execution=await f.execution(f.firstId)
  files=(await listWorkspaceFilesIndexRanked(execution.security.access,101)).flatMap(boundScopeSources)
  expect(files).toHaveLength(101)
  for(let i=0;i<101;i++)await addSessionMessage({sessionId:f.session.id,role:'user',content:`Fictional large request ${i}`,scope:f.envelope})
  const memory=await createDbMemoryStore().getIndex(execution.security.access,false,authority())
  const query=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:101,authority:authority()})
  sources=new ContextScopeAccumulator({sources:[...boundScopeSources(query),...boundScopeSources(memory),...files]}).evidence.sources!
  expect(sources.filter(source=>source.resourceKind==='application_field').length).toBeGreaterThan(100)
  expect(sources.length).toBeLessThan(4096)
  await f.pool.query(`CREATE FUNCTION ${mutation}(w uuid,action text,i uuid,v text) RETURNS void
   LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
   DECLARE definition text;body text;
   BEGIN
    IF action='hold' THEN
     INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
      VALUES(w,'workspace_file',i,v,'held',1,'Fictional large source hold');
    ELSIF action='labels' THEN UPDATE workspace_files SET sensitivity='confidential' WHERE workspace_id=w AND id=i;
    ELSIF action='drift' THEN
     SELECT pg_get_functiondef(oid),prosrc INTO STRICT definition,body FROM pg_proc WHERE oid='conversation_dag(uuid,jsonb,jsonb)'::regprocedure;
     EXECUTE replace(definition,body,'BEGIN RAISE EXCEPTION ''Fictional unknown evaluator must not execute'';END');
    ELSE RAISE EXCEPTION 'Unknown large evidence fixture action';END IF;
   END $fixture$;
   REVOKE ALL ON FUNCTION ${mutation}(uuid,text,uuid,text) FROM PUBLIC;
   GRANT EXECUTE ON FUNCTION ${mutation}(uuid,text,uuid,text) TO app_user`)
 },120_000)
 afterAll(async()=>{
  try{await getPool().query(`DROP FUNCTION IF EXISTS ${mutation}(uuid,text,uuid,text)`);await f?.cleanup()}
  finally{await getAppPool().end();await getPool().end()}
 })
 it('retains every original root through one complete application capture',async()=>{
  const admitted=await tryNativeInvocationEvidence(execution,{sources},execution.security.ceiling,'caller')
  expect(admitted).not.toBeNull()
  for(const source of sources)expect(admitted!.sources).toContainEqual(source)
 })
 it('matches the general source validator for more than one hundred fields and independent file roots',async()=>frame(async client=>{
  const actual=await validateCallerScopeEvidence({sources},execution.security.ceiling,client)
  const general={query:async(sql:string,params?:unknown[])=>sql.includes('capture_conversation_evidence')?{rows:[{value:null}]}:client.query(sql,params)} as Pick<PoolClient,'query'>
  expect(normalized(actual)).toEqual(normalized(await validateCallerScopeEvidence({sources},execution.security.ceiling,general)))
 }),90_000)
 it('publishes every current source while keeping missing native D1 labels in the output floor',async()=>{
  const absent={...files[0],resourceId:randomUUID()}
  const [row]=await publishNativeSessionMessageBatch({sessionId:f.session.id,authority:authority(),derivationTarget:f.envelope,
   messages:[{role:'assistant',content:'Fictional absent source response'}],
   derivation:{producer:'fixture:large-d1',sources:[...sources,absent]}})
  await assertDeclarations(row.id)
  expect((await f.pool.query('SELECT sensitivity FROM session_messages WHERE id=$1',[row.id])).rows[0].sensitivity).toBe(absent.sensitivity)
  expect((await f.pool.query('SELECT source_id FROM scope_derivation_sources WHERE workspace_id=$1 AND source_id=$2',[f.workspaceId,absent.resourceId])).rows).toEqual([])
 },90_000)
 it.each(['batch','single'] as const)('publishes a %s result with the complete shared manifest and exact reopen',async mode=>{
  const current=authority(),content=`Fictional large ${mode} response`,common={sessionId:f.session.id,authority:current,
   derivationTarget:f.envelope,derivation:{producer:'fixture:large-publication',sources}}
  const row=mode==='single'?await publishNativeSessionMessage({...common,role:'assistant',content,senderAssistantId:f.assistantId})
   :(await withSessionMessagePublication(current,sources,async client=>{
    const rows=await publishNativeSessionMessageBatch({...common,messages:[{role:'assistant',content,senderAssistantId:f.assistantId}]},client)
    await client.query('SET CONSTRAINTS application_field_derivation_dependencies IMMEDIATE')
    return rows
   }))[0]
  await assertDeclarations(row.id)
  const reopened=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:row.sequenceNum,authority:authority()})
  expect(reopened.history.find(message=>message.id===row.id)?.content).toBe(content)
  if(mode==='batch'){
   const body=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:row.sequenceNum,topicThroughSequence:0,authority:authority()})
   expect(await writeSessionContextRevision({sessionId:f.session.id,parentId:row.id,kind:'message_annotation',
    content:{topicLabel:'Fictional large context',topicConfidence:0.9,replyToText:null},authority:authority(),
    derivation:{producer:'fixture:large-annotation',sources:[...boundScopeSources(body),...files]}})).not.toBeNull()
   const annotated=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:row.sequenceNum,authority:authority()})
   expect(annotated.annotations.some(annotation=>annotation.id===row.id&&annotation.topicLabel==='Fictional large context')).toBe(true)
  }
 },90_000)
 it.each(['hold','labels','drift'] as const)('rejects fresh %s before completing a large publication',async action=>{
  const current=authority()
  let written=false,messageId:string|undefined
  await expect(withSessionMessagePublication(current,sources,async client=>{
   const [row]=await publishNativeSessionMessageBatch({sessionId:f.session.id,authority:current,derivationTarget:f.envelope,
    messages:[{role:'assistant',content:'Fictional withheld large answer'}],derivation:{producer:'fixture:large-refusal',sources}},client)
   written=true;messageId=row.id
   await mutate(client,action)
   await client.query('SET CONSTRAINTS ALL IMMEDIATE')
  })).rejects.toMatchObject({message:expect.stringMatching(/^scope_(source_changed|operation_denied|visibility_incompatible|evidence_missing)$/)})
  expect(written).toBe(true)
  expect((await f.pool.query('SELECT id FROM session_messages WHERE id=$1',[messageId])).rows).toEqual([])
 },90_000)
 it.each(['private','version'] as const)('refuses the changed original %s floor instead of covering its identity',async change=>frame(async client=>{
  const invalid=structuredClone(sources)
  if(change==='private')invalid.find(source=>source.resourceKind==='workspace_file')!.userId=f.secondId
  else invalid.find(source=>source.resourceKind==='application_field')!.version='fictional-unrecorded-version'
  await expect(validateCallerScopeEvidence({sources:invalid},execution.security.ceiling,client)).rejects.toMatchObject({reason:'caller_evidence_unavailable'})
 }))
 it('declines oversized identity input before SQL instead of truncating it',async()=>{
  let queried=false
  const client={query:async()=>{queried=true;throw new Error('Oversized roots reached SQL')}} as Pick<PoolClient,'query'>
  expect(await readConversationEvidence(client,f.workspaceId,Array.from({length:4097},()=>sources[0]))).toBeNull()
  expect(queried).toBe(false)
 })
})
