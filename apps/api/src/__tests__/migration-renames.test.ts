/** [COMP:api/migration-order] Released filename aliases at the embedded boundary. */
import { PGlite } from '@electric-sql/pglite'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { migratePglite } from '../migrate-pglite.js'

const externalPairs = [
  ['8240_external_human_approvals.sql', '8242_external_human_approvals.sql'],
  ['8241_external_human_approvals.sql', '8242_external_human_approvals.sql'],
  ['8241_workspace_external_approval_sources.sql', '8243_workspace_external_approval_sources.sql'],
  ['8242_workspace_external_approval_sources.sql', '8243_workspace_external_approval_sources.sql'],
  ['8243_external_approval_web_chat_destination.sql', '8244_external_approval_web_chat_destination.sql'],
  ['8244_external_approval_conversation_members.sql', '8245_external_approval_conversation_members.sql'],
  ['8245_external_human_question_answers.sql', '8246_external_human_question_answers.sql'],
] as const
const pairs = [
  ['557_association_membership_catalogue.sql', '5570_association_membership_catalogue.sql'],
  ['561_association_site_content.sql', '5610_association_site_content.sql'],
  ['563_department_scope_evidence.sql', '5630_department_scope_evidence.sql'],
  ['564_crm_intake_existing_or_new.sql', '5640_crm_intake_existing_or_new.sql'],
  ['8146_explicit_unclassified_legacy_erasure.sql', '81460_explicit_unclassified_legacy_erasure.sql'],
  ['8147_private_chat_recovery.sql', '81470_private_chat_recovery.sql'],
  ...externalPairs,
] as const
const canonicalNames = [...new Set(pairs.map(([, current]) => current))]
const externalNames = [...new Set(externalPairs.map(([, current]) => current))]
const appliedAt = '2026-01-01T00:00:00.000Z'

test('preserves old embedded ledger names and timestamps without replaying canonical SQL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'embedded-rename-upgrade-')), db = new PGlite()
  try {
    await db.exec('CREATE TABLE _migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
    for (const [previous] of pairs) {
      await db.query('INSERT INTO _migrations(name,applied_at) VALUES($1,$2)', [previous, appliedAt])
    }
    for (const current of canonicalNames) await writeFile(join(directory, current), 'SELECT unexpected_migration_replay();')
    assert.deepEqual(await Promise.all([migratePglite(db, directory), migratePglite(db, directory)]), [canonicalNames.length, 0])
    const rows = (await db.query<{name:string;applied_at:Date}>('SELECT name,applied_at FROM _migrations')).rows
    assert.equal(rows.length, pairs.length + canonicalNames.length)
    assert.deepEqual(new Set(rows.map(row => row.name)), new Set(pairs.flat()))
    assert.ok(rows.every(row => row.applied_at.toISOString() === appliedAt))
  } finally { await db.close(); await rm(directory, { recursive: true, force: true }) }
})

test('executes canonical files on fresh embedded brains and then skips them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'embedded-rename-fresh-')), db = new PGlite()
  try {
    for (const [index, current] of canonicalNames.entries()) await writeFile(join(directory, current), `CREATE TABLE rename_probe_${index}(id integer);`)
    assert.equal(await migratePglite(db, directory), canonicalNames.length)
    assert.equal(await migratePglite(db, directory), 0)
    assert.equal((await db.query('SELECT name FROM _migrations')).rows.length, canonicalNames.length)
    assert.equal((await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'rename_probe_%'")).rows.length, canonicalNames.length)
  } finally { await db.close(); await rm(directory, { recursive: true, force: true }) }
})

for (const { label, applied } of [
  { label: 'original approval/source names', applied: ['8240_external_human_approvals.sql', '8241_workspace_external_approval_sources.sql'] },
  { label: 'previous complete feature names', applied: ['8241_external_human_approvals.sql', '8242_workspace_external_approval_sources.sql', '8243_external_approval_web_chat_destination.sql', '8244_external_approval_conversation_members.sql', '8245_external_human_question_answers.sql'] },
  { label: 'current canonical names', applied: externalNames },
]) {
  test(`upgrades ${label} without replaying applied SQL or skipping same-number neighbours`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'embedded-external-stage-')), db = new PGlite()
    try {
      await db.exec('CREATE TABLE _migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
      const appliedSet: ReadonlySet<string> = new Set(applied)
      for (const name of applied) await db.query('INSERT INTO _migrations(name,applied_at) VALUES($1,$2)', [name, appliedAt])
      const retained = new Set<string>(externalNames.filter(current => appliedSet.has(current) || externalPairs.some(([previous, name]) => name === current && appliedSet.has(previous))))
      const expectedTables: string[] = []
      for (const [index, current] of externalNames.entries()) {
        const table = `rename_stage_probe_${index}`
        const sql = retained.has(current) ? 'SELECT unexpected_migration_replay();' : `CREATE TABLE ${table}(id integer);`
        if (!retained.has(current)) expectedTables.push(table)
        await writeFile(join(directory, current), sql)
      }
      const neighbours = ['8240_channel_connection_provenance.sql', '8241_telegram_recording_history_recovery.sql']
      for (const [index, name] of neighbours.entries()) {
        const table = `rename_stage_probe_neighbour_${index}`
        expectedTables.push(table)
        await writeFile(join(directory, name), `CREATE TABLE ${table}(id integer);`)
      }
      const expectedCount = neighbours.length + externalNames.filter(current => !appliedSet.has(current)).length
      assert.deepEqual(await Promise.all([migratePglite(db, directory), migratePglite(db, directory)]), [expectedCount, 0])
      const rows = (await db.query<{name:string;applied_at:Date}>('SELECT name,applied_at FROM _migrations')).rows
      assert.deepEqual(new Set(rows.map(row => row.name)), new Set([...applied, ...externalNames, ...neighbours]))
      assert.ok(rows.filter(row => appliedSet.has(row.name) || retained.has(row.name)).every(row => row.applied_at.toISOString() === appliedAt))
      const tables = (await db.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'rename_stage_probe_%'")).rows
      assert.deepEqual(tables.map(row => row.tablename).sort(), expectedTables.sort())
    } finally { await db.close(); await rm(directory, { recursive: true, force: true }) }
  })
}
