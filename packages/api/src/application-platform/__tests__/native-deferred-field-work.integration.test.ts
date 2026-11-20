/** Generic producers retain real per-event validation after queue retirement. [COMP:api/application-persistence] */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import type { ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'
import { boundScopeSources } from '@use-brian/agent-runtime/security/source-evidence.js'
import { applyRLSGucs, getAppPool, getPool, rollbackAndRelease, runWithAgentAccess } from '../../db/client.js'
import { readAdmittedSessionQuery } from '../../db/conversation-store.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const fn = `generic_source_${randomUUID().replaceAll('-', '')}`
const constraint = 'application_field_derivation_dependencies'
let f: Awaited<ReturnType<typeof persistentContextFixture>>
let sources: ScopeSource[], target: string, input: string
async function op<T = unknown>(client: PoolClient, action: string, payload: unknown = {}) {
  return (await client.query<{value:T}>(`SELECT ${fn}($1,$2,$3) value`, [f.workspaceId,action,payload])).rows[0].value
}
async function frame(run: (client: PoolClient) => Promise<void>) {
 const execution=await f.execution(),client=await getAppPool().connect()
 try { await runWithAgentAccess(execution.security.access,async()=>{
  await client.query('BEGIN');await applyRLSGucs(client,f.ownerId)
  await client.query("SELECT set_config('app.v2_assistant_id',$1,true)",[f.assistantId])
  await run(client)
 }) } finally {await rollbackAndRelease(client)}
}
async function install(client: PoolClient) { await op(client,'install',{target,sources}) }
async function flush(client: PoolClient) { await client.query(`SET CONSTRAINTS ${constraint} IMMEDIATE`) }

describe.sequential('[COMP:api/application-persistence] canonical scheduling with generic field constraints',()=>{
 beforeAll(async()=>{
  f=await persistentContextFixture();const history=await f.history();input=history[0].id;target=history[2].id
  const query=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:2,authority:await f.modelContext()})
  sources=[...boundScopeSources(query),{...f.envelope,resourceKind:'session_message',resourceId:input,version:'1'}];expect(sources.some(s=>s.resourceKind==='application_field')).toBe(true)
  await f.pool.query(`CREATE FUNCTION ${fn}(w uuid,action text,payload jsonb) RETURNS jsonb
   LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
   DECLARE d uuid;edge scope_derivation_sources;field record;roots jsonb;before_count bigint;
   BEGIN
    IF action='install' THEN
     INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,user_id,assistant_id,sensitivity,compartments,project_ids,producer,source_policy_revision)
      SELECT w,'session_message',m.id,m.scope_version::text,m.user_id,m.assistant_id,m.sensitivity,m.compartments,m.project_ids,'fixture:generic-source',(SELECT revision FROM workspace_access_policies WHERE workspace_id=w)
      FROM session_messages m WHERE m.workspace_id=w AND m.id=(payload->>'target')::uuid RETURNING id INTO d;
     roots:=payload->'sources';
     FOR field IN SELECT * FROM read_application_field_dependencies(w,
       ARRAY(SELECT value->>'resourceKind' FROM jsonb_array_elements(roots)),
       ARRAY(SELECT (value->>'resourceId')::uuid FROM jsonb_array_elements(roots)),
       ARRAY(SELECT value->>'version' FROM jsonb_array_elements(roots))) LOOP
      roots:=roots||jsonb_build_array(field.source);END LOOP;
     INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
      SELECT DISTINCT w,d,item->>'resourceKind',(item->>'resourceId')::uuid,item->>'version'
       FROM jsonb_array_elements(roots) item ON CONFLICT DO NOTHING;
     RETURN to_jsonb(d);
    ELSIF action='hold' THEN UPDATE session_messages SET scope_held=true WHERE workspace_id=w AND id='${input}'::uuid;
    ELSIF action='labels' THEN UPDATE session_messages SET sensitivity='confidential' WHERE workspace_id=w AND id='${input}'::uuid;
    ELSIF action='body' THEN UPDATE session_messages SET content='"Fictional changed input"'::jsonb WHERE workspace_id=w AND id='${input}'::uuid;
    ELSIF action='refresh_all' THEN UPDATE scope_derivation_sources SET source_version=source_version WHERE workspace_id=w;
    ELSIF action='many' THEN
     FOR before_count IN 1..4097 LOOP UPDATE scope_derivation_sources SET source_version=source_version WHERE workspace_id=w AND source_kind='session_message';END LOOP;
    ELSIF action='trace' THEN PERFORM set_config('track_functions','all',true);
    ELSIF action='calls' THEN RETURN to_jsonb(coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid='validate_application_field_dependencies()'::regprocedure),0));
    ELSIF action='count' THEN RETURN to_jsonb((SELECT count(*) FROM scope_derivation_sources e JOIN scope_derivations d ON d.workspace_id=e.workspace_id AND d.id=e.derivation_id WHERE d.workspace_id=w AND d.resource_id='${target}'::uuid));
    ELSE
     SELECT e.* INTO STRICT edge FROM scope_derivation_sources e JOIN scope_derivations d ON d.workspace_id=e.workspace_id AND d.id=e.derivation_id
      WHERE d.workspace_id=w AND d.resource_id='${target}'::uuid AND e.source_kind='application_field' ORDER BY e.source_id LIMIT 1;
     IF action='repeat' THEN
      UPDATE scope_derivation_sources SET source_version=source_version WHERE derivation_id=edge.derivation_id AND source_kind=edge.source_kind AND source_id=edge.source_id;
      UPDATE scope_derivation_sources SET source_version=source_version WHERE derivation_id=edge.derivation_id AND source_kind=edge.source_kind AND source_id=edge.source_id;
     ELSIF action='ignored' THEN INSERT INTO scope_derivation_sources SELECT (edge).* ON CONFLICT DO NOTHING;
     ELSIF action='upsert' THEN INSERT INTO scope_derivation_sources SELECT (edge).* ON CONFLICT(derivation_id,source_kind,source_id) DO UPDATE SET source_version=excluded.source_version;
     ELSIF action='missing' THEN DELETE FROM scope_derivation_sources WHERE derivation_id=edge.derivation_id AND source_kind=edge.source_kind AND source_id=edge.source_id;
     ELSE RAISE EXCEPTION 'Unknown fictional operation';END IF;
    END IF;RETURN 'null'::jsonb;
   END $fixture$;
   REVOKE ALL ON FUNCTION ${fn}(uuid,text,jsonb) FROM PUBLIC;
   GRANT EXECUTE ON FUNCTION ${fn}(uuid,text,jsonb) TO app_user`)
 },60_000)
 afterAll(async()=>{try{await f?.pool.query(`DROP FUNCTION IF EXISTS ${fn}(uuid,text,jsonb)`);await f?.cleanup()}finally{await getAppPool().end();await getPool().end()}})
 it('retires the scheduler, its tables and specialized fallback instead of leaving dormant owners',async()=>{
  for(const signature of ['enqueue_native_field_dependency_work()','validate_native_field_dependency_batch(uuid,uuid,jsonb)','validate_native_covered_field_dependency_work(uuid,uuid,bigint)','read_native_field_reference_snapshot(uuid,uuid,uuid,text)'])
   expect((await f.pool.query('SELECT to_regprocedure($1) value',[signature])).rows[0].value).toBeNull()
  for(const table of ['native_field_dependency_work','native_field_dependency_batches'])expect((await f.pool.query('SELECT to_regclass($1) value',[table])).rows[0].value).toBeNull()
  expect((await f.pool.query("SELECT has_function_privilege('app_user','native_turn_capture_event()','EXECUTE') value")).rows[0].value).toBe(false)
 })
 it.each(['deferred','immediate'])('accepts a real generic producer with %s constraints',async mode=>frame(async c=>{
  if(mode==='immediate')await flush(c)
  await install(c);expect(await op<number>(c,'count')).toBeGreaterThan(0);await flush(c)
 }))
 for(const [action,events] of [['repeat',2],['ignored',0],['upsert',1]] as const)it(`preserves ${action} per-event semantics`,async()=>frame(async c=>{
  await install(c);await flush(c);await c.query(`SET CONSTRAINTS ${constraint} DEFERRED`);await op(c,'trace')
  const before=await op<number>(c,'calls'),count=await op(c,'count');await op(c,action);await flush(c)
  expect(await op(c,'count')).toBe(count);expect((await op<number>(c,'calls'))-before).toBe(events)
 }))
 it('restores both source state and deferred events after savepoint rollback',async()=>frame(async c=>{
  await install(c);await c.query('SAVEPOINT source_repair');await op(c,'repeat');await op(c,'hold')
  await c.query('ROLLBACK TO SAVEPOINT source_repair');await flush(c)
 }))
 it('validates later updates across immediate/deferred transitions',async()=>frame(async c=>{
  await install(c);await flush(c);await op(c,'repeat');await c.query(`SET CONSTRAINTS ${constraint} DEFERRED`)
  await op(c,'refresh_all');await op(c,'hold');await expect(flush(c)).rejects.toThrow()
 }))
 it('rejects deletion of an immutable field declaration immediately',async()=>frame(async c=>{
  await install(c);await expect(op(c,'missing')).rejects.toMatchObject({message:'scope_evidence_immutable'})
 }))
 it('validates 4097 duplicate non-field events without allocating a second queue',async()=>frame(async c=>{
  await install(c);await flush(c);await c.query(`SET CONSTRAINTS ${constraint} DEFERRED`);await op(c,'trace')
  const before=await op<number>(c,'calls');await op(c,'many');await flush(c)
  expect((await op<number>(c,'calls'))-before).toBe(4097)
 }),120_000)
 for(const change of ['hold','labels','body'])it(`rejects ${change} before the real named constraint completes`,async()=>frame(async c=>{
  await install(c);await op(c,change);await expect(flush(c)).rejects.toThrow()
 }))
})
