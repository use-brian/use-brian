/** [COMP:api/migration-execution-sql] Real historical repinning, ordinary owner. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
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

const memoryFile = '8246_native_private_memory_empty_domain.sql'
const memorySource = await readFile(new URL(memoryFile, migrations), 'utf8')
const memoryExecution = toMigrationExecutionSql(memorySource, memoryFile)
const memoryBlock = memoryExecution.match(/^DO \$private_memory_domain_profile\$[\s\S]*?END \$private_memory_domain_profile\$;/m)![0]
const declarationEnd = memoryBlock.indexOf('\nBEGIN\n')
const initializationEnd = memoryBlock.indexOf(' SELECT relowner INTO STRICT owner_oid')
const guardStart = memoryBlock.indexOf(" SELECT * INTO STRICT routine FROM pg_proc WHERE oid='native_turn_helpers_current()'::regprocedure;")
// Execute the exact adapted enrollment, independently of the six unchanged
// operative replacements. Full migration-chain replay covers those contracts.
const enrollment = `DO $fixture_enrollment$${memoryBlock.slice('DO $private_memory_domain_profile$'.length, initializationEnd)}
 SELECT relowner INTO STRICT owner_oid FROM pg_class WHERE oid='public.memories'::regclass;
${memoryBlock.slice(guardStart, memoryBlock.lastIndexOf('END $private_memory_domain_profile$;'))}END $fixture_enrollment$;`
const beforeRoster = memorySource.split('$native_guard_before$')[1]
const afterRoster = memorySource.split('$native_guard_after$')[1]
const beforeMembers = [...beforeRoster.matchAll(/'([^']*)'/g)].map(match => match[1])
const rosterLiteral = (members: readonly string[]) => `ARRAY[${members.map(literal).join(',')}]::text[]`
const bootstrap = await readFile(new URL('8183_native_turn_requirements.sql', migrations), 'utf8')
const guardDefinitionStart = bootstrap.indexOf('CREATE FUNCTION native_turn_helpers_current()')
const guardDefinition = bootstrap.slice(guardDefinitionStart, bootstrap.indexOf('$$;', guardDefinitionStart) + 3)
const originalGuardBody = guardDefinition.split('AS $$')[1].slice(0, -3)
  .replace('SELECT EXISTS', 'SELECT native_turn_publication_contract() AND EXISTS')
  .replace('count(*)>0', `array_agg(h.signature ORDER BY h.signature)=${beforeRoster}`)
const templateHash = '803d9cd34a7c94347e32172c77ea7387d5cb8e642f905ca08f7f18b796451255'
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

async function enrollmentFixture(body = originalGuardBody) {
  const db = new PGlite()
  await db.waitReady
  await db.exec(`CREATE ROLE migration_owner NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE other_owner NOSUPERUSER NOBYPASSRLS;
    GRANT other_owner TO migration_owner;
    GRANT CREATE,USAGE ON SCHEMA public TO migration_owner,other_owner;
    SET ROLE migration_owner;
    CREATE TABLE fixture_memories(id uuid);
    CREATE VIEW memories AS SELECT id FROM fixture_memories;
    CREATE TABLE native_turn_contract_helpers(signature text PRIMARY KEY,fingerprint text NOT NULL);
    CREATE FUNCTION native_turn_publication_contract() RETURNS boolean LANGUAGE sql AS 'SELECT true';
    CREATE FUNCTION application_memory_statement_helpers_current() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
      SET search_path=pg_catalog,public,pg_temp AS 'BEGIN RETURN true;END';
    CREATE FUNCTION native_turn_helpers_current() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path=pg_catalog,public,pg_temp AS ${literal(body)};
    REVOKE ALL ON FUNCTION native_turn_helpers_current(),application_memory_statement_helpers_current() FROM PUBLIC;
    CREATE FUNCTION fixture_sentinel() RETURNS text LANGUAGE sql AS 'SELECT ''before''';
    BEGIN;
    CREATE TEMP TABLE private_memory_profile_originals ON COMMIT DROP AS
      SELECT oid,prosrc expected_body,to_jsonb(p)-'prosrc' metadata FROM pg_proc p WHERE oid='native_turn_helpers_current()'::regprocedure;`)
  for (const member of beforeMembers) await db.query('INSERT INTO native_turn_contract_helpers VALUES($1,$2)', [member, 'fixture'])
  return db
}

test('[COMP:api/migration-execution-sql] enrolls the exact native guard under the database collation and preserves catalog metadata', async () => {
  const db = await enrollmentFixture()
  try {
    assert.ok(declarationEnd > 0 && initializationEnd > declarationEnd && guardStart > initializationEnd)
    const before = (await db.query<{ metadata: unknown }>("SELECT to_jsonb(p)-'prosrc' metadata FROM pg_proc p WHERE oid='native_turn_helpers_current()'::regprocedure")).rows[0].metadata
    await db.exec(enrollment)
    const after = (await db.query<{ body: string; metadata: unknown }>("SELECT prosrc body,to_jsonb(p)-'prosrc' metadata FROM pg_proc p WHERE oid='native_turn_helpers_current()'::regprocedure")).rows[0]
    const localRoster = (await db.query<{ value: string }>(`SELECT 'ARRAY['||string_agg(quote_literal(signature),',' ORDER BY signature)||']::text[]' value FROM unnest(${afterRoster}) declared(signature)`)).rows[0].value
    assert.equal(after.body, originalGuardBody.replace(beforeRoster, localRoster))
    assert.equal(digest(after.body.replace(localRoster, '__ROSTER__')), templateHash)
    assert.deepEqual(after.metadata, before)
    assert.equal((await db.query<{ count: number }>('SELECT count(*)::int count FROM native_turn_contract_helpers')).rows[0].count, 149)
    assert.equal((await db.query<{ current: boolean }>(`SELECT h.fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') current
      FROM native_turn_contract_helpers h JOIN pg_proc p ON p.oid='application_memory_statement_helpers_current()'::regprocedure
      WHERE h.signature='application_memory_statement_helpers_current()'`)).rows[0].current, true)
    assert.deepEqual((await db.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows, [{ rolsuper: false, rolbypassrls: false }])
  } finally { await db.exec('ROLLBACK'); await db.close() }
})

test('[COMP:api/migration-execution-sql] authenticates the captured locale-sensitive roster as the identical guard template', () => {
  // These punctuation-order differences reproduce the captured libc en_US
  // guard without including deployment identifiers or any live data.
  const members = [...beforeMembers]
  const reorder = (names: string[]) => {
    const positions = names.map(name => members.indexOf(name)).sort((a, b) => a - b)
    assert.ok(positions.every(position => position >= 0))
    positions.forEach((position, index) => { members[position] = names[index] })
  }
  reorder(['native_turn_completed_field(uuid,uuid,text,jsonb,jsonb)', 'native_turn_completed_point(uuid,text,uuid,text[],jsonb,jsonb)', 'native_turn_completed_scope(uuid,text,uuid,text,jsonb,jsonb)', 'native_turn_complete_publication()'])
  reorder(['native_turn_parent_scope(uuid,uuid)', 'native_turn_parent(uuid,uuid,jsonb)'])
  reorder(['read_scope_source_before_knowledge_binding(uuid,text,uuid)', 'read_scope_source(uuid,text,uuid)'])
  reorder(['scope_source_table_before_knowledge_versions(text)', 'scope_source_table(text)'])
  const capturedRoster = rosterLiteral(members), capturedBody = originalGuardBody.replace(beforeRoster, capturedRoster)
  assert.equal(digest(originalGuardBody), 'd76edcc03ae49ebbe10bebbe198267aeff0837d597085058aaab0a65ab6247a2')
  assert.equal(digest(capturedBody), '9f10ce290abf7cdbec0aa9af8db3f72cb9343609058b632f5231d23045acef8b')
  assert.equal(digest(capturedBody.replace(capturedRoster, '__ROSTER__')), templateHash)
  assert.equal(new Set(members).size, 148)
  assert.deepEqual([...members].sort(), [...beforeMembers].sort())
  assert.ok(memoryExecution.includes("string_agg(quote_literal(signature),',' ORDER BY signature)"))
  assert.ok(!memoryExecution.includes("EXECUTE 'SELECT '||original"))
})

test('[COMP:api/migration-execution-sql] rejects altered members, code, anchors and metadata atomically', async () => {
  const replaceGuard = (db: PGlite, body: string) => db.exec(`CREATE OR REPLACE FUNCTION native_turn_helpers_current() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS ${literal(body)}`)
  const cases: Array<[string, (db: PGlite) => Promise<unknown>]> = [
    ['extra member', db => replaceGuard(db, originalGuardBody.replace(beforeRoster, rosterLiteral([...beforeMembers, 'unexpected()'])))],
    ['missing member', db => replaceGuard(db, originalGuardBody.replace(beforeRoster, rosterLiteral(beforeMembers.slice(1))))],
    ['duplicate member', db => replaceGuard(db, originalGuardBody.replace(beforeRoster, rosterLiteral([...beforeMembers.slice(1), beforeMembers[1]])))],
    ['non-roster code', db => replaceGuard(db, originalGuardBody.replace('SELECT native_turn_publication_contract()', 'SELECT true OR native_turn_publication_contract()'))],
    ['multiple anchors', db => replaceGuard(db, originalGuardBody + `-- ${beforeRoster}\n`)],
    ['volatility', db => db.exec('ALTER FUNCTION native_turn_helpers_current() VOLATILE')],
    ['owner', db => db.exec('ALTER FUNCTION native_turn_helpers_current() OWNER TO other_owner')],
    ['execution grants', db => db.exec('GRANT EXECUTE ON FUNCTION native_turn_helpers_current() TO PUBLIC')],
    ['security mode', db => db.exec('ALTER FUNCTION native_turn_helpers_current() SECURITY INVOKER')],
    ['search path', db => db.exec('ALTER FUNCTION native_turn_helpers_current() SET search_path=public')],
  ]
  const db = await enrollmentFixture()
  try {
    for (const [name, tamper] of cases) {
      const before = await catalog(db)
      await db.exec('SAVEPOINT refusal')
      await tamper(db)
      await db.exec("CREATE OR REPLACE FUNCTION fixture_sentinel() RETURNS text LANGUAGE sql AS 'SELECT ''attempted'''")
      await assert.rejects(db.exec(enrollment), /private_memory_profile_native_guard_changed/, name)
      await db.exec('ROLLBACK TO SAVEPOINT refusal')
      assert.deepEqual(await catalog(db), before, name)
      assert.equal((await db.query<{ count: number }>('SELECT count(*)::int count FROM native_turn_contract_helpers')).rows[0].count, 148, name)
      assert.equal((await db.query<{ value: string }>('SELECT fixture_sentinel() value')).rows[0].value, 'before', name)
    }
  } finally { await db.exec('ROLLBACK'); await db.close() }
})
