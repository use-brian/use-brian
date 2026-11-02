import {randomUUID} from 'node:crypto'
import type {PoolClient} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {boundScopeSources,ContextScopeAccumulator,type ExecutionContext} from '@use-brian/core'
import {applyRLSGucs,getAppPool,getPool,rollbackAndRelease,runWithAgentAccess} from '../../db/client.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {publishNativeSessionMessage} from '../../db/session-message-publication.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {resolveExecutionContextSystem} from '../../context-scope/execution-context.js'
import {findAssistantById} from '../../db/users.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
type Json=Record<string,any>
const port=`compact_fixture_${randomUUID().replaceAll('-','')}`
let f:Awaited<ReturnType<typeof persistentContextFixture>>,execution:ExecutionContext,roots:Json[],plainRoots:Json[],messageId:string
async function operation(client:PoolClient,action:string,payload:unknown={}):Promise<Json>{
 return(await client.query(`SELECT ${port}($1,$2,$3) value`,[f.workspaceId,action,JSON.stringify(payload)])).rows[0].value
}
async function frame<T>(run:(client:PoolClient)=>Promise<T>):Promise<T>{
 const client=await getAppPool().connect()
 try{return await runWithAgentAccess(execution.security.access,async()=>{
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');await applyRLSGucs(client,execution.security.access.userId)
  await client.query("SELECT set_config('app.v2_assistant_id',$1,true)",[execution.assistant.id])
  return run(client)
 })}finally{await rollbackAndRelease(client)}
}
async function equal(client:PoolClient,input:Json[]=roots,selectors:Json[]=[],available=true){
 const payload={roots:input,selectors},full=await operation(client,'full',payload),actual=await operation(client,'compact',payload)
 expect(actual.available).toBe(available)
 if(full.available){
  const {points,requirements,...rest}=full
  expect(points).toBeInstanceOf(Array)
  expect(requirements).toHaveProperty('privacyEdges');expect(requirements).toHaveProperty('candidates')
  expect(actual).toEqual({...rest,requirements:{nativeMetadata:requirements.nativeMetadata,sessionParents:requirements.sessionParents}})
 }else expect(actual).toEqual(full)
 return actual
}

describe.sequential('[COMP:api/native-turn-frame] compact fresh native requirements',()=>{
 beforeAll(async()=>{
  f=await persistentContextFixture()
  const unbounded=await f.execution(f.firstId),maximumAccess={...unbounded.security.ceiling,
   clearance:f.envelope.sensitivity,compartments:f.envelope.compartments,mutationCompartments:[],projectIds:f.envelope.projectIds}
  execution=(await resolveExecutionContextSystem({userId:f.firstId,workspaceId:f.workspaceId,
   assistant:(await findAssistantById(f.assistantId))!,memberMode:'member',sharedAudience:true,
   session:f.session,sessionAuthority:f.session,identity:unbounded.identity,ownership:unbounded.ownership,
   lifecycle:unbounded.lifecycle,maximumAccess,maximumAccessCurrent:async()=>maximumAccess})).executionContext
  const history=await f.history();messageId=history[0].id
  plainRoots=(await f.pool.query("SELECT 'session_message' kind,id,scope_version::text version FROM session_messages WHERE session_id=$1 ORDER BY id",[f.session.id])).rows
  await f.pool.query(`CREATE FUNCTION ${port}(w uuid,action text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
   BEGIN
    IF action='full' THEN RETURN read_native_turn_query_requirements(w,payload->'roots',payload->'selectors');
    ELSIF action='compact' THEN RETURN read_native_turn_compact_requirements(w,payload->'roots',payload->'selectors');
    ELSIF action='discover' THEN RETURN native_turn_discover_lock_requirements(w,payload->'roots',payload->'selectors');
    ELSIF action='capture' THEN RETURN native_turn_capture_compact_requirements(w,payload->'roots',payload->'selectors');
    ELSIF action='topology' THEN RETURN native_turn_compact_topology(payload->'nodes',payload->'edges');
    ELSIF action='scope' THEN RETURN read_native_turn_scope_evidence(w,payload->'roots');
    ELSIF action='trace' THEN PERFORM set_config('track_functions','all',true);
    ELSIF action='stats' THEN RETURN coalesce((SELECT jsonb_object_agg(p.proname,s.calls) FROM pg_stat_xact_user_functions s JOIN pg_proc p ON p.oid=s.funcid),'{}');
    ELSIF action='hold' THEN UPDATE session_messages SET scope_held=true WHERE workspace_id=w AND id=(payload->>'id')::uuid;
    ELSIF action='body' THEN UPDATE session_messages SET content='[{"type":"text","text":"Fictional changed compact body"}]' WHERE workspace_id=w AND id=(payload->>'id')::uuid;
    ELSIF action='version' THEN
      UPDATE session_messages SET sensitivity='public' WHERE workspace_id=w AND id=(payload->>'id')::uuid;
      RETURN jsonb_build_object('version',(SELECT scope_version::text FROM session_messages WHERE workspace_id=w AND id=(payload->>'id')::uuid));
    ELSIF action='privacy' THEN UPDATE sessions SET recording_privacy_held=true WHERE workspace_id=w AND id=(payload->>'id')::uuid;
    ELSIF action='parent' THEN UPDATE sessions SET channel_type='slack' WHERE workspace_id=w AND id=(payload->>'id')::uuid;
    ELSIF action='revoke' THEN UPDATE workspace_members SET clearance='public' WHERE workspace_id=w AND user_id=(payload->>'id')::uuid;
    ELSIF action='hidden' THEN UPDATE session_messages SET sensitivity='confidential' WHERE workspace_id=w AND id=(payload->>'id')::uuid;
    ELSIF action='helper' THEN ALTER FUNCTION native_turn_compact_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb) COST 101;
    ELSE RAISE EXCEPTION 'Unknown compact fixture action';END IF;
    RETURN '{}'::jsonb;
   END $fixture$;
   REVOKE ALL ON FUNCTION ${port}(uuid,text,jsonb) FROM PUBLIC;GRANT EXECUTE ON FUNCTION ${port}(uuid,text,jsonb) TO app_user`)
  for(let turn=0;turn<2;turn++){
   const authority={execution,accumulator:new ContextScopeAccumulator()}
   const query=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:3+turn,authority})
   const memory=await createDbMemoryStore().getIndex(execution.security.access,false,authority)
   await publishNativeSessionMessage({sessionId:f.session.id,role:'assistant',content:`Fictional compact proof reply ${turn}`,
    senderAssistantId:f.assistantId,authority,derivationTarget:f.envelope,
    derivation:{producer:'fixture:compact-native-proof',sources:[...boundScopeSources(query),...boundScopeSources(memory)]}})
  }
  roots=(await f.pool.query("SELECT 'session_message' kind,id,scope_version::text version FROM session_messages WHERE session_id=$1 ORDER BY id",[f.session.id])).rows
 },180_000)
 afterAll(async()=>{
  try{await getPool().query(`DROP FUNCTION IF EXISTS ${port}(uuid,text,jsonb)`);await f?.cleanup()}
  finally{await getAppPool().end();await getPool().end()}
 })
 it('preserves complete scopes, counts and lock witnesses for shared history and empty Memory',async()=>frame(async client=>{
  const result=await equal(client)
  expect(result.counts.semanticEdges).toBeGreaterThan(result.counts.semanticNodes)
  expect(result.counts.domains).toBeGreaterThan(0)
  expect(result).not.toHaveProperty('points')
 }),90_000)
 it.each([[5,3],[3,5],[5,0]])('preserves both selector captures at independent bounds %i/%i',async(body,topics)=>frame(async client=>{
  const selectors=[{type:'session_message',sessionId:f.session.id,through:body},{type:'session_message_annotation',sessionId:f.session.id,through:topics}]
  const result=await equal(client,[...roots.slice().reverse(),roots[0]],selectors)
  expect(result.queryCaptures).toHaveLength(2)
  if(topics===0)expect(result.queryCaptures[1].rows).toHaveLength(1)
 }),90_000)
 it('keeps denied physical candidates in both-selector admission',async()=>frame(async client=>{
  await operation(client,'hidden',{id:messageId})
  await equal(client,plainRoots,[{type:'session_message',sessionId:f.session.id,through:3},{type:'session_message_annotation',sessionId:f.session.id,through:3}],false)
 }),90_000)
 it.each(['hold','body','privacy','revoke'] as const)('preserves a fresh %s refusal after an admitted proof',async action=>frame(async client=>{
  await equal(client)
  await operation(client,action,{id:action==='privacy'?f.session.id:action==='revoke'?f.firstId:messageId})
  await equal(client,roots,[],false)
 }),90_000)
 it.each(['version','parent'] as const)('retains exact changed %s lock coverage after discovery',async action=>frame(async client=>{
  const payload={roots:plainRoots,selectors:[]},before=await operation(client,'discover',payload)
  expect(before.eligibleMetadata).toBe(true)
  const changed=await operation(client,action,{id:action==='parent'?f.session.id:messageId})
  if(action==='version')expect(Number(changed.version)).toBeGreaterThan(Number(plainRoots.find(root=>root.id===messageId)!.version))
  const after=await operation(client,'capture',payload)
  expect(after.available).toBe(true)
  expect(after.requirements[action==='parent'?'sessionParents':'nativeMetadata'])
   .not.toEqual(before.witness[action==='parent'?'sessionParents':'nativeMetadata'])
 }),90_000)
 it('uses one fresh compact proof at the scope evidence boundary',async()=>frame(async client=>{
  await operation(client,'trace');const before=await operation(client,'stats')
  expect((await operation(client,'scope',{roots})).admitted).toBe(true)
  const after=await operation(client,'stats')
  expect((after.read_native_turn_compact_requirements??0)-(before.read_native_turn_compact_requirements??0)).toBe(1)
  expect((after.read_native_turn_requirements??0)-(before.read_native_turn_requirements??0)).toBe(0)
 }),90_000)
 it('keeps unsupported and changed helper profiles unavailable',async()=>frame(async client=>{
  await equal(client,[{kind:'external_source',id:randomUUID(),version:'1'}],[],false)
  await operation(client,'helper')
  expect(await equal(client,roots,[],false)).toEqual({available:false,reason:'reader_contract_changed'})
 }))
 it('keeps every compact helper private to its canonical callers',async()=>frame(async client=>{
  const exposed=(await client.query(`SELECT p.proname FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
   AND(p.proname LIKE 'native_turn_compact_%' OR p.proname IN('native_turn_discover_lock_requirements','native_turn_capture_compact_requirements','read_native_turn_compact_requirements'))
   AND has_function_privilege(current_user,p.oid,'EXECUTE')`)).rows
  expect(exposed).toEqual([])
 }))
 it.each(['diamond','cycle','duplicate','missing','extra','null','node-bound','edge-bound'] as const)('keeps ordinal %s graphs bounded and complete',async shape=>frame(async client=>{
  const node=()=>({tag:'source',kind:'session_message',id:randomUUID(),version:'1'})
  const a=node(),b=node(),c=node(),d=node();let nodes:Json[]=[a,b,c,d],edges:Json[]=[{parent:a,child:b},{parent:a,child:c},{parent:b,child:d},{parent:c,child:d}]
  if(shape==='cycle')edges.push({parent:d,child:a})
  if(shape==='duplicate')nodes.push({...a})
  if(shape==='missing')edges.push({parent:a,child:node()})
  if(shape==='extra')edges.push({parent:a,child:{...b,extra:true}})
  if(shape==='null')edges.push({parent:a,child:null})
  if(shape==='node-bound'){nodes=Array.from({length:4097},node);edges=[]}
  if(shape==='edge-bound')edges=Array.from({length:16385},()=>({parent:a,child:b}))
  const order=await operation(client,'topology',{nodes,edges})
  if(shape!=='diamond'){expect(order).toBeNull();return}
  const keys=(order as unknown as string[]).map(key=>JSON.parse(key)[2])
  expect(new Set(keys)).toEqual(new Set(nodes.map(n=>n.id)))
  for(const edge of edges)expect(keys.indexOf(edge.child.id)).toBeLessThan(keys.indexOf(edge.parent.id))
 }),90_000)
})
