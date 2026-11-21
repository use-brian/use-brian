import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import pg from 'pg'
import { tsImport } from 'tsx/esm/api'
import { assertLocalFixture, cloneLocalFixture } from '../crm/local-fixture.mjs'

const { runMigrations } = await tsImport('../../packages/api/scripts/migrate.ts', import.meta.url)

// Forward real PostgreSQL frames and drop the selected command's reply before
// node-postgres receives it. ReadyForQuery distinguishes staged from committed.
async function disconnectOnReply(databaseUrl, migrationDirs, command) {
  const target = new URL(databaseUrl)
  assert.equal(target.hostname, '127.0.0.1')
  let transactionStatus
  const server = createServer(downstream => {
    const upstream = createConnection({ host: target.hostname, port: Number(target.port) })
    downstream.pipe(upstream)
    downstream.on('close', () => upstream.destroy())
    upstream.on('close', () => downstream.destroy())
    downstream.on('error', () => upstream.destroy())
    upstream.on('error', () => downstream.destroy())
    let pending = Buffer.alloc(0)
    let dropping = false
    upstream.on('data', chunk => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 5) {
        const end = pending.readUInt32BE(1) + 1
        if (pending.length < end) break
        const frame = pending.subarray(0, end)
        pending = pending.subarray(end)
        if (frame[0] === 67 && frame.toString('utf8', 5, end - 1) === command) dropping = true // CommandComplete
        if (!dropping) downstream.write(frame)
        if (dropping && frame[0] === 90) { // ReadyForQuery
          transactionStatus = frame.toString('ascii', 5, 6)
          downstream.destroy()
          upstream.destroy()
          break
        }
      }
    })
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const proxyUrl = new URL(databaseUrl)
  proxyUrl.port = String(server.address().port)
  proxyUrl.searchParams.set('sslmode', 'disable')
  try {
    await assert.rejects(runMigrations({ databaseUrl: proxyUrl.href, migrationDirs }), /Connection terminated unexpectedly|ECONNRESET/)
    return transactionStatus
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

test('[COMP:api/migration-retries] populated PostgreSQL upgrades recover a dropped reply and authenticate online indexes', { timeout: 60_000 }, async t => {
  await assertLocalFixture()
  const clone = process.env.BRIAN_ASSURANCE_TEMPLATE ? await cloneLocalFixture() : undefined
  if (clone) Object.assign(process.env, clone.env)
  const databaseUrl = process.env.DATABASE_URL
  const directory = await mkdtemp(join(tmpdir(), 'migration-retries-'))
  const migrationDirs = [...(process.env.MIGRATION_DIRS ?? '').split(':').filter(Boolean), directory]
  const { getPool, getAppPool, queryWithRLS } = await tsImport('../../packages/api/src/db/client.ts', import.meta.url)
  const { getWorkspaceTranscriptionPrefs, setWorkspaceTranscriptionPrefs } = await tsImport('../../packages/api/src/db/workspace-store.ts', import.meta.url)
  const db = getPool()
  const app = getAppPool()
  t.after(async () => {
    await Promise.all([db.end(), app.end()])
    await clone?.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  const query = async (sql, params) => (await db.query(sql, params)).rows
  const migrate = async () => (await runMigrations({ databaseUrl, migrationDirs })).appliedCount
  const receipts = async file => (await query('SELECT name FROM public._migrations WHERE name = $1', [file])).map(row => row.name)
  const write = (file, sql) => writeFile(join(directory, file), sql)
  const role = await query('SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user')
  assert.deepEqual(role, [{ rolsuper: false, rolbypassrls: false, rolcreaterole: false }])
  const [{ server_version: version }] = await query('SHOW server_version')
  const [{ head }] = await query('SELECT max(name) AS head FROM public._migrations')
  t.diagnostic(`Populated predecessor ${head} on PostgreSQL ${version}, ${migrationDirs.length === 1 ? 'open schema' : 'open plus hosted overlay schema'}`)

  const actor = randomUUID(), workspace = randomUUID()
  await query('INSERT INTO public.users(id, auth_provider_id) VALUES ($1::uuid, $1::text)', [actor])
  await query("INSERT INTO public.workspaces(id, name, owner_user_id) VALUES ($1, 'Fictional upgrade workspace', $2)", [workspace, actor])
  await query("INSERT INTO public.workspace_members(workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [workspace, actor])
  const readPrefs = () => getWorkspaceTranscriptionPrefs(workspace)
  const writePrefs = async languageCode => {
    assert.deepEqual(await setWorkspaceTranscriptionPrefs(actor, workspace, { languageCode }), { ok: true, prefs: { languageCode } })
    assert.deepEqual(await readPrefs(), { languageCode })
  }
  await writePrefs('en')

  for (const [label, file, column, command, status, wrapped, language] of [
    ['before commit', '9994_retry_before_commit.sql', 'retry_before_commit', 'INSERT 0 1', 'T', false, 'fr'],
    ['after commit', '9995_retry_after_commit.sql', 'retry_after_commit', 'COMMIT', 'I', true, 'de'],
  ]) {
    await t.test(label, async () => {
      const sql = `-- ROLLBACK is only prose
        ALTER TABLE public.workspaces ADD COLUMN ${column} integer;
        UPDATE public.workspaces SET ${column} = coalesce(${column}, 0) + 1,
          transcription_prefs = '{"languageCode":"${language}"}'::jsonb WHERE id = '${workspace}';
        DO $migration$ BEGIN PERFORM 'COMMIT; ROLLBACK;'; END $migration$;
      `
      await write(file, wrapped ? `/* nested /* syntax */ comment */ BEGIN; ${sql} COMMIT;` : sql)
      assert.equal(await disconnectOnReply(databaseUrl, migrationDirs, command), status)
      const committed = status === 'I'
      assert.deepEqual(await receipts(file), committed ? [file] : [])
      const columns = await query(`SELECT attname FROM pg_attribute WHERE attrelid = 'public.workspaces'::regclass AND attname = $1`, [column])
      assert.deepEqual(columns, committed ? [{ attname: column }] : [])
      assert.deepEqual(await readPrefs(), { languageCode: committed ? language : 'en' })
      assert.equal(await migrate(), committed ? 0 : 1)
      assert.equal(await migrate(), 0)
      assert.deepEqual(await receipts(file), [file])
      assert.deepEqual(await query(`SELECT ${column} FROM public.workspaces WHERE id = $1`, [workspace]), [{ [column]: 1 }])
      assert.deepEqual(await readPrefs(), { languageCode: language })
      await writePrefs('ja')
      const result = await queryWithRLS(actor, 'SELECT current_user AS role, transcription_prefs FROM public.workspaces WHERE id = $1', [workspace])
      assert.deepEqual(result.rows, [{ role: 'app_user', transcription_prefs: { languageCode: 'ja' } }])
    })
  }

  await query('CREATE TABLE public.retry_index_rows (value integer, other integer); INSERT INTO public.retry_index_rows VALUES (1, 1), (1, 2)')
  const online = ddl => `-- migration: concurrent-index\n${ddl};`
  const installed = name => query(`SELECT c.oid, i.indisvalid AS valid FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_index i ON i.indexrelid = c.oid
    WHERE n.nspname = 'public' AND c.relname = $1`, [name])

  await t.test('a completed online index survives a lost build reply without rebuilding', async () => {
    const file = '9996_retry_index.sql'
    await write(file, online('CREATE INDEX CONCURRENTLY retry_index ON public.retry_index_rows USING btree (value) WHERE (value > 0)'))
    assert.equal(await disconnectOnReply(databaseUrl, migrationDirs, 'CREATE INDEX'), 'I')
    const before = await installed('retry_index')
    assert.equal(before[0]?.valid, true)
    assert.deepEqual(await receipts(file), [])
    assert.equal(await migrate(), 1)
    assert.equal(await migrate(), 0)
    assert.deepEqual(await installed('retry_index'), before)
    assert.deepEqual(await receipts(file), [file])
  })

  await t.test('a real failed concurrent build and a wrong valid index cannot acquire a receipt', async () => {
    const file = '9997_retry_unique.sql'
    await write(file, online('CREATE UNIQUE INDEX CONCURRENTLY retry_unique ON public.retry_index_rows USING btree (value)'))
    await assert.rejects(migrate(), error => error.code === '23505')
    const invalid = await installed('retry_unique')
    assert.equal(invalid[0]?.valid, false)
    await assert.rejects(migrate(), /retry_unique is invalid or incomplete/)
    assert.deepEqual(await receipts(file), [])
    assert.deepEqual(await installed('retry_unique'), invalid)
    await query('DROP INDEX CONCURRENTLY public.retry_unique')
    await query('CREATE UNIQUE INDEX retry_unique ON public.retry_index_rows (other)')
    await assert.rejects(migrate(), /mismatched index public.retry_unique/)
    assert.deepEqual(await receipts(file), [])
    await query('DROP INDEX CONCURRENTLY public.retry_unique')
    await query('UPDATE public.retry_index_rows SET value = other')
    assert.equal(await migrate(), 1)
    assert.deepEqual(await receipts(file), [file])
    assert.equal((await installed('retry_unique'))[0]?.valid, true)
  })
})
