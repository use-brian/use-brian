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

import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { vector } from '@electric-sql/pglite-pgvector'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { toPgliteMigrationSql } from '@use-brian/api/migrations/pglite-sql.js'
import { migratePglite } from '../migrate-pglite.js'

const migrationsDir = fileURLToPath(
  new URL('../../../../packages/api/migrations', import.meta.url),
)

const WORKSPACE_ID = '00000000-0000-4000-8000-0000000000f1'
const SKILL_ID = '00000000-0000-4000-8000-0000000000b1'
const DEPARTMENT = 'team:00000000-0000-4000-8000-0000000000d1'

/** A database provisioned the way the self-host recipe leaves it. */
async function openAsOwner(options: { appUser?: boolean; varyOids?: boolean; legacyDefaults?: boolean } = {}): Promise<PGlite> {
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
  if (options.appUser) {
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

async function assertNothingLeftBypassed(db: PGlite): Promise<void> {
  assert.deepEqual(
    (await db.query(
      `SELECT tgrelid::regclass::text AS "table", tgname FROM pg_trigger
        WHERE NOT tgisinternal AND tgenabled <> 'O'`,
    )).rows,
    [],
  )
  assert.deepEqual(
    (await db.query(
      `SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.workspace_skill_scope_revisions'::regclass`,
    )).rows,
    [{ relforcerowsecurity: true }],
  )
}

describe('[COMP:api/migration-owner-role] Migrations run as an ordinary owner role', () => {
  it('repairs historical function defaults atomically and replays the complete upgrade', async (t) => {
    const db = await openAsOwner({ appUser: true, varyOids: true, legacyDefaults: true })
    const migration = '81110_legacy_function_execute_privileges.sql'
    const cohort = 'public.read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)'
    const extra = 'public.application_session_eval_point_state(uuid,text,uuid,text[],jsonb)'
    const facade = 'public.read_admitted_native_scope_snapshot(uuid,text,uuid)'
    const sql = toPgliteMigrationSql(await readFile(`${migrationsDir}/${migration}`, 'utf8'), migration)
    const snapshots = async () => ({
      functions: (await db.query(`SELECT to_jsonb(p) AS metadata FROM pg_proc p
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
      await migratePglite(db, migrationsDir)
      assert.deepEqual((await db.query('SELECT application_memory_statement_helpers_current() AS current')).rows, [{ current: true }])
      assert.deepEqual((await db.query(`SELECT has_function_privilege('app_user',
        'public.application_memory_statement_state(uuid,uuid,text[],jsonb)','EXECUTE') AS exposed`)).rows, [{ exposed: false }])
      await assertOrdinaryOwner(db)
      // Older installations that already passed 8111 must retain their live pins.
      const before = await snapshots()
      await db.transaction(async (tx) => { await tx.exec(sql) })
      assert.deepEqual(await snapshots(), before)
      await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO app_user')
      const withLegacyDefault = await snapshots()
      await assert.rejects(db.transaction(async (tx) => { await tx.exec(sql) }), /Memory guard already installed/)
      assert.deepEqual(await snapshots(), withLegacyDefault)
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

  it('replays the whole chain from empty without a superuser', async () => {
    const db = await openAsOwner()
    try {
      // One connection for every file, so the baseline's row_security = off
      // is still in force when the later data-rewriting migrations run.
      assert.ok((await migratePglite(db, migrationsDir)) > 0)
      assert.equal(await migratePglite(db, migrationsDir), 0)
      await assertOrdinaryOwner(db)
      await assertNothingLeftBypassed(db)
    } finally {
      await db.close()
    }
  })

  it('relabels free-form compartments on upgrade, bypassing triggers and restoring them', async () => {
    const db = await openAsOwner()
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
      await assertNothingLeftBypassed(db)

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
      await assertNothingLeftBypassed(db)
      assert.deepEqual((await db.query(`SELECT relname, relrowsecurity, relforcerowsecurity
        FROM pg_class WHERE oid IN ('public.tasks'::regclass,
          'public.workspace_skill_scope_revisions'::regclass) ORDER BY relname`)).rows,
      [
        { relname: 'tasks', relrowsecurity: true, relforcerowsecurity: false },
        { relname: 'workspace_skill_scope_revisions', relrowsecurity: true, relforcerowsecurity: true },
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
    const db=await openAsOwner({appUser:true})
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
    await assertOrdinaryOwner(db);await assertNothingLeftBypassed(db);proof.status='pass'
   }catch(error){proof.status='blocked';proof.error={message:(error as Error).message,stack:(error as Error).stack};throw error}
   finally{
    await db.close();proof.closed=true
    if(process.env.F_E13B_ORDINARY_ARTIFACT)await writeFile(process.env.F_E13B_ORDINARY_ARTIFACT+'-'+(appUser?'present':'absent')+'.json',JSON.stringify(proof,null,2)+'\n')
   }
  })
 }
})
