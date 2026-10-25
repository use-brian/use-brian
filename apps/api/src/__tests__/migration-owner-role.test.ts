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
import { migratePglite } from '../migrate-pglite.js'

const migrationsDir = fileURLToPath(
  new URL('../../../../packages/api/migrations', import.meta.url),
)

const WORKSPACE_ID = '00000000-0000-4000-8000-0000000000f1'
const SKILL_ID = '00000000-0000-4000-8000-0000000000b1'
const DEPARTMENT = 'team:00000000-0000-4000-8000-0000000000d1'

/** A database provisioned the way the self-host recipe leaves it. */
async function openAsOwner(options: { appUser?: boolean; varyOids?: boolean } = {}): Promise<PGlite> {
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
  for (const appUser of [false, true]) {
    it(`validates Memory prerequisites with app_user ${appUser ? 'present and local OIDs varied' : 'absent'}`, async (t) => {
      const db = await openAsOwner({ appUser, varyOids: appUser })
      const migration = '8111_native_memory_statement_visitor.sql'
      const helper = 'public.scope_source_table(text)'
      const lineage = 'public.application_scope_lineage(uuid,text[],uuid[],text[])'
      const admitted = 'public.read_admitted_native_scope_snapshot(uuid,text,uuid)'
      try {
        await migratePglite(db, migrationsDir, { through: '8111' })
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
