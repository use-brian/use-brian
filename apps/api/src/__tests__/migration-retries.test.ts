import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { isNewMigration } from '@use-brian/api/migrations/transaction-sql.js'
import { migratePglite } from '../migrate-pglite.js'

test('[COMP:api/migration-retries] protocol follows the existing forward filename order', () => {
  for (const file of ['000_overlay_v1.sql', '620_drop_email_archive_trgm.sql', '82980_legacy.sql', '8332_previous.sql']) {
    assert.equal(isNewMigration(file), false, file)
  }
  for (const file of ['83330_prerequisite.sql', '8333_next.sql', '9999_future.sql']) {
    assert.equal(isNewMigration(file), true, file)
  }
})

test('[COMP:api/migration-retries] embedded upgrade rolls back on receipt failure and records a canonical index once', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pglite-migration-retries-'))
  const db = new PGlite()
  t.after(async () => {
    await db.close()
    await rm(directory, { recursive: true, force: true })
  })
  await db.exec('CREATE ROLE migration_owner NOSUPERUSER NOBYPASSRLS; ALTER SCHEMA public OWNER TO migration_owner; SET ROLE migration_owner')
  const install = () => migratePglite(db, directory)
  const write = (file: string, sql: string) => writeFile(join(directory, file), sql)
  await write('8332_predecessor.sql', 'BEGIN;\nCREATE TABLE public.retry_rows (id integer);\nCOMMIT;')
  assert.equal(await install(), 1)
  await db.exec('INSERT INTO public.retry_rows VALUES (5), (7)')

  const file = '8333_retry_rows.sql'
  await write(file, String.raw`/* comment /* ROLLBACK; */ with ; */ begin;
    ALTER TABLE public.retry_rows ADD COLUMN installed integer;
    UPDATE public.retry_rows SET installed = id * 2;
    DO $migration$ BEGIN PERFORM E'escaped\'quote; COMMIT;'; END $migration$;
    SELECT 'CONCURRENTLY; BEGIN; END;';
    commit;`)
  await db.exec(`ALTER TABLE public._migrations ADD CONSTRAINT reject_receipt CHECK (name <> '${file}')`)
  await assert.rejects(install(), /reject_receipt/)
  assert.deepEqual((await db.query('SELECT * FROM public.retry_rows ORDER BY id')).rows, [{ id: 5 }, { id: 7 }])
  assert.deepEqual((await db.query('SELECT name FROM public._migrations WHERE name = $1', [file])).rows, [])
  await db.exec('ALTER TABLE public._migrations DROP CONSTRAINT reject_receipt')
  assert.equal(await install(), 1)
  assert.equal(await install(), 0)
  assert.deepEqual((await db.query('SELECT * FROM public.retry_rows ORDER BY id')).rows, [{ id: 5, installed: 10 }, { id: 7, installed: 14 }])

  const index = '8334_retry_index.sql'
  await write(index, `-- migration: concurrent-index
    CREATE INDEX CONCURRENTLY retry_value ON public.retry_rows USING btree (installed);`)
  assert.equal(await install(), 1)
  assert.equal(await install(), 0)
  assert.deepEqual((await db.query(`SELECT indisvalid, indisready, indislive FROM pg_index WHERE indexrelid = 'public.retry_value'::regclass`)).rows,
    [{ indisvalid: true, indisready: true, indislive: true }])
  assert.deepEqual((await db.query(`SELECT name FROM public._migrations WHERE name IN ($1, $2) ORDER BY name`, [file, index])).rows, [{ name: file }, { name: index }])

  await write('8335_refused.sql', 'CREATE TABLE public.uncommitted(id integer); END AND CHAIN;')
  await assert.rejects(install(), /transaction control belongs to the migration runner/)
  assert.deepEqual((await db.query(`SELECT to_regclass('public.uncommitted') AS relation`)).rows, [{ relation: null }])
})
