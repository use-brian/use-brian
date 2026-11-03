import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import type {PoolClient} from 'pg'
import {afterAll,describe,expect,it} from 'vitest'
import {getAppPool,getPool} from '../../db/client.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
const migration=(await readFile(new URL('../../../migrations/8199_native_turn_compact_requirements.sql',import.meta.url),'utf8'))
 .replace(/^BEGIN;\n/m,'').replace(/\nCOMMIT;\s*$/,'')
const boundary=process.env.BRIAN_NATIVE_COMPACT_UPGRADE_BOUNDARY==='8198'
 ||(await pool.query("SELECT to_regprocedure('read_native_turn_compact_requirements(uuid,jsonb,jsonb)') IS NULL predecessor")).rows[0].predecessor===true
const guards=`SELECT native_turn_helpers_current() reader,native_turn_publication_contract() publication,
 application_native_worklist_helpers_current() worklist,application_native_dependency_batch_helpers_current() dependency,
 application_native_field_reference_helpers_current() reference,application_memory_statement_helpers_current() memory`
const healthy={reader:true,publication:true,worklist:true,dependency:true,reference:true,memory:true}
const diagnostics=['read_native_turn_requirements(uuid,jsonb)','read_native_turn_query_requirements(uuid,jsonb,jsonb)',
 'native_turn_metadata_acquire(uuid,jsonb,jsonb)','native_turn_capture_requirements(uuid,jsonb,jsonb)','native_turn_topology(jsonb,jsonb)']
const compact="p.proname LIKE 'native_turn_compact_%' OR p.proname IN('native_turn_discover_lock_requirements','native_turn_capture_compact_requirements','read_native_turn_compact_requirements')"
afterAll(async()=>{await getAppPool().end();await pool.end()})
async function rollback(run:(client:PoolClient)=>Promise<void>){
 const client=await pool.connect()
 try{await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='120s'");await run(client)}
 finally{await client.query('ROLLBACK');client.release()}
}
async function replaceBody(client:PoolClient,signature:string,body:string){
 const row=(await client.query('SELECT prosrc body,pg_get_functiondef(oid) definition FROM pg_proc WHERE oid=$1::regprocedure',[signature])).rows[0]
 await client.query(row.definition.replace(row.body,()=>body))
}
describe.sequential('[COMP:api/native-turn-frame] compact compiler guard canary',()=>{
 it('keeps current authority guards and any installed compact helpers private',async()=>{
  expect((await pool.query(guards)).rows[0]).toEqual(healthy)
  expect((await pool.query(`SELECT count(*)::integer exposed FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
   AND(${compact}) AND has_function_privilege('app_user',p.oid,'EXECUTE')`)).rows[0].exposed).toBe(0)
 })
})
describe.skipIf(!boundary).sequential('[COMP:api/native-turn-frame] compact compiler authentication (8199 upgrade profile)',()=>{
 it('authenticates the predecessor and preserves full diagnostic contracts',async()=>rollback(async client=>{
  const before=(await client.query('SELECT oid::regprocedure::text signature,to_jsonb(p) definition FROM pg_proc p WHERE oid=ANY($1::regprocedure[]) ORDER BY signature',[diagnostics])).rows
  await client.query(migration)
  expect((await client.query(guards)).rows[0]).toEqual(healthy)
  expect((await client.query('SELECT oid::regprocedure::text signature,to_jsonb(p) definition FROM pg_proc p WHERE oid=ANY($1::regprocedure[]) ORDER BY signature',[diagnostics])).rows).toEqual(before)
  expect((await client.query(`SELECT count(*)::integer count,bool_and(NOT has_function_privilege('app_user',p.oid,'EXECUTE')) private
   FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND(${compact})`)).rows[0]).toEqual({count:11,private:true})
  expect((await client.query('SELECT count(*)::integer count FROM native_turn_contract_helpers')).rows[0].count).toBe(144)
 }),180_000)
 it('rejects a preexisting compact helper collision',async()=>rollback(async client=>{
  await client.query("CREATE FUNCTION read_native_turn_compact_requirements(uuid,jsonb,jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$")
  await expect(client.query(migration)).rejects.toThrow('native_compact_predecessor_roster_changed')
 }),180_000)
 it('rejects an unknown static consumer of a rerouted reader pin',async()=>rollback(async client=>{
  await client.query(`DO $fixture$ DECLARE pin text;BEGIN
   SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO pin FROM pg_proc p WHERE oid='read_native_turn_scope_evidence(uuid,jsonb)'::regprocedure;
   EXECUTE format('CREATE FUNCTION public.fictional_compact_pin_consumer() RETURNS text LANGUAGE sql AS %L','SELECT '||quote_literal(pin)||'::text');
  END $fixture$`)
  await expect(client.query(migration)).rejects.toThrow('native_compact_unauthenticated_pin_consumer')
 }),180_000)
 it('rejects coordinated helper, guard and manifest forgery',async()=>rollback(async client=>{
  await replaceBody(client,'native_turn_metadata_acquire(uuid,jsonb,jsonb)',"BEGIN RETURN '{}'::jsonb;END")
  await replaceBody(client,'native_turn_helpers_current()','SELECT true')
  await client.query(`UPDATE native_turn_contract_helpers h SET fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure(h.signature)`)
  await expect(client.query(migration)).rejects.toThrow('native_invalidation_canonical:')
 }),180_000)
 it.each(['cost','grant'] as const)('refuses altered predecessor executable %s metadata',async change=>rollback(async client=>{
  await client.query(change==='cost'?'ALTER FUNCTION native_turn_capture_requirements(uuid,jsonb,jsonb) COST 101':'GRANT EXECUTE ON FUNCTION native_turn_capture_requirements(uuid,jsonb,jsonb) TO app_user')
  await expect(client.query(migration)).rejects.toThrow('native_invalidation_canonical:')
 }),180_000)
 it('removes inherited application execution defaults from newly private helpers',async()=>rollback(async client=>{
  await client.query('ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO app_user')
  await client.query(migration)
  expect((await client.query(guards)).rows[0]).toEqual(healthy)
  expect((await client.query(`SELECT bool_and(NOT has_function_privilege('app_user',p.oid,'EXECUTE')) private FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND(${compact})`)).rows[0].private).toBe(true)
 }),180_000)
 it('refuses an unexpected inherited third-party execution grant',async()=>rollback(async client=>{
  const role=`compact_grantee_${randomUUID().replaceAll('-','')}`
  await client.query(`CREATE ROLE ${role};ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO ${role}`)
  await expect(client.query(migration)).rejects.toThrow('native_compact_authored_contract_changed')
 }),180_000)
 it('refuses a missing predecessor contract member',async()=>rollback(async client=>{
  await client.query("DELETE FROM native_turn_contract_helpers WHERE signature='native_turn_topology(jsonb,jsonb)'")
  await expect(client.query(migration)).rejects.toThrow(/native_/)
 }),180_000)
})
