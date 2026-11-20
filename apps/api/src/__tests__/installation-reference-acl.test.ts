/**
 * [COMP:api/native-turn-frame] The 8274 predecessor authentication compiles its
 * erasure-target reference with the same inherited table ACL that the maintained
 * bootstrap gives migration 522's table, whichever role was created first.
 *
 * PostgreSQL sorts default-ACL items by grantee OID. Ordinary-owner PGlite
 * creates app_user before the owner; the native profile creates its owner first.
 * An appended GRANT on the reference only matches the second order.
 *
 * Spec: docs/architecture/platform/database-schema.md -> "Inputtable executable registry (8274)".
 */
import { PGlite } from '@electric-sql/pglite'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { preparePgliteRuntimeRole } from '../migrate-pglite.js'

const sourceRoot = fileURLToPath(new URL('../../../../packages/api/', import.meta.url))
const compilerPath = sourceRoot + 'scripts/conversation-store/installation-authentication-8273.mjs'
const migrationPath = sourceRoot + 'migrations/8274_inputtable_executable_contracts.sql'
const reference = 'a8273_conversion_source_reference'

/** The compiled reference DDL for the three added input tables, verbatim. */
async function compiledReferenceDdl(): Promise<string> {
  const { currentInstallationAuthenticationSource } = await import(compilerPath)
  const { sql } = await currentInstallationAuthenticationSource({ sourceRoot })
  const start = sql.indexOf(`CREATE TABLE ${reference}.native_turn_contract_helpers(`)
  const end = sql.indexOf('DO $conversion_assert_source_relations$', start)
  assert.ok(start > 0 && end > start, 'compiled reference section')
  return sql.slice(start, end)
}

async function migration522Table(): Promise<string> {
  const source = await readFile(sourceRoot + 'migrations/522_crm_erasure_journal.sql', 'utf8')
  const start = source.indexOf('CREATE TABLE public.crm_erasure_journal_targets (')
  return source.slice(start, source.indexOf(');', start) + 2)
}

/** Ordinary-owner fixture in either role order, with the maintained bootstrap defaults. */
async function openFixture(order: 'runtime-first' | 'owner-first'): Promise<PGlite> {
  const db = new PGlite()
  await db.waitReady
  if (order === 'owner-first') await db.exec('CREATE ROLE migration_owner NOSUPERUSER NOBYPASSRLS')
  await preparePgliteRuntimeRole(db)
  if (order === 'runtime-first') await db.exec('CREATE ROLE migration_owner NOSUPERUSER NOBYPASSRLS')
  await db.exec(`ALTER SCHEMA public OWNER TO migration_owner;
    GRANT CREATE ON DATABASE postgres TO migration_owner;
    SET ROLE migration_owner;`)
  await preparePgliteRuntimeRole(db)
  // Only the referenced registry type and capture trigger function are stubbed;
  // this checks relation ACL rendering, not their separately authenticated bodies.
  await db.exec(`${await migration522Table()}
    ALTER TABLE public.crm_erasure_journal_targets ENABLE ROW LEVEL SECURITY;
    CREATE FUNCTION public.crm_capture_erasure_effect() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL;END$$;
    CREATE SCHEMA ${reference};`)
  return db
}

async function acls(db: PGlite): Promise<{ installed: string; rendered: string }> {
  return (await db.query<{ installed: string; rendered: string }>(`SELECT
    (SELECT relacl::text FROM pg_class WHERE oid='public.crm_erasure_journal_targets'::regclass) installed,
    (SELECT relacl::text FROM pg_class WHERE oid='${reference}.crm_erasure_journal_targets'::regclass) rendered`)).rows[0]
}

describe('[COMP:api/native-turn-frame] 8274 predecessor reference ACL', () => {
  for (const order of ['runtime-first', 'owner-first'] as const) {
    it(`renders the bootstrap table default exactly with ${order} role creation`, async () => {
      const db = await openFixture(order)
      try {
        await db.exec(await compiledReferenceDdl())
        const { installed, rendered } = await acls(db)
        assert.match(installed, /app_user=arwd\/migration_owner/)
        assert.equal(rendered, installed)
        // The reference default is closed again before any later source table.
        assert.deepEqual((await db.query(`SELECT count(*)::int n FROM pg_default_acl WHERE defaclnamespace='${reference}'::regnamespace`)).rows, [{ n: 0 }])
        await db.exec(`CREATE TABLE ${reference}.later_source(id int)`)
        assert.deepEqual((await db.query(`SELECT relacl FROM pg_class WHERE oid='${reference}.later_source'::regclass`)).rows, [{ relacl: null }])
      } finally { await db.close() }
    })
  }

  it('still distinguishes an extra or missing runtime privilege on the installed table', async () => {
    const db = await openFixture('runtime-first')
    try {
      await db.exec(await compiledReferenceDdl())
      await db.exec('RESET ROLE; CREATE ROLE reference_acl_stranger NOLOGIN; SET ROLE migration_owner')
      await db.exec('GRANT SELECT ON public.crm_erasure_journal_targets TO reference_acl_stranger')
      let { installed, rendered } = await acls(db)
      assert.notEqual(rendered, installed)
      await db.exec('REVOKE SELECT ON public.crm_erasure_journal_targets FROM reference_acl_stranger')
      await db.exec('REVOKE DELETE ON public.crm_erasure_journal_targets FROM app_user');
      ({ installed, rendered } = await acls(db))
      assert.notEqual(rendered, installed)
    } finally { await db.close() }
  })

  it('ships the same compiled reference in migration 8274', async () => {
    assert.ok((await readFile(migrationPath, 'utf8')).includes(await compiledReferenceDdl()))
  })
})
