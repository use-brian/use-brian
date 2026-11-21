import {randomUUID} from 'node:crypto'
import type {PoolClient} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {ContextScopeAccumulator} from '@use-brian/agent-runtime/security/context-scope.js'
import type {ScopeSource} from '@use-brian/agent-runtime/security/derived-scope.js'
import type {ExecutionContext} from '@use-brian/agent-runtime/security/execution-context.js'
import {boundScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import {applyRLSGucs,getAppPool,getPool,rollbackAndRelease,runWithAgentAccess} from '../../db/client.js'
import {readAdmittedSessionQuery} from '../../db/conversation-store.js'
import {publishNativeSessionMessage,publishNativeSessionMessageBatch} from '../../db/conversation-store.js'
import {withSessionMessagePublication} from '../../db/session-context-revisions.js'
import {validateCallerScopeEvidence,readValidatedNativePublicationCohorts} from '../../context-scope/caller-evidence.js'
import {connectBootstrap} from '../../__tests__/fixtures/bootstrap-role.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
type Json=Record<string,any>
const port=`cohort_fixture_${randomUUID().replaceAll('-','')}`
let f:Awaited<ReturnType<typeof persistentContextFixture>>,execution:ExecutionContext,roots:Json[],plain:Json[],sources:ScopeSource[],querySources:ScopeSource[],messageId:string
const identity=(source:ScopeSource)=>({kind:source.resourceKind,id:source.resourceId,version:source.version})
async function operation(client:Pick<PoolClient,'query'>,action:string,payload:unknown={}):Promise<Json>{
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
async function acquired(client:PoolClient,cohorts:Json[][]){
 const value=(await client.query('SELECT capture_conversation_evidence($1,NULL,NULL,$2) value',
  [f.workspaceId,JSON.stringify(cohorts)])).rows[0]?.value
 if(value===null)return null
 if(value?.admitted!==true)throw Object.assign(new Error('scope_source_changed'),{code:'42501'})
 return value as Json
}
async function equal(client:PoolClient,cohorts:Json[][]){
 const separate=[]
 for(const input of cohorts){const full=await operation(client,'original',{roots:input});expect(full.admitted).toBe(true);separate.push({immutable:full.immutable,current:full.current})}
 const joint=await acquired(client,cohorts)
 const normalize=(packets:Json[])=>packets.map(packet=>Object.fromEntries(Object.entries(packet).map(([key,values])=>[key,(values as Json[]).slice().sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))])))
 expect(joint?.admitted).toBe(true)
 expect(normalize(joint!.cohorts)).toEqual(normalize(separate))
 return joint!
}
describe.sequential('[COMP:api/native-turn-frame] exact independent publication cohorts',()=>{
 beforeAll(async()=>{
  f=await persistentContextFixture();execution=await f.execution(f.firstId)
  const history=await f.history();messageId=history[0].id
  // Read canonical versions instead of relying on optional host row metadata.
  plain=(await f.pool.query("SELECT 'session_message' kind,id,scope_version::text version FROM session_messages WHERE session_id=$1 ORDER BY sequence_num",[f.session.id])).rows
  sources=plain.map(n=>({...f.envelope,resourceKind:'session_message',resourceId:n.id,version:n.version}))
  const authority={execution,accumulator:new ContextScopeAccumulator()}
  const query=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:3,authority});querySources=boundScopeSources(query)
  await publishNativeSessionMessage({sessionId:f.session.id,role:'assistant',content:'Fictional cohort reply',senderAssistantId:f.assistantId,
   authority,derivationTarget:f.envelope,derivation:{producer:'fixture:cohort-proof',sources:querySources}})
  roots=(await f.pool.query("SELECT 'session_message' kind,id,scope_version::text version FROM session_messages WHERE session_id=$1 ORDER BY sequence_num",[f.session.id])).rows
  await f.pool.query(`CREATE FUNCTION ${port}(w uuid,action text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
   BEGIN
    IF action='original' THEN RETURN capture_conversation_evidence(w,payload->'roots');
    ELSIF action='prepare' THEN RETURN conversation_prepare_publications(w,(payload->>'sessionId')::uuid,payload->'commands');
    ELSIF action='trace' THEN PERFORM set_config('track_functions','all',true);
    ELSIF action='stats' THEN RETURN coalesce((SELECT jsonb_object_agg(p.proname,s.calls) FROM pg_stat_xact_user_functions s JOIN pg_proc p ON p.oid=s.funcid),'{}');
    ELSIF action='hold' THEN UPDATE session_messages SET scope_held=true WHERE workspace_id=w AND id=(payload->>'id')::uuid;
    ELSIF action='privacy' THEN UPDATE sessions SET recording_privacy_held=true WHERE workspace_id=w AND id=(payload->>'id')::uuid;
    ELSIF action='version' THEN
     UPDATE session_messages SET sensitivity='public' WHERE workspace_id=w AND id=(payload->>'id')::uuid;
     RETURN jsonb_build_object('version',(SELECT scope_version::text FROM session_messages WHERE workspace_id=w AND id=(payload->>'id')::uuid));
    ELSIF action='body' THEN UPDATE session_messages SET content='[{"type":"text","text":"Fictional changed cohort source"}]' WHERE workspace_id=w AND id=(payload->>'id')::uuid;
    ELSIF action='revoke' THEN UPDATE workspace_members SET clearance='public' WHERE workspace_id=w AND user_id=(payload->>'id')::uuid;
    ELSIF action='candidate-bound' THEN
     INSERT INTO session_messages(session_id,workspace_id,role,content,sequence_num,sensitivity,user_id,assistant_id,compartments,project_ids,scope_version,scope_held)
      SELECT (payload->>'sessionId')::uuid,w,'user','[{"type":"text","text":"Fictional bounded candidate"}]'::jsonb,n+4,'internal',NULL,NULL,'{}','{}',1,false
      FROM generate_series(1,4097) n;
    ELSIF action='helper' THEN ALTER FUNCTION conversation_dag(uuid,jsonb,jsonb) COST 101;
    ELSIF action='context-body' THEN
     EXECUTE $attack$CREATE OR REPLACE FUNCTION public.native_turn_context() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
      SET search_path=pg_catalog,public,pg_temp AS $body$BEGIN RAISE EXCEPTION 'changed_cohort_context_must_not_execute';END$body$$attack$;
    ELSIF action='key-body' THEN
     EXECUTE $attack$CREATE OR REPLACE FUNCTION public.native_turn_key(n jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT
      SET search_path=pg_catalog,public,pg_temp AS $body$BEGIN RAISE EXCEPTION 'changed_cohort_key_must_not_execute';END$body$$attack$;
    ELSE RAISE EXCEPTION 'Unknown cohort fixture action';END IF;
    RETURN '{}'::jsonb;
   END $fixture$;
   REVOKE ALL ON FUNCTION ${port}(uuid,text,jsonb) FROM PUBLIC;GRANT EXECUTE ON FUNCTION ${port}(uuid,text,jsonb) TO app_user`)
 },180_000)
 afterAll(async()=>{try{await getPool().query(`DROP FUNCTION IF EXISTS ${port}(uuid,text,jsonb)`);await f?.cleanup()}
  finally{await getAppPool().end();await getPool().end()}})
 it.each(['identical','subset','disjoint'] as const)('prepares %s output cohorts with one graph and exact independent floors',async shape=>frame(async client=>{
  const cohorts=shape==='identical'?[sources,sources]:shape==='subset'?[sources,[sources[0]]]:[[sources[0]],[sources[2]]]
  const commands=cohorts.map(rows=>({producer:'fixture:preparation-cohorts',sources:rows,target:f.envelope}))
  await operation(client,'trace')
  const before=await operation(client,'stats')
  const joint=await operation(client,'prepare',{sessionId:f.session.id,commands})
  const after=await operation(client,'stats')
  expect((after.conversation_dag??0)-(before.conversation_dag??0)).toBe(1)
  const standalone=[]
  for(const command of commands){const value=await operation(client,'prepare',{sessionId:f.session.id,commands:[command]});standalone.push(value[0])}
  expect(joint).toEqual(standalone)
  expect(joint[1].retained).toEqual(cohorts[1].slice().sort((a,b)=>a.resourceKind.localeCompare(b.resourceKind)||a.resourceId.localeCompare(b.resourceId)))
 }),90_000)
 it('refuses the complete prepared effect when one cohort loses a source',async()=>frame(async client=>{
  const commands=[[sources[0]],[sources[2]]].map(rows=>({producer:'fixture:preparation-refusal',sources:rows,target:f.envelope}))
  await operation(client,'hold',{id:sources[2].resourceId})
  await expect(operation(client,'prepare',{sessionId:f.session.id,commands})).rejects.toThrow('scope_source_changed')
 }))
 it.each(['identical','subset','disjoint','overlap','duplicates'] as const)('matches both complete standalone packets for %s roots',async shape=>frame(async client=>{
  const pairs=shape==='identical'?[roots,roots]:shape==='subset'?[roots,[roots[0]]]:shape==='disjoint'?[[plain[0]],[plain[2]]]
   :shape==='overlap'?[[plain[0],plain[1]],[plain[1],plain[2]]]:[[roots[3],roots[0],roots[3]],[roots[0],roots[0]]]
  await equal(client,pairs)
 }),90_000)
 it('keeps semantic query candidates out of a narrower cohort while proving their admission',async()=>frame(async client=>{
  const joint=await equal(client,[querySources.map(identity),[plain[0]]])
  expect(joint.cohorts[1].current.map((s:Json)=>s.resourceId)).toEqual([plain[0].id])
  expect(joint.cohorts[1].immutable).toEqual([])
  expect(joint.cohorts[0].immutable.length).toBeGreaterThan(0)
  await operation(client,'body',{id:plain[2].id})
  await expect(acquired(client,[querySources.map(identity),[plain[0]]])).rejects.toMatchObject({code:'42501'})
 }),90_000)
 it('routes declared Memory roots once and preserves both cohort proofs',async()=>{
  const memory=await f.memory('Fictional retained cohort memory')
  const {rows:[root]}=await f.pool.query(`SELECT 'memory' kind,id,scope_version::text version FROM memories WHERE id=$1`,[memory.id])
  const {rows:[{owner,allowed}]}=await f.pool.query(`SELECT quote_ident(current_user) owner,
   has_parameter_privilege(current_user,'track_functions','SET') allowed`)
  const bootstrap=await connectBootstrap()
  try{
   if(!allowed)await bootstrap.query(`GRANT SET ON PARAMETER track_functions TO ${owner}`)
   await frame(async client=>{
    await operation(client,'trace')
    const before=await operation(client,'stats'),inputs=[[root],[plain[0],root]]
    const joint=await acquired(client,inputs),after=await operation(client,'stats')
    expect((after.fused_f_capture??0)-(before.fused_f_capture??0)).toBe(0)
    expect((after.conversation_dag??0)-(before.conversation_dag??0)).toBe(1)
    expect(joint).toEqual(await equal(client,inputs))
    await expect(acquired(client,[[{...root,extra:true}],[plain[0]]])).rejects.toMatchObject({code:'22023'})
   })
  }finally{
   try{if(!allowed)await bootstrap.query(`REVOKE SET ON PARAMETER track_functions FROM ${owner}`)}
   finally{await bootstrap.end()}
  }
  await frame(async client=>{
   await expect(acquired(client,[[root],[plain[0]],[root]])).rejects.toMatchObject({code:'22023'})
  })
 })
 it('associates multiple original versions with the same changed current descriptor without deduplicating it',async()=>frame(async client=>{
  const changed=await operation(client,'version',{id:messageId});expect(changed.version).not.toBe(plain[0].version)
  const newer={...plain[0],version:changed.version},joint=await equal(client,[[plain[0],newer],[plain[0]]])
  expect(joint.cohorts[0].current).toHaveLength(2)
  expect(joint.cohorts[0].current[0]).toEqual(joint.cohorts[0].current[1])
  expect(joint.cohorts[1].current[0].version).toBe(changed.version)
 }),90_000)
 it('acquires one fresh compiler result for both host checks and preserves each scalar floor',async()=>frame(async client=>{
  await operation(client,'trace');const before=await operation(client,'stats')
  const checked=await readValidatedNativePublicationCohorts([{sources},{sensitivity:'internal',sources:[sources[0]]}],execution.security.ceiling,client)
  const after=await operation(client,'stats');expect(checked).not.toBeNull()
  expect(checked![1].sources).toEqual([sources[0]])
  expect((after.capture_conversation_evidence??0)-(before.capture_conversation_evidence??0)).toBe(1)
  expect((after.conversation_dag??0)-(before.conversation_dag??0)).toBe(1)
  expect((after.native_turn_helpers_current??0)-(before.native_turn_helpers_current??0)).toBe(2)
  expect((after.read_native_turn_compact_requirements??0)-(before.read_native_turn_compact_requirements??0)).toBe(0)
  expect((after.native_turn_discover_lock_requirements??0)-(before.native_turn_discover_lock_requirements??0)).toBe(0)
 }),90_000)
 it.each(['hold','revoke','body'] as const)('never falls back after an eligible discovery detects a fresh %s refusal',async action=>frame(async client=>{
  await equal(client,[roots,[plain[0]]])
  await operation(client,action,{id:action==='revoke'?f.firstId:messageId})
  await expect(acquired(client,[roots,[plain[0]]])).rejects.toMatchObject({code:'42501'})
 }),90_000)
 it.each(['missing','held-parent'] as const)('retains rejecting original validation after pre-proof %s fallback',async kind=>frame(async client=>{
  const field=querySources.find(source=>source.resourceKind==='application_field')!
  expect(field).toBeDefined()
  const source=kind==='missing'?{...field,resourceId:randomUUID()}:field
  if(kind==='held-parent')await operation(client,'privacy',{id:f.session.id})
  const input=[identity(source)]
  const proof=await acquired(client,[input,input]).catch(error=>({admitted:false,code:error.code}))
  expect(proof?.admitted).not.toBe(true)
  await expect(validateCallerScopeEvidence({sources:[source]},execution.security.ceiling,client)).rejects.toThrow()
 }),90_000)
 it('retains the exact metadata-only oversized saved-domain fallback',async()=>{
  const authority={execution,accumulator:new ContextScopeAccumulator()}
  const capture=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:5000,authority})
  const large=boundScopeSources(capture).map(identity)
  await frame(async client=>{
   await operation(client,'candidate-bound',{sessionId:f.session.id})
   await expect(acquired(client,[large,[plain[0]]])).rejects.toMatchObject({code:'42501'})
  })
 },90_000)
 it('does not let a completed host acquisition authorize a later changed writer source',async()=>{
  const authority={execution,accumulator:new ContextScopeAccumulator()}
  await expect(withSessionMessagePublication(authority,querySources,async client=>{
   expect(await readValidatedNativePublicationCohorts([{sources:querySources},{sources:[sources[0]]}],execution.security.ceiling,client)).not.toBeNull()
   await operation(client,'body',{id:messageId})
   await publishNativeSessionMessageBatch({sessionId:f.session.id,authority,derivationTarget:f.envelope,
    derivation:{producer:'fixture:cohort-stale-writer',sources:querySources},messages:[{role:'assistant',content:'Fictional forbidden stale reply'}]},client)
  })).rejects.toThrow()
  expect((await f.pool.query('SELECT count(*)::integer count FROM session_messages WHERE session_id=$1',[f.session.id])).rows[0].count).toBe(4)
 },90_000)
 it('rejects changed executable authority instead of selecting fallback',async()=>frame(async client=>{
  await operation(client,'helper');await expect(acquired(client,[plain,plain])).rejects.toMatchObject({code:'42501'})
 }))
 it.each(['context-body','key-body'])('checks the complete helper guard before executing a changed %s helper',async action=>frame(async client=>{
  await operation(client,action)
  const signature=action==='context-body'?'public.native_turn_context()':'public.native_turn_key(jsonb)'
  expect((await client.query("SELECT prosrc LIKE '%changed_cohort_%_must_not_execute%' changed FROM pg_proc WHERE oid=to_regprocedure($1)",[signature])).rows[0].changed).toBe(true)
  await expect(acquired(client,[plain,plain])).rejects.toMatchObject({code:'42501',message:'scope_source_changed'})
 }))
 it.each([null,[],[{kind:'session_message',id:'invalid',version:'1'}],
  [{kind:'session_message',id:'invalid',version:'1',payload:'forbidden'}]])
 ('never admits malformed identity input %j',async input=>frame(async client=>{
  const result=await client.query('SELECT capture_conversation_evidence($1,$2) value',[f.workspaceId,JSON.stringify(input)]).catch(error=>({rows:[{value:{code:error.code}}]}))
  expect(result.rows[0].value?.admitted).not.toBe(true)
 }))
})
