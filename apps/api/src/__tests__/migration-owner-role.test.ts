/**
 * Executed proof that the OSS migration chain runs as an ordinary owner role.
 *
 * The self-host recipe creates the migrating role with a plain `createuser`,
 * and a managed Postgres owner is not a superuser either. Every other replay
 * in this suite runs as the embedded superuser, which is why a superuser-only
 * statement can pass them all and still stop a deploy at that file.
 *
 * Spec: docs/architecture/platform/database-schema.md -> "A migration runs as
 * an ordinary owner role".
 *
 * [COMP:api/migration-owner-role]
 */

import { preparedIdentity, savePreparedPglite } from './prepared-pglite.js'
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { vector } from '@electric-sql/pglite-pgvector'
import assert from 'node:assert/strict'
import { describe, type TestContext } from 'node:test'
import { migrationOwnerTest as it } from './migration-owner-groups.js'
import { fileURLToPath } from 'node:url'
import { readFile, readdir } from 'node:fs/promises'
import { toPgliteMigrationSql } from '@use-brian/api/migrations/pglite-sql.js'
import { migratePglite, preparePgliteRuntimeRole } from '../migrate-pglite.js'

const migrationsDir = fileURLToPath(
  new URL('../../../../packages/api/migrations', import.meta.url),
)

const WORKSPACE_ID = '00000000-0000-4000-8000-0000000000f1'
const SKILL_ID = '00000000-0000-4000-8000-0000000000b1'
const DEPARTMENT = 'team:00000000-0000-4000-8000-0000000000d1'

/** A database provisioned the way the self-host recipe leaves it. */
async function openAsOwner(options: { appUser?: boolean; varyOids?: boolean; legacyDefaults?: boolean; prepareRuntime?: boolean } = {}): Promise<PGlite> {
  const db = new PGlite({ extensions: { vector, pg_trgm } })
  await db.waitReady
  if (options.varyOids) {
    const before = (await db.query(`SELECT 'public'::regnamespace::oid AS namespace,
      (SELECT oid FROM pg_language WHERE lanname='plpgsql') AS language`)).rows
    // Independent installations need not assign the same catalog OIDs.
    await db.exec(`ALTER SCHEMA public RENAME TO original_public;
      CREATE SCHEMA public; DROP SCHEMA original_public;
      DROP EXTENSION plpgsql; CREATE EXTENSION plpgsql;`)
    assert.notDeepEqual((await db.query(`SELECT 'public'::regnamespace::oid AS namespace,
      (SELECT oid FROM pg_language WHERE lanname='plpgsql') AS language`)).rows, before)
  }
  if (options.prepareRuntime) {
    await preparePgliteRuntimeRole(db)
  } else if (options.appUser) {
    await db.exec('CREATE ROLE app_user NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT')
  }
  await db.exec(`
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE ROLE migration_owner NOSUPERUSER NOBYPASSRLS;
    UPDATE pg_extension
       SET extowner = (SELECT oid FROM pg_authid WHERE rolname = 'migration_owner')
     WHERE extname = 'vector';
    ALTER SCHEMA public OWNER TO migration_owner;
    GRANT CREATE ON DATABASE postgres TO migration_owner;
    SET ROLE migration_owner;
  `)
  if (options.prepareRuntime) await preparePgliteRuntimeRole(db)
  if (options.legacyDefaults) {
    await db.exec(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO app_user;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO app_user;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO app_user;
    `)
  }
  return db
}

async function assertOrdinaryOwner(db: PGlite): Promise<void> {
  assert.deepEqual(
    (await db.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows,
    [{ rolsuper: false, rolbypassrls: false }],
  )
}

/** [COMP:api/native-chat-read-cost] Reuse the ordinary-owner full-chain fixture at8266. */
async function assertRetainedBootstrap(db:PGlite,t:TestContext):Promise<void>{
 const migration='8267_retained_native_graph.sql'
 const sql=toPgliteMigrationSql(await readFile(`${migrationsDir}/${migration}`,'utf8'),migration)
 const guard='public.native_turn_helpers_current()',publication='public.native_turn_publication_contract()'
 const definitions=(await db.query<{signature:string;definition:string;body:string}>(
  `SELECT p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition,p.prosrc body
   FROM pg_proc p WHERE p.oid=ANY($1::regprocedure[])`,[ [guard,publication] ])).rows
 const original=(name:string)=>definitions.find(row=>row.signature===name.replace('public.',''))!
 const roster=original(guard).body.match(/AND array_agg\(h.signature ORDER BY h.signature\)=(ARRAY\[[\s\S]*?\]::text\[\]) AND bool_and/)?.[1]
 assert.ok(roster)
 await db.exec(`CREATE SEQUENCE public.retained_bootstrap_probe;
  CREATE FUNCTION public.retained_bootstrap_marker() RETURNS boolean LANGUAGE plpgsql AS $probe$
   BEGIN PERFORM nextval('public.retained_bootstrap_probe');RETURN true;END$probe$;
  REVOKE ALL ON FUNCTION public.retained_bootstrap_marker() FROM PUBLIC,app_user`)
 const changedBody=(name:string,body:string)=>original(name).definition.replace(original(name).body,()=>body)
 const scenarios=[
  {name:'native guard code with the same149 members',sql:changedBody(guard,`SELECT public.retained_bootstrap_marker() AND (${original(guard).body})`)},
  {name:'missing native member',sql:changedBody(guard,original(guard).body.replace(roster,()=>roster.replace(/'[^']*',/,'')))},
  {name:'extra native member',sql:changedBody(guard,original(guard).body.replace(roster,()=>roster.replace(']::text[]',",'fictional_bootstrap_member()']::text[]")))},
  {name:'publication comparator code',sql:changedBody(publication,`SELECT public.retained_bootstrap_marker() AND (${original(publication).body})`)},
  {name:'executable metadata COST',sql:`ALTER FUNCTION ${guard} COST 101`},
  {name:'PUBLIC guard execution',sql:`GRANT EXECUTE ON FUNCTION ${guard} TO PUBLIC`},
  {name:'publication default',sql:'ALTER TABLE public.native_turn_publication_work ALTER COLUMN completion_ready SET DEFAULT true'},
  {name:'publication trigger',sql:'ALTER TABLE public.native_turn_frames DISABLE TRIGGER native_turn_frame_immutable'},
 ]
 try{
  for(const scenario of scenarios)await t.test(`refuses retained bootstrap ${scenario.name} before executing unknown code`,async()=>{
   await db.exec("SELECT setval('public.retained_bootstrap_probe',1,false);BEGIN")
   try{
    await db.exec(scenario.sql)
    const before=(await db.query("SELECT oid,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') fingerprint FROM pg_proc p WHERE pronamespace='public'::regnamespace ORDER BY oid")).rows
    await db.exec('SAVEPOINT retained_install_attempt')
    await assert.rejects(db.exec(sql),/retained_reader_predecessor_changed|native_annotation_publication_(contract|defaults|triggers)_changed/)
    await db.exec('ROLLBACK TO SAVEPOINT retained_install_attempt')
    assert.deepEqual((await db.query('SELECT is_called FROM public.retained_bootstrap_probe')).rows,[{is_called:false}])
    assert.deepEqual((await db.query("SELECT oid,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') fingerprint FROM pg_proc p WHERE pronamespace='public'::regnamespace ORDER BY oid")).rows,before)
    assert.deepEqual((await db.query(`SELECT to_regclass('public.native_retained_contract_helpers') registry,
     to_regprocedure('public.read_native_retained_session_query(uuid,uuid,integer,integer)') facade,
     EXISTS(SELECT 1 FROM _migrations WHERE name=$1) applied`,[migration])).rows,[{registry:null,facade:null,applied:false}])
    await assertOrdinaryOwner(db)
   }finally{await db.exec('ROLLBACK')}
  })
 }finally{await db.exec('DROP FUNCTION public.retained_bootstrap_marker();DROP SEQUENCE public.retained_bootstrap_probe')}
}

/** Qualify the inherited profile on the existing real shifted-OID upgrade fixture. */
async function assertPublicationLegacyAclUpgrade(db:PGlite,t:TestContext):Promise<void>{
 const migration='8272_durable_conversation_publications.sql'
 const candidate=toPgliteMigrationSql(await readFile(`${migrationsDir}/${migration}`,'utf8'),migration)
 const privateHelpers=['crm_install_erasure_capture()',
  'read_session_authority_facts(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean)']
 const publicHelpers=['file_session_binding_allows(uuid)','media_parent_visible(text,uuid)',
  'office_output_file_allows(uuid,boolean)','pdf_intake_file_visible(uuid)',
  'project_labels_allowed(jsonb,uuid,text[],boolean)','recording_transcript_file_allows(uuid)']
 const signatures=[...privateHelpers,...publicHelpers]
 const state=async()=>{
  const result:Record<string,unknown>={}
  const queries={
   functions:`SELECT to_jsonb(p) value FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname!~'^pg_(temp|toast)' ORDER BY p.oid`,
   policies:`SELECT to_jsonb(p) value FROM pg_policy p WHERE polrelid IN(SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace) ORDER BY oid`,
   relations:`SELECT to_jsonb(c) value FROM pg_class c WHERE relnamespace='public'::regnamespace AND relkind IN('r','p') ORDER BY oid`,
   constraints:`SELECT to_jsonb(c) value FROM pg_constraint c WHERE conrelid IN(SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace) ORDER BY oid`,
   triggers:`SELECT to_jsonb(c) value FROM pg_trigger c WHERE tgrelid IN(SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace) ORDER BY oid`,
   native:`SELECT to_jsonb(h) value FROM native_turn_contract_helpers h ORDER BY signature`,
   retained:`SELECT to_jsonb(h) value FROM native_retained_contract_helpers h ORDER BY signature`,
   defaults:`SELECT to_jsonb(d) value FROM pg_default_acl d ORDER BY oid`,
   ledger:`SELECT to_jsonb(m) value FROM _migrations m ORDER BY name`,
  }
  for(const [name,sql] of Object.entries(queries))result[name]=(await db.query(`SELECT encode(sha256(convert_to(coalesce(jsonb_agg(value)::text,'[]'),'UTF8')),'hex') digest FROM(${sql}) records`)).rows[0]
  return result
 }
 await assertOrdinaryOwner(db)
 const baseline=await state()
 const original=(await db.query<{signature:string;metadata:Record<string,unknown>}>(
  'SELECT p.oid::regprocedure::text signature,to_jsonb(p) metadata FROM pg_proc p WHERE oid=ANY($1::regprocedure[]) ORDER BY signature',[signatures])).rows
 const defaults=(await db.query('SELECT to_jsonb(d) value FROM pg_default_acl d ORDER BY oid')).rows
 const refused: Array<{name:string;sql:string;expected:RegExp;marker?:boolean;guardsCurrent?:boolean;snapshotAsBootstrap?:boolean}>=[]
 for(const signature of signatures){
  refused.push({name:`${signature} extra principal`,sql:`GRANT EXECUTE ON FUNCTION ${signature} TO legacy_privilege_probe`,expected:/publication_predecessor_changed/})
  refused.push({name:`${signature} grant option`,sql:`GRANT EXECUTE ON FUNCTION ${signature} TO app_user WITH GRANT OPTION`,expected:/publication_predecessor_changed/})
 }
 for(const signature of privateHelpers)refused.push({name:`${signature} PUBLIC execution`,sql:`GRANT EXECUTE ON FUNCTION ${signature} TO PUBLIC`,expected:/publication_predecessor_changed/})
 refused.push({name:'canonical PUBLIC grant missing',sql:'REVOKE EXECUTE ON FUNCTION file_session_binding_allows(uuid) FROM PUBLIC',expected:/publication_predecessor_changed/})
 for(const [name,sql] of [
  ['additional default principal','ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO legacy_privilege_probe'],
  ['PUBLIC schema default','ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC'],
  ['default grant option','ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO app_user WITH GRANT OPTION'],
  ['global default','ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO app_user'],
 ])refused.push({name,sql,expected:/publication_legacy_function_default_changed/})
 refused.push({name:'installer planner metadata',sql:'ALTER FUNCTION crm_install_erasure_capture() COST 101',expected:/publication_predecessor_changed/})
 refused.push({name:'constraint namespace differs from named public relation',sql:`RESET ROLE;
  UPDATE pg_constraint SET connamespace='pg_catalog'::regnamespace WHERE conrelid='public.native_turn_frames'::regclass AND conname='native_turn_frames_pkey';
  SET ROLE migration_owner`,expected:/publication_constraint_namespace_changed/})
 const guard=(await db.query<{body:string;definition:string}>("SELECT prosrc body,pg_get_functiondef(oid) definition FROM pg_proc WHERE oid='native_turn_helpers_current()'::regprocedure")).rows[0]
 refused.push({name:'unknown guard body is refused before execution',sql:`CREATE SEQUENCE public.publication_legacy_unknown_called;
  CREATE FUNCTION public.publication_legacy_unknown_marker() RETURNS boolean LANGUAGE plpgsql AS $marker$ BEGIN
   PERFORM nextval('public.publication_legacy_unknown_called');RETURN true;END $marker$;
  ${guard.definition.replace(guard.body,()=>`SELECT public.publication_legacy_unknown_marker() AND (${guard.body})`)}`,
  expected:/publication_predecessor_changed/,marker:true})
 const installerPin=(await db.query<{value:string}>("SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') value FROM pg_proc p WHERE oid='crm_install_erasure_capture()'::regprocedure")).rows[0].value
 refused.push({name:'unknown original fingerprint consumer',sql:`CREATE SCHEMA publication_legacy_unknown;
  CREATE FUNCTION publication_legacy_unknown.installer_pin() RETURNS text LANGUAGE sql AS $pin$ SELECT '${installerPin}'::text $pin$`,expected:/publication_unreviewed_pin_consumer: crm_install_erasure_capture/})
 const markerSql=`CREATE SEQUENCE public.publication_legacy_unknown_called;
  CREATE FUNCTION public.publication_legacy_unknown_marker() RETURNS boolean LANGUAGE plpgsql AS $marker$ BEGIN
   PERFORM nextval('public.publication_legacy_unknown_called');RETURN true;END $marker$;`
 const retained=(await db.query<{body:string;definition:string}>("SELECT prosrc body,pg_get_functiondef(oid) definition FROM pg_proc WHERE oid='native_retained_helpers_current()'::regprocedure")).rows[0]
 refused.push({name:'retained guard unknown body with coherent self fingerprint',sql:markerSql+
  retained.definition.replace(retained.body,()=>`SELECT public.publication_legacy_unknown_marker()`)+`;

  UPDATE native_retained_contract_helpers h SET fingerprint=(SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
   FROM pg_proc p WHERE p.oid='native_retained_helpers_current()'::regprocedure) WHERE h.signature='native_retained_helpers_current()'`,
  expected:/publication_retained_guard_changed/,marker:true})
 refused.push({name:'retained registry forced policy cannot execute before authentication',sql:markerSql+`
  ALTER TABLE native_retained_contract_helpers FORCE ROW LEVEL SECURITY;
  CREATE POLICY publication_unknown_policy ON native_retained_contract_helpers USING(public.publication_legacy_unknown_marker())`,
  expected:/publication_retained_registry_changed/,marker:true,snapshotAsBootstrap:true})
 refused.push({name:'retained registry has an unreviewed member',sql:`INSERT INTO native_retained_contract_helpers(signature,fingerprint)
  SELECT 'sensitivity_rank(text)',encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE p.oid='sensitivity_rank(text)'::regprocedure`,
  expected:/publication_retained_registry_changed/})
 for(const kind of ['grantee','grantor'] as const){
  // Corrupt only this synthetic fixture, including its stored local pin: a
  // display name OWNER must not masquerade as the actual function owner OID.
  const acl=kind==='grantee'?`ARRAY['=X/migration_owner','"OWNER"=X/migration_owner']::aclitem[]`
   :`ARRAY['=X/"OWNER"','migration_owner=X/migration_owner']::aclitem[]`
  refused.push({name:`quoted foreign OWNER ${kind} with coherent registry`,sql:`RESET ROLE;
   CREATE ROLE "OWNER" NOLOGIN NOSUPERUSER NOBYPASSRLS;
   UPDATE pg_proc SET proacl=${acl} WHERE oid='file_session_binding_allows(uuid)'::regprocedure;
   SET ROLE migration_owner;
   DO $fixture$ DECLARE actual pg_proc;BEGIN
    SELECT * INTO STRICT actual FROM pg_proc WHERE oid='file_session_binding_allows(uuid)'::regprocedure;
    UPDATE native_turn_contract_helpers SET contract=actual WHERE signature='file_session_binding_allows(uuid)';
   END $fixture$`,expected:/publication_predecessor_changed: file_session_binding_allows/,guardsCurrent:true})
 }
 for(const scenario of refused)await t.test(`refuses publication inherited profile ${scenario.name} atomically`,async()=>{
  await db.exec('BEGIN')
  try{
   // Only this synthetic corruption fixture uses bootstrap for the catalog
   // write above; authentication and every migration statement use the owner.
   await db.exec(scenario.sql);await assertOrdinaryOwner(db)
   if(scenario.guardsCurrent)assert.deepEqual((await db.query('SELECT native_turn_helpers_current() native,native_turn_publication_contract() publication,native_retained_helpers_current() retained')).rows,[{native:true,publication:true,retained:true}])
   if(scenario.snapshotAsBootstrap)await db.exec('RESET ROLE')
   const drifted=await state();await db.exec('SET ROLE migration_owner');await assertOrdinaryOwner(db)
   await db.exec('SAVEPOINT publication_inherited_attempt')
   await assert.rejects(db.exec(candidate),scenario.expected)
   await db.exec('ROLLBACK TO SAVEPOINT publication_inherited_attempt')
   if(scenario.snapshotAsBootstrap)await db.exec('RESET ROLE')
   assert.deepEqual(await state(),drifted)
   await db.exec('SET ROLE migration_owner')
   if(scenario.marker)assert.equal((await db.query<{is_called:boolean}>('SELECT is_called FROM public.publication_legacy_unknown_called')).rows[0]!.is_called,false)
  }finally{await db.exec('ROLLBACK')}
  assert.deepEqual(await state(),baseline)
 })
 await t.test('keeps all eight inherited alternatives after genuine post-8269 default cleanup',async()=>{
  const rollback=new Error('fixture_post8269_default_cleanup_rollback')
  await assert.rejects(db.transaction(async tx=>{
   await tx.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM app_user')
   assert.deepEqual((await tx.query('SELECT native_turn_helpers_current() native,native_turn_publication_contract() publication,native_retained_helpers_current() retained')).rows,[{native:true,publication:true,retained:true}])
   const cleanDefaults=(await tx.query('SELECT to_jsonb(d) value FROM pg_default_acl d ORDER BY oid')).rows
   await tx.exec(candidate)
   assert.deepEqual((await tx.query('SELECT to_jsonb(d) value FROM pg_default_acl d ORDER BY oid')).rows,cleanDefaults)
   assert.deepEqual((await tx.query('SELECT native_turn_helpers_current() native,native_turn_publication_contract() publication,native_retained_helpers_current() retained')).rows,[{native:true,publication:true,retained:true}])
   const redundant=(await tx.query(`SELECT count(*)::int count FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
    WHERE p.oid=ANY($1::regprocedure[]) AND a.grantee='app_user'::regrole`,[signatures])).rows[0]
   assert.deepEqual(redundant,{count:0})
   throw rollback
  }),error=>error===rollback)
  assert.deepEqual(await state(),baseline)
 })
 await t.test('rolls back inherited ACL repair if a private successor gains runtime access',async()=>{
  const marker='CREATE TEMP TABLE publication_source_functions('
  assert.equal(candidate.split(marker).length,2)
  const variant=candidate.replace(marker,`GRANT EXECUTE ON FUNCTION native_conversation_publication_scope(uuid,uuid) TO app_user;\n${marker}`)
  await assert.rejects(db.transaction(tx=>tx.exec(variant)),/publication_source_successor_changed/)
  assert.deepEqual(await state(),baseline)
 })
 assert.equal(await migratePglite(db,migrationsDir,{through:migration}),1)
 assert.equal(await migratePglite(db,migrationsDir,{through:migration}),0)
 assert.deepEqual((await db.query('SELECT to_jsonb(d) value FROM pg_default_acl d ORDER BY oid')).rows,defaults)
 const installed=(await db.query<{signature:string;metadata:Record<string,unknown>}>(
  'SELECT p.oid::regprocedure::text signature,to_jsonb(p) metadata FROM pg_proc p WHERE oid=ANY($1::regprocedure[]) ORDER BY signature',[signatures])).rows
 assert.equal(installed.length,8)
 for(const row of installed){
  const prior=original.find(item=>item.signature===row.signature)!
  assert.deepEqual({...row.metadata,proacl:prior.metadata.proacl},prior.metadata)
  const grants=(await db.query<{grantee:string;grantor:string;grantable:boolean}>(`SELECT CASE WHEN a.grantee=p.proowner THEN 'OWNER'
   WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END grantee,
   CASE WHEN a.grantor=p.proowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantor) END grantor,a.is_grantable grantable
   FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.oid=$1::regprocedure ORDER BY 1`,[row.signature])).rows
  assert.deepEqual(grants,[{grantee:'OWNER',grantor:'OWNER',grantable:false},
   ...(publicHelpers.includes(row.signature)?[{grantee:'PUBLIC',grantor:'OWNER',grantable:false}]:[])])
  assert.equal((await db.query<{allowed:boolean}>("SELECT has_function_privilege('app_user',$1::regprocedure,'EXECUTE') allowed",[row.signature])).rows[0].allowed,publicHelpers.includes(row.signature))
 }
 assert.deepEqual((await db.query('SELECT native_turn_helpers_current() native,native_turn_publication_contract() publication,native_retained_helpers_current() retained')).rows,[{native:true,publication:true,retained:true}])
}

async function assertMigrationSecurity(db: PGlite, forceSkillScopeRls: boolean): Promise<void> {
  assert.deepEqual(
    (await db.query(
      `SELECT tgrelid::regclass::text AS "table", tgname FROM pg_trigger
        WHERE NOT tgisinternal AND tgenabled <> 'O'`,
    )).rows,
    [],
  )
  assert.deepEqual(
    (await db.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.workspace_skill_scope_revisions'::regclass`,
    )).rows,
    [{ relrowsecurity: true, relforcerowsecurity: forceSkillScopeRls }],
  )
}

describe('[COMP:api/migration-owner-role] RLS checkpoint assertions', () => {
  it('tracks forced and owner-access checkpoints without weakening application-role RLS', async () => {
    const db = new PGlite()
    try {
      await db.waitReady
      await db.exec(`
        CREATE ROLE checkpoint_owner NOSUPERUSER NOBYPASSRLS;
        CREATE ROLE checkpoint_app NOSUPERUSER NOBYPASSRLS;
        CREATE TABLE public.workspace_skill_scope_revisions(id integer PRIMARY KEY);
        ALTER TABLE public.workspace_skill_scope_revisions OWNER TO checkpoint_owner;
        ALTER TABLE public.workspace_skill_scope_revisions ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.workspace_skill_scope_revisions FORCE ROW LEVEL SECURITY;
        GRANT SELECT ON public.workspace_skill_scope_revisions TO checkpoint_app;
        SET ROLE checkpoint_owner;
      `)
      await assertOrdinaryOwner(db)
      await assertMigrationSecurity(db, true)
      await assert.rejects(assertMigrationSecurity(db, false), assert.AssertionError)
      await assert.rejects(db.exec('INSERT INTO public.workspace_skill_scope_revisions VALUES(1)'), /row-level security/)

      await db.exec(await readFile(`${migrationsDir}/82200_skill_scope_owner_access.sql`, 'utf8'))
      await assertOrdinaryOwner(db)
      await assertMigrationSecurity(db, false)
      await assert.rejects(assertMigrationSecurity(db, true), assert.AssertionError)
      await db.exec('INSERT INTO public.workspace_skill_scope_revisions VALUES(1)')
      assert.deepEqual((await db.query('SELECT id FROM public.workspace_skill_scope_revisions')).rows, [{ id: 1 }])
      await db.exec('RESET ROLE; SET ROLE checkpoint_app')
      assert.deepEqual((await db.query('SELECT id FROM public.workspace_skill_scope_revisions')).rows, [])

      await db.exec('RESET ROLE; SET ROLE checkpoint_owner; ALTER TABLE public.workspace_skill_scope_revisions DISABLE ROW LEVEL SECURITY')
      await assert.rejects(assertMigrationSecurity(db, false), assert.AssertionError)
    } finally {
      await db.close()
    }
  })
})

describe('[COMP:api/migration-owner-role] Migrations run as an ordinary owner role', () => {
  it('preserves application RLS when the skill receipt owner-access repair removes FORCE', async () => {
    const db = await openAsOwner({ appUser: true })
    try {
      await db.exec(`
        CREATE TABLE public.workspace_skill_scope_revisions(id integer PRIMARY KEY);
        INSERT INTO public.workspace_skill_scope_revisions VALUES(1),(2);
        ALTER TABLE public.workspace_skill_scope_revisions ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.workspace_skill_scope_revisions FORCE ROW LEVEL SECURITY;
        CREATE POLICY receipt_read ON public.workspace_skill_scope_revisions
          FOR SELECT TO app_user USING(id=1);
        GRANT SELECT,INSERT,UPDATE,DELETE ON public.workspace_skill_scope_revisions TO app_user;
      `)
      await assertOrdinaryOwner(db)
      await assertMigrationSecurity(db, true)
      const repair = await readFile(`${migrationsDir}/82200_skill_scope_owner_access.sql`, 'utf8')
      await db.exec(repair)
      await assertMigrationSecurity(db, false)
      assert.deepEqual((await db.query('SELECT id FROM workspace_skill_scope_revisions ORDER BY id')).rows,
        [{ id: 1 }, { id: 2 }])
      await db.exec('INSERT INTO workspace_skill_scope_revisions VALUES(3); SET ROLE app_user')
      await assertOrdinaryOwner(db)
      assert.deepEqual((await db.query('SELECT id FROM workspace_skill_scope_revisions ORDER BY id')).rows,
        [{ id: 1 }])
      await assert.rejects(db.exec('INSERT INTO workspace_skill_scope_revisions VALUES(4)'),
        (error: Error & { code?: string }) => error.code === '42501')
      assert.deepEqual((await db.query('UPDATE workspace_skill_scope_revisions SET id=5 RETURNING id')).rows, [])
      await db.exec('SET ROLE migration_owner')
      await db.exec(repair)
      await assertMigrationSecurity(db, false)
      assert.deepEqual((await db.query('SELECT id FROM workspace_skill_scope_revisions ORDER BY id')).rows,
        [{ id: 1 }, { id: 2 }, { id: 3 }])
    } finally {
      await db.close()
    }
  })

  it('repairs historical function defaults atomically and replays the complete upgrade', async (t) => {
    const db = await openAsOwner({ appUser: true, varyOids: true, legacyDefaults: true })
    const migration = '81110_legacy_function_execute_privileges.sql'
    const cohort = 'public.read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)'
    const extra = 'public.application_session_eval_point_state(uuid,text,uuid,text[],jsonb)'
    const facade = 'public.read_admitted_native_scope_snapshot(uuid,text,uuid)'
    const sql = toPgliteMigrationSql(await readFile(`${migrationsDir}/${migration}`, 'utf8'), migration)
    const snapshots = async () => ({
      functions: (await db.query<{ metadata: Record<string, unknown> }>(`SELECT to_jsonb(p) AS metadata FROM pg_proc p
        WHERE pronamespace='public'::regnamespace ORDER BY oid`)).rows,
      defaults: (await db.query('SELECT to_jsonb(d) AS metadata FROM pg_default_acl d ORDER BY oid')).rows,
      ledger: (await db.query('SELECT * FROM _migrations ORDER BY name')).rows,
    })
    try {
      await migratePglite(db, migrationsDir, { through: '8110_canonical_task_author_delete.sql' })
      await assertOrdinaryOwner(db)
      assert.deepEqual((await db.query(`SELECT has_function_privilege('app_user',$1::regprocedure,'EXECUTE') AS legacy`, [cohort])).rows, [{ legacy: true }])
      await db.exec('RESET ROLE; CREATE ROLE legacy_privilege_probe NOLOGIN; SET ROLE migration_owner')
      const definition = (await db.query<{ definition: string }>('SELECT pg_get_functiondef($1::regprocedure) AS definition', [cohort])).rows[0].definition
      const cases = [
        { name: 'unknown body', change: definition.replace('$function$', '$function$\n-- Fictional unknown body\n'), restore: definition },
        { name: 'unknown execution setting', change: `ALTER FUNCTION ${cohort} STABLE`, restore: `ALTER FUNCTION ${cohort} VOLATILE` },
        { name: 'unknown principal', change: `GRANT EXECUTE ON FUNCTION ${cohort} TO legacy_privilege_probe`, restore: `REVOKE ALL ON FUNCTION ${cohort} FROM legacy_privilege_probe` },
        { name: 'runtime grant option', change: `GRANT EXECUTE ON FUNCTION ${cohort} TO app_user WITH GRANT OPTION`, restore: `REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION ${cohort} FROM app_user` },
        { name: 'empty late helper ACL', change: `REVOKE ALL ON FUNCTION ${extra} FROM migration_owner,app_user`, restore: `GRANT EXECUTE ON FUNCTION ${extra} TO migration_owner,app_user` },
        { name: 'late helper metadata', change: `ALTER FUNCTION ${extra} COST 101`, restore: `ALTER FUNCTION ${extra} COST 100` },
        { name: 'additional default principal', change: 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO legacy_privilege_probe', restore: 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM legacy_privilege_probe' },
        { name: 'global default grant', change: 'ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO app_user', restore: 'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM app_user' },
      ]
      for (const scenario of cases) {
        await t.test(`refuses ${scenario.name} without partial repair`, async () => {
          try {
            await db.exec(scenario.change)
            const before = await snapshots()
            await assert.rejects(migratePglite(db, migrationsDir, { through: migration }), /Legacy function (prerequisite|default privileges) changed/)
            assert.deepEqual(await snapshots(), before)
          } finally {
            await db.exec(scenario.restore)
          }
        })
      }
      const retainedDefaults = (await db.query(`SELECT to_jsonb(d) AS metadata FROM pg_default_acl d WHERE defaclobjtype<>'f' ORDER BY oid`)).rows
      const beforeRepair = (await db.query(`SELECT oid,to_jsonb(p)-'proacl' AS metadata FROM pg_proc p
        WHERE pronamespace='public'::regnamespace ORDER BY oid`)).rows
      assert.equal(await migratePglite(db, migrationsDir, { through: migration }), 1)
      assert.deepEqual((await db.query(`SELECT oid,to_jsonb(p)-'proacl' AS metadata FROM pg_proc p
        WHERE pronamespace='public'::regnamespace ORDER BY oid`)).rows, beforeRepair)
      assert.deepEqual((await db.query(`SELECT has_function_privilege('app_user',$1::regprocedure,'EXECUTE') AS private,
        has_function_privilege('app_user',$2::regprocedure,'EXECUTE') AS facade,
        has_function_privilege('app_user',$3::regprocedure,'EXECUTE') AS later_private`, [cohort, facade, extra])).rows,
      [{ private: false, facade: true, later_private: false }])
      assert.deepEqual((await db.query(`SELECT to_jsonb(d) AS metadata FROM pg_default_acl d WHERE defaclobjtype<>'f' ORDER BY oid`)).rows, retainedDefaults)
      assert.equal(await migratePglite(db, migrationsDir, { through: migration }), 0)
      const captureRepair = '81560_legacy_native_function_privileges.sql'
      const capture = 'public.capture_native_session_projection_batch(uuid,uuid,integer,text)'
      const captureSql = toPgliteMigrationSql(await readFile(`${migrationsDir}/${captureRepair}`, 'utf8'), captureRepair)
      const ordered = (await readdir(migrationsDir)).filter(name => name.endsWith('.sql')).sort()
      assert.equal(ordered[ordered.indexOf(captureRepair) - 1], '8155_native_validation_query_plans.sql')
      assert.equal(ordered[ordered.indexOf(captureRepair) + 1], '8156_native_file_capture_frame.sql')
      await migratePglite(db, migrationsDir, { through: '8155_native_validation_query_plans.sql' })
      assert.deepEqual((await db.query(`SELECT has_function_privilege('app_user',$1::regprocedure,'EXECUTE') AS legacy`, [capture])).rows, [{ legacy: true }])
      const captureDefinition = (await db.query<{ definition: string }>('SELECT pg_get_functiondef($1::regprocedure) AS definition', [capture])).rows[0].definition
      const captureCases = [
        { name: 'body', change: captureDefinition.replace('$function$', '$function$\n-- Fictional capture drift\n'), restore: captureDefinition },
        { name: 'execution property', change: `ALTER FUNCTION ${capture} COST 101`, restore: `ALTER FUNCTION ${capture} COST 100` },
        { name: 'unknown principal', change: `GRANT EXECUTE ON FUNCTION ${capture} TO legacy_privilege_probe`, restore: `REVOKE ALL ON FUNCTION ${capture} FROM legacy_privilege_probe` },
        { name: 'PUBLIC access', change: `GRANT EXECUTE ON FUNCTION ${capture} TO PUBLIC`, restore: `REVOKE ALL ON FUNCTION ${capture} FROM PUBLIC` },
        { name: 'grant option', change: `GRANT EXECUTE ON FUNCTION ${capture} TO app_user WITH GRANT OPTION`, restore: `REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION ${capture} FROM app_user` },
        { name: 'later helper execution property', change: 'ALTER FUNCTION public.application_current_field_snapshot(uuid,uuid) COST 101', restore: 'ALTER FUNCTION public.application_current_field_snapshot(uuid,uuid) COST 100' },
        { name: 'missing owner grant', change: `REVOKE ALL ON FUNCTION ${capture} FROM migration_owner`, restore: `GRANT EXECUTE ON FUNCTION ${capture} TO migration_owner` },
      ]
      for (const scenario of captureCases) {
        await t.test(`refuses capture ${scenario.name} atomically`, async () => {
          try {
            await db.exec(scenario.change)
            const before = await snapshots()
            await assert.rejects(migratePglite(db, migrationsDir, { through: captureRepair }), /Legacy native function prerequisite changed/)
            assert.deepEqual(await snapshots(), before)
          } finally { await db.exec(scenario.restore) }
        })
      }
      const beforeCaptureRepair = (await db.query(`SELECT oid,to_jsonb(p)-'proacl' AS metadata FROM pg_proc p
        WHERE pronamespace='public'::regnamespace ORDER BY oid`)).rows
      assert.equal(await migratePglite(db, migrationsDir, { through: captureRepair }), 1)
      assert.deepEqual((await db.query(`SELECT oid,to_jsonb(p)-'proacl' AS metadata FROM pg_proc p
        WHERE pronamespace='public'::regnamespace ORDER BY oid`)).rows, beforeCaptureRepair)
      assert.deepEqual((await db.query(`SELECT has_function_privilege('app_user',$1::regprocedure,'EXECUTE') AS exposed`, [capture])).rows, [{ exposed: false }])
      const repaired = await snapshots()
      await db.transaction(async tx => { await tx.exec(captureSql) })
      assert.deepEqual(await snapshots(), repaired)
      await migratePglite(db, migrationsDir, { through: '8156_native_file_capture_frame.sql' })
      const partial = await snapshots()
      await db.transaction(async tx => { await tx.exec(captureSql) })
      assert.deepEqual(await snapshots(), partial)
      const queryRepair = '81660_legacy_native_query_privileges.sql'
      const queryHelper = 'public.application_session_field_keys(text)'
      const materializer = 'public.application_materialize_field_envelope(uuid,jsonb,integer)'
      const querySql = toPgliteMigrationSql(await readFile(`${migrationsDir}/${queryRepair}`, 'utf8'), queryRepair)
      assert.equal(ordered[ordered.indexOf(queryRepair) - 1], '8165_native_personal_title_acquisition.sql')
      assert.equal(ordered[ordered.indexOf(queryRepair) + 1], '8166_native_session_query_acquisition.sql')
      await migratePglite(db, migrationsDir, { through: '8165_native_personal_title_acquisition.sql' })
      const queryHelpers = [queryHelper, 'public.application_session_query_bounds(uuid,jsonb)', materializer,
        'public.application_session_query_scan(uuid,uuid,text,integer,text[],jsonb,jsonb)',
        'public.read_native_application_session_projection(uuid,uuid,integer,text)']
      for (const helper of queryHelpers) assert.equal((await db.query<{ exposed: boolean }>(
        "SELECT has_function_privilege('app_user',$1::regprocedure,'EXECUTE') AS exposed", [helper])).rows[0].exposed, true)
      const queryDefinition = (await db.query<{ definition: string }>('SELECT pg_get_functiondef($1::regprocedure) AS definition', [queryHelper])).rows[0].definition
      const materializerDefinition = (await db.query<{ definition: string }>('SELECT pg_get_functiondef($1::regprocedure) AS definition', [materializer])).rows[0].definition
      const changedDefault = materializerDefinition.replace('DEFAULT 0', 'DEFAULT 1')
      assert.notEqual(changedDefault, materializerDefinition)
      const queryCases = [
        { name: 'body', change: queryDefinition.replace('$function$', '$function$\n-- Fictional query drift\n'), restore: queryDefinition },
        { name: 'unknown principal', change: `GRANT EXECUTE ON FUNCTION ${queryHelper} TO legacy_privilege_probe`, restore: `REVOKE ALL ON FUNCTION ${queryHelper} FROM legacy_privilege_probe` },
        { name: 'PUBLIC access', change: `GRANT EXECUTE ON FUNCTION ${queryHelper} TO PUBLIC`, restore: `REVOKE ALL ON FUNCTION ${queryHelper} FROM PUBLIC` },
        { name: 'grant option', change: `GRANT EXECUTE ON FUNCTION ${queryHelper} TO app_user WITH GRANT OPTION`, restore: `REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION ${queryHelper} FROM app_user` },
        { name: 'later helper cost', change: `ALTER FUNCTION ${materializer} COST 101`, restore: `ALTER FUNCTION ${materializer} COST 100` },
        { name: 'different integer default', change: changedDefault, restore: materializerDefinition },
      ]
      for (const scenario of queryCases) await t.test(`refuses query ${scenario.name} atomically`, async () => {
        try {
          await db.exec(scenario.change)
          const before = await snapshots()
          await assert.rejects(migratePglite(db, migrationsDir, { through: queryRepair }), /Legacy native query prerequisite changed/)
          assert.deepEqual(await snapshots(), before)
        } finally { await db.exec(scenario.restore) }
      })
      const beforeQueryRepair = (await db.query(`SELECT oid,to_jsonb(p)-'proacl' AS metadata FROM pg_proc p
        WHERE pronamespace='public'::regnamespace ORDER BY oid`)).rows
      assert.equal(await migratePglite(db, migrationsDir, { through: queryRepair }), 1)
      assert.deepEqual((await db.query(`SELECT oid,to_jsonb(p)-'proacl' AS metadata FROM pg_proc p
        WHERE pronamespace='public'::regnamespace ORDER BY oid`)).rows, beforeQueryRepair)
      for (const helper of queryHelpers) assert.equal((await db.query<{ exposed: boolean }>(
        "SELECT has_function_privilege('app_user',$1::regprocedure,'EXECUTE') AS exposed", [helper])).rows[0].exposed, false)
      const queryRepaired = await snapshots()
      await db.transaction(async tx => { await tx.exec(querySql) })
      assert.deepEqual(await snapshots(), queryRepaired)
      const scopeRepair = '81690_legacy_native_scope_privileges.sql'
      const scopeHelper = 'public.application_session_eval_scope_current(uuid,text,uuid,text,jsonb)'
      const scopeSql = toPgliteMigrationSql(await readFile(`${migrationsDir}/${scopeRepair}`, 'utf8'), scopeRepair)
      assert.equal(ordered[ordered.indexOf(scopeRepair) - 1], '8168_native_source_edge_dispatch.sql')
      assert.equal(ordered[ordered.indexOf(scopeRepair) + 1], '8169_native_covered_helper_manifest.sql')
      await migratePglite(db, migrationsDir, { through: '8168_native_source_edge_dispatch.sql' })
      assert.deepEqual((await db.query(`SELECT has_function_privilege('app_user',$1::regprocedure,'EXECUTE') AS legacy`, [scopeHelper])).rows, [{ legacy: true }])
      const scopeDefinition = (await db.query<{ definition: string }>('SELECT pg_get_functiondef($1::regprocedure) AS definition', [scopeHelper])).rows[0].definition
      const scopeDefault = scopeDefinition.replace('memo jsonb)', "memo jsonb DEFAULT '{}'::jsonb)")
      assert.notEqual(scopeDefault, scopeDefinition)
      const scopeCases = [
        { name: 'body', change: scopeDefinition.replace('$function$', '$function$\n-- Fictional scope drift\n'), restore: scopeDefinition },
        { name: 'cost', change: `ALTER FUNCTION ${scopeHelper} COST 101`, restore: `ALTER FUNCTION ${scopeHelper} COST 100` },
        { name: 'configuration', change: `ALTER FUNCTION ${scopeHelper} SET work_mem='8MB'`, restore: `ALTER FUNCTION ${scopeHelper} RESET work_mem` },
        { name: 'owner', change: `RESET ROLE; ALTER FUNCTION ${scopeHelper} OWNER TO legacy_privilege_probe; SET ROLE migration_owner`, restore: `RESET ROLE; ALTER FUNCTION ${scopeHelper} OWNER TO migration_owner; SET ROLE migration_owner` },
        { name: 'unknown principal', change: `GRANT EXECUTE ON FUNCTION ${scopeHelper} TO legacy_privilege_probe`, restore: `REVOKE ALL ON FUNCTION ${scopeHelper} FROM legacy_privilege_probe` },
        { name: 'PUBLIC access', change: `GRANT EXECUTE ON FUNCTION ${scopeHelper} TO PUBLIC`, restore: `REVOKE ALL ON FUNCTION ${scopeHelper} FROM PUBLIC` },
        { name: 'grant option', change: `GRANT EXECUTE ON FUNCTION ${scopeHelper} TO app_user WITH GRANT OPTION`, restore: `REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION ${scopeHelper} FROM app_user` },
        { name: 'missing owner grant', change: `REVOKE ALL ON FUNCTION ${scopeHelper} FROM migration_owner`, restore: `GRANT EXECUTE ON FUNCTION ${scopeHelper} TO migration_owner` },
      ]
      for (const scenario of scopeCases) await t.test(`refuses scope ${scenario.name} atomically`, async () => {
        try {
          await db.exec(scenario.change)
          const before = await snapshots()
          await assert.rejects(migratePglite(db, migrationsDir, { through: scopeRepair }), /Legacy native scope prerequisite changed/)
          assert.deepEqual(await snapshots(), before)
        } finally { await db.exec(scenario.restore) }
      })
      await t.test('refuses an added scope argument default atomically', async () => {
        const changed = await openAsOwner({ appUser: true })
        try {
          await changed.exec('CREATE TABLE memories(id uuid); CREATE TABLE _migrations(name text PRIMARY KEY)')
          await changed.exec(scopeDefault)
          await changed.exec(`REVOKE ALL ON FUNCTION ${scopeHelper} FROM PUBLIC; GRANT EXECUTE ON FUNCTION ${scopeHelper} TO app_user`)
          const before = (await changed.query('SELECT to_jsonb(p) metadata FROM pg_proc p WHERE oid=$1::regprocedure', [scopeHelper])).rows
          const repairBody = scopeSql.replace(/^BEGIN;\s*/m, '').replace(/COMMIT;\s*$/, '')
          await assert.rejects(changed.transaction(tx => tx.exec(repairBody)), /Legacy native scope prerequisite changed/)
          assert.deepEqual((await changed.query('SELECT to_jsonb(p) metadata FROM pg_proc p WHERE oid=$1::regprocedure', [scopeHelper])).rows, before)
        } finally { await changed.close() }
      })
      await t.test('accepts the exact private scope helper when app_user is absent', async () => {
        const absent = await openAsOwner()
        try {
          await absent.exec('CREATE TABLE memories(id uuid); CREATE TABLE _migrations(name text PRIMARY KEY)')
          await absent.exec(scopeDefinition)
          await absent.exec(`REVOKE ALL ON FUNCTION ${scopeHelper} FROM PUBLIC`)
          const before = (await absent.query('SELECT to_jsonb(p) metadata FROM pg_proc p WHERE oid=$1::regprocedure', [scopeHelper])).rows
          await absent.exec(scopeSql)
          assert.deepEqual((await absent.query('SELECT to_jsonb(p) metadata FROM pg_proc p WHERE oid=$1::regprocedure', [scopeHelper])).rows, before)
          await assertOrdinaryOwner(absent)
        } finally { await absent.close() }
      })
      const beforeScopeRepair = await snapshots()
      assert.equal(await migratePglite(db, migrationsDir, { through: scopeRepair }), 1)
      const afterScopeRepair = await snapshots()
      const scopeOid = (await db.query<{ oid: number }>('SELECT $1::regprocedure::oid oid', [scopeHelper])).rows[0].oid
      // Exactly one ACL may change; all other full catalog rows and defaults
      // remain byte-identical, including already installed guard fingerprints.
      const withoutScopeAcl = (rows: typeof beforeScopeRepair.functions) => rows.map(row => {
        const metadata = { ...(row.metadata as Record<string, unknown>) }
        if (Number(metadata.oid) === Number(scopeOid)) delete metadata.proacl
        return metadata
      })
      assert.deepEqual(withoutScopeAcl(afterScopeRepair.functions), withoutScopeAcl(beforeScopeRepair.functions))
      assert.deepEqual(afterScopeRepair.defaults, beforeScopeRepair.defaults)
      assert.deepEqual((await db.query(`SELECT has_function_privilege('app_user',$1::regprocedure,'EXECUTE') AS exposed`, [scopeHelper])).rows, [{ exposed: false }])
      await db.exec(scopeSql)
      assert.deepEqual(await snapshots(), afterScopeRepair)
      await migratePglite(db, migrationsDir, { through: '8184_native_query_policy_compilation.sql' })
      const publicationMigration='8188_native_turn_shared_publication.sql'
      const publicationSql=toPgliteMigrationSql(await readFile(`${migrationsDir}/${publicationMigration}`,'utf8'),publicationMigration)
        .replace(/^BEGIN;\s*/m,'').replace(/COMMIT;\s*$/,'')
      const mutationHelper='public.agent_mutation_scope_allows(text[])'
      const mutationBefore=(await db.query<{raw:Record<string,unknown>;definition:string;fingerprint:string}>(
        `SELECT to_jsonb(p) raw,pg_get_functiondef(oid) definition,
         encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') fingerprint FROM pg_proc p WHERE oid=$1::regprocedure`,[mutationHelper])).rows[0]
      assert.deepEqual((await db.query(`SELECT a.grantee::regrole::text grantee,a.grantor::regrole::text grantor,a.is_grantable
        FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
        WHERE p.oid=$1::regprocedure AND a.grantee='app_user'::regrole`,[mutationHelper])).rows,
      [{grantee:'app_user',grantor:'migration_owner',is_grantable:false}])
      const privateMutationHelpers=['session_context_payload_shape(text,jsonb)','validate_session_context_revision_pair()']
      const privateMutationBefore=(await db.query<{signature:string;raw:Record<string,unknown>}>(
        'SELECT oid::regprocedure::text signature,to_jsonb(p) raw FROM pg_proc p WHERE oid=ANY($1::regprocedure[]) ORDER BY signature',
        [privateMutationHelpers])).rows
      assert.equal(privateMutationBefore.length,2)
      assert.deepEqual((await db.query(`SELECT bool_and(has_function_privilege('app_user',signature,'EXECUTE')) inherited
        FROM unnest($1::text[]) signature`,[privateMutationHelpers])).rows,[{inherited:true}])
      const mutationCases=[
        {name:'body',change:mutationBefore.definition.replace('$function$','$function$\n-- Fictional mutation helper drift\n')},
        {name:'metadata',change:`ALTER FUNCTION ${mutationHelper} COST 101`},
        {name:'grant option',change:`GRANT EXECUTE ON FUNCTION ${mutationHelper} TO app_user WITH GRANT OPTION`},
        {name:'unknown principal',change:`GRANT EXECUTE ON FUNCTION ${mutationHelper} TO legacy_privilege_probe`},
        {name:'foreign grantor',change:`RESET ROLE; UPDATE pg_proc SET proacl=ARRAY[
          'migration_owner=X/migration_owner','=X/migration_owner','app_user=X/legacy_privilege_probe']::aclitem[]
          WHERE oid='${mutationHelper}'::regprocedure; SET ROLE migration_owner`},
        {name:'missing PUBLIC grant',change:`REVOKE EXECUTE ON FUNCTION ${mutationHelper} FROM PUBLIC`},
        {name:'existing fingerprint consumer',change:`CREATE FUNCTION fictional_mutation_pin() RETURNS text LANGUAGE sql AS
          'SELECT ''${mutationBefore.fingerprint}''::text'`},
        {name:'existing manifest entry',change:`INSERT INTO native_turn_contract_helpers(signature,fingerprint)
          VALUES('agent_mutation_scope_allows(text[])','${mutationBefore.fingerprint}')`},
        {name:'qualified manifest entry',change:`INSERT INTO native_turn_contract_helpers(signature,fingerprint)
          VALUES('public.agent_mutation_scope_allows(text[])','${mutationBefore.fingerprint}')`},
        ...privateMutationHelpers.flatMap(signature=>[
          {name:`private ${signature} PUBLIC grant`,change:`GRANT EXECUTE ON FUNCTION ${signature} TO PUBLIC`},
          {name:`private ${signature} unknown principal`,change:`GRANT EXECUTE ON FUNCTION ${signature} TO legacy_privilege_probe`},
          {name:`private ${signature} grant option`,change:`GRANT EXECUTE ON FUNCTION ${signature} TO app_user WITH GRANT OPTION`},
          {name:`private ${signature} existing fingerprint consumer`,change:`DO $fixture$ DECLARE pin text;BEGIN
            SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO pin FROM pg_proc p WHERE oid='${signature}'::regprocedure;
            EXECUTE format('CREATE FUNCTION fictional_private_mutation_pin() RETURNS text LANGUAGE sql AS %L','SELECT '||quote_literal(pin)||'::text');
          END $fixture$`},
        ]),
      ]
      for(const scenario of mutationCases)await t.test(`refuses mutation helper ${scenario.name} atomically`,async()=>{
        await db.exec('BEGIN')
        try{
          await db.exec(scenario.change)
          const before=await snapshots()
          await db.exec('SAVEPOINT publication_attempt')
          await assert.rejects(db.exec(publicationSql),scenario.name==='qualified manifest entry'
            ? /Native turn predecessor contract changed/
            : /Native mutation scope legacy ACL (prerequisite changed|has an existing pin)/)
          await db.exec('ROLLBACK TO SAVEPOINT publication_attempt')
          assert.deepEqual(await snapshots(),before)
        }finally{await db.exec('ROLLBACK')}
      })
      // Historical repair idempotence belongs to its last supported cohort.
      await migratePglite(db, migrationsDir, {through:'82690_private_transcript_preparation_eligibility.sql'})
      const mutationAfter=(await db.query<{raw:Record<string,unknown>}>(
        'SELECT to_jsonb(p) raw FROM pg_proc p WHERE oid=$1::regprocedure',[mutationHelper])).rows[0].raw
      assert.deepEqual({...mutationAfter,proacl:mutationBefore.raw.proacl},mutationBefore.raw)
      assert.deepEqual((await db.query(`SELECT has_function_privilege('app_user',$1::regprocedure,'EXECUTE') executable,
        NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
         WHERE p.oid=$1::regprocedure AND a.grantee='app_user'::regrole) no_redundant_grant`,[mutationHelper])).rows,
      [{executable:true,no_redundant_grant:true}])
      const privateMutationAfter=(await db.query<{signature:string;raw:Record<string,unknown>}>(
        'SELECT oid::regprocedure::text signature,to_jsonb(p) raw FROM pg_proc p WHERE oid=ANY($1::regprocedure[]) ORDER BY signature',
        [privateMutationHelpers])).rows
      // These bodies receive the independently authenticated publication patch;
      // the compatibility repair changes only their known inherited ACLs.
      assert.deepEqual(privateMutationAfter.map((row,index)=>({...row,raw:{...row.raw,
        prosrc:privateMutationBefore[index].raw.prosrc,proacl:privateMutationBefore[index].raw.proacl}})),privateMutationBefore)
      assert.deepEqual((await db.query(`SELECT bool_and(NOT has_function_privilege('app_user',signature,'EXECUTE')) private
        FROM unnest($1::text[]) signature`,[privateMutationHelpers])).rows,[{private:true}])
      const scopeInstalled = await snapshots()
      await db.exec(scopeSql)
      assert.deepEqual(await snapshots(), scopeInstalled)
      await db.exec(`ALTER FUNCTION ${scopeHelper} COST 101`)
      const installedCustomMetadata = await snapshots()
      await db.exec(scopeSql)
      assert.deepEqual(await snapshots(), installedCustomMetadata)
      await db.exec(`ALTER FUNCTION ${scopeHelper} COST 100`)
      assert.deepEqual((await db.query('SELECT application_native_covered_evidence_helpers_current() AS current')).rows, [{ current: true }])
      const queryInstalled = await snapshots()
      await db.transaction(async tx => { await tx.exec(querySql) })
      assert.deepEqual(await snapshots(), queryInstalled)
      assert.deepEqual((await db.query('SELECT native_turn_helpers_current() AS current')).rows, [{ current: true }])
      const upgraded = await snapshots()
      await db.transaction(async tx => { await tx.exec(captureSql) })
      assert.deepEqual(await snapshots(), upgraded)
      assert.deepEqual((await db.query('SELECT application_memory_statement_helpers_current() AS current')).rows, [{ current: true }])
      assert.deepEqual((await db.query(`SELECT has_function_privilege('app_user',
        'public.application_memory_statement_state(uuid,uuid,text[],jsonb)','EXECUTE') AS exposed`)).rows, [{ exposed: false }])
      await assertOrdinaryOwner(db)
      // Older installations that already passed 8111 must retain their live pins.
      const before = await snapshots()
      await db.transaction(async (tx) => { await tx.exec(sql) })
      assert.deepEqual(await snapshots(), before)
      await t.test('retires the residual 8071 reader grant after 81110 removed the creation default', async () => {
        const name = '8269_canonical_conversation_publication.sql'
        const candidate = toPgliteMigrationSql(await readFile(`${migrationsDir}/${name}`, 'utf8'), name)
        const privilege = `SELECT has_function_privilege('app_user',
          'public.read_native_session_query_cohort_nodes(uuid,jsonb)', 'EXECUTE') AS allowed`
        await db.exec('BEGIN')
        try {
          assert.deepEqual((await db.query(privilege)).rows, [{ allowed: true }])
          const defaults = (await db.query('SELECT * FROM pg_default_acl ORDER BY oid')).rows
          await db.exec('SAVEPOINT before_history')
          await db.query('DELETE FROM public._migrations WHERE name=$1', [migration])
          await assert.rejects(db.exec(candidate), /conversation_rule_predecessor_changed: read_native_session_query_cohort_nodes/)
          await db.exec('ROLLBACK TO SAVEPOINT before_history')
          await db.exec(candidate)
          assert.deepEqual((await db.query(privilege)).rows, [{ allowed: false }])
          assert.deepEqual((await db.query('SELECT * FROM pg_default_acl ORDER BY oid')).rows, defaults)
          assert.deepEqual((await db.query(`SELECT native_turn_helpers_current() AS helpers,
            native_turn_publication_contract() AS publication, native_retained_helpers_current() AS retained`)).rows,
          [{ helpers: true, publication: true, retained: true }])
        } finally {
          await db.exec('ROLLBACK')
        }
      })
      await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO app_user')
      try {
        const withLegacyDefault = await snapshots()
        await assert.rejects(db.transaction(async (tx) => { await tx.exec(sql) }), /Memory guard already installed/)
        assert.deepEqual(await snapshots(), withLegacyDefault)
        await migratePglite(db, migrationsDir, {through:'8271_refresh_recovery_capture.sql'})
        await assertPublicationLegacyAclUpgrade(db,t)
      } finally {
        // The negative probe and 8269 compatibility cases deliberately model
        // restored historical defaults. Normal forward replay continues with
        // the post-81110 function default profile.
        await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM app_user')
      }
      // Diagnose/qualify the exact historical Page reader before the ordered
      // 82775 privilege prerequisite. Its known 725 body must not be replaced
      // or repinned merely to repair an inherited owner-issued runtime ACL.
      await migratePglite(db,migrationsDir,{through:'8276_registry_guard_successor.sql'})
      const pagePredecessor=(await db.query<{body_hash:string;acl:unknown}>(`SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') body_hash,
        p.proowner::regrole::text owner,to_jsonb(p)-ARRAY['oid','prosrc','pronamespace','proowner','prolang','proargtypes','prorettype'] metadata,
        (SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,
          'grantor',a.grantor::regrole::text,'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee)
         FROM aclexplode(p.proacl) a) acl
        FROM pg_proc p WHERE p.oid='public.read_page_event_authority(uuid,uuid,uuid)'::regprocedure`)).rows[0]
      t.diagnostic('page_authority_historical_predecessor '+JSON.stringify(pagePredecessor))
      assert.equal(pagePredecessor.body_hash,'454fb6f2dc1dd89dbf7cc8d46c0ceb3e8ac11fa19eb25c4053fcb153f024e79b')
      assert.deepEqual(pagePredecessor.acl,[
        {grantee:'app_user',grantor:'migration_owner',privilege:'EXECUTE',grantable:false},
        {grantee:'migration_owner',grantor:'migration_owner',privilege:'EXECUTE',grantable:false},
      ])
      const pageRepair='82775_legacy_page_authority_privileges.sql'
      const pageOrdered=(await readdir(migrationsDir)).filter(name=>name.endsWith('.sql')).sort()
      assert.equal(pageOrdered[pageOrdered.indexOf(pageRepair)-1],'8276_registry_guard_successor.sql')
      assert.equal(pageOrdered[pageOrdered.indexOf(pageRepair)+1],'8277_durable_turn_completions.sql')
      const pageBefore=(await db.query<{value:{proacl:string[]}}>('SELECT to_jsonb(p) value FROM pg_proc p WHERE oid=$1::regprocedure',
        ['read_page_event_authority(uuid,uuid,uuid)'])).rows[0].value
      assert.equal(await migratePglite(db,migrationsDir,{through:pageRepair}),1)
      const pageAfter=(await db.query<{value:{proacl:string[]}}>('SELECT to_jsonb(p) value FROM pg_proc p WHERE oid=$1::regprocedure',
        ['read_page_event_authority(uuid,uuid,uuid)'])).rows[0].value
      assert.deepEqual({...pageAfter,proacl:pageBefore.proacl},pageBefore)
      assert.deepEqual(pageAfter.proacl,['migration_owner=X/migration_owner'])
      assert.equal(await migratePglite(db,migrationsDir,{through:pageRepair}),0)
      // Historical default grants use app-first order. The exact 82860
      // prerequisite repairs the tuple and its authenticated consumers before
      // executing the unchanged 8286 title admission migration.
      const titleRepair='82860_legacy_title_admission_privilege_order.sql'
      const titleSuccessor='8286_title_revision_admission.sql'
      const titleSignature='public.session_context_revision_allowed(uuid,uuid)'
      const titleOrdered=(await readdir(migrationsDir)).filter(name=>name.endsWith('.sql')).sort()
      assert.equal(titleOrdered[titleOrdered.indexOf(titleRepair)-1],'8285_owner_forced_rls_retirement.sql')
      assert.equal(titleOrdered[titleOrdered.indexOf(titleRepair)+1],titleSuccessor)
      await migratePglite(db,migrationsDir,{through:'8285_owner_forced_rls_retirement.sql'})
      const titleSql=toPgliteMigrationSql(await readFile(`${migrationsDir}/${titleRepair}`,'utf8'),titleRepair)
      const actualTitle=async()=> (await db.query<{metadata:Record<string,unknown>;fingerprint:string}>(`SELECT
        to_jsonb(p) metadata,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') fingerprint
        FROM pg_proc p WHERE p.oid=$1::regprocedure`,[titleSignature])).rows[0]
      const titlePhysicalState=async()=> ({
        routines:(await db.query<{signature:string;xmin:string;ctid:string;fingerprint:string}>(`SELECT p.oid::regprocedure::text signature,p.xmin::text xmin,p.ctid::text ctid,
          encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') fingerprint
          FROM pg_proc p WHERE p.pronamespace='public'::regnamespace ORDER BY p.oid`)).rows,
        native:(await db.query(`SELECT signature,xmin::text,ctid::text,encode(sha256(convert_to(to_jsonb(h.contract)::text,'UTF8')),'hex') fingerprint
          FROM native_turn_contract_helpers h ORDER BY signature COLLATE "C"`)).rows,
        retained:(await db.query('SELECT *,xmin::text,ctid::text FROM native_retained_contract_helpers ORDER BY signature COLLATE "C"')).rows,
        witness:(await db.query('SELECT to_jsonb(w) witness,xmin::text,ctid::text FROM native_turn_contract_witness w')).rows,
        ledger:(await db.query('SELECT * FROM _migrations ORDER BY name')).rows,
      })
      const historicalTitle=await actualTitle()
      assert.deepEqual(historicalTitle.metadata.proacl,['app_user=X/migration_owner','migration_owner=X/migration_owner'])
      const titleTampering=[
        {name:'different title metadata',sql:`ALTER FUNCTION ${titleSignature} COST 101`,error:/title_acl_prerequisite_contract_changed/},
        {name:'grant option',sql:`GRANT EXECUTE ON FUNCTION ${titleSignature} TO app_user WITH GRANT OPTION`,error:/title_acl_prerequisite_contract_changed/},
        {name:'unreviewed fingerprint reader',sql:`CREATE FUNCTION public.fictional_title_privilege_pin() RETURNS text LANGUAGE SQL AS
          'SELECT ''${historicalTitle.fingerprint}''::text'`,error:/conversion_unreviewed_original_pin_consumer/},
      ]
      for(const scenario of titleTampering)await t.test(`refuses historical title ${scenario.name} atomically`,async()=>{
        await db.exec('BEGIN')
        try{
          await db.exec(scenario.sql)
          const before=await titlePhysicalState()
          await db.exec('SAVEPOINT unrecognized_title_prerequisite')
          await assert.rejects(db.exec(titleSql),scenario.error)
          await db.exec('ROLLBACK TO SAVEPOINT unrecognized_title_prerequisite')
          assert.deepEqual(await titlePhysicalState(),before)
        }finally{await db.exec('ROLLBACK')}
      })
      const beforeTitleRepair=await titlePhysicalState()
      assert.equal(await migratePglite(db,migrationsDir,{through:titleRepair}),1)
      const canonicalTitle=await actualTitle(), afterTitleRepair=await titlePhysicalState()
      assert.deepEqual({...canonicalTitle.metadata,proacl:historicalTitle.metadata.proacl},historicalTitle.metadata)
      assert.deepEqual(canonicalTitle.metadata.proacl,['migration_owner=X/migration_owner','app_user=X/migration_owner'])
      const priorPins=new Map(beforeTitleRepair.routines.map(row=>[row.signature,row.fingerprint]))
      const changedRoutines=afterTitleRepair.routines.filter(row=>priorPins.get(row.signature)!==row.fingerprint).map(row=>row.signature)
      assert.ok(changedRoutines.includes('session_context_revision_allowed(uuid,uuid)'))
      assert.ok(changedRoutines.includes('application_native_title_group_helpers_current()'))
      t.diagnostic('title_acl_repaired_catalog_members '+JSON.stringify(changedRoutines))
      const noWriteTitleRepair=async()=>{
        const before=await titlePhysicalState()
        await db.transaction(tx=>tx.exec(titleSql))
        assert.deepEqual(await titlePhysicalState(),before)
      }
      await noWriteTitleRepair()
      assert.equal(await migratePglite(db,migrationsDir,{through:titleSuccessor}),1)
      await noWriteTitleRepair()
      const derivationMembers = [
        'application_patch_canonical_task(uuid,uuid,jsonb,text,jsonb)',
        'create_source_derived_entity_before_capture(jsonb,jsonb)',
        'create_source_derived_file(jsonb,jsonb)',
      ]
      const configuredMembers = [
        'application_recheck_native_task_sources()',
        'check_programmatic_publication_commit()',
      ]
      const appGrant = 'app_user=X/migration_owner'
      const ownerGrant = 'migration_owner=X/migration_owner'
      const publicGrant = '=X/migration_owner'
      const finalUpgradeState = async (members: readonly string[]) => ({
        routines: (await db.query<{
          signature: string; oid: string; acl: string[]; body: string; metadata: Record<string,unknown>; deps: unknown
        }>(`SELECT p.oid::regprocedure::text signature,p.oid::text oid,p.proacl::text[] acl,p.prosrc body,
          to_jsonb(p)-ARRAY['prosrc','proacl'] metadata,
          (SELECT jsonb_agg(to_jsonb(d) ORDER BY d.classid,d.objid,d.refclassid,d.refobjid) FROM pg_depend d
           WHERE (d.classid='pg_proc'::regclass AND d.objid=p.oid) OR (d.refclassid='pg_proc'::regclass AND d.refobjid=p.oid)) deps
          FROM pg_proc p WHERE p.oid=ANY($1::regprocedure[]) ORDER BY signature`, [members])).rows,
        ledger: (await db.query('SELECT name FROM _migrations ORDER BY name')).rows,
        defaults: (await db.query(`SELECT to_jsonb(d) FROM pg_default_acl d WHERE d.defaclobjtype='f'
          AND d.defaclrole=current_user::regrole::oid AND d.defaclnamespace IN (0,'public'::regnamespace)`)).rows,
      })
      const rejectsFinalUpgrade = async (file: string, members: readonly string[], setup: string, error: RegExp) => {
        const original = await finalUpgradeState(members)
        const executable = toPgliteMigrationSql(await readFile(`${migrationsDir}/${file}`,'utf8'),file)
        await db.exec('BEGIN')
        try {
          await db.exec(setup)
          const tampered = await finalUpgradeState(members)
          await db.exec('SAVEPOINT final_upgrade_refusal')
          await assert.rejects(db.exec(executable), error)
          await db.exec('ROLLBACK TO SAVEPOINT final_upgrade_refusal')
          assert.deepEqual(await finalUpgradeState(members), tampered)
        } finally { await db.exec('ROLLBACK') }
        assert.deepEqual(await finalUpgradeState(members), original)
      }
      const assertFinalUpgradeMembers = async (file: string, members: readonly string[], old: string[][], installed: string[][],
        changedConfigs: Record<string,string[]> = {}) => {
        const before = await finalUpgradeState(members)
        assert.deepEqual(before.defaults, [])
        assert.deepEqual(before.routines.map(row => row.acl), old)
        assert.equal(await migratePglite(db,migrationsDir,{through:file}),1)
        const after = await finalUpgradeState(members)
        assert.deepEqual(after.defaults, before.defaults)
        assert.deepEqual(after.routines.map(row => row.acl), installed)
        assert.deepEqual(after.routines.map(({oid,metadata,deps})=>({oid,metadata,deps})),
          before.routines.map(({oid,metadata,deps,signature})=>({
            oid, metadata: changedConfigs[signature] ? {...metadata,proconfig:changedConfigs[signature]} : metadata, deps,
          })))
        assert.ok(after.routines.every((row,i)=>row.body!==before.routines[i].body))
      }
      const participationRetirement = '8290_participation_read_retirement.sql'
      await migratePglite(db,migrationsDir,{through:'8289_fused_admission.sql'})
      await t.test('refuses historical participation retirement with changed metadata or an active legacy default',async()=>{
        await rejectsFinalUpgrade(participationRetirement,derivationMembers,
          `ALTER FUNCTION public.${derivationMembers[1]} COST 101`,/participation_retirement_unverified_historical_acl_profile/)
        await rejectsFinalUpgrade(participationRetirement,derivationMembers,
          'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO app_user',
          /participation_retirement_unverified_historical_acl_profile/)
      })
      await assertFinalUpgradeMembers(participationRetirement,derivationMembers,
        [[appGrant,ownerGrant],[publicGrant,appGrant,ownerGrant],[publicGrant,appGrant,ownerGrant]],
        [[ownerGrant,appGrant],[publicGrant,ownerGrant],[publicGrant,ownerGrant]])

      const configuredPublication = '8296_configured_task_publication.sql'
      await migratePglite(db,migrationsDir,{through:'8295_conversation_envelope_foundation.sql'})
      await t.test('refuses mixed ACLs, grant options and unknown configured task trigger edges atomically',async()=>{
        await rejectsFinalUpgrade(configuredPublication,configuredMembers,
          `REVOKE EXECUTE ON FUNCTION public.${configuredMembers[0]} FROM app_user`,
          /configured_task_unverified_historical_source_acl/)
        await rejectsFinalUpgrade(configuredPublication,configuredMembers,
          `GRANT EXECUTE ON FUNCTION public.${configuredMembers[1]} TO app_user WITH GRANT OPTION`,
          /configured_task_source_member_changed/)
        await rejectsFinalUpgrade(configuredPublication,configuredMembers,
          `CREATE TRIGGER unknown_task_source AFTER UPDATE ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.${configuredMembers[0]}`,
          /configured_task_unverified_historical_source_dependencies/)
      })
      await assertFinalUpgradeMembers(configuredPublication,configuredMembers,
        [[appGrant,ownerGrant],[publicGrant,appGrant,ownerGrant]],[[ownerGrant],[ownerGrant]],
        {'check_programmatic_publication_commit()':['search_path=pg_catalog, public, pg_temp']})
      const triggerRepair = '82980_legacy_conversation_trigger_privileges.sql'
      const triggerMembers = [
        'prevent_locked_session_context_change()', 'stamp_session_project_label()', 'validate_session_context_binding()',
      ]
      await migratePglite(db, migrationsDir, { through: '8297_conversation_record_admission.sql' })
      const legacyTriggers = await finalUpgradeState(triggerMembers)
      assert.equal(legacyTriggers.routines.length, triggerMembers.length)
      assert.ok(legacyTriggers.routines.every(row => row.acl.slice().sort().join() === [appGrant, ownerGrant, publicGrant].sort().join()))
      t.diagnostic('legacy_conversation_trigger_acl ' + JSON.stringify(legacyTriggers.routines.map(({signature,acl,oid,deps})=>({signature,acl,oid,deps}))))
      await t.test('refuses unreviewed conversation trigger ACL, definition and binding changes atomically', async () => {
        await rejectsFinalUpgrade(triggerRepair, triggerMembers,
          `GRANT EXECUTE ON FUNCTION public.${triggerMembers[0]} TO legacy_privilege_probe`, /conversation_trigger_acl_profile_changed/)
        await rejectsFinalUpgrade(triggerRepair, triggerMembers,
          `GRANT EXECUTE ON FUNCTION public.${triggerMembers[0]} TO app_user WITH GRANT OPTION`, /conversation_trigger_acl_profile_changed/)
        await rejectsFinalUpgrade(triggerRepair, triggerMembers,
          `REVOKE EXECUTE ON FUNCTION public.${triggerMembers[0]} FROM app_user`, /conversation_trigger_acl_unverified_historical_profile/)
        await rejectsFinalUpgrade(triggerRepair, triggerMembers,
          `ALTER FUNCTION public.${triggerMembers[0]} COST 101`, /conversation_trigger_acl_definition_changed/)
        await rejectsFinalUpgrade(triggerRepair, triggerMembers,
          'ALTER TABLE public.sessions DISABLE TRIGGER sessions_context_immutable_after_lock', /conversation_trigger_acl_binding_changed/)
      })
      const publicRoutines = ['can_view_department_directory(uuid,uuid)', 'crm_activity_scope_allows(crm_activities,boolean)']
      const appRoutines = [
        'admit_knowledge_repo_write(jsonb,jsonb,jsonb,uuid,text)', 'apply_knowledge_source_refresh(jsonb,jsonb)',
        'native_knowledge_creation_fields_allowed(uuid,text[],uuid,text)',
        'record_admitted_knowledge_entry_derivation(uuid,uuid,text,text,jsonb)',
        'update_admitted_knowledge_entry_body(uuid,uuid,text,text,text,jsonb,text[],uuid[])',
      ]
      const ordinaryRoutines = [...publicRoutines, ...appRoutines, 'application_native_task_review_current(uuid,uuid)']
      const repairedPolicies = [
        'workspace_groups_directory', 'workspace_compartments_directory', 'crm_activities_scope_read',
        'crm_activities_scope_insert', 'crm_activities_scope_update', 'crm_activities_scope_delete',
      ]
      const exactPolicies = async () => (await db.query(`SELECT p.oid::text,p.polname,p.polcmd,p.polpermissive,p.polroles::text,
        c.relrowsecurity,c.relforcerowsecurity,pg_get_expr(p.polqual,p.polrelid) AS qual,pg_get_expr(p.polwithcheck,p.polrelid) AS check
        FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE p.polname=ANY($1::text[]) ORDER BY p.polname`,[repairedPolicies])).rows
      const beforePolicies = await exactPolicies()
      assert.equal(beforePolicies.length, repairedPolicies.length)
      const beforeOrdinary = await finalUpgradeState(ordinaryRoutines)
      await t.test('refuses changed ordinary-routine policy or registered dependencies without partial rebind', async () => {
        await rejectsFinalUpgrade(triggerRepair, ordinaryRoutines,
          `REVOKE EXECUTE ON FUNCTION public.${appRoutines[0]} FROM app_user;
           GRANT EXECUTE ON FUNCTION public.${appRoutines[0]} TO app_user`,
          /legacy_bypass_function_predecessor_changed/)
        await rejectsFinalUpgrade(triggerRepair, ordinaryRoutines,
          'ALTER POLICY workspace_groups_directory ON public.workspace_groups TO app_user', /legacy_ordinary_acl_policy_changed/)
        await rejectsFinalUpgrade(triggerRepair, ordinaryRoutines,
          'ALTER TABLE public.workspace_groups FORCE ROW LEVEL SECURITY', /legacy_ordinary_acl_policy_changed/)
        await rejectsFinalUpgrade(triggerRepair, ordinaryRoutines,
          'CREATE VIEW public.unreviewed_directory AS SELECT public.can_view_department_directory(NULL::uuid,NULL::uuid)',
          /legacy_ordinary_acl_unreviewed_inbound_dependency/)
        await rejectsFinalUpgrade(triggerRepair, ordinaryRoutines,
          'ALTER TABLE public.application_native_field_contracts ADD COLUMN unreviewed_proc regprocedure',
          /legacy_ordinary_acl_registry_shape_changed/)
        const candidateSql = toPgliteMigrationSql(await readFile(`${migrationsDir}/${triggerRepair}`,'utf8'),triggerRepair)
        await assert.rejects(db.transaction(async tx => {
          await tx.exec(candidateSql)
          throw Error('ordinary-policy-rollback-control')
        }), /ordinary-policy-rollback-control/)
        assert.deepEqual(await finalUpgradeState(ordinaryRoutines),beforeOrdinary)
        assert.deepEqual(await exactPolicies(),beforePolicies)
      })
      assert.equal(await migratePglite(db, migrationsDir, { through: triggerRepair }), 1)
      const afterOrdinary = await finalUpgradeState(ordinaryRoutines)
      assert.deepEqual(await exactPolicies(),beforePolicies)
      assert.equal(afterOrdinary.routines.length,ordinaryRoutines.length)
      for (let index = 0; index < ordinaryRoutines.length; index++) {
        const before = beforeOrdinary.routines[index], after = afterOrdinary.routines[index]
        assert.equal(after.signature,before.signature)
        assert.equal(after.body,before.body)
        assert.deepEqual({...after.metadata,oid:before.metadata.oid},before.metadata)
        if (publicRoutines.includes(before.signature)) {
          assert.notEqual(after.oid,before.oid)
          assert.equal(after.acl,null)
        } else {
          assert.equal(after.oid,before.oid)
          assert.deepEqual(after.acl,appRoutines.includes(before.signature)?[ownerGrant,appGrant]:[ownerGrant])
          assert.deepEqual(after.deps,before.deps)
        }
      }
      const repairedTriggers = await finalUpgradeState(triggerMembers)
      assert.deepEqual(repairedTriggers.routines.map(row => ({ ...row, acl: row.acl.slice().sort() })),
        legacyTriggers.routines.map(row => ({ ...row, acl: [ownerGrant, publicGrant].sort() })))
      assert.deepEqual(repairedTriggers.defaults, legacyTriggers.defaults)
      await migratePglite(db, migrationsDir, { through: '8330_project_harness_verification.sql' })
      // Compare the actual full-chain predecessor against 8331's source-owned
      // metadata predicates without executing or enrolling its observed body.
      const chatSql = await readFile(`${migrationsDir}/8331_project_chat_creation_admission.sql`, 'utf8')
      const metadataPredicate = chatSql.slice(chatSql.indexOf(' IF encode(') + 4, chatSql.indexOf("\n THEN RAISE EXCEPTION 'project_chat_creation_predecessor_changed'"))
        .replaceAll("convert_to(original,", "convert_to(routine.prosrc,")
      const chatProfile = (await db.query<{ metadata_matches: boolean; acl: string[] }>(`SELECT NOT (${metadataPredicate}) metadata_matches,
        routine.proacl::text[] acl FROM pg_proc routine WHERE oid='public.require_session_creation_admission()'::regprocedure`)).rows[0]!
      t.diagnostic('project_chat_creation_metadata_predicate ' + JSON.stringify(chatProfile))
      assert.equal(chatProfile.metadata_matches, true)
      assert.deepEqual(chatProfile.acl.slice().sort(), [ownerGrant, appGrant].sort())
      const chatBefore = await finalUpgradeState(['require_session_creation_admission()'])
      const chatTrigger = (await db.query(`SELECT to_jsonb(t) record FROM pg_trigger t WHERE tgname='zzzz_session_creation_admission'`)).rows
      await migratePglite(db, migrationsDir)
      const chatAfter = await finalUpgradeState(['require_session_creation_admission()'])
      assert.deepEqual(chatAfter.routines.map(row => ({...row, body: chatBefore.routines[0].body, acl: chatBefore.routines[0].acl})), chatBefore.routines)
      assert.deepEqual(chatAfter.routines[0].acl, [ownerGrant])
      assert.notEqual(chatAfter.routines[0].body, chatBefore.routines[0].body)
      assert.deepEqual(chatAfter.defaults, chatBefore.defaults)
      assert.deepEqual((await db.query(`SELECT to_jsonb(t) record FROM pg_trigger t WHERE tgname='zzzz_session_creation_admission'`)).rows, chatTrigger)
      await t.test('records the interstitial migration on a canonical 8314 ledger without changing the functions', async () => {
        const canonical = await finalUpgradeState([...triggerMembers,...ordinaryRoutines])
        const canonicalPolicies = await exactPolicies()
        await rejectsFinalUpgrade(triggerRepair, triggerMembers,
          `GRANT EXECUTE ON FUNCTION ${triggerMembers.map(signature => 'public.' + signature).join(', ')} TO app_user`,
          /conversation_trigger_acl_unverified_historical_profile/)
        await db.query('DELETE FROM _migrations WHERE name=$1', [triggerRepair])
        assert.equal(await migratePglite(db, migrationsDir), 1)
        assert.deepEqual(await finalUpgradeState([...triggerMembers,...ordinaryRoutines]), canonical)
        assert.deepEqual(await exactPolicies(),canonicalPolicies)
      })
      await noWriteTitleRepair()
      assert.equal(await migratePglite(db, migrationsDir), 0)
      assert.deepEqual((await db.query(`SELECT
        to_regprocedure('public.application_native_session_query_acquisition_current()') retired,
        has_function_privilege('app_user','public.capture_conversation_query(uuid,uuid,integer,integer)','EXECUTE') readable,
        has_function_privilege('app_user','public.capture_conversation_selection(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb)','EXECUTE') private_exposed`)).rows,
      [{retired:null,readable:true,private_exposed:false}])
      assert.deepEqual((await db.query(`SELECT native_turn_helpers_current() current,
        to_regprocedure('application_memory_statement_helpers_current()') retired,
        has_function_privilege('app_user','read_native_session_query_cohort_nodes(uuid,jsonb)','EXECUTE') exposed`)).rows,
      [{current:true,retired:null,exposed:false}])
    } finally {
      await db.close()
    }
  })

  for (const appUser of [false, true]) {
    it(`validates Memory prerequisites with app_user ${appUser ? 'present and local OIDs varied' : 'absent'}`, async (t) => {
      const db = await openAsOwner({ appUser, varyOids: appUser })
      const migration = '8111_native_memory_statement_visitor.sql'
      const helper = 'public.scope_source_table(text)'
      const lineage = 'public.application_scope_lineage(uuid,text[],uuid[],text[])'
      const admitted = 'public.read_admitted_native_scope_snapshot(uuid,text,uuid)'
      try {
        await migratePglite(db, migrationsDir, { through: '81110_legacy_function_execute_privileges.sql' })
        await db.exec('RESET ROLE; CREATE ROLE prerequisite_probe NOLOGIN; SET ROLE migration_owner')
        const definition = async (signature: string) => (await db.query<{ definition: string }>(
          'SELECT pg_get_functiondef($1::regprocedure) AS definition', [signature],
        )).rows[0].definition
        const helperDefinition = await definition(helper)
        const lineageDefinition = await definition(lineage)
        const driftBody = (value: string) => {
          const changed = value.replace('$function$', '$function$\n-- Fictional prerequisite drift\n')
          assert.notEqual(changed, value)
          return changed
        }
        const changedPin = lineageDefinition.replace(/'[0-9a-f]{64}'::text/, `'${'0'.repeat(64)}'::text`)
        assert.notEqual(changedPin, lineageDefinition)
        const cases = [
          { name: 'lineage body', signature: lineage, change: driftBody(lineageDefinition), restore: lineageDefinition },
          { name: 'lineage pin', signature: lineage, change: changedPin, restore: lineageDefinition },
          { name: 'helper body', signature: helper, change: driftBody(helperDefinition), restore: helperDefinition },
          { name: 'helper volatility', signature: helper, change: `ALTER FUNCTION ${helper} STABLE`, restore: `ALTER FUNCTION ${helper} IMMUTABLE` },
          { name: 'extra principal', signature: helper, change: `GRANT EXECUTE ON FUNCTION ${helper} TO prerequisite_probe`, restore: `REVOKE ALL ON FUNCTION ${helper} FROM prerequisite_probe` },
          { name: 'PUBLIC execution', signature: helper, change: `GRANT EXECUTE ON FUNCTION ${helper} TO PUBLIC`, restore: `REVOKE ALL ON FUNCTION ${helper} FROM PUBLIC` },
          { name: 'grant option', signature: helper, change: `GRANT EXECUTE ON FUNCTION ${helper} TO prerequisite_probe WITH GRANT OPTION`, restore: `REVOKE ALL ON FUNCTION ${helper} FROM prerequisite_probe` },
          ...(appUser ? [{ name: 'required runtime grant revoked', signature: admitted, change: `REVOKE EXECUTE ON FUNCTION ${admitted} FROM app_user`, restore: `GRANT EXECUTE ON FUNCTION ${admitted} TO app_user` }] : []),
        ]
        for (const scenario of cases) {
          await t.test(`rejects ${scenario.name} atomically`, async () => {
            try {
              await db.exec(scenario.change)
              await assert.rejects(migratePglite(db, migrationsDir, { through: migration }),
                (error: Error) => error.message === `Memory statement prerequisite changed: ${scenario.signature}`)
              assert.deepEqual((await db.query('SELECT name FROM _migrations WHERE name=$1', [migration])).rows, [])
              assert.deepEqual((await db.query(`SELECT to_regprocedure(
                'public.application_memory_statement_state(uuid,uuid,text[],jsonb)')::text AS helper`)).rows, [{ helper: null }])
              await assertOrdinaryOwner(db)
            } finally {
              await db.exec(scenario.restore)
            }
          })
        }
        await t.test('installs the exact reviewed predecessor and remains idempotent', async () => {
          assert.equal(await migratePglite(db, migrationsDir, { through: migration }), 1)
          assert.equal(await migratePglite(db, migrationsDir, { through: migration }), 0)
          assert.deepEqual((await db.query('SELECT application_memory_statement_helpers_current() AS current')).rows, [{ current: true }])
          assert.deepEqual((await db.query(`SELECT EXISTS(SELECT FROM pg_proc p,
            LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
            WHERE p.oid='application_memory_statement_state(uuid,uuid,text[],jsonb)'::regprocedure
            AND a.grantee<>p.proowner) AS exposed`)).rows, [{ exposed: false }])
          await assertOrdinaryOwner(db)
        })
      } finally {
        await db.close()
      }
    })
  }

  it('validates the exact Memory guard amendment before installation', async (t) => {
    const db = await openAsOwner({ appUser: true })
    const migration = '8113_native_memory_statement_helper_projection_guard.sql'
    const guard = 'public.application_memory_statement_helpers_current()'
    const helper = 'public.scope_source_table(text)'
    try {
      await migratePglite(db, migrationsDir, { through: '8112_native_feedback_outcome_projection.sql' })
      await db.exec('RESET ROLE; CREATE ROLE guard_prerequisite_probe NOLOGIN; SET ROLE migration_owner')
      const original = (await db.query<{ definition: string; body: string }>(
        'SELECT pg_get_functiondef(oid) AS definition,prosrc AS body FROM pg_proc WHERE oid=$1::regprocedure', [guard],
      )).rows[0]
      const pins = original.body.match(/\([0-9]+::oid,'[0-9a-f]{64}'::text\)/g)!
      assert.equal(pins.length, 120)
      const firstOid = /^\(([0-9]+)::oid/.exec(pins[0])![1]
      // OID text with a leading zero is parsed as octal. Keep this fixture
      // parseable so the exact-text gate, rather than the OID parser, rejects it.
      const noncanonicalPin = pins.find((pin) => /^\([0-7]+::oid/.test(pin))!
      assert.ok(noncanonicalPin)
      const helperOid = (await db.query<{ oid: number }>('SELECT $1::regprocedure::oid AS oid', [helper])).rows[0].oid
      const replaceBody = (body: string) => {
        assert.notEqual(body, original.body)
        const changed = original.definition.replace(original.body, body)
        assert.notEqual(changed, original.definition)
        return changed
      }
      const cases = [
        { name: 'outer grammar', error: 'Memory statement guard prerequisite changed', change: replaceBody(original.body.replace(' SELECT count(*)=120', '  SELECT count(*)=120')), restore: original.definition },
        { name: 'unmatched body text', error: 'Memory statement guard prerequisite changed', change: replaceBody(original.body + ' /* Fictional unmatched guard text */'), restore: original.definition },
        { name: 'missing pin', error: 'Memory statement guard prerequisite changed', change: replaceBody(original.body.replace(pins[0] + ',', '')), restore: original.definition },
        { name: 'extra pin', error: 'Memory statement guard prerequisite changed', change: replaceBody(original.body.replace(pins[0], pins[0] + ',' + pins[0])), restore: original.definition },
        { name: 'noncanonical OID spelling', error: 'Memory statement guard prerequisite changed', change: replaceBody(original.body.replace(noncanonicalPin, noncanonicalPin.replace('(', '(0'))), restore: original.definition },
        { name: 'altered fingerprint', error: `Memory statement canonical prerequisite changed: ${firstOid}`, change: replaceBody(original.body.replace(pins[0], pins[0].replace(/[0-9a-f]{64}/, '0'.repeat(64)))), restore: original.definition },
        { name: 'duplicate canonical identity', error: 'Memory statement canonical identities changed', change: replaceBody(original.body.replace(pins[1], pins[0])), restore: original.definition },
        { name: 'guard volatility', error: 'Memory statement guard prerequisite changed', change: `ALTER FUNCTION ${guard} STABLE`, restore: `ALTER FUNCTION ${guard} VOLATILE` },
        { name: 'helper volatility', error: `Memory statement canonical prerequisite changed: ${helperOid}`, change: `ALTER FUNCTION ${helper} STABLE`, restore: `ALTER FUNCTION ${helper} IMMUTABLE` },
        { name: 'extra guard principal', error: 'Memory statement guard privileges changed', change: `GRANT EXECUTE ON FUNCTION ${guard} TO guard_prerequisite_probe`, restore: `REVOKE ALL ON FUNCTION ${guard} FROM guard_prerequisite_probe` },
        { name: 'PUBLIC guard execution', error: 'Memory statement guard privileges changed', change: `GRANT EXECUTE ON FUNCTION ${guard} TO PUBLIC`, restore: `REVOKE ALL ON FUNCTION ${guard} FROM PUBLIC` },
        { name: 'guard grant option', error: 'Memory statement guard privileges changed', change: `GRANT EXECUTE ON FUNCTION ${guard} TO guard_prerequisite_probe WITH GRANT OPTION`, restore: `REVOKE ALL ON FUNCTION ${guard} FROM guard_prerequisite_probe` },
        { name: 'helper ACL drift', error: `Memory statement canonical prerequisite changed: ${helperOid}`, change: `GRANT EXECUTE ON FUNCTION ${helper} TO PUBLIC`, restore: `REVOKE ALL ON FUNCTION ${helper} FROM PUBLIC` },
      ]
      const metadata = () => db.query(`SELECT oid,md5(to_jsonb(p)::text) AS fingerprint FROM pg_proc p
        WHERE oid IN($1::regprocedure,$2::regprocedure,
          'public.application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[])'::regprocedure,
          'public.read_entity_derivation_source(uuid,text,uuid)'::regprocedure)
        ORDER BY oid`, [guard, helper])
      for (const scenario of cases) {
        await t.test(`rejects ${scenario.name} without recording or partially amending the guard`, async () => {
          try {
            await db.exec(scenario.change)
            const before = (await metadata()).rows
            await assert.rejects(migratePglite(db, migrationsDir, { through: migration }),
              (error: Error) => error.message === scenario.error)
            assert.deepEqual((await db.query('SELECT name FROM _migrations WHERE name=$1', [migration])).rows, [])
            assert.deepEqual((await metadata()).rows, before)
            await assertOrdinaryOwner(db)
          } finally {
            await db.exec(scenario.restore)
          }
        })
      }
      await t.test('installs only the reviewed amendment and remains private and idempotent', async () => {
        assert.equal(await migratePglite(db, migrationsDir, { through: migration }), 1)
        assert.equal(await migratePglite(db, migrationsDir, { through: migration }), 0)
        assert.deepEqual((await db.query('SELECT application_memory_statement_helpers_current() AS current')).rows, [{ current: true }])
        assert.deepEqual((await db.query(`SELECT has_function_privilege('app_user',$1::regprocedure,'EXECUTE') AS runtime,
          EXISTS(SELECT FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
            WHERE p.oid=$1::regprocedure AND a.grantee=0) AS public FROM pg_proc WHERE oid=$1::regprocedure`, [guard])).rows,
          [{ runtime: false, public: false }])
        await assertOrdinaryOwner(db)
      })
    } finally {
      await db.close()
    }
  })

  it('replays the whole chain from empty without a superuser', async (t) => {
    const snapshot = process.env.BRIAN_TEST_PGLITE_SNAPSHOT
    const identity = snapshot ? await preparedIdentity() : undefined
    const db = await openAsOwner({ prepareRuntime: true })
    try {
      // One connection for every file, so the baseline's row_security = off
      // is still in force when the later data-rewriting migrations run.
      assert.ok((await migratePglite(db, migrationsDir, { through: '8266_home_app_role_isolation.sql' })) > 0)
      await assertRetainedBootstrap(db,t)
      assert.equal(await migratePglite(db, migrationsDir, { through: '8267_retained_native_graph.sql' }), 1)
      await migratePglite(db, migrationsDir)
      assert.equal(await migratePglite(db, migrationsDir), 0)
      await assertOrdinaryOwner(db)
      await assertMigrationSecurity(db, false)
      if (snapshot && identity) await savePreparedPglite(db, snapshot, identity)
    } finally {
      await db.close()
    }
  })

  it('relabels free-form compartments on upgrade, bypassing triggers and restoring them', async () => {
    const db = await openAsOwner({ prepareRuntime: true })
    try {
      await migratePglite(db, migrationsDir, { through: '649_department_read_policy.sql' })

      // Seed the pre-cutover state. Only this disposable fixture skips the
      // write guards; the migration under test runs as the owner below.
      await db.exec('RESET ROLE')
      await db.exec(`
        BEGIN;
        SET LOCAL session_replication_role = replica;
        INSERT INTO tasks (title, workspace_id, compartments, updated_at) VALUES
          ('mixed', '${WORKSPACE_ID}', ARRAY['legal', '${DEPARTMENT}'], '2020-01-01Z'),
          ('free-form only', '${WORKSPACE_ID}', ARRAY['hr'], '2020-01-01Z'),
          ('department only', '${WORKSPACE_ID}', ARRAY['${DEPARTMENT}'], '2020-01-01Z');
        INSERT INTO workspace_skill_scope_revisions
          (workspace_id, skill_id, revision, sensitivity, compartments, project_ids, scope_held) VALUES
          ('${WORKSPACE_ID}', '${SKILL_ID}', 1, 'internal', ARRAY['legal', '${DEPARTMENT}'], '{}', false),
          ('${WORKSPACE_ID}', '${SKILL_ID}', 2, 'internal', ARRAY['hr'], '{}', true);
        COMMIT;
      `)
      const taskState = async () => (await db.query<{ state: Record<string, unknown> }>(
        'SELECT to_jsonb(t) AS state FROM tasks t ORDER BY id',
      )).rows.map(row => row.state)
      const tasksBefore = await taskState()
      assert.equal(tasksBefore.length, 3)
      const skillState = async () => (await db.query<{ state: Record<string, unknown> }>(
        'SELECT to_jsonb(s) AS state FROM workspace_skill_scope_revisions s ORDER BY revision',
      )).rows.map(row => row.state)
      const skillsBefore = await skillState()
      const versionsBefore = (await db.query(
        'SELECT title, scope_version FROM tasks ORDER BY title',
      )).rows

      // An upgrade arrives on a new connection, where row security is on and
      // a forced table filters its owner instead of refusing the statement.
      await db.exec('SET ROLE migration_owner; SET row_security = on;')
      await assertOrdinaryOwner(db)
      // Timestamp preservation belongs to this relabel, before later backfills.
      assert.equal(await migratePglite(db, migrationsDir, { through: '650_department_read_cutover.sql' }), 1)
      await assertOrdinaryOwner(db)
      await assertMigrationSecurity(db, true)

      await db.exec('RESET ROLE')
      assert.deepEqual(
        (await db.query(
          `SELECT title, compartments, updated_at = '2020-01-01Z' AS untouched
             FROM tasks ORDER BY title`,
        )).rows,
        [
          { title: 'department only', compartments: [DEPARTMENT], untouched: true },
          { title: 'free-form only', compartments: [], untouched: true },
          { title: 'mixed', compartments: [DEPARTMENT], untouched: true },
        ],
      )
      assert.deepEqual(
        (await db.query('SELECT title, scope_version FROM tasks ORDER BY title')).rows,
        versionsBefore,
      )
      // The forced table, including the held row its read policy hides.
      assert.deepEqual(
        (await db.query(
          'SELECT revision::int AS revision, compartments, scope_held FROM workspace_skill_scope_revisions ORDER BY revision',
        )).rows,
        [
          { revision: 1, compartments: [DEPARTMENT], scope_held: false },
          { revision: 2, compartments: [], scope_held: true },
        ],
      )
      const normalizedTasks = await taskState()
      const normalizedSkills = await skillState()

      // Continue every remaining migration as the ordinary owner. The historical
      // 8051 logical-ID backfill also fires the existing updated_at trigger;
      // its observed timestamp effect is not 650's preservation contract.
      await db.exec('SET ROLE migration_owner; SET row_security = on;')
      await assertOrdinaryOwner(db)
      const ledgerBefore = (await db.query('SELECT name FROM _migrations')).rows.length
      const files = (await (await import('node:fs/promises')).readdir(migrationsDir))
        .filter(file => file.endsWith('.sql')).sort()
      assert.equal(await migratePglite(db, migrationsDir), files.length - ledgerBefore)
      assert.deepEqual((await db.query('SELECT name FROM _migrations ORDER BY name')).rows,
        files.map(name => ({ name })))
      assert.equal(await migratePglite(db, migrationsDir), 0)
      await assertOrdinaryOwner(db)
      await assertMigrationSecurity(db, false)
      assert.deepEqual((await db.query(`SELECT relname, relrowsecurity, relforcerowsecurity
        FROM pg_class WHERE oid IN ('public.tasks'::regclass,
          'public.workspace_skill_scope_revisions'::regclass) ORDER BY relname`)).rows,
      [
        { relname: 'tasks', relrowsecurity: true, relforcerowsecurity: false },
        { relname: 'workspace_skill_scope_revisions', relrowsecurity: true, relforcerowsecurity: false },
      ])
      assert.deepEqual((await db.query(`SELECT tgname, tgenabled FROM pg_trigger
        WHERE tgrelid='public.tasks'::regclass
          AND tgname IN ('canonical_scope_version', 'tasks_set_updated_at_trg') ORDER BY tgname`)).rows,
      [{ tgname: 'canonical_scope_version', tgenabled: 'O' }, { tgname: 'tasks_set_updated_at_trg', tgenabled: 'O' }])

      await db.exec('RESET ROLE')
      const finalTasks = await taskState()
      assert.deepEqual(finalTasks.map(row => row.id), tasksBefore.map(row => row.id))
      assert.deepEqual(finalTasks.map(row => row.logical_id), tasksBefore.map(row => row.id))
      assert.deepEqual(finalTasks.map(row => row.compartments), normalizedTasks.map(row => row.compartments))
      // Compare every original field except the explicitly normalized labels and
      // historical timestamp effect, including IDs and canonical scope versions.
      const originalTaskFields = Object.keys(tasksBefore[0])
        .filter(key => key !== 'compartments' && key !== 'updated_at')
      const project = (rows: Record<string, unknown>[], keys: string[]) =>
        rows.map(row => Object.fromEntries(keys.map(key => [key, row[key]])))
      assert.deepEqual(project(finalTasks, originalTaskFields), project(tasksBefore, originalTaskFields))
      const finalSkills = await skillState()
      assert.deepEqual(finalSkills.map(row => row.compartments), normalizedSkills.map(row => row.compartments))
      assert.deepEqual(project(finalSkills, Object.keys(skillsBefore[0]).filter(key => key !== 'compartments')),
        project(skillsBefore, Object.keys(skillsBefore[0]).filter(key => key !== 'compartments')))
    } finally {
      await db.close()
    }
  })
})

// This regression uses the unchanged full chain through8125 and the ordinary
// owner boundary. The real selective-order upgrade is separately exercised on PG18.
describe('[COMP:api/migration-owner-role] Memory successor parity8126',()=>{
  async function prerequisite(){
    const db=await openAsOwner({prepareRuntime:true})
    await migratePglite(db,migrationsDir,{through:'8125_association_drain_continuation.sql'})
    await assertOrdinaryOwner(db)
    const {readFile}=await import('node:fs/promises')
    const repair=await readFile(migrationsDir+'/8126_native_memory_successor_derivation_parity.sql','utf8')
    const historical=await readFile(migrationsDir+'/8090_admitted_native_memory_derivation.sql','utf8')
    const pairs=[...historical.matchAll(/before:=\$before\$([\s\S]*?)\$before\$;\s*after:=\$after\$([\s\S]*?)\$after\$;/g)]
    assert.equal(pairs.length,4)
    const signature='public.record_admitted_memory_successor_derivation(uuid,text,uuid,text,text,jsonb,uuid,text)'
    const state=async()=>(await db.query<{raw:Record<string,unknown>;definition:string;body:string}>(
      'SELECT to_jsonb(p) AS raw,pg_get_functiondef(p.oid) AS definition,p.prosrc AS body FROM pg_proc p WHERE oid=$1::regprocedure',[signature])).rows[0]
    return {db,repair,pairs,signature,state}
  }
  it('preserves a current clone and repairs only the exact known old body with unchanged OID/properties/private ACL',async()=>{
    const f=await prerequisite()
    try{
      const current=await f.state()
      await f.db.exec(f.repair);assert.deepEqual(await f.state(),current)
      let legacy=current.body
      for(const pair of f.pairs){assert.equal(legacy.split(pair[2]).length,2);legacy=legacy.replace(pair[2],pair[1])}
      assert.notEqual(legacy,current.body)
      await f.db.exec(current.definition.replace(current.body,legacy))
      const old=await f.state();assert.deepEqual({...old.raw,prosrc:current.raw.prosrc},current.raw)
      await f.db.exec(f.repair);assert.deepEqual(await f.state(),current)
      assert.equal((await f.db.query<{current:boolean}>('SELECT application_memory_statement_helpers_current() AS current')).rows[0].current,true)
      const installed=new Set((await f.db.query<{name:string}>('SELECT name FROM _migrations')).rows.map(row=>row.name))
      const {readdir}=await import('node:fs/promises')
      const pending=(await readdir(migrationsDir)).filter(name=>name.endsWith('.sql')&&!installed.has(name)).sort()
      assert(pending.includes('8126_native_memory_successor_derivation_parity.sql'))
      assert(pending.includes('8127_native_memory_retraction_hold_binding.sql'))
      // Full-chain replay uses the same role-before-migrate table defaults as
      // embedded product boot, including the shared evidence relations.
      assert.deepEqual((await f.db.query(`SELECT c.relname,
        array_agg(a.privilege_type ORDER BY a.privilege_type) privileges,
        bool_and(a.grantor=c.relowner AND NOT a.is_grantable) owner_grants
        FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
        JOIN pg_roles r ON r.oid=a.grantee AND r.rolname='app_user'
        WHERE c.oid IN('public.scope_derivations'::regclass,'public.scope_derivation_sources'::regclass)
        GROUP BY c.relname ORDER BY c.relname`)).rows, [
        {relname:'scope_derivation_sources',privileges:['DELETE','INSERT','SELECT','UPDATE'],owner_grants:true},
        {relname:'scope_derivations',privileges:['DELETE','INSERT','SELECT','UPDATE'],owner_grants:true},
      ])
      assert.equal(await migratePglite(f.db,migrationsDir),pending.length)
      assert.equal(await migratePglite(f.db,migrationsDir),0)
      await assertOrdinaryOwner(f.db)
    }finally{await f.db.close()}
  })
  it('refuses unknown clone body, metadata or public ACL drift without changing that state or ledger',async()=>{
    const f=await prerequisite()
    try{
      const current=await f.state(),ledger=async()=>(await f.db.query('SELECT name FROM _migrations ORDER BY name')).rows
      const originalLedger=await ledger()
      for(const kind of ['body','metadata','acl']){
        if(kind==='body')await f.db.exec(current.definition.replace(current.body,current.body+'\n-- Unknown clone drift\n'))
        if(kind==='metadata')await f.db.exec(`ALTER FUNCTION ${f.signature} COST 101`)
        if(kind==='acl')await f.db.exec(`GRANT EXECUTE ON FUNCTION ${f.signature} TO PUBLIC`)
        const drifted=await f.state()
        await assert.rejects(f.db.exec(f.repair),/Memory successor parity (body|metadata) prerequisite changed/)
        await f.db.exec('ROLLBACK')
        assert.deepEqual(await f.state(),drifted);assert.deepEqual(await ledger(),originalLedger)
        if(kind==='acl')await f.db.exec(`REVOKE EXECUTE ON FUNCTION ${f.signature} FROM PUBLIC`)
        await f.db.exec(current.definition);assert.deepEqual(await f.state(),current)
      }
    }finally{await f.db.close()}
  })
})

// Existing ordinary-owner provisioning, including installations with different
// public/plpgsql OIDs. These cases exercise only the8133 prerequisite boundary.
describe('[COMP:api/migration-owner-role] Native transcript read prerequisite portability8133',()=>{
 for(const appUser of [false,true]){
  it(`preserves exact8133 prerequisites with app_user ${appUser?'present and local OIDs varied':'absent'}`,async()=>{
   const {readdir,writeFile}=await import('node:fs/promises')
   const db=await openAsOwner({appUser,varyOids:appUser})
   const proof:Record<string,unknown>={appUser,varyOids:appUser,status:'running',refusals:[]}
   const predecessor='8132_native_history_transcript_dependencies.sql'
   const migration='8133_native_history_transcript_read.sql',lineage='public.application_scope_lineage(uuid,text[],uuid[],text[])'
   const edge='public.application_scope_source_edges(uuid,text,uuid,text)',nullConfig='public.scope_source_table_before_media(text)'
   const canonical='public.application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)'
   const envelope='public.application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)'
   const state=async()=>({
    catalog:(await db.query<{oid:string;value:Record<string,unknown>}>('SELECT p.oid::text AS oid,to_jsonb(p) AS value FROM pg_proc p WHERE p.pronamespace=\'public\'::regnamespace ORDER BY p.oid')).rows,
    trigger:(await db.query('SELECT to_jsonb(t) AS value FROM pg_trigger t WHERE tgrelid=\'public.scope_derivation_sources\'::regclass AND tgname=\'application_field_derivation_dependencies\'')).rows,
    ledger:(await db.query<{name:string;applied_at:string}>('SELECT name,applied_at::text FROM _migrations ORDER BY name')).rows,
    guard:(await db.query('SELECT application_memory_statement_helpers_current() AS current')).rows,
   })
   try{
    const files=(await readdir(migrationsDir)).filter(name=>name.endsWith('.sql')).sort()
    const beforeNames=files.filter(name=>name<=predecessor),afterNames=files.filter(name=>name<=migration)
    assert.deepEqual(afterNames,[...beforeNames,migration]);proof.inventory={beforeNames,afterNames}
    await migratePglite(db,migrationsDir,{through:predecessor})
    await assertOrdinaryOwner(db)
    const before=await state();assert.deepEqual(before.ledger.map(row=>row.name),beforeNames);assert.deepEqual(before.guard,[{current:true}]);proof.before=before
    proof.environment=(await db.query(`SELECT current_user,session_user,'public'::regnamespace::oid AS namespace,
     (SELECT oid FROM pg_language WHERE lanname='plpgsql') AS plpgsql_language,
     (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser,
     (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass`)).rows
    const definition=async(signature:string)=>(await db.query<{value:string}>('SELECT pg_get_functiondef($1::regprocedure) AS value',[signature])).rows[0].value
    const definitions=new Map(await Promise.all([lineage,edge,nullConfig,canonical,envelope].map(async signature=>[signature,await definition(signature)] as const)))
    const body=(signature:string)=>String(before.catalog.find(row=>row.value.proname===signature.split('.')[1].split('(')[0])!.value.prosrc)
    assert.equal(before.catalog.find(row=>row.value.proname==='scope_source_table_before_media')!.value.proconfig,null)
    const changeBody=(signature:string)=>definitions.get(signature)!.replace(body(signature),body(signature)+'\n-- Fictional transcript prerequisite drift\n')
    const changedPin=definitions.get(lineage)!.replace(/'[0-9a-f]{64}'::text/,`'${'0'.repeat(64)}'::text`)
    assert.notEqual(changedPin,definitions.get(lineage))
    const trueDefault=definitions.get(canonical)!.replace('DEFAULT false','DEFAULT true')
    const depthOne=definitions.get(envelope)!.replace('DEFAULT 0','DEFAULT 1')
    assert.notEqual(trueDefault,definitions.get(canonical));assert.notEqual(depthOne,definitions.get(envelope))
    const cases=[
     {name:'lineage raw body',change:changeBody(lineage),restore:definitions.get(lineage)!},
     {name:'lineage historical pin',change:changedPin,restore:definitions.get(lineage)!},
     {name:'current history-aware edge body',change:changeBody(edge),restore:definitions.get(edge)!},
     {name:'NULL-config helper body',change:changeBody(nullConfig),restore:definitions.get(nullConfig)!},
     {name:'NULL-config helper setting',change:`ALTER FUNCTION ${nullConfig} SET search_path=public`,restore:`ALTER FUNCTION ${nullConfig} RESET ALL`},
     {name:'private helper ACL',change:`GRANT EXECUTE ON FUNCTION ${nullConfig} TO PUBLIC`,restore:`REVOKE ALL ON FUNCTION ${nullConfig} FROM PUBLIC`},
     {name:'fixed helper metadata',change:`ALTER FUNCTION ${edge} COST 101`,restore:`ALTER FUNCTION ${edge} COST 100`},
     {name:'boolean default true',change:trueDefault,restore:definitions.get(canonical)!},
     {name:'integer depth default1',change:depthOne,restore:definitions.get(envelope)!},
    ]
    for(const scenario of cases){
     await db.exec(scenario.change)
     const drifted=await state()
     try{
      await assert.rejects(migratePglite(db,migrationsDir,{through:migration}),/Native history transcript read .*prerequisite changed/)
      assert.deepEqual(await state(),drifted,scenario.name)
      assert.deepEqual(drifted.ledger.map(row=>row.name),beforeNames);assert.equal(drifted.ledger.some(row=>row.name===migration),false)
      ;(proof.refusals as unknown[]).push({name:scenario.name,atomicCatalogTriggerLedgerConservation:true})
     }finally{await db.exec(scenario.restore)}
     assert.deepEqual(await state(),before,scenario.name+' restored')
     await assertOrdinaryOwner(db)
    }
    assert.equal(await migratePglite(db,migrationsDir,{through:migration}),1)
    assert.equal(await migratePglite(db,migrationsDir,{through:migration}),0)
    const after=await state();proof.after=after
    assert.deepEqual(after.ledger.map(row=>row.name),afterNames);assert.deepEqual(after.ledger.filter(row=>row.name!==migration),before.ledger)
    assert.equal(after.ledger.filter(row=>row.name===migration).length,1);assert.deepEqual(after.trigger,before.trigger)
    assert.deepEqual(after.guard,[{current:true}]);assert.equal(after.catalog.length,before.catalog.length)
    const targetHashes:Record<string,string>={application_session_eval_point_state:'5be4ee91b3ab9e447ace596249e789b2408568d3519cd60bb769820dc0bb7562',
     application_field_envelope_ancestry_allowed:'27143be754ab14cd8dd868df6da06a88cf784787b00e7093361f2a3702b2e62d',
     read_native_session_field_dependencies:'fc663c87b15ec0a570ca3f75d97e8f1add1ea158fa68bfb13930c361235afbbe'}
    let changed=0
    for(let n=0;n<before.catalog.length;n++){
     const prior=before.catalog[n],current=after.catalog[n];assert.equal(current.oid,prior.oid)
     if(String(current.value.proname) in targetHashes){
      const{prosrc:oldBody,...oldMetadata}=prior.value,{prosrc:newBody,...newMetadata}=current.value
      assert.notEqual(newBody,oldBody);assert.deepEqual(newMetadata,oldMetadata)
      assert.equal((await db.query<{hash:string}>("SELECT encode(sha256(convert_to($1,'UTF8')),'hex') AS hash",[String(newBody)])).rows[0].hash,targetHashes[String(current.value.proname)]);changed++
     }else assert.deepEqual(current,prior)
    }
    assert.equal(changed,3);proof.changedBodies=changed;proof.replay=0
    await assertOrdinaryOwner(db);await assertMigrationSecurity(db,true);proof.status='pass'
   }catch(error){proof.status='blocked';proof.error={message:(error as Error).message,stack:(error as Error).stack};throw error}
   finally{
    await db.close();proof.closed=true
    if(process.env.F_E13B_ORDINARY_ARTIFACT)await writeFile(process.env.F_E13B_ORDINARY_ARTIFACT+'-'+(appUser?'present':'absent')+'.json',JSON.stringify(proof,null,2)+'\n')
   }
  })
 }
})
