/** [COMP:api/migration-order] Released filename aliases at the embedded boundary. */
import { PGlite } from '@electric-sql/pglite'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { migratePglite } from '../migrate-pglite.js'

const pairs = [
  ['557_association_membership_catalogue.sql', '5570_association_membership_catalogue.sql'],
  ['561_association_site_content.sql', '5610_association_site_content.sql'],
  ['563_department_scope_evidence.sql', '5630_department_scope_evidence.sql'],
  ['564_crm_intake_existing_or_new.sql', '5640_crm_intake_existing_or_new.sql'],
  ['8146_explicit_unclassified_legacy_erasure.sql', '81460_explicit_unclassified_legacy_erasure.sql'],
  ['8147_private_chat_recovery.sql', '81470_private_chat_recovery.sql'],
  ['8240_external_human_approvals.sql', '8241_external_human_approvals.sql'],
  ['8241_workspace_external_approval_sources.sql', '8242_workspace_external_approval_sources.sql'],
] as const

test('preserves old embedded ledger names and timestamps without replaying canonical SQL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'embedded-rename-upgrade-')), db = new PGlite()
  try {
    await db.exec('CREATE TABLE _migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
    for (const [previous, current] of pairs) {
      await db.query('INSERT INTO _migrations(name,applied_at) VALUES($1,$2)', [previous, '2026-01-01T00:00:00Z'])
      await writeFile(join(directory, current), 'SELECT unexpected_migration_replay();')
    }
    assert.deepEqual(await Promise.all([migratePglite(db, directory), migratePglite(db, directory)]), [pairs.length, 0])
    const rows = (await db.query<{name:string;applied_at:Date}>('SELECT name,applied_at FROM _migrations')).rows
    assert.equal(rows.length, pairs.length * 2)
    assert.deepEqual(new Set(rows.map(row => row.name)), new Set(pairs.flat()))
    assert.ok(rows.every(row => row.applied_at.toISOString() === '2026-01-01T00:00:00.000Z'))
  } finally { await db.close(); await rm(directory, { recursive: true, force: true }) }
})

test('executes canonical files on fresh embedded brains and then skips them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'embedded-rename-fresh-')), db = new PGlite()
  try {
    for (const [index, [, current]] of pairs.entries()) await writeFile(join(directory, current), `CREATE TABLE rename_probe_${index}(id integer);`)
    assert.equal(await migratePglite(db, directory), pairs.length)
    assert.equal(await migratePglite(db, directory), 0)
    assert.equal((await db.query('SELECT name FROM _migrations')).rows.length, pairs.length)
    assert.equal((await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'rename_probe_%'")).rows.length, pairs.length)
  } finally { await db.close(); await rm(directory, { recursive: true, force: true }) }
})
