import {randomUUID} from 'node:crypto'
import type {PoolClient} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {ContextScopeAccumulator} from '@use-brian/agent-runtime/security/context-scope.js'
import type {ExecutionContext} from '@use-brian/agent-runtime/security/execution-context.js'
import {boundScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import {applyRLSGucs,getAppPool,getPool,rollbackAndRelease,runWithAgentAccess} from '../../db/client.js'
import {readAdmittedSessionQuery} from '../../db/conversation-store.js'
import {publishNativeSessionMessage} from '../../db/conversation-store.js'
import {createWorkspaceFile} from '../../db/workspace-files.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
type Json=Record<string,any>
const suffix=randomUUID().replaceAll('-','')
const names={port:`graph_test_port_${suffix}`}
let cycleFiles:string[]
let f:Awaited<ReturnType<typeof persistentContextFixture>>,execution:ExecutionContext,roots:Json[],messageId:string
async function operation(client:PoolClient,action:string,payload:unknown={}):Promise<Json>{
 return(await client.query(`SELECT ${names.port}($1,$2,$3) value`,[f.workspaceId,action,JSON.stringify(payload)])).rows[0].value
}
async function frame<T>(run:(client:PoolClient)=>Promise<T>):Promise<T>{
 const client=await getAppPool().connect()
 try{return await runWithAgentAccess(execution.security.access,async()=>{
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
  await applyRLSGucs(client,execution.security.access.userId)
  await client.query("SELECT set_config('app.v2_assistant_id',$1,true)",[execution.assistant.id])
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
