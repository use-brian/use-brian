import {randomUUID} from 'node:crypto'
import type {PoolClient} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {ContextScopeAccumulator} from '@use-brian/agent-runtime/security/context-scope.js'
import type {ExecutionContext} from '@use-brian/agent-runtime/security/execution-context.js'
import {boundScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import {applyRLSGucs,getAppPool,getPool,rollbackAndRelease,runWithAgentAccess} from '../../db/client.js'
import {readAdmittedSessionQuery} from '../../db/conversation-store.js'
import {publishNativeSessionMessage} from '../../db/conversation-store.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {resolveExecutionContextSystem} from '../../context-scope/execution-context.js'
import {findAssistantById} from '../../db/users.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
type Json=Record<string,any>
const port=`compact_fixture_${randomUUID().replaceAll('-','')}`
let fieldRoots:Json[]
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
const authorityForTest=()=>({execution,accumulator:new ContextScopeAccumulator()})
async function snapshots(client:PoolClient,input=fieldRoots){
 return (await client.query('SELECT ord,snapshot FROM read_native_session_field_snapshots($1,$2,$3)',
  [f.workspaceId,input.map(n=>n.id),input.map(n=>n.version)])).rows
}

describe.sequential('[COMP:api/native-turn-frame] canonical current conversation fields',()=>{
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
    IF action='scope' THEN RETURN capture_conversation_evidence(w,payload->'roots');
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
    ELSIF action='helper' THEN ALTER FUNCTION conversation_dag_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb[]) COST 101;
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
  const captured=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:5,authority:authorityForTest()})
  fieldRoots=boundScopeSources(captured).filter(source=>source.resourceKind==='application_field')
   .map(source=>({kind:source.resourceKind,id:source.resourceId,version:source.version}))
  expect(fieldRoots.length).toBeGreaterThan(0)

 },180_000)
 afterAll(async()=>{
  try{await getPool().query(`DROP FUNCTION IF EXISTS ${port}(uuid,text,jsonb)`);await f?.cleanup()}
  finally{await getAppPool().end();await getPool().end()}
 })

 it('preserves each original field position and duplicates with one native acquisition',async()=>frame(async client=>{
  const input=[...fieldRoots.slice().reverse(),fieldRoots[0]]
  await operation(client,'trace');const before=await operation(client,'stats')
  const rows=await snapshots(client,input),after=await operation(client,'stats')
  expect(rows).toHaveLength(input.length)
  rows.forEach((row,index)=>{expect(row.ord).toBe(index+1);expect(row.snapshot).toMatchObject({held:false,resourceId:input[index].id,version:input[index].version})})
  expect(rows.at(-1)!.snapshot).toEqual(rows.find(row=>row.snapshot.resourceId===fieldRoots[0].id)!.snapshot)
  expect((after.conversation_dag??0)-(before.conversation_dag??0)).toBe(1)
  for(const name of ['read_native_turn_compact_requirements','native_turn_capture_compact_requirements','read_native_session_cohort_frame','application_session_eval_field'])
   expect((after[name]??0)-(before[name]??0)).toBe(0)
 }),90_000)
 it('keeps valid, unknown and held fields separate in the same result',async()=>frame(async client=>{
  const missing={kind:'application_field',id:randomUUID(),version:'1'}
  const rows=await snapshots(client,[fieldRoots[0],missing,fieldRoots[0]])
  expect(rows.map(row=>row.ord)).toEqual([1,2,3])
  expect(rows[0].snapshot).toMatchObject({held:false});expect(rows[2].snapshot).toEqual(rows[0].snapshot)
  expect(rows[1].snapshot?.held).not.toBe(false)
  await operation(client,'hold',{id:messageId})
  const held=await snapshots(client)
  expect(held.some(row=>row.snapshot?.held!==false)).toBe(true)
 }))
 it.each(['hold','body','privacy','revoke'] as const)('freshly refuses captured fields after %s',async action=>frame(async client=>{
  expect((await snapshots(client)).every(row=>row.snapshot?.held===false)).toBe(true)
  await operation(client,action,{id:action==='privacy'?f.session.id:action==='revoke'?f.firstId:messageId})
  expect((await snapshots(client)).some(row=>row.snapshot?.held!==false)).toBe(true)
 }),90_000)
 it('rejects helper drift before returning any field',async()=>frame(async client=>{
  await operation(client,'helper')
  await expect(snapshots(client)).rejects.toMatchObject({code:'42501',message:'scope_source_changed'})
 }))
 it('does not admit native fields through an owner login',async()=>{
  const client=await getPool().connect()
  try{
   await client.query('BEGIN');await applyRLSGucs(client,execution.security.access.userId)
   expect((await snapshots(client)).every(row=>row.snapshot?.held===true)).toBe(true)
  }finally{await rollbackAndRelease(client)}
 })
 it('deletes the compact and retained reader implementations from the installed database',async()=>frame(async client=>{
  const {readFile}=await import('node:fs/promises')
  const source=await readFile(new URL('../../../scripts/conversation-store/build.mjs',import.meta.url),'utf8')
  const retired=JSON.parse(source.split('const retiredImplementation=')[1].split('\nconst signatures=')[0]) as string[]
  expect(retired.length).toBeGreaterThan(50)
  const rows=(await client.query('SELECT signature FROM unnest($1::text[]) signature WHERE to_regprocedure(signature) IS NOT NULL',[retired])).rows
  expect(rows).toEqual([])
 }))
})
