/** Disposable ordinary-owner baseline catalog inventory for M7 bypass retirement. */
import { writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import pg from 'pg'
import { expect, it } from 'vitest'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

it('inventories the exact installed settings, executable readers and forced actor relations', async () => {
 const startedAt = new Date().toISOString()
 const client = new pg.Client({connectionString:process.env.DATABASE_URL})
 await client.connect()
 try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const {rows:identity}=await client.query(`SELECT current_user='assurance_owner' AS ordinary_owner,rolsuper,rolbypassrls
   FROM pg_roles WHERE rolname=current_user`)
  expect(identity).toEqual([{ordinary_owner:true,rolsuper:false,rolbypassrls:false}])
  const bound = 'app.system_bypass'
  const {rows:policies}=await client.query(`SELECT n.nspname AS schema,c.relname AS relation,p.polname AS policy,
   p.polpermissive AS permissive,p.polcmd AS command,p.polroles AS roles,
   pg_get_expr(p.polqual,p.polrelid) AS qual,pg_get_expr(p.polwithcheck,p.polrelid) AS check_expression,
   c.relrowsecurity AS rls,c.relforcerowsecurity AS force
   FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE position($1 IN concat(pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)))>0
   ORDER BY schema,relation,policy`,[bound])
  const {rows:functions}=await client.query(`SELECT n.nspname AS schema,p.oid::regprocedure::text AS signature,
   encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body_sha256,p.prosrc AS body,pg_get_functiondef(p.oid) AS declaration,
   to_jsonb(p)-ARRAY['oid','prosrc','proowner','pronamespace','prolang','prorettype','proargtypes','proallargtypes','prosupport','protrftypes'] AS metadata,
   h.signature IS NOT NULL AS native_registry,r.signature IS NOT NULL AS retained_registry
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   LEFT JOIN native_turn_contract_helpers h ON h.signature=p.oid::regprocedure::text
   LEFT JOIN native_retained_contract_helpers r ON r.signature=p.oid::regprocedure::text
   WHERE n.nspname NOT IN('pg_catalog','information_schema') AND p.prokind IN('f','p','w')
    AND position($1 IN p.prosrc)>0 ORDER BY schema,signature`,[bound])
  const {rows:forced}=await client.query(`SELECT n.nspname AS schema,c.relname AS relation,pg_get_userbyid(c.relowner) AS owner,
   (SELECT jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd,'roles',p.polroles,
    'qual',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname)
    FROM pg_policy p WHERE p.polrelid=c.oid) AS policies
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relforcerowsecurity
   ORDER BY schema,relation`)
  const {rows:[ledger]}=await client.query('SELECT max(name) AS head,count(*)::int AS migrations FROM public._migrations')
  await client.query('COMMIT')
  const inventory={startedAt,completedAt:new Date().toISOString(),ledger,policies,functions,forced}
  const content=JSON.stringify(inventory,null,2)+'\n'
  await writeFile('/private/tmp/m7-bypass-catalog-8296.json',content,{mode:0o600})
  console.log(JSON.stringify({proof:'m7-bypass-catalog-inventory',ledger,count:{policies:policies.length,functions:functions.length,forced:forced.length},
   sha256:createHash('sha256').update(content).digest('hex')}))
 } finally {
  await client.end()
 }
})
