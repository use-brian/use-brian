import {randomUUID} from 'node:crypto'
import type {PoolClient} from 'pg'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import {boundScopeSources,ContextScopeAccumulator,type ExecutionContext,type ScopeSource} from '@use-brian/core'
import {applyRLSGucs,getAppPool,getPool,rollbackAndRelease,runWithAgentAccess} from '../../db/client.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {publishNativeSessionMessage,publishNativeSessionMessageBatch} from '../../db/session-message-publication.js'
import {withSessionMessagePublication} from '../../db/session-context-revisions.js'
import {validateCallerScopeEvidence,readValidatedNativePublicationCohorts} from '../../context-scope/caller-evidence.js'
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
 return(await client.query('SELECT read_native_turn_publication_cohorts($1,$2) value',[f.workspaceId,JSON.stringify(cohorts)])).rows[0].value as Json|null
}
async function equal(client:PoolClient,cohorts:Json[][]){
 const separate=[]
 for(const input of cohorts){const full=await operation(client,'original',{roots:input});expect(full.available).toBe(true);separate.push({immutable:full.immutable,current:full.current})}
 const joint=await acquired(client,cohorts)
 expect(joint).toEqual({admitted:true,cohorts:separate})
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
    IF action='original' THEN RETURN read_native_turn_compact_requirements(w,payload->'roots','[]');
    ELSIF action='discover' THEN RETURN native_turn_discover_lock_requirements(w,payload->'roots','[]');
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
    ELSIF action='helper' THEN ALTER FUNCTION native_turn_capture_publication_cohorts(uuid,jsonb,jsonb) COST 101;
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
  expect((after.native_turn_capture_publication_cohorts??0)-(before.native_turn_capture_publication_cohorts??0)).toBe(1)
  expect((after.read_native_turn_compact_requirements??0)-(before.read_native_turn_compact_requirements??0)).toBe(0)
  expect((after.native_turn_discover_lock_requirements??0)-(before.native_turn_discover_lock_requirements??0)).toBe(1)
 }),90_000)
 it.each(['hold','revoke','body'] as const)('never falls back after an eligible discovery detects a fresh %s refusal',async action=>frame(async client=>{
  await equal(client,[roots,[plain[0]]])
  await operation(client,action,{id:action==='revoke'?f.firstId:messageId})
  expect((await operation(client,'discover',{roots})).eligibleMetadata).toBe(true)
  await expect(acquired(client,[roots,[plain[0]]])).rejects.toMatchObject({code:'42501'})
 }),90_000)
 it.each(['missing','held-parent'] as const)('retains rejecting original validation after pre-proof %s fallback',async kind=>frame(async client=>{
  const field=querySources.find(source=>source.resourceKind==='application_field')!
  expect(field).toBeDefined()
  const source=kind==='missing'?{...field,resourceId:randomUUID()}:field
  if(kind==='held-parent')await operation(client,'privacy',{id:f.session.id})
  const input=[identity(source)],discovered=await operation(client,'discover',{roots:input})
  expect(discovered).toMatchObject({eligibleMetadata:false,authorizationEvaluated:false})
  expect(await acquired(client,[input,input])).toBeNull()
  await expect(validateCallerScopeEvidence({sources:[source]},execution.security.ceiling,client)).rejects.toThrow()
 }),90_000)
 it('retains the exact metadata-only oversized saved-domain fallback',async()=>{
  const authority={execution,accumulator:new ContextScopeAccumulator()}
  const capture=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:5000,authority})
  const large=boundScopeSources(capture).map(identity)
  await frame(async client=>{
   await operation(client,'candidate-bound',{sessionId:f.session.id})
   expect(await operation(client,'discover',{roots:large})).toEqual({eligibleMetadata:false,reason:'selector_candidate_bound'})
   expect(await operation(client,'original',{roots:large})).toEqual({available:false,reason:'unsupported_requirements'})
   expect(await acquired(client,[large,[plain[0]]])).toBeNull()
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
  await expect(acquired(client,[plain,plain])).rejects.toMatchObject({code:'42501',message:'native_turn_reader_contract_changed'})
 }))
 it.each([null,[],[[]],[[],[]],[[{kind:'session_message',id:'invalid',version:'1'}],[]],[[{kind:'session_message',id:'invalid',version:'1',payload:'forbidden'}],[{kind:'session_message',id:'invalid',version:'1'}]]])
 ('refuses malformed identity input %j',async input=>frame(async client=>{
  await expect(client.query('SELECT read_native_turn_publication_cohorts($1,$2)',[f.workspaceId,JSON.stringify(input)])).rejects.toThrow()
 }))
})
