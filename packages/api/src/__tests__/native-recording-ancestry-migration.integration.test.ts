/** [COMP:api/native-chat-read-cost] Actual forward migration and drift refusal on an owned local database. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { PoolClient } from 'pg'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getPool } from '../db/client.js'

const { assertLocalFixture } = await import(new URL('../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const migration = await readFile(new URL('../../migrations/8261_native_recording_file_ancestry.sql', import.meta.url), 'utf8')
const changes = JSON.parse(migration.split('$media_changes$')[1]) as Array<{ sig: string; sha: string; edits: Array<{ before: string; after: string }> }>
const actualMigration = migration.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '')
const dependencyMigration = await readFile(new URL('../../migrations/8262_native_media_admission_dependency.sql', import.meta.url), 'utf8')
const actualDependencyMigration = dependencyMigration.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '')
const fragment = (name: string) => dependencyMigration.split(`$${name}$`)[1]
const dependencyContract = JSON.parse(fragment('media_target_contract')) as { sha: string }
const dependencies = JSON.parse(fragment('media_dependencies')) as Array<{ signature: string }>
const holdMigration = await readFile(new URL('../../migrations/8263_native_declared_media_hold.sql', import.meta.url), 'utf8')
const actualHoldMigration = holdMigration.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '')
const holdFragment = (name: string) => holdMigration.split(`$${name}$`)[1]
const compactContract = JSON.parse(holdFragment('hold_compact_contract')) as { sha: string }
const sha = (body: string) => createHash('sha256').update(body).digest('hex')
let client: PoolClient
let original: unknown
let originalDependencies: unknown

async function state() {
  return (await client.query(`SELECT h.signature,to_jsonb(p) routine,h.fingerprint FROM native_turn_contract_helpers h
    JOIN pg_proc p ON p.oid=to_regprocedure(h.signature) WHERE h.signature=ANY($1) ORDER BY h.signature`,
  [changes.map(change => change.sig)])).rows
}
async function repin() {
  await client.query(`UPDATE native_turn_contract_helpers h SET fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
    FROM pg_proc p WHERE p.oid=to_regprocedure(h.signature) AND h.signature=ANY($1)`, [changes.map(change => change.sig)])
}
async function dependencyState() {
  return (await client.query('SELECT to_jsonb(p) routine FROM pg_proc p WHERE oid=ANY($1::regprocedure[]) ORDER BY oid',
    [dependencies.map(dependency => dependency.signature)])).rows
}
async function replaceBody(signature: string, transform: (body: string) => string) {
  const current = (await client.query<{ definition: string; body: string }>(
    'SELECT pg_get_functiondef($1::regprocedure) definition,prosrc body FROM pg_proc WHERE oid=$1::regprocedure', [signature])).rows[0]
  const next = transform(current.body)
  await client.query(current.definition.replace(current.body, () => next))
}
async function refuses(reason: string) {
  const before = await state()
  await client.query('SAVEPOINT refusal')
  await expect(client.query(actualMigration)).rejects.toThrow(reason)
  await client.query('ROLLBACK TO SAVEPOINT refusal')
  expect(await state()).toEqual(before)
}

async function setup(predecessor: '8261' | '8262' | '8263') {
  client = await getPool().connect()
  await client.query('BEGIN')
  original = await state()
  originalDependencies = await dependencyState()
  expect((original as unknown[]).length).toBe(changes.length)
  const packet: string[] = []
  for (const dependency of dependencies) {
    const row = (await client.query<{ oid: number; fingerprint: string }>(`SELECT oid,
      encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') fingerprint FROM pg_proc p WHERE oid=$1::regprocedure`,
    [dependency.signature])).rows[0]
    packet.push(`(${row.oid}::oid,'${row.fingerprint}'::text)`)
  }
  await replaceBody('native_turn_capture_sources(uuid,jsonb)', body => {
    if (body.includes(holdFragment('hold_declaration_after'))) {
      const preflight = holdFragment('hold_preflight_after').replaceAll('__MEDIA_PINS__', packet.join(','))
      expect(body.split(preflight).length).toBe(2)
      body = body.replace(preflight, () => holdFragment('hold_preflight_before'))
        .replace(holdFragment('hold_declaration_after'), () => holdFragment('hold_declaration_before'))
    }
    if (predecessor === '8263') {
      const normalized = body.replace(fragment('media_dependency_after').replaceAll('__MEDIA_PINS__', packet.join(',')),
        () => fragment('media_dependency_before'))
      expect(sha(normalized)).toBe(dependencyContract.sha)
      return body
    }
    if (sha(body) === dependencyContract.sha || sha(body) === changes[0].sha) return body
    const successor = fragment('media_dependency_after').replaceAll('__MEDIA_PINS__', packet.join(','))
    expect(body.split(successor).length).toBe(2)
    body = body.replace(successor, () => fragment('media_dependency_before'))
    expect(sha(body)).toBe(dependencyContract.sha)
    return body
  })
  await replaceBody('native_turn_capture_compact_requirements(uuid,jsonb,jsonb)', body => {
    if (body.includes(holdFragment('hold_compact_after'))) {
      body = body.replace(holdFragment('hold_compact_after'), () => holdFragment('hold_compact_before'))
    }
    expect(sha(body)).toBe(compactContract.sha)
    return body
  })
  // Reconstruct the authenticated predecessor inside this rollback-only
  // transaction. No fixture helper replaces canonical admission or policy.
  if (predecessor === '8261') for (const change of changes) await replaceBody(change.sig, body => {
    if (sha(body) === change.sha) return body
    for (const edit of [...change.edits].reverse()) {
      expect(body.split(edit.after).length).toBe(2)
      body = body.replace(edit.after, () => edit.before)
    }
    expect(sha(body)).toBe(change.sha)
    return body
  })
  await repin()
}
afterEach(async () => {
  if (!client) return
  try {
    await client.query('ROLLBACK')
    expect(await state()).toEqual(original)
    expect(await dependencyState()).toEqual(originalDependencies)
  } finally { client.release() }
})
afterAll(async () => { await getPool().end() })

describe.sequential('[COMP:api/native-chat-read-cost] recording ancestry forward migration', () => {
  beforeEach(() => setup('8261'))
  it('preserves exact routine metadata and advances only the five authenticated registry pins', async () => {
    const before = await state()
    await client.query(actualMigration)
    const after = await state()
    expect(after.map(row => row.signature)).toEqual(before.map(row => row.signature))
    for (const [index, row] of after.entries()) {
      const { prosrc: _afterBody, ...afterMetadata } = row.routine
      const { prosrc: _beforeBody, ...beforeMetadata } = before[index].routine
      expect(afterMetadata).toEqual(beforeMetadata)
      expect(row.fingerprint).not.toBe(before[index].fingerprint)
    }
    expect((await client.query('SELECT native_turn_helpers_current() value')).rows[0].value).toBe(true)
  })

  it('refuses source drift even when the forged registry matches that drift', async () => {
    await replaceBody(changes[0].sig, body => `${body}\n-- Fictional unreviewed drift\n`)
    await repin()
    await refuses('native_media_ancestry_predecessor_changed')
  })

  it('refuses changed execution authority even with a matching registry', async () => {
    await client.query(`ALTER FUNCTION ${changes[0].sig} SECURITY INVOKER`)
    await repin()
    await refuses('native_media_ancestry_predecessor_changed')
  })

  it('refuses an executable literal pin consumer without changing any helper', async () => {
    const fingerprint = (await state())[0].fingerprint
    await client.query(`CREATE FUNCTION fixture_unreviewed_media_pin() RETURNS text LANGUAGE sql
      AS $body$SELECT '${fingerprint}'::text$body$`)
    await refuses('native_media_ancestry_unexpected_pin_consumer')
  })

  it('refuses a changed registry before replacing any helper', async () => {
    await client.query('UPDATE native_turn_contract_helpers SET fingerprint=repeat(\'0\',64) WHERE signature=$1', [changes[0].sig])
    await refuses('native_media_ancestry_dependency_changed')
  })
})

describe.sequential('[COMP:api/native-chat-read-cost] canonical media dependency forward migration', () => {
  beforeEach(() => setup('8262'))

  it.each(['current', 'explicit_public', 'explicit_public_app'] as const)(
    'preserves execution metadata and actual dependency ACL bytes for %s', async profile => {
    if (profile !== 'current') for (const dependency of dependencies) {
      if (profile === 'explicit_public') await client.query(`REVOKE EXECUTE ON FUNCTION ${dependency.signature} FROM app_user`)
      await client.query(`REVOKE EXECUTE ON FUNCTION ${dependency.signature} FROM PUBLIC`)
      await client.query(`GRANT EXECUTE ON FUNCTION ${dependency.signature} TO PUBLIC`)
      if (profile === 'explicit_public_app') await client.query(`GRANT EXECUTE ON FUNCTION ${dependency.signature} TO app_user`)
    }
    const aclBefore = await dependencyState()
    if (profile !== 'current') for (const dependency of dependencies) {
      const acl = (await client.query<{ count: number; distinct_count: number; acl_null: boolean }>(`SELECT a.*,p.proacl IS NULL acl_null
        FROM pg_proc p CROSS JOIN LATERAL(SELECT count(*)::int count,count(DISTINCT privilege.grantee)::int distinct_count
          FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) privilege) a
        WHERE p.oid=$1::regprocedure`, [dependency.signature])).rows[0]
      expect(acl).toEqual({ count: profile === 'explicit_public' ? 2 : 3, distinct_count: profile === 'explicit_public' ? 2 : 3, acl_null: false })
    }
    const before = await state()
    await client.query(actualDependencyMigration)
    const after = await state()
    expect(await dependencyState()).toEqual(aclBefore)
    for (const [index, row] of after.entries()) {
      const { prosrc: afterBody, ...afterMetadata } = row.routine
      const { prosrc: beforeBody, ...beforeMetadata } = before[index].routine
      expect(afterMetadata).toEqual(beforeMetadata)
      if (row.signature === 'native_turn_capture_sources(uuid,jsonb)') {
        expect(afterBody).not.toBe(beforeBody)
        expect(afterBody.match(/Canonical media admission dependency fence\./g)).toHaveLength(2)
      } else expect(row).toEqual(before[index])
    }
  })

  it('refuses a permissive canonical media callee before embedding any pin', async () => {
    await replaceBody('media_parent_visible(text,uuid)', () => 'BEGIN RETURN true;END')
    const before = await state()
    await client.query('SAVEPOINT dependency_refusal')
    await expect(client.query(actualDependencyMigration)).rejects.toThrow('native_media_admission_dependency_changed')
    await client.query('ROLLBACK TO SAVEPOINT dependency_refusal')
    expect(await state()).toEqual(before)
  })

  it.each([
    'ALTER FUNCTION media_parent_visible(text,uuid) SECURITY INVOKER',
    'REVOKE ALL ON FUNCTION media_parent_visible(text,uuid) FROM PUBLIC',
    'GRANT EXECUTE ON FUNCTION media_parent_visible(text,uuid) TO app_user WITH GRANT OPTION',
    'GRANT EXECUTE ON FUNCTION media_parent_visible(text,uuid) TO pg_read_all_data',
  ])('refuses canonical callee execution metadata drift: %s', async change => {
    await client.query(change)
    await client.query('SAVEPOINT dependency_refusal')
    await expect(client.query(actualDependencyMigration)).rejects.toThrow('native_media_admission_dependency_changed')
    await client.query('ROLLBACK TO SAVEPOINT dependency_refusal')
  })

  it('refuses a public/app ACL missing the mandatory owner entry', async () => {
    await client.query('GRANT EXECUTE ON FUNCTION media_parent_visible(text,uuid) TO app_user')
    const statement = (await client.query<{ sql: string }>(`SELECT format(
      'REVOKE EXECUTE ON FUNCTION media_parent_visible(text,uuid) FROM %I',pg_get_userbyid(proowner)) sql
      FROM pg_proc WHERE oid='media_parent_visible(text,uuid)'::regprocedure`)).rows[0].sql
    await client.query(statement)
    await client.query('SAVEPOINT dependency_refusal')
    await expect(client.query(actualDependencyMigration)).rejects.toThrow('native_media_admission_dependency_changed')
    await client.query('ROLLBACK TO SAVEPOINT dependency_refusal')
  })
})

describe.sequential('[COMP:api/native-chat-read-cost] declared media denial forward migration', () => {
  beforeEach(() => setup('8263'))

  it('preserves every routine authority field while advancing only the two reviewed pins', async () => {
    const before = await state()
    await client.query(actualHoldMigration)
    const after = await state()
    for (const [index, row] of after.entries()) {
      const { prosrc: afterBody, ...afterMetadata } = row.routine
      const { prosrc: beforeBody, ...beforeMetadata } = before[index].routine
      expect(afterMetadata).toEqual(beforeMetadata)
      if (['native_turn_capture_sources(uuid,jsonb)', 'native_turn_capture_compact_requirements(uuid,jsonb,jsonb)'].includes(row.signature)) {
        expect(afterBody).not.toBe(beforeBody)
        expect(row.fingerprint).not.toBe(before[index].fingerprint)
      } else expect(row).toEqual(before[index])
    }
  })

  it.each(['native_turn_capture_sources(uuid,jsonb)', 'native_turn_capture_compact_requirements(uuid,jsonb,jsonb)'])(
    'refuses forged source and registry drift in %s', async signature => {
      await replaceBody(signature, body => `${body}\n-- Fictional unreviewed denial drift\n`)
      await repin()
      await client.query('SAVEPOINT hold_refusal')
      await expect(client.query(actualHoldMigration)).rejects.toThrow('native_declared_media_predecessor_changed')
      await client.query('ROLLBACK TO SAVEPOINT hold_refusal')
    })

  it('refuses permissive canonical dependency drift before constructing a new packet', async () => {
    await replaceBody('media_parent_visible(text,uuid)', () => 'BEGIN RETURN true;END')
    await client.query('SAVEPOINT hold_refusal')
    await expect(client.query(actualHoldMigration)).rejects.toThrow('native_declared_media_dependency_changed')
    await client.query('ROLLBACK TO SAVEPOINT hold_refusal')
  })

  it('refuses a new executable pin consumer before either helper changes', async () => {
    const target = (await state()).find(row => row.signature === 'native_turn_capture_sources(uuid,jsonb)')!
    await client.query(`CREATE FUNCTION fixture_unreviewed_hold_pin() RETURNS text LANGUAGE sql AS $body$SELECT '${target.fingerprint}'::text$body$`)
    await client.query('SAVEPOINT hold_refusal')
    await expect(client.query(actualHoldMigration)).rejects.toThrow('native_declared_media_unexpected_pin_consumer')
    await client.query('ROLLBACK TO SAVEPOINT hold_refusal')
  })
})
