import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import type {PoolClient} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {boundScopeSources,ContextScopeAccumulator,type ExecutionContext} from '@use-brian/core'
import {applyRLSGucs,getAppPool,getPool,rollbackAndRelease,runWithAgentAccess} from '../../db/client.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {publishNativeSessionMessage} from '../../db/session-message-publication.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
type Json=Record<string,any>
const suffix=randomUUID().replaceAll('-','')
const names={topology:`graph_original_topology_${suffix}`,metadata:`graph_original_metadata_${suffix}`,
 capture:`graph_original_capture_${suffix}`,read:`graph_original_read_${suffix}`,port:`graph_test_port_${suffix}`}
let f:Awaited<ReturnType<typeof persistentContextFixture>>,execution:ExecutionContext,roots:Json[],messageId:string
function declaration(source:string,name:string,tag:string):string{
 const marker=name==='native_turn_topology'?'CREATE OR REPLACE FUNCTION public.':'CREATE FUNCTION public.'
 const begin=source.indexOf(marker+name+'(')
 if(begin<0)throw new Error('Canonical graph predecessor declaration missing')
 const end=source.indexOf(`END $${tag}$;`,begin)
 if(end<0)throw new Error('Canonical graph predecessor body missing')
 return source.slice(begin,end+`END $${tag}$;`.length)
}
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
async function equalProof(client:PoolClient,input:Json[],selectors:Json[]=[],available=true){
 const payload={roots:input,selectors}
 const original=await operation(client,'original',payload),current=await operation(client,'read',payload)
 expect(current).toEqual(original)
 expect(current.available).toBe(available)
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
  roots=(await f.pool.query("SELECT 'session_message' kind,id,scope_version::text version FROM session_messages WHERE session_id=$1 ORDER BY id",[f.session.id])).rows
  const original=await readFile(new URL('../../../migrations/8183_native_turn_requirements.sql',import.meta.url),'utf8')
  const acquisition=await readFile(new URL('../../../migrations/8197_native_turn_query_acquisition.sql',import.meta.url),'utf8')
  const topology=declaration(original,'native_turn_topology','').replace('CREATE OR REPLACE FUNCTION public.native_turn_topology(',`CREATE FUNCTION ${names.topology}(`)
  const metadata=declaration(acquisition,'native_turn_metadata_acquire','body')
   .replace('CREATE FUNCTION public.native_turn_metadata_acquire(',`CREATE FUNCTION ${names.metadata}(`)
   .replace('public.native_turn_topology(nodes,edges)',`${names.topology}(nodes,edges)`)
  const capture=declaration(acquisition,'native_turn_capture_requirements','body')
   .replace('CREATE FUNCTION public.native_turn_capture_requirements(',`CREATE FUNCTION ${names.capture}(`)
   .replace('native_turn_metadata_acquire(w,roots,selectors)',`${names.metadata}(w,roots,selectors)`)
  const read=declaration(acquisition,'read_native_turn_query_requirements','body')
   .replace('CREATE FUNCTION public.read_native_turn_query_requirements(',`CREATE FUNCTION ${names.read}(`)
   .replace('native_turn_metadata_acquire(w,roots,selectors)',`${names.metadata}(w,roots,selectors)`)
   .replace('native_turn_capture_requirements(w,roots,selectors)',`${names.capture}(w,roots,selectors)`)
  await f.pool.query([topology,metadata,capture,read,
   `REVOKE ALL ON FUNCTION ${names.topology}(jsonb,jsonb),${names.metadata}(uuid,jsonb,jsonb),${names.capture}(uuid,jsonb,jsonb),${names.read}(uuid,jsonb,jsonb) FROM PUBLIC,app_user;`,
   `CREATE FUNCTION ${names.port}(w uuid,action text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
    BEGIN
     IF action='read' THEN RETURN read_native_turn_query_requirements(w,payload->'roots',payload->'selectors');
     ELSIF action='original' THEN RETURN ${names.read}(w,payload->'roots',payload->'selectors');
     ELSIF action='metadata' THEN RETURN native_turn_metadata_acquire(w,payload->'roots',payload->'selectors')-'observedAt';
     ELSIF action='original_metadata' THEN RETURN ${names.metadata}(w,payload->'roots',payload->'selectors')-'observedAt';
     ELSIF action='topology' THEN RETURN native_turn_topology(payload->'nodes',payload->'edges');
     ELSIF action='original_topology' THEN RETURN ${names.topology}(payload->'nodes',payload->'edges');
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
   await getPool().query(`DROP FUNCTION IF EXISTS ${names.port}(uuid,text,jsonb),${names.read}(uuid,jsonb,jsonb),${names.capture}(uuid,jsonb,jsonb),${names.metadata}(uuid,jsonb,jsonb),${names.topology}(jsonb,jsonb)`)
   await f?.cleanup()
  }finally{await getAppPool().end();await getPool().end()}
 })
 it('preserves the complete graph witness and proof for overlapping retained history',async()=>frame(async client=>{
  const result=await equalProof(client,roots)
  expect(result.counts.semanticEdges).toBeGreaterThan(result.counts.semanticNodes)
  expect(result.counts.points).toBeGreaterThan(0)
  const payload={roots,selectors:[]}
  expect(await operation(client,'metadata',payload)).toEqual(await operation(client,'original_metadata',payload))
 }),90_000)
 it('preserves repeated roots and independently bounded body and annotation selectors',async()=>frame(async client=>{
  const selectors=[{type:'session_message',sessionId:f.session.id,through:5},{type:'session_message_annotation',sessionId:f.session.id,through:3}]
  const result=await equalProof(client,[...roots.slice().reverse(),roots[0]],selectors)
  expect(result.queryCaptures).toHaveLength(2)
 }),90_000)
 it.each(['hold','body','privacy','revoke'] as const)('preserves a fresh %s refusal after a completed proof',async action=>frame(async client=>{
  await equalProof(client,roots)
  await operation(client,action,{id:action==='privacy'?f.session.id:action==='revoke'?f.firstId:messageId})
  await equalProof(client,roots,[],false)
 }),90_000)
 it('retains the unsupported-family refusal',async()=>frame(async client=>{
  await equalProof(client,[{kind:'external_source',id:randomUUID(),version:'1'}],[],false)
 }))
 it.each(['diamond','cycle','duplicate-key','overflow'] as const)('preserves exact topological %s behavior',async shape=>frame(async client=>{
  const node=(id:string,version='1')=>({tag:'source',kind:'session_message',id,version})
  const a=node(randomUUID()),b=node(randomUUID()),c=node(randomUUID()),d=node(randomUUID())
  let nodes=[a,b,c,d],edges=[{parent:a,child:b},{parent:a,child:c},{parent:b,child:d},{parent:c,child:d}]
  if(shape==='cycle')edges.push({parent:d,child:a})
  if(shape==='duplicate-key')nodes.push({...a})
  if(shape==='overflow'){nodes=Array.from({length:4097},()=>node(randomUUID()));edges=[]}
  const input={nodes,edges},current=await operation(client,'topology',input)
  expect(current).toEqual(await operation(client,'original_topology',input))
  if(shape==='diamond')expect(current).toHaveLength(4)
  else expect(current).toBeNull()
 }),90_000)
})
