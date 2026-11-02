import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import type {PoolClient} from 'pg'
import {afterAll,describe,expect,it} from 'vitest'
import {getAppPool,getPool} from '../../db/client.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
const migration=(await readFile(new URL('../../../migrations/8198_native_turn_graph_representation.sql',import.meta.url),'utf8'))
 .replace(/^BEGIN;\n/m,'').replace(/\nCOMMIT;\s*$/,'')
const predecessor=await readFile(new URL('../../../migrations/8183_native_turn_requirements.sql',import.meta.url),'utf8')
const start=predecessor.indexOf('CREATE OR REPLACE FUNCTION public.native_turn_topology(')
const bodyStart=predecessor.indexOf('AS $$',start)+5
const originalTopology=predecessor.slice(bodyStart,predecessor.indexOf('$$;',bodyStart))
const originalHash=createHash('sha256').update(originalTopology).digest('hex')
const boundary=process.env.BRIAN_NATIVE_GRAPH_UPGRADE_BOUNDARY==='8197'
 ||(await pool.query(`SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex')=$1 predecessor
  FROM pg_proc WHERE oid='native_turn_topology(jsonb,jsonb)'::regprocedure`,[originalHash])).rows[0]?.predecessor===true
const guards=`SELECT native_turn_helpers_current() reader,native_turn_publication_contract() publication,
 application_native_worklist_helpers_current() worklist,application_native_dependency_batch_helpers_current() dependency,
 application_native_field_reference_helpers_current() reference,application_memory_statement_helpers_current() memory`
const healthy={reader:true,publication:true,worklist:true,dependency:true,reference:true,memory:true}
const changed=['native_turn_metadata_acquire(uuid,jsonb,jsonb)','native_turn_capture_requirements(uuid,jsonb,jsonb)','native_turn_topology(jsonb,jsonb)'].sort()
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
describe.sequential('[COMP:api/native-turn-frame] graph compiler guard canary',()=>{
 it('keeps current authority guards and private graph helpers intact',async()=>{
  expect((await pool.query(guards)).rows[0]).toEqual(healthy)
  expect((await pool.query(`SELECT bool_and(NOT has_function_privilege('app_user',signature,'EXECUTE')) private
   FROM unnest($1::text[]) signature`,[changed])).rows[0].private).toBe(true)
 })
})
describe.skipIf(!boundary).sequential('[COMP:api/native-turn-frame] graph compiler authentication (8198 upgrade profile)',()=>{
 it('authenticates the canonical predecessor and changes only three graph bodies',async()=>rollback(async client=>{
  await client.query('CREATE TEMP TABLE graph_before AS SELECT oid,to_jsonb(p) definition FROM pg_proc p WHERE pronamespace=\'public\'::regnamespace')
  await client.query(migration)
  expect((await client.query(guards)).rows[0]).toEqual(healthy)
  const differences=(await client.query(`SELECT p.oid::regprocedure::text signature FROM graph_before b JOIN pg_proc p ON p.oid=b.oid
   WHERE to_jsonb(p) IS DISTINCT FROM b.definition ORDER BY signature`)).rows.map(row=>row.signature)
  expect(differences).toEqual(changed)
 }),180_000)
 it('rejects an unrecognized static consumer of a changed graph pin',async()=>rollback(async client=>{
  await client.query(`DO $fixture$ DECLARE pin text;BEGIN
   SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO pin FROM pg_proc p WHERE oid='native_turn_topology(jsonb,jsonb)'::regprocedure;
   EXECUTE format('CREATE FUNCTION public.fictional_graph_pin_consumer() RETURNS text LANGUAGE sql AS %L','SELECT '||quote_literal(pin)||'::text');
  END $fixture$`)
  await expect(client.query(migration)).rejects.toThrow('native_graph_unauthenticated_pin_consumer')
 }),180_000)
 it('rejects coordinated body, helper-guard and manifest replacement',async()=>rollback(async client=>{
  await replaceBody(client,'native_turn_topology(jsonb,jsonb)',"BEGIN RETURN '[]'::jsonb;END")
  await replaceBody(client,'native_turn_helpers_current()','SELECT true')
  await client.query(`UPDATE native_turn_contract_helpers h SET fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure(h.signature)`)
  expect((await client.query('SELECT native_turn_helpers_current() current')).rows[0].current).toBe(true)
  await expect(client.query(migration)).rejects.toThrow('native_invalidation_canonical:')
 }),180_000)
 it.each(['cost','grant'] as const)('refuses changed private executable %s metadata',async change=>rollback(async client=>{
  await client.query(change==='cost'?'ALTER FUNCTION native_turn_topology(jsonb,jsonb) COST 101':'GRANT EXECUTE ON FUNCTION native_turn_topology(jsonb,jsonb) TO app_user')
  await expect(client.query(migration)).rejects.toThrow('native_invalidation_canonical:')
 }),180_000)
 it('refuses a missing current graph helper manifest entry',async()=>rollback(async client=>{
  await client.query("DELETE FROM native_turn_contract_helpers WHERE signature='native_turn_topology(jsonb,jsonb)'")
  await expect(client.query(migration)).rejects.toThrow(/native_/)
 }),180_000)
})
