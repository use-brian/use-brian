/** [COMP:api/migration-execution-sql] Historical catalog snapshots use local OID order. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { toMigrationExecutionSql } from '../../../../packages/api/src/migrations/execution-sql.js'

const name = '8272_durable_conversation_publications.sql'
const raw = await readFile(new URL(`../../../../packages/api/migrations/${name}`, import.meta.url), 'utf8')
const executable = toMigrationExecutionSql(raw, name)
const manifest = JSON.parse(await readFile(new URL(
  '../../../../packages/api/scripts/conversation-store/publication-recovery-predecessors.json', import.meta.url), 'utf8'))
const contract = (signature: string) => manifest.contracts.find((item: any) => item.signature === signature)
const guard = contract('native_turn_helpers_current()')
const publication = contract('native_turn_publication_contract()')
const templates = [guard.bodyParts[1].slot.template, guard.bodyParts[3].slot.template, publication.bodyParts[1].slot.template]
const literal = (text: string) => `'${text.replaceAll("'", "''")}'`
const renderers = (sql: string, prefix = '') => sql.slice(sql.indexOf(`CREATE FUNCTION pg_temp.${prefix}publication_json(`),
  sql.indexOf('END $source_order$;') + 'END $source_order$;'.length)

async function fixture() {
  const db = new PGlite()
  await db.waitReady
  await db.exec(`CREATE ROLE migration_owner NOSUPERUSER NOBYPASSRLS;
    GRANT CREATE,USAGE ON SCHEMA public TO migration_owner;
    SET ROLE migration_owner;
    CREATE TEMP TABLE local_slots(slot jsonb PRIMARY KEY,value text NOT NULL);
    CREATE FUNCTION pg_temp.publication_slot(slot jsonb) RETURNS text LANGUAGE sql AS
      'SELECT value FROM pg_temp.local_slots WHERE local_slots.slot=$1';`)
  const slots = new Map<string, string>()
  const resolve = (input: any): any => {
    if (Array.isArray(input)) return input.map(resolve)
    if (input && typeof input === 'object') {
      if (input.$slot) {
        const slot = input.$slot, key = JSON.stringify(slot)
        if (!slots.has(key)) {
          // Deliberately reverse declaration order, crossing lexical numeric order.
          let value = String(200000 - slots.size * 137)
          if (slot.kind === 'relationDefaultAcl') value = JSON.stringify(['owner=arwdDxtm/owner', 'app_user=arwd/owner'])
          if (slot.kind === 'ownerAcl') value = `owner=${slot.identity}/owner`
          if (slot.kind === 'constraintTriggerName') value = `RI_ConstraintTrigger_${value}`
          // The production report: source relation predates derivations; the
          // reference trigger predates both recreated foreign keys.
          if (slot.kind === 'relation' && slot.identity === 'public.scope_derivation_sources') value = '24263'
          if (slot.kind === 'relation' && slot.identity === 'public.scope_derivations') value = '24275'
          if (slot.kind === 'trigger' && slot.identity.endsWith('.scope_derivation_sources_reference')) value = '30162'
          slots.set(key, value)
        }
        const value = slots.get(key)!
        return slot.encoding === 'number' ? Number(value) : slot.encoding === 'json' ? JSON.parse(value) : value
      }
      return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, resolve(value)]))
    }
    return input
  }
  const resolved = templates.map(resolve)
  for (const [slot, value] of slots) await db.query('INSERT INTO local_slots VALUES($1::jsonb,$2)', [slot, value])
  return { db, resolved }
}

// Independent reconstruction of the historical aggregate ORDER BY clauses.
const byOid = (a: any, b: any) => Number(a.oid) - Number(b.oid)
const historical = (resolved: any[]) => {
  const [triggers, foreignKey, publication] = structuredClone(resolved)
  triggers.sort(byOid)
  for (const key of ['triggers', 'functions', 'rules']) foreignKey[key]?.sort(byOid)
  foreignKey.relations.sort((a: any, b: any) => Number(a[0]) - Number(b[0]))
  for (const key of ['tables', 'defaults', 'policies', 'triggers', 'constraints', 'rules']) publication[key]?.sort(byOid)
  publication.columns.sort((a: any, b: any) => Number(a[0]) - Number(b[0]) || a[1] - b[1])
  return [triggers, foreignKey, publication]
}

test('[COMP:api/migration-execution-sql] reproduces local-OID snapshots before quoting and sorting guard predicates', async () => {
  const { db, resolved } = await fixture()
  try {
    await db.exec(renderers(raw))
    const legacy = (await db.query<{ body: string }>(
      'SELECT pg_temp.publication_source_body($1,$2::jsonb,false) body', [guard.signature, JSON.stringify(guard.bodyParts)])).rows[0].body
    await db.exec(renderers(executable).replaceAll('CREATE FUNCTION pg_temp.', 'CREATE OR REPLACE FUNCTION pg_temp.'))
    assert.deepEqual((await db.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows,
      [{ rolsuper: false, rolbypassrls: false }])
    const expected = historical(resolved)
    assert.notDeepEqual(resolved, expected)
    assert.deepEqual(expected[1].relations.map((row: any) => row[0]), ['24263', '24275'])
    assert.equal(expected[0][0].tgname, 'scope_derivation_sources_reference')
    for (let index = 0; index < templates.length; index++) {
      const actual = (await db.query<{ value: unknown }>('SELECT pg_temp.publication_ordered_catalog($1::jsonb) value',
        [JSON.stringify(templates[index])])).rows[0].value
      assert.deepEqual(actual, expected[index])
    }
    const body = (await db.query<{ body: string }>(
      'SELECT pg_temp.publication_source_body($1,$2::jsonb,false) body', [guard.signature, JSON.stringify(guard.bodyParts)])).rows[0].body
    assert.notEqual(body, legacy, 'the unadapted migration rejects this legitimate historical snapshot')
    for (const snapshot of expected.slice(0, 2)) {
      const quoted = (await db.query<{ value: string }>('SELECT quote_literal($1::jsonb::text) value', [JSON.stringify(snapshot)])).rows[0].value
      assert.ok(body.includes(quoted), 'catalog ordering must happen before SQL literal serialization')
    }
    // Final guard successor changes only its roster, retaining both catalog
    // templates. Exercise the real successor source-order validation as well.
    const sourceOrder = executable.slice(executable.indexOf('CREATE FUNCTION pg_temp.publication_source_body('), executable.indexOf('END $source_order$;'))
    const nextNames = JSON.parse(sourceOrder.match(/FROM jsonb_array_elements_text\(CASE WHEN successor THEN '(.*?)'::jsonb ELSE /s)![1].replaceAll("''", "'")) as string[]
    const successorParts = structuredClone(guard.bodyParts)
    const oldRoster = successorParts[4].match(/array_agg\(h.signature ORDER BY h.signature\)=(ARRAY\[.*?\])::text\[\]/s)![1]
    successorParts[4] = successorParts[4].replace(oldRoster, `ARRAY[${nextNames.map(literal).join(',')}]`)
    const successor = (await db.query<{ body: string }>(
      'SELECT pg_temp.publication_source_body($1,$2::jsonb,true) body', [guard.signature, JSON.stringify(successorParts)])).rows[0].body
    for (const snapshot of expected.slice(0, 2)) {
      const quoted = (await db.query<{ value: string }>('SELECT quote_literal($1::jsonb::text) value', [JSON.stringify(snapshot)])).rows[0].value
      assert.ok(successor.includes(quoted))
    }
    assert.notEqual(successor, body)
  } finally { await db.close() }
})

for (const [file, prefix] of [
  ['8273_conversation_requirement_conversion.sql', 'c8273_'],
  ['8274_inputtable_executable_contracts.sql', 'a8273_'],
]) test(`[COMP:api/migration-execution-sql] preserves local catalog ordering in ${file}`, async () => {
  const source = await readFile(new URL(`../../../../packages/api/migrations/${file}`, import.meta.url), 'utf8')
  const adapted = toMigrationExecutionSql(source, file)
  const { db, resolved } = await fixture()
  try {
    await db.exec(`CREATE FUNCTION pg_temp.${prefix}publication_slot(slot jsonb) RETURNS text LANGUAGE sql AS
      'SELECT pg_temp.publication_slot($1)'`)
    await db.exec(renderers(adapted, prefix))
    const expected = historical(resolved)
    for (let index = 0; index < templates.length; index++) {
      assert.deepEqual((await db.query<{ value: unknown }>(`SELECT pg_temp.${prefix}publication_ordered_catalog($1::jsonb) value`,
        [JSON.stringify(templates[index])])).rows[0].value, expected[index])
    }
    assert.ok(adapted.includes(`publication_predecessor_table_snapshot SELECT pg_temp.${prefix}publication_ordered_catalog(`))
    assert.ok(!adapted.includes(`publication_predecessor_table_snapshot SELECT pg_temp.${prefix}publication_json(`))
    assert.throws(() => toMigrationExecutionSql(source + '\n', file), /historical migration content changed/)
  } finally { await db.close() }
})

test('[COMP:api/migration-execution-sql] leaves non-profile arrays and unexpected catalog values unchanged', async () => {
  const { db, resolved } = await fixture()
  try {
    await db.exec(renderers(executable))
    const unrelated = { acl: ['z', 'a'], conkey: [2, 1], rows: [{ oid: '9' }, { oid: '2' }] }
    assert.deepEqual((await db.query<{ value: unknown }>('SELECT pg_temp.publication_ordered_catalog($1::jsonb) value',
      [JSON.stringify(unrelated)])).rows[0].value, unrelated)
    const expected = historical(resolved)[1]
    const mutations = [
      (value: any) => { value.constraint.confdeltype = 'a' },
      (value: any) => { value.constraint.conkey.reverse() },
      (value: any) => { value.relations[0][2].reverse() },
      (value: any) => { value.triggers[0].tgenabled = 'D' },
    ]
    for (const mutate of mutations) {
      const installed = structuredClone(expected)
      mutate(installed)
      assert.notDeepEqual(installed, expected)
      assert.equal((await db.query<{ matches: boolean }>(
        'SELECT pg_temp.publication_ordered_catalog($1::jsonb)=$2::jsonb matches',
        [JSON.stringify(templates[1]), JSON.stringify(installed)])).rows[0].matches, false)
    }
    assert.ok(executable.includes("ELSIF p.prosrc IS DISTINCT FROM pg_temp.publication_source_body(signature,expected->'bodyParts',false) THEN"))
    assert.ok(executable.includes("RAISE EXCEPTION 'publication_upstream_memory_body_changed: %',signature"))
    assert.throws(() => toMigrationExecutionSql(raw + '\n', name), /historical migration content changed/)
    assert.equal(toMigrationExecutionSql(raw, 'future.sql'), raw)
    // No DDL is run outside the existing transaction or under elevated authority.
    assert.equal(executable.match(/^BEGIN;$/gm)?.length, 1)
    assert.equal(executable.match(/^COMMIT;$/gm)?.length, 1)
  } finally { await db.close() }
})
