import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import type {PoolClient} from 'pg'
import {afterAll,describe,expect,it} from 'vitest'
import {getAppPool,getPool} from '../../db/client.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const {nativePageCompletionRecoverySql}=await import(new URL('../../../scripts/migration-recovery.ts',import.meta.url).href)
const pool=getPool()
const migration=(await readFile(new URL('../../../migrations/8200_native_turn_page_completion.sql',import.meta.url),'utf8'))
 .replace(/^BEGIN;\n/m,'').replace(/\nCOMMIT;\s*$/,'')
const recovery=await nativePageCompletionRecoverySql()
const pageMigrationName='8200_native_turn_page_completion.sql'
const routineCatalog=`SELECT oid,md5(to_jsonb(p)::text) fingerprint FROM pg_proc p
 WHERE pronamespace='public'::regnamespace ORDER BY oid`
const boundary=process.env.BRIAN_NATIVE_PAGE_UPGRADE_BOUNDARY==='8199'
 ||(await pool.query("SELECT to_regprocedure('native_turn_page_event(jsonb)') IS NULL predecessor")).rows[0].predecessor===true
const guards=`SELECT native_turn_helpers_current() reader,native_turn_publication_contract() publication,
 application_native_worklist_helpers_current() worklist,application_native_dependency_batch_helpers_current() dependency,
 application_native_field_reference_helpers_current() reference,application_memory_statement_helpers_current() memory`
const healthy={reader:true,publication:true,worklist:true,dependency:true,reference:true,memory:true}
const diagnostics=['read_native_turn_requirements(uuid,jsonb)','read_native_turn_query_requirements(uuid,jsonb,jsonb)',
 'native_turn_discover_lock_requirements(uuid,jsonb,jsonb)','native_turn_capture_requirements(uuid,jsonb,jsonb)','native_turn_topology(jsonb,jsonb)']
const page="p.proname='native_turn_page_event'"
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
describe.sequential('[COMP:api/native-turn-frame] sealed Page delegation guard canary',()=>{
 it('keeps current authority guards and any installed Page helper private',async()=>{
  expect((await pool.query(guards)).rows[0]).toEqual(healthy)
  expect((await pool.query(`SELECT count(*)::integer exposed FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
   AND(${page}) AND has_function_privilege('app_user',p.oid,'EXECUTE')`)).rows[0].exposed).toBe(0)
 })
})
describe.skipIf(!boundary).sequential('[COMP:api/native-turn-frame] sealed Page delegation authentication (8200 upgrade profile)',()=>{
 it('authenticates the predecessor and preserves full diagnostic contracts',async()=>rollback(async client=>{
  const before=(await client.query('SELECT oid::regprocedure::text signature,to_jsonb(p) definition FROM pg_proc p WHERE oid=ANY($1::regprocedure[]) ORDER BY signature',[diagnostics])).rows
  await client.query(migration)
  expect((await client.query(guards)).rows[0]).toEqual(healthy)
  expect((await client.query('SELECT oid::regprocedure::text signature,to_jsonb(p) definition FROM pg_proc p WHERE oid=ANY($1::regprocedure[]) ORDER BY signature',[diagnostics])).rows).toEqual(before)
  expect((await client.query(`SELECT count(*)::integer count,bool_and(NOT has_function_privilege('app_user',p.oid,'EXECUTE')) private
   FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND(${page})`)).rows[0]).toEqual({count:1,private:true})
  expect((await client.query('SELECT count(*)::integer count FROM native_turn_contract_helpers')).rows[0].count).toBe(146)
 }),180_000)
 it('rejects a preexisting Page helper collision',async()=>rollback(async client=>{
  await client.query("CREATE FUNCTION native_turn_page_event(jsonb) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$")
  await expect(client.query(migration)).rejects.toThrow('native_page_predecessor_roster_changed')
 }),180_000)
 it('rejects an unknown static consumer of a Page validator pin',async()=>rollback(async client=>{
  await client.query(`DO $fixture$ DECLARE pin text;BEGIN
   SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO pin FROM pg_proc p WHERE oid='validate_page_derivation_dependencies()'::regprocedure;
   EXECUTE format('CREATE FUNCTION public.fictional_page_pin_consumer() RETURNS text LANGUAGE sql AS %L','SELECT '||quote_literal(pin)||'::text');
  END $fixture$`)
  await expect(client.query(migration)).rejects.toThrow('native_page_unauthenticated_pin_consumer')
 }),180_000)
 it('rejects coordinated helper, guard and manifest forgery',async()=>rollback(async client=>{
  await replaceBody(client,'native_turn_discover_lock_requirements(uuid,jsonb,jsonb)',"BEGIN RETURN '{}'::jsonb;END")
  await replaceBody(client,'native_turn_helpers_current()','SELECT true')
  await client.query(`UPDATE native_turn_contract_helpers h SET fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE p.oid=to_regprocedure(h.signature)`)
  await expect(client.query(migration)).rejects.toThrow('native_invalidation_canonical:')
 }),180_000)
 it.each(['cost','grant'] as const)('refuses altered predecessor executable %s metadata',async change=>rollback(async client=>{
  await client.query(change==='cost'?'ALTER FUNCTION validate_page_derivation_dependencies() COST 101':'GRANT EXECUTE ON FUNCTION validate_page_derivation_dependencies() TO app_user')
  await expect(client.query(migration)).rejects.toThrow('native_invalidation_canonical:')
 }),180_000)
 it('removes inherited application execution defaults from newly private helpers',async()=>rollback(async client=>{
  await client.query('ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO app_user')
  await client.query(migration)
  expect((await client.query(guards)).rows[0]).toEqual(healthy)
  expect((await client.query(`SELECT bool_and(NOT has_function_privilege('app_user',p.oid,'EXECUTE')) private FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND(${page})`)).rows[0].private).toBe(true)
 }),180_000)
 it('refuses an unexpected inherited third-party execution grant',async()=>rollback(async client=>{
  const role=`page_grantee_${randomUUID().replaceAll('-','')}`
  await client.query(`CREATE ROLE ${role};ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO ${role}`)
  await expect(client.query(migration)).rejects.toThrow('native_page_authored_contract_changed')
 }),180_000)
 it('refuses a missing predecessor contract member',async()=>rollback(async client=>{
  await client.query("DELETE FROM native_turn_contract_helpers WHERE signature='native_turn_topology(jsonb,jsonb)'")
  await expect(client.query(migration)).rejects.toThrow(/native_/)
 }),180_000)
})


describe.skipIf(!boundary).sequential('[COMP:api/migration-recovery] interrupted Page migration ledger recovery',()=>{
 it('leaves an authentic 8199 predecessor for the normal migration path',async()=>rollback(async client=>{
  const before=(await client.query(routineCatalog)).rows
  const ledger=(await client.query('SELECT * FROM public._migrations ORDER BY name')).rows
  expect((await client.query("SELECT to_regprocedure('public.native_turn_page_event(jsonb)') page")).rows[0].page).toBeNull()
  await client.query(recovery)
  expect((await client.query(routineCatalog)).rows).toEqual(before)
  expect((await client.query('SELECT * FROM public._migrations ORDER BY name')).rows).toEqual(ledger)
 }),180_000)
 it('authenticates committed Page DDL, repairs its missing ledger entry and becomes a no-op',async()=>rollback(async client=>{
  await client.query(migration)
  expect((await client.query('SELECT name FROM public._migrations WHERE name=$1',[pageMigrationName])).rowCount).toBe(0)
  const before=(await client.query(routineCatalog)).rows
  const manifest=(await client.query('SELECT * FROM native_turn_contract_helpers ORDER BY signature')).rows
  await client.query('SAVEPOINT replay')
  await expect(client.query(migration)).rejects.toThrow('Native turn predecessor roster template changed')
  await client.query('ROLLBACK TO SAVEPOINT replay')
  await client.query(recovery)
  const recorded=(await client.query('SELECT * FROM public._migrations WHERE name=$1',[pageMigrationName])).rows
  expect(recorded).toHaveLength(1)
  expect((await client.query(guards)).rows[0]).toEqual(healthy)
  expect((await client.query(routineCatalog)).rows).toEqual(before)
  expect((await client.query('SELECT * FROM native_turn_contract_helpers ORDER BY signature')).rows).toEqual(manifest)
  await client.query(recovery)
  expect((await client.query('SELECT * FROM public._migrations WHERE name=$1',[pageMigrationName])).rows).toEqual(recorded)
  expect((await client.query(routineCatalog)).rows).toEqual(before)
 }),180_000)
 it.each(['forged-body','cost','missing-member'] as const)('refuses to stamp an altered Page successor: %s',async change=>rollback(async client=>{
  await client.query(migration)
  if(change==='forged-body'){
   await replaceBody(client,'native_turn_page_event(jsonb)','BEGIN RETURN true;END')
   await replaceBody(client,'native_turn_helpers_current()','SELECT true')
   await client.query(`UPDATE native_turn_contract_helpers h SET fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
    FROM pg_proc p WHERE p.oid=to_regprocedure(h.signature)`)
  }else if(change==='cost'){
   await client.query('ALTER FUNCTION native_turn_page_event(jsonb) COST 101')
  }else{
   await client.query("DELETE FROM native_turn_contract_helpers WHERE signature='native_turn_page_event(jsonb)'")
  }
  await client.query('SAVEPOINT recovery_attempt')
  await expect(client.query(recovery)).rejects.toThrow(/native_/)
  await client.query('ROLLBACK TO SAVEPOINT recovery_attempt')
  expect((await client.query('SELECT name FROM public._migrations WHERE name=$1',[pageMigrationName])).rowCount).toBe(0)
 }),180_000)
 it('keeps the committed schema intact if recording the recovery fails',async()=>rollback(async client=>{
  await client.query(migration)
  const before=(await client.query(routineCatalog)).rows
  await client.query(`ALTER TABLE public._migrations ADD CONSTRAINT fictional_page_ledger_failure
   CHECK(name<>'8200_native_turn_page_completion.sql') NOT VALID`)
  await client.query('SAVEPOINT recovery_attempt')
  await expect(client.query(recovery)).rejects.toThrow('fictional_page_ledger_failure')
  await client.query('ROLLBACK TO SAVEPOINT recovery_attempt')
  expect((await client.query('SELECT name FROM public._migrations WHERE name=$1',[pageMigrationName])).rowCount).toBe(0)
  expect((await client.query(routineCatalog)).rows).toEqual(before)
  expect((await client.query(guards)).rows[0]).toEqual(healthy)
 }),180_000)
})
