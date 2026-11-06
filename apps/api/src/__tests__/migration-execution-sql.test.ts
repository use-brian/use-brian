/** [COMP:api/migration-execution-sql] Real historical repinning, ordinary owner. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { toMigrationExecutionSql } from '../../../../packages/api/src/migrations/execution-sql.js'

const migrations = new URL('../../../../packages/api/migrations/', import.meta.url)
const file = '8196_native_turn_annotation_publication.sql'
const source = await readFile(new URL(file, migrations), 'utf8')
const original = source.match(/^DO \$controlled_repin\$[\s\S]*?END \$controlled_repin\$;/m)![0]
const adapted = toMigrationExecutionSql(source, file)
const begin = adapted.indexOf('CREATE TEMP TABLE pg_temp.migration_pin_candidates')
const end = adapted.indexOf('DROP TABLE pg_temp.migration_pin_candidates;', begin) + 'DROP TABLE pg_temp.migration_pin_candidates;'.length
const optimized = adapted.slice(begin, end)
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`

async function fixture() {
  const db = new PGlite({ extensions: { pg_trgm } })
  await db.waitReady
  await db.exec(`CREATE EXTENSION pg_trgm; CREATE ROLE migration_owner NOSUPERUSER NOBYPASSRLS;
    GRANT CREATE ON DATABASE postgres TO migration_owner;
    GRANT CREATE,USAGE ON SCHEMA public TO migration_owner; SET ROLE migration_owner;
    CREATE FUNCTION probe_root() RETURNS text LANGUAGE plpgsql AS $body$BEGIN RETURN 'old %_\\ value'; END$body$;`)
  const old = (await db.query<{ body: string; fingerprint: string; hash: string }>(`SELECT prosrc AS body,
    encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') AS fingerprint,
    encode(sha256(convert_to(prosrc,'UTF8')),'hex') AS hash FROM pg_proc p WHERE oid='probe_root()'::regprocedure`)).rows[0]
  const quoted = (await db.query<{ value: string }>('SELECT quote_literal($1) AS value', [old.body])).rows[0].value
  await db.exec(`CREATE FUNCTION probe_caller() RETURNS text LANGUAGE sql AS ${literal(`SELECT '${old.fingerprint}|${old.hash}'`)};
    CREATE FUNCTION probe_quoted() RETURNS text LANGUAGE sql AS ${literal(`SELECT ${quoted}`)};
    CREATE FUNCTION probe_unrelated() RETURNS text LANGUAGE sql AS 'SELECT ''unchanged''';`)
  const pin = (await db.query<{ pin: string }>(`SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') AS pin
    FROM pg_proc p WHERE oid='probe_caller()'::regprocedure`)).rows[0].pin
  await db.exec(`CREATE FUNCTION probe_transitive() RETURNS text LANGUAGE sql AS ${literal(`SELECT '${pin}'`)};
    BEGIN;
    CREATE TEMP TABLE native_annotation_originals ON COMMIT DROP AS SELECT p.oid,
      to_jsonb(p)-'prosrc' AS metadata,p.prosrc AS body,p.prosrc AS expected_body,
      encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') AS fingerprint,
      encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body_hash,quote_literal(p.prosrc) AS quoted_body
      FROM pg_proc p WHERE proname LIKE 'probe_%';
    CREATE OR REPLACE FUNCTION probe_root() RETURNS text LANGUAGE plpgsql AS $body$BEGIN RETURN 'new %_\\ value'; END$body$;
    UPDATE native_annotation_originals o SET expected_body=p.prosrc FROM pg_proc p WHERE p.oid=o.oid AND p.proname='probe_root';`)
  return { db, old }
}

const catalog = async (db: PGlite) => (await db.query(`SELECT to_jsonb(p) AS value FROM pg_proc p ORDER BY oid`)).rows

test('[COMP:api/migration-execution-sql] repins the identical catalog, including transitive and quoted wildcard consumers, without elevated migration authority', async () => {
  const { db } = await fixture()
  try {
    assert.deepEqual((await db.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows,
      [{ rolsuper: false, rolbypassrls: false }])
    await db.exec('SAVEPOINT comparison')
    await db.exec(original)
    const expected = await catalog(db)
    const expectedRows = (await db.query('SELECT * FROM native_annotation_originals ORDER BY oid')).rows
    await db.exec('ROLLBACK TO SAVEPOINT comparison')
    await db.exec(optimized)
    assert.deepEqual(await catalog(db), expected)
    assert.deepEqual((await db.query('SELECT * FROM native_annotation_originals ORDER BY oid')).rows, expectedRows)
    assert.deepEqual((await db.query('SELECT probe_root() AS root,probe_quoted() AS quoted,probe_unrelated() AS unrelated')).rows,
      [{ root: 'new %_\\ value', quoted: "BEGIN RETURN 'new %_\\ value'; END", unrelated: 'unchanged' }])
    assert.equal((await db.query<{ candidate: string | null }>("SELECT to_regclass('pg_temp.migration_pin_candidates') AS candidate")).rows[0].candidate, null)
  } finally { await db.exec('ROLLBACK'); await db.close() }
})

test('[COMP:api/migration-execution-sql] refuses unknown consumers outside public and preserves the catalog on rollback', async () => {
  const { db, old } = await fixture()
  try {
    await db.exec(`CREATE SCHEMA unexpected; CREATE FUNCTION unexpected.consumer() RETURNS text LANGUAGE sql AS ${literal(`SELECT '${old.fingerprint}'`)};`)
    const before = await catalog(db)
    for (const sql of [original, optimized]) {
      await db.exec('SAVEPOINT refusal')
      await assert.rejects(db.exec(sql), /unauthenticated_pin_consumer/)
      await db.exec('ROLLBACK TO SAVEPOINT refusal')
      assert.deepEqual(await catalog(db), before)
      assert.equal((await db.query<{ candidate: string | null }>("SELECT to_regclass('pg_temp.migration_pin_candidates') AS candidate")).rows[0].candidate, null)
    }
  } finally { await db.exec('ROLLBACK'); await db.close() }
})

test('[COMP:api/migration-execution-sql] authenticates every adapted immutable source and leaves other migrations alone', async () => {
  let count = 0
  for (const name of await readdir(migrations)) {
    if (!name.endsWith('.sql')) continue
    const sql = await readFile(new URL(name, migrations), 'utf8')
    if (!sql.includes('FOR caller IN SELECT p.oid,p.prosrc FROM pg_proc p')) continue
    assert.notEqual(toMigrationExecutionSql(sql, name), sql)
    assert.equal(sql.match(/^BEGIN;\s*$/gm)?.length, 1)
    assert.equal(sql.match(/^COMMIT;\s*$/gm)?.length, 1)
    assert.throws(() => toMigrationExecutionSql(sql + '\n', name), /content changed/)
    count++
  }
  assert.ok(count >= 13)
  assert.equal(toMigrationExecutionSql('SELECT 1;', 'future.sql'), 'SELECT 1;')
})
