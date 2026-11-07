import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import pg from 'pg'
import { tsImport } from 'tsx/esm/api'
import { assertLocalFixture, cloneLocalFixture } from '../crm/local-fixture.mjs'

const { runMigrations } = await tsImport('../../packages/api/scripts/migrate.ts', import.meta.url)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate) {
  const deadline = Date.now() + 20_000
  while (!await predicate()) {
    if (Date.now() >= deadline) throw Error('Migration diagnostic did not arrive')
    await pause(25)
  }
}

test('[COMP:api/migration-diagnostics] actual migration lock, DDL blocker, timings and failed ledger on an owned clone', { timeout: 60_000 }, async t => {
  await assertLocalFixture()
  const fixture = await cloneLocalFixture()
  const directory = await mkdtemp(join(tmpdir(), 'migration-diagnostics-'))
  const holder = new pg.Client({ connectionString: fixture.adminUrl })
  await holder.connect()
  const events = [], output = [], originalLog = console.log
  console.log = (...args) => {
    const line = args.join(' ')
    output.push(line)
    if (line.startsWith('[migration] {')) events.push(JSON.parse(line.slice('[migration] '.length)))
  }
  let pending
  try {
    const holderPid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    await t.test('a competing runner stays behind the advisory lock, then records one applied file', async () => {
      const file = '9997_diagnostic_probe.sql'
      await writeFile(join(directory, file), 'BEGIN; CREATE TABLE diagnostic_probe(id integer); COMMIT;')
      await holder.query("SELECT pg_advisory_lock(hashtextextended('use-brian:migrations',0))")
      pending = runMigrations({ databaseUrl: fixture.adminUrl, migrationDirs: [directory] })
      try {
        await until(() => events.some(event => event.event === 'migration_progress' && event.phase === 'migration_lock' && event.blockerPids.includes(holderPid)))
        assert.equal((await holder.query('SELECT count(*)::int AS n FROM _migrations WHERE name=$1', [file])).rows[0].n, 0)
      } finally { await holder.query("SELECT pg_advisory_unlock(hashtextextended('use-brian:migrations',0))") }
      assert.equal((await pending).appliedCount, 1); pending = undefined
      assert(events.some(event => event.phase === 'migration_lock' && event.status === 'acquired' && event.elapsedMs >= 10_000))
      assert(events.some(event => event.file === file && event.status === 'applied' && Number.isFinite(event.elapsedMs)))
    })
    await t.test('a blocked ALTER reports the actual blocker and only records completion after release', async () => {
      const file = '9998_diagnostic_alter.sql'
      await writeFile(join(directory, file), 'BEGIN; ALTER TABLE diagnostic_probe ADD COLUMN detail text; COMMIT;')
      await holder.query('BEGIN; LOCK TABLE diagnostic_probe IN ACCESS EXCLUSIVE MODE')
      pending = runMigrations({ databaseUrl: fixture.adminUrl, migrationDirs: [directory] })
      try {
        await until(() => events.some(event => event.file === file && event.event === 'migration_progress' && event.waitEventType === 'Lock' && event.blockerPids.includes(holderPid)))
        assert.equal((await holder.query('SELECT count(*)::int AS n FROM _migrations WHERE name=$1', [file])).rows[0].n, 0)
      } finally { await holder.query('ROLLBACK') }
      assert.equal((await pending).appliedCount, 1); pending = undefined
      assert(events.some(event => event.file === file && event.blockers?.some(blocker => blocker.pid === holderPid
        && blocker.state === 'idle in transaction' && blocker.transactionAgeMs > 0)))
    })
    await t.test('SQL failure retains its code and filename without a successful ledger receipt', async () => {
      const file = '9999_diagnostic_failure.sql'
      await writeFile(join(directory, file), 'BEGIN; SELECT 1/0; -- private-diagnostic-canary\nCOMMIT;')
      await assert.rejects(runMigrations({ databaseUrl: fixture.adminUrl, migrationDirs: [directory] }), error => error.code === '22012')
      assert(events.some(event => event.file === file && event.status === 'failed' && event.errorCode === '22012'))
      assert.equal((await holder.query('SELECT count(*)::int AS n FROM _migrations WHERE name=$1', [file])).rows[0].n, 0)
      assert(!events.some(event => event.file === file && event.status === 'applied'))
      assert(!output.join('\n').includes('private-diagnostic-canary'))
      assert(output.some(line => /complete elapsed_ms=\d+ lock_wait_ms=\d+ applied=1 skipped=\d+/.test(line)))
      await until(async () => (await holder.query(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname=current_database() AND application_name='use-brian-migration-diagnostics'`)).rows[0].n === 0)
    })
  } finally {
    await holder.query('ROLLBACK').catch(() => {})
    await holder.query('SELECT pg_advisory_unlock_all()').catch(() => {})
    await pending?.catch(() => {})
    console.log = originalLog
    await holder.end()
    await fixture.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
