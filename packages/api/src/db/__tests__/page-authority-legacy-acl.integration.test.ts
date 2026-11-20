/** [COMP:api/migration-owner-role] Exact known predecessor narrowing and
 * source-known successor no-op, never a target-catalog-derived replacement. */
import {createHash} from 'node:crypto'
import {afterAll,describe,expect,it} from 'vitest'
import type {PoolClient} from 'pg'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const {getPool,getAppPool,rollbackAndRelease}=await import('../client.js')
const {pageAuthorityLegacyAclSql,pageAuthorityLegacyPredecessorDeclaration}=await import(
 new URL('../../../scripts/conversation-store/page-authority-legacy-acl.mjs',import.meta.url).href)
const {pageAuthorityPredecessorSql}=await import(new URL('../../../scripts/conversation-store/page-closure.mjs',import.meta.url).href)
const candidate=pageAuthorityLegacyAclSql.replace(/^BEGIN;\s*/m,'').replace(/COMMIT;\s*$/,'')
console.log('page_authority_candidate_sha256='+createHash('sha256').update(pageAuthorityLegacyAclSql).digest('hex'))
afterAll(async()=>{await getAppPool().end();await getPool().end()})
const signature='public.read_page_event_authority(uuid,uuid,uuid)'
const snapshot=async(client:PoolClient)=>(await client.query(
 'SELECT to_jsonb(p) value FROM pg_proc p WHERE oid=$1::regprocedure',[signature])).rows[0].value
async function legacy(client:PoolClient){
 await client.query(pageAuthorityLegacyPredecessorDeclaration)
 // Reproduce the observed historical array order using ordinary GRANT/REVOKE,
 // without catalog writes or superuser execution of the candidate.
 await client.query(`GRANT EXECUTE ON FUNCTION ${signature} TO app_user;
  REVOKE EXECUTE ON FUNCTION ${signature} FROM CURRENT_USER;
  GRANT EXECUTE ON FUNCTION ${signature} TO CURRENT_USER`)
 expect((await client.query(`SELECT a.grantee::regrole::text grantee,a.grantor::regrole::text grantor,a.is_grantable grantable
  FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.oid=$1::regprocedure ORDER BY a.grantee`,[signature])).rows)
  .toHaveLength(2)
}
describe.sequential('[COMP:api/migration-owner-role] Page legacy ACL prerequisite',()=>{
 it('authenticates the installed source-known successor as a complete no-op',async()=>{
  const client=await getPool().connect()
  try{
   await client.query('BEGIN');const before=await snapshot(client)
   await client.query(candidate)
   expect(await snapshot(client)).toEqual(before)
   expect((await client.query('SELECT native_turn_helpers_current() AS current')).rows[0].current).toBe(true)
  }finally{await rollbackAndRelease(client)}
 })
 it('changes only the observed inherited EXECUTE addition and satisfies the unchanged8278 predecessor guard',async()=>{
  const client=await getPool().connect()
  try{
   await client.query('BEGIN');await legacy(client)
   console.log('page_registry_shape='+JSON.stringify((await client.query(`SELECT r.relname,r.relkind,r.relpersistence,r.relrowsecurity,r.relforcerowsecurity,r.relacl,
    (SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',a.atttypid::regtype::text,'collation',a.attcollation::regcollation::text,
     'notnull',a.attnotnull,'typmod',a.atttypmod,'default',a.atthasdef,'missing',a.atthasmissing,'identity',a.attidentity,'generated',a.attgenerated,
     'acl',a.attacl,'number',a.attnum) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=r.oid AND a.attnum>0) attributes,
    (SELECT jsonb_agg(to_jsonb(c)) FROM pg_constraint c WHERE c.conrelid=r.oid) constraints,
    (SELECT jsonb_agg(to_jsonb(i)) FROM pg_index i WHERE i.indrelid=r.oid) indexes
    FROM pg_class r WHERE r.oid=ANY(ARRAY['native_turn_contract_helpers'::regclass,'native_retained_contract_helpers'::regclass])`)).rows))
   const before=await snapshot(client)
   await expect(client.query(pageAuthorityPredecessorSql)).rejects.toMatchObject({message:'page_authority_predecessor_changed'})
   await client.query('ROLLBACK')
   await client.query('BEGIN');await legacy(client)
   await client.query(candidate)
   const after=await snapshot(client)
   expect({...after,proacl:before.proacl}).toEqual(before)
   expect(after.proacl).toEqual(['assurance_owner=X/assurance_owner'])
   await client.query(pageAuthorityPredecessorSql)
   await client.query(candidate);expect(await snapshot(client)).toEqual(after)
  }finally{await rollbackAndRelease(client)}
 })
 it.each([
  ['body',`CREATE OR REPLACE FUNCTION ${signature.replace('(uuid,uuid,uuid)','(w uuid,receipt_id uuid,actor uuid)')} RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$ BEGIN RETURN NULL; END $body$`],
  ['planner metadata',`ALTER FUNCTION ${signature} COST 101`],
  ['configuration',`ALTER FUNCTION ${signature} SET work_mem='8MB'`],
  ['execution boundary',`ALTER FUNCTION ${signature} SECURITY INVOKER`],
  ['PUBLIC execution',`GRANT EXECUTE ON FUNCTION ${signature} TO PUBLIC`],
  ['grant option',`GRANT EXECUTE ON FUNCTION ${signature} TO app_user WITH GRANT OPTION`],
  ['unknown principal',`GRANT EXECUTE ON FUNCTION ${signature} TO assurance_bootstrap`],
  ['registry FORCE',`ALTER TABLE native_turn_contract_helpers FORCE ROW LEVEL SECURITY`],
  ['registry reader',`CREATE POLICY fictional_page_registry_reader ON native_turn_contract_helpers FOR SELECT USING(false)`],
  ['registry ACL',`GRANT SELECT ON native_turn_contract_helpers TO app_user`],
 ] as const)('refuses %s atomically while retaining unknown drift',async(_name,change)=>{
  const client=await getPool().connect()
  try{
   await client.query('BEGIN');await legacy(client);await client.query(change)
   const before=await snapshot(client)
   await client.query('SAVEPOINT candidate')
   await expect(client.query(candidate)).rejects.toMatchObject({code:'P0001'})
   await client.query('ROLLBACK TO SAVEPOINT candidate')
   expect(await snapshot(client)).toEqual(before)
  }finally{await rollbackAndRelease(client)}
 })
 it('refuses an existing fingerprint consumer without executing its body or repairing the ACL',async()=>{
  const client=await getPool().connect()
  try{
   await client.query('BEGIN');await legacy(client)
   const before=await snapshot(client)
   const pin=(await client.query("SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') pin FROM pg_proc p WHERE oid=$1::regprocedure",[signature])).rows[0].pin
   const create=(await client.query("SELECT format('CREATE FUNCTION fictional_page_authority_pin() RETURNS text LANGUAGE sql AS %L','SELECT '||quote_literal($1)||'::text') AS sql",[pin])).rows[0].sql
   await client.query(create);await client.query('SAVEPOINT candidate')
   await expect(client.query(candidate)).rejects.toMatchObject({message:'legacy_page_authority_existing_pin'})
   await client.query('ROLLBACK TO SAVEPOINT candidate');expect(await snapshot(client)).toEqual(before)
  }finally{await rollbackAndRelease(client)}
 })
})
