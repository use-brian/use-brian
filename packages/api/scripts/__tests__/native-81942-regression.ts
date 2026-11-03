/** Disposable native PG18 regression. Never reads DATABASE_URL or dotenv.
 * PG_BIN=/tmp/native81942-pg/bin node_modules/.bin/tsx packages/api/scripts/__tests__/native-81942-regression.ts
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { runMigrations } from '../migrate.js'

const bin = process.env.PG_BIN
assert.ok(bin, 'Set PG_BIN to native PostgreSQL18 bin directory')
const root = await mkdtemp(join(tmpdir(), 'native81942-'))
console.log('Disposable cluster:', root)
const cmd = (name: string, args: string[]) => execFileSync(join(bin, name), args, { encoding: 'utf8' })
assert.match(cmd('postgres', ['--version']), /PostgreSQL\) 18\./)
cmd('initdb', ['-D', join(root, 'data'), '-A', 'trust', '-U', 'bootstrap', '--no-locale', '-E', 'UTF8'])
const port = 58194
cmd('pg_ctl', ['-D', join(root, 'data'), '-l', join(root, 'server.log'), '-o', `-k ${root} -p ${port} -c listen_addresses=''`, '-w', 'start'])
const client = (user: string) => new pg.Client({ host: root, port, user, database: 'postgres' })
const admin = client('bootstrap')
const owner = client('migration_owner')
const url = `postgresql://migration_owner@localhost:${port}/postgres?host=${encodeURIComponent(root)}`
const repairName = '81942_legacy_dependency_acl_snapshots.sql'
const blockedName = '8195_native_publication_invalidation_contract.sql'
const migrationDir = new URL('../../migrations/', import.meta.url)
const repair = await readFile(new URL(repairName, migrationDir), 'utf8')
const blocked = await readFile(new URL(blockedName, migrationDir), 'utf8')
const sentinel = new Error('fixture boundary')
async function through(stopBefore: string) {
  await assert.rejects(runMigrations({ databaseUrl: url, beforeApply({ file }) {
    if (file === stopBefore) throw sentinel
  } }), error => error === sentinel)
}
async function transaction(sql: string, commit = false) {
  // Repair files contain BEGIN/COMMIT. Removing only those boundary lines lets
  // the fixture own rollback, including successful repair/no-op probes.
  const body = sql.replace(/^BEGIN;\s*$/gm, '').replace(/^COMMIT;\s*$/gm, '')
  await owner.query('BEGIN')
  try {
    await owner.query(body)
    if (commit) await owner.query('COMMIT')
  } finally { if (!commit) await owner.query('ROLLBACK') }
}
async function snapshot() {
  return (await owner.query(`SELECT jsonb_build_object(
    'relations',(SELECT jsonb_agg(to_jsonb(c) ORDER BY oid) FROM pg_class c WHERE relnamespace='public'::regnamespace),
    'functions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY oid) FROM pg_proc p WHERE pronamespace='public'::regnamespace),
    'sequences',(SELECT jsonb_agg(to_jsonb(s) ORDER BY seqrelid) FROM pg_sequence s),
    'ledger',(SELECT jsonb_agg(to_jsonb(m) ORDER BY name) FROM _migrations m)) AS state`)).rows[0].state
}
try {
  await admin.connect()
  console.log((await admin.query('SELECT version()')).rows)
  await admin.query(`CREATE ROLE migration_owner LOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE app_user NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE "brian-debug" NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;
    UPDATE pg_extension SET extowner='migration_owner'::regrole WHERE extname IN ('vector','pg_trgm');
    ALTER DATABASE postgres OWNER TO migration_owner;
    ALTER SCHEMA public OWNER TO migration_owner;`)
  console.log('vector:', (await admin.query("SELECT extversion FROM pg_extension WHERE extname='vector'")).rows)
  await owner.connect()
  assert.deepEqual((await owner.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows, [{ rolsuper: false, rolbypassrls: false }])
  await owner.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO app_user;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO app_user;`)
  await through('81850_legacy_dependency_guard_rebake.sql')
  await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON
    native_field_dependency_batches,native_field_dependency_work,scope_derivations,scope_derivation_sources TO app_user;
    GRANT SELECT ON native_field_dependency_batches,native_field_dependency_work,scope_derivations,scope_derivation_sources TO "brian-debug";
    GRANT USAGE,SELECT ON native_field_dependency_work_id_seq TO app_user;`)
  await through(repairName)
  const legacy = (await owner.query("SELECT prosrc FROM pg_proc WHERE oid='application_native_dependency_batch_helpers_current()'::regprocedure")).rows[0].prosrc
  assert.ok(legacy.includes('app_user=arwd/migration_owner'))
  assert.ok(legacy.includes('brian-debug'))
  assert.ok(legacy.includes('app_user=rU/migration_owner'))
  await assert.rejects(transaction(blocked), /native_invalidation_predecessor_changed: application_native_dependency_batch_helpers_current\(\)/)
  console.log('PASS authenticated native 8195 predecessor failure')
  const before = await snapshot()
  const original = (await owner.query("SELECT pg_get_functiondef('validate_native_field_dependency_batch(uuid,uuid,jsonb)'::regprocedure) AS definition")).rows[0].definition
  // Modify the executable body, not just metadata, while retaining its signature.
  const changed = original.replace(/\bBEGIN\b/, 'BEGIN PERFORM 1;') + ';'
  assert.notEqual(changed, original)
  for (const [label, drift] of [
    ['queue RLS', 'ALTER TABLE native_field_dependency_work DISABLE ROW LEVEL SECURITY;'],
    ['sequence', 'ALTER SEQUENCE native_field_dependency_work_id_seq INCREMENT BY 2;'],
    ['function body', changed],
  ]) {
    await assert.rejects(transaction(`${drift}\n${repair}`), /changed/i)
    assert.deepEqual(await snapshot(), before)
    console.log(`PASS atomic rejection: ${label}`)
  }
  await through(blockedName)
  const repaired = await snapshot()
  assert.notDeepEqual(repaired, before)
  const metadata = (state: typeof before) => {
    const copy = structuredClone(state)
    copy.ledger = copy.ledger.filter((m: { name: string }) => m.name !== repairName)
    for (const fn of copy.functions) {
      if (['application_native_dependency_batch_helpers_current', 'application_native_field_reference_helpers_current'].includes(fn.proname)) delete fn.prosrc
    }
    return copy
  }
  assert.deepEqual(metadata(repaired), metadata(before))
  console.log('PASS repair changes only two guard bodies and its ledger row')
  await transaction(repair, true)
  assert.deepEqual(await snapshot(), repaired)
  console.log('PASS repeated repair before 8195 is catalog no-op')
  await through('8202_session_turn_started_at.sql')
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM _migrations WHERE name=ANY($1::text[])', [[repairName, blockedName, '8201_native_turn_publication_cohorts.sql']])).rows[0].n, 3)
  const installed = await snapshot()
  await transaction(repair, true)
  assert.deepEqual(await snapshot(), installed)
  console.log('PASS actual runMigrations chain through 8201; historical repair remains no-op')
  console.log('NATIVE81942 SUCCESS')
} finally {
  await owner.end().catch(() => {})
  await admin.end().catch(() => {})
  console.log(cmd('pg_ctl', ['-D', join(root, 'data'), '-m', 'immediate', '-w', 'stop']))
  console.log('Retained disposable data/logs:', root)
}
