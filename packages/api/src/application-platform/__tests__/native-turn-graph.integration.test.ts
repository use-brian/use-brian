import {randomUUID} from 'node:crypto'
import type {PoolClient} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {ContextScopeAccumulator} from '@use-brian/agent-runtime/security/context-scope.js'
import type {ExecutionContext} from '@use-brian/agent-runtime/security/execution-context.js'
import {boundScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import {applyRLSGucs,getAppPool,getPool,rollbackAndRelease,runWithAgentAccess} from '../../db/client.js'
import {captureConversationQuery,publishNativeSessionMessage,readAdmittedSessionQuery} from '../../db/conversation-store.js'
import {writeSessionContextRevision} from '../../db/session-context-revisions.js'
import {addSessionMessage,readSessionMessageScopeSource} from '../../db/sessions.js'
import {createWorkspaceFile} from '../../db/workspace-files.js'
import {withTableTriggersSuspended} from '../../__tests__/fixtures/bootstrap-role.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
type Json=Record<string,any>
const suffix=randomUUID().replaceAll('-','')
const names={port:`graph_test_port_${suffix}`}
let cycleFiles:string[]
let f:Awaited<ReturnType<typeof persistentContextFixture>>,execution:ExecutionContext,roots:Json[],messageId:string
async function operation(client:PoolClient,action:string,payload:unknown={},workspaceId=f.workspaceId):Promise<Json>{
 return(await client.query(`SELECT ${names.port}($1,$2,$3) value`,[workspaceId,action,JSON.stringify(payload)])).rows[0].value
}
async function frame<T>(run:(client:PoolClient)=>Promise<T>,isolation:'READ COMMITTED'|'REPEATABLE READ'='READ COMMITTED',
 context=execution):Promise<T>{
 const client=await getAppPool().connect()
 try{return await runWithAgentAccess(context.security.access,async()=>{
  await client.query(`BEGIN ISOLATION LEVEL ${isolation}`)
  await applyRLSGucs(client,context.security.access.userId)
  await client.query("SELECT set_config('app.v2_assistant_id',$1,true)",[context.assistant.id])
  return run(client)
 })}finally{await rollbackAndRelease(client)}
}
async function equalProof(client:PoolClient,input:Json[],selectors:Json[]=[],admitted=true){
 const current=await operation(client,'read',{roots:input,selectors})
 expect(current?.admitted===true).toBe(admitted)
 return current
}
describe.sequential('[COMP:api/native-turn-frame] lossless graph representation',()=>{
 beforeAll(async()=>{
  f=await persistentContextFixture()
  const history=await f.history();messageId=history[0].id
  execution=await f.execution(f.firstId)
  for(let turn=0;turn<2;turn++){
   const authority={execution,accumulator:new ContextScopeAccumulator()}
   const query=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:3+turn,authority})
   await publishNativeSessionMessage({sessionId:f.session.id,role:'assistant',content:`Fictional shared graph reply ${turn}`,
    senderAssistantId:f.assistantId,authority,derivationTarget:f.envelope,
    derivation:{producer:'fixture:shared-native-graph',sources:boundScopeSources(query)}})
  }
  cycleFiles=[]
  for(let i=0;i<2;i++){
   const file=await createWorkspaceFile(f.ownerId,{workspaceId:f.workspaceId,path:`/uploads/fictional-cycle-${i}-${suffix}.txt`,
    parentPath:'/uploads',name:`Fictional cycle ${i}`,mime:'text/plain',sizeBytes:1,storageUri:'fixture://conversation-cycle',createdByUserId:f.ownerId,source:'user'})
   cycleFiles.push(file.id)
  }
  roots=(await f.pool.query("SELECT 'session_message' kind,id,scope_version::text version FROM session_messages WHERE session_id=$1 ORDER BY id",[f.session.id])).rows
  await f.pool.query([
   `CREATE FUNCTION ${names.port}(w uuid,action text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
    BEGIN
     IF action='read' THEN RETURN capture_conversation_evidence(w,payload->'roots');
     ELSIF action='topics' THEN
      RETURN (SELECT jsonb_build_object('ids',coalesce(jsonb_agg(key::jsonb->>1 ORDER BY key::jsonb->>1),'[]'))
       FROM jsonb_each(conversation_dag(w,'[]',payload->'selectors')->'points')
       WHERE value#>>'{values,topicLabel}' IS NOT NULL);
     ELSIF action='cycle' THEN UPDATE workspace_files SET superseded_by=CASE id WHEN (payload->>0)::uuid THEN (payload->>1)::uuid ELSE (payload->>0)::uuid END WHERE workspace_id=w AND id IN((payload->>0)::uuid,(payload->>1)::uuid);
     ELSIF action='hold' THEN UPDATE session_messages SET scope_held=true WHERE workspace_id=w AND id=(payload->>'id')::uuid;
     ELSIF action='body' THEN UPDATE session_messages SET content='[{"type":"text","text":"Fictional changed graph body"}]' WHERE workspace_id=w AND id=(payload->>'id')::uuid;
     ELSIF action='privacy' THEN UPDATE sessions SET recording_privacy_held=true WHERE workspace_id=w AND id=(payload->>'id')::uuid;
     ELSIF action='revoke' THEN UPDATE workspace_members SET clearance='public' WHERE workspace_id=w AND user_id=(payload->>'id')::uuid;
     ELSE RAISE EXCEPTION 'Unknown graph fixture operation';END IF;
     RETURN '{}'::jsonb;
    END $fixture$;
    REVOKE ALL ON FUNCTION ${names.port}(uuid,text,jsonb) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION ${names.port}(uuid,text,jsonb) TO app_user;`].join('\n'))
 },180_000)
 afterAll(async()=>{
  try{
   await getPool().query(`DROP FUNCTION IF EXISTS ${names.port}(uuid,text,jsonb)`)
   await f?.cleanup()
  }finally{await getAppPool().end();await getPool().end()}
 })
 it('preserves the complete graph witness and proof for overlapping retained history',async()=>frame(async client=>{
  const result=await equalProof(client,roots)
  expect(result.current.length).toBeGreaterThan(roots.length)
  expect(result.immutable.length).toBeGreaterThan(0)
 }),90_000)
 it('matches retained history in the canonical repeatable-read evaluator',async()=>{
  const selection={sessionId:f.session.id,throughSequence:5,topicThroughSequence:5}
  const capture=(client:PoolClient)=>captureConversationQuery(client,f.workspaceId,selection)
  const frontier=await frame(capture)
  const canonical=await frame(capture,'REPEATABLE READ')
  expect(frontier.history.slice(1)).toHaveLength(5)
  expect(canonical).toEqual(frontier)
  const afterHold=await frame(async client=>{
   await operation(client,'hold',{id:messageId})
   return capture(client)
  },'REPEATABLE READ')
  expect(afterHold.history.some(({row})=>row?.id===messageId)).toBe(false)
 },90_000)
 it('preserves repeated root identities without duplicating requirements',async()=>frame(async client=>{
  const original=await equalProof(client,roots)
  const repeated=await equalProof(client,[...roots.slice().reverse(),roots[0]])
  const normalize=(packet:Json)=>Object.fromEntries(Object.entries(packet).map(([key,value])=>[key,Array.isArray(value)?value.map(item=>JSON.stringify(item)).sort():value]))
  expect(normalize(repeated)).toEqual(normalize(original))
 }),90_000)
 it.each(['hold','body','privacy','revoke'] as const)('preserves a fresh %s refusal after a completed proof',async action=>frame(async client=>{
  await equalProof(client,roots)
  await operation(client,action,{id:action==='privacy'?f.session.id:action==='revoke'?f.firstId:messageId})
  await equalProof(client,roots,[],false)
 }),90_000)
 it('retains the unsupported-family refusal',async()=>frame(async client=>{
  await equalProof(client,[{kind:'external_source',id:randomUUID(),version:'1'}],[],false)
 }))
 it('terminates a real stored file cycle and refuses its capture',async()=>frame(async client=>{
  const fileRoots=cycleFiles.map(id=>({kind:'workspace_file',id,version:'1'}))
  await equalProof(client,fileRoots)
  await operation(client,'cycle',cycleFiles)
  await expect(operation(client,'read',{roots:fileRoots})).rejects.toMatchObject({code:'42501',message:'scope_ancestry_unavailable'})
 }),90_000)
 it('refuses an oversized root set at the actual capture port',async()=>frame(async client=>{
  await equalProof(client,Array.from({length:4097},()=>({kind:'session_message',id:randomUUID(),version:'1'})),[],false)
 }))
 it('evaluates a topic graph beyond the old adjacency byte limit and still holds withdrawn inputs',async()=>{
  const dense=await persistentContextFixture()
  try{
   // Record prior workspaces' statistics before inserting this workspace's dense history.
   await dense.pool.query(`ANALYZE public.scope_derivations,public.scope_derivation_sources,
    public.application_field_observation_sources`)
   const historySize=325
   const denseExecution=await dense.execution(dense.firstId)
   const authority=()=>({execution:denseExecution,accumulator:new ContextScopeAccumulator()})
   const read=async(throughSequence:number,topicThroughSequence=throughSequence)=>readAdmittedSessionQuery({
    sessionId:dense.session.id,throughSequence,topicThroughSequence,authority:authority(),
   })
   const messages=[]
   for(let index=0;index<historySize;index++){
    messages.push(await addSessionMessage({sessionId:dense.session.id,role:'user',
     content:[{type:'text',text:`Fictional retained message ${index+1}`}],scope:dense.envelope}))
   }
   // Seed genuine overlapping query observations before adding topics so their
   // original cohort has no dependency on any of the later topic revisions.
   const bodies=await read(historySize,0),previous=await read(historySize-1,0)
   const historySources=new ContextScopeAccumulator({sources:[
    ...boundScopeSources(bodies.history),...boundScopeSources(previous.history),
   ]}).evidence.sources!
   expect(bodies.history).toHaveLength(historySize)
   const earlierFields=bodies.history.slice(0,162).map(row=>boundScopeSources(row)[0])
   const laterFields=bodies.history.slice(162).map(row=>boundScopeSources(row)[0])
   const targets=messages.slice(-30)
   for(const target of targets){
    const source=await readSessionMessageScopeSource(dense.workspaceId,target.id)
    expect(source).not.toBeNull()
    expect(await writeSessionContextRevision({
     sessionId:dense.session.id,parentId:target.id,kind:'message_annotation',authority:authority(),
     content:{topicLabel:'Fictional retained topic',topicConfidence:0.9,replyToText:null},
     derivation:{producer:'fixture:dense-topic',sources:[source!]},
    })).not.toBeNull()
   }
   const owner=await dense.pool.connect()
   try{
    await owner.query('BEGIN')
    // Restore broad historical annotation and field dependencies using real
    // captured field identities. Current writers emit compact frame provenance.
    await withTableTriggersSuspended(owner,['session_context_scope_revisions','session_context_revision_contents',
     'scope_derivations','scope_derivation_sources'],async()=>{
     await owner.query(`WITH historical AS (
      INSERT INTO session_context_scope_revisions(workspace_id,session_id,parent_kind,parent_id,user_id,assistant_id,
       sensitivity,compartments,project_ids,payload_sha256)
      SELECT workspace_id,session_id,parent_kind,parent_id,user_id,assistant_id,sensitivity,compartments,project_ids,payload_sha256
      FROM session_context_scope_revisions r JOIN session_message_annotation_heads h USING(workspace_id,session_id)
      WHERE r.workspace_id=$1 AND r.id=h.scope_revision_id RETURNING *
     ), payloads AS (
      INSERT INTO session_context_revision_contents(workspace_id,revision_id,content)
      SELECT r.workspace_id,r.id,c.content FROM historical r JOIN session_message_annotation_heads h
       ON h.workspace_id=r.workspace_id AND h.session_id=r.session_id AND h.message_id=r.parent_id
      JOIN session_context_revision_contents c ON c.workspace_id=h.workspace_id AND c.revision_id=h.scope_revision_id
     ), historical_derivations AS (
      INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,
       user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
      SELECT workspace_id,'session_context_revision',id,'1','fixture:dense-historical-topic',
       user_id,assistant_id,sensitivity,compartments,project_ids,1 FROM historical RETURNING workspace_id,id
     ), heads AS (
      SELECT d.workspace_id,d.id,h.message_id FROM session_message_annotation_heads h
      JOIN scope_derivations d ON d.workspace_id=h.workspace_id AND d.resource_kind='session_context_revision'
       AND d.resource_id=h.scope_revision_id WHERE h.workspace_id=$1
     ), historical_fields AS (
      INSERT INTO application_field_observations(workspace_id,resource_id,version,record_version,policy_version,
       source_kind,source_id,source_version,source_scope,owner_id)
      SELECT o.workspace_id,o.resource_id,encode(sha256(convert_to(o.version||'fictional prior observation','UTF8')),'hex'),
       o.record_version,o.policy_version,o.source_kind,o.source_id,o.source_version,o.source_scope,o.owner_id
      FROM application_field_observations o JOIN jsonb_to_recordset($3) f(id uuid,version text)
       ON o.resource_id=f.id AND o.version=f.version
      WHERE o.workspace_id=$1 RETURNING workspace_id,resource_id,version
     ), field_links AS (
      INSERT INTO application_field_observation_sources(workspace_id,resource_id,version,source_kind,source_id,source_version)
      SELECT d.workspace_id,d.resource_id,d.version,'application_field',s.id,s.version
      FROM historical_fields d CROSS JOIN jsonb_to_recordset($4) s(id uuid,version text)
     ), retained_fields AS (
      SELECT s.id,s.version FROM jsonb_to_recordset($2) s(id uuid,version text)
      WHERE NOT EXISTS(SELECT 1 FROM historical_fields h WHERE h.resource_id=s.id)
      UNION ALL SELECT resource_id,version FROM historical_fields
     ), links AS (
      SELECT d.workspace_id,d.id,'application_field'::text source_kind,s.id source_id,s.version source_version
      FROM (SELECT workspace_id,id FROM historical_derivations UNION ALL SELECT workspace_id,id FROM heads) d
      CROSS JOIN retained_fields s
      UNION ALL
      SELECT d.workspace_id,d.id,'session_context_revision',r.id,'1'
      FROM historical r JOIN heads d ON d.workspace_id=r.workspace_id AND d.message_id=r.parent_id
     ) INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
     SELECT * FROM links`,[dense.workspaceId,...[historySources,laterFields,earlierFields].map(sources=>
      JSON.stringify(sources.map(source=>({id:source.resourceId,version:source.version}))))])
    })
    expect((await owner.query<{current:boolean}>('SELECT native_turn_contract_witness_refresh() AS current')).rows[0].current).toBe(true)
    await owner.query('COMMIT')
   }finally{await rollbackAndRelease(owner)}
   const {edges,bytes}=(await dense.pool.query<{edges:number;bytes:number}>(`WITH retained_edges AS (
    SELECT d.resource_kind,d.resource_id,d.resource_version,s.source_kind,s.source_id,s.source_version
    FROM scope_derivations d JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
    WHERE d.workspace_id=$1
    UNION ALL SELECT 'application_field',resource_id,version,source_kind,source_id,source_version
    FROM application_field_observation_sources WHERE workspace_id=$1
   ) SELECT count(*)::int AS edges,
    pg_column_size(jsonb_agg(jsonb_build_object('parent',jsonb_build_object('tag','source','kind',resource_kind,
     'id',resource_id,'version',resource_version),'child',jsonb_build_object('tag','source','kind',source_kind,
     'id',source_id,'version',source_version),'edge_kind','derivation'))) AS bytes FROM retained_edges`,[dense.workspaceId])).rows[0]
   expect(edges).toBeGreaterThan(39_000)
   expect(edges).toBeLessThan(65_536)
   expect(bytes).toBeGreaterThan(16*1024*1024)
   const selectors=[{type:'session_message_annotation',through:historySize,sessionId:dense.session.id}]
   const captureTopics=()=>frame(async client=>(await operation(client,'topics',{selectors},dense.workspaceId)).ids,
    'READ COMMITTED',denseExecution)
   expect(await captureTopics()).toEqual(targets.map(row=>row.id).sort())
   await dense.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1',[messages[0].id])
   expect(await captureTopics()).toEqual([])
  }finally{await dense.cleanup()}
 },240_000)
 it('keeps canonical graph internals and their contract registry private',async()=>{
  expect((await f.pool.query(`SELECT has_table_privilege('app_user','native_turn_contract_helpers','SELECT') read,
   has_table_privilege('app_user','native_turn_contract_helpers','UPDATE') write`)).rows[0]).toEqual({read:false,write:false})
  const internals=['conversation_dag','conversation_dag_edges','conversation_dag_point','conversation_dag_envelope','conversation_dag_domain','conversation_dag_scan','conversation_dag_scope']
  const routines=(await f.pool.query<{name:string;permitted:boolean}>(`SELECT proname name,has_function_privilege('app_user',oid,'EXECUTE') permitted
   FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[])`,[internals])).rows
  expect(routines.map(row=>row.name).sort()).toEqual(internals.sort())
  expect(routines.every(row=>!row.permitted)).toBe(true)
  expect((await f.pool.query(`SELECT p.oid::regprocedure::text signature FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'native_retained_graph_%'`)).rows).toEqual([])
 })
})
