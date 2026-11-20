import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bindsProjectHarnessReceipt, projectHarnessCandidateBoundarySql as guard, projectHarnessSuccessorFiles } from '../project-harness-candidate-boundary.js'
let db: PGlite
beforeAll(async () => { db = new PGlite(); await db.waitReady })
afterAll(async () => { await db?.close() })
const ledger = `CREATE TABLE public._migrations(name text PRIMARY KEY);`
async function snapshot() {
  return (await db.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.oid) FROM pg_class c WHERE relnamespace='public'::regnamespace) relations,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_proc p WHERE pronamespace='public'::regnamespace) routines,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.oid) FROM pg_constraint c WHERE connamespace='public'::regnamespace) constraints`)).rows
}
async function check(setup: string, refused: boolean) {
  await db.exec('BEGIN')
  try {
    await db.exec(setup)
    const before = await snapshot()
    await db.exec('SAVEPOINT boundary')
    if (refused) {
      await expect(db.exec(guard)).rejects.toThrow('project_harness_candidate_upgrade_unsupported')
      await db.exec('ROLLBACK TO boundary')
    } else await db.exec(guard)
    expect(await snapshot()).toEqual(before)
  } finally { await db.exec('ROLLBACK') }
}
describe.sequential('[COMP:api/harness-migration-upgrade] finite unsupported candidate boundary (actual read-only SQL)', () => {
  it('accepts empty databases without creating a ledger', async () => { await check('', false) })
  it('leaves develop Memory 8268 lineage to its existing authenticated adapter', async () => {
    await check(ledger + `INSERT INTO _migrations VALUES('8268_native_memory_query_write_lineage.sql')`, false)
  })
  it.each(['8269_project_harnesses.sql','8270_project_harness_verification.sql','8271_project_chat_creation_admission.sql','8272_native_helper_attestation_cost.sql'])('refuses old ledger %s without effects', async name => {
    await check(ledger + `INSERT INTO _migrations VALUES('${name}')`, true)
  })
  it.each([
    'CREATE TABLE native_turn_helper_attestations(payload text)',
    `CREATE FUNCTION native_turn_helpers_current() RETURNS text LANGUAGE sql AS $$ SELECT 'native_turn_helper_attestations' $$`,
    'CREATE TABLE project_harness_products(id int)',
    'CREATE TABLE project_harness_components(id int)',
    'CREATE TABLE project_harness_revisions(id int)',
    'CREATE TABLE project_harness_approvals(id int)',
    'CREATE TABLE project_harness_runs(id int)',
    'CREATE TABLE project_harness_evidence(id int)',
    'CREATE TABLE project_harness_execution_audit(id int)',
    'CREATE FUNCTION project_harness_visible() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$',
    'CREATE FUNCTION harness_execution_human() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$',
    `CREATE TABLE project_shared_scopes(id int CONSTRAINT project_shared_scopes_workspace_project_unique UNIQUE)`,
    `CREATE FUNCTION require_session_creation_admission() RETURNS text LANGUAGE sql AS $$ SELECT 'D24: an explicitly shared Project room' $$`,
  ])('refuses effects without historical ledger: %s', async sql => { await check(sql, true) })
  it('accepts atomically receipted successor effects on retry', async () => {
    await check(ledger + projectHarnessSuccessorFiles.map(name => `INSERT INTO _migrations VALUES('${name}');`).join('') + `
      CREATE TABLE project_harness_products(id int); CREATE TABLE project_harness_runs(id int);
      CREATE FUNCTION require_session_creation_admission() RETURNS text LANGUAGE sql AS $$ SELECT 'D24: an explicitly shared Project room' $$;`, false)
  })
  it('refuses incomplete successor receipts', async () => { await check(ledger + `INSERT INTO _migrations VALUES('8331_project_chat_creation_admission.sql')`, true) })
  it('binds only the three exact new SQL receipts', () => {
    for (const file of projectHarnessSuccessorFiles) expect(bindsProjectHarnessReceipt(file)).toBe(true)
    for (const file of ['8329_other.sql','8332_project_harnesses.sql','8271_project_chat_creation_admission.sql']) expect(bindsProjectHarnessReceipt(file)).toBe(false)
  })
  it('both actual entry points check before mutation; native new files bind their receipts', async () => {
    const native = await readFile(new URL('../../../scripts/migrate.ts', import.meta.url), 'utf8')
    expect(native.indexOf('await client.query(projectHarnessCandidateBoundarySql)')).toBeLessThan(native.indexOf('CREATE TABLE IF NOT EXISTS public._migrations'))
    expect(native.indexOf('await client.query(projectHarnessCandidateBoundarySql)')).toBeLessThan(native.indexOf('await nativePageCompletionRecoverySql()'))
    expect(native).toContain('|| bindsProjectHarnessReceipt(file)')
    const embedded = await readFile(new URL('../../../../../apps/api/src/migrate-pglite.ts', import.meta.url), 'utf8')
    const exclusive = embedded.slice(embedded.indexOf('async function migratePgliteExclusive'))
    expect(exclusive.indexOf('await db.exec(projectHarnessCandidateBoundarySql)')).toBeLessThan(exclusive.indexOf('CREATE TABLE IF NOT EXISTS public._migrations'))
    expect(embedded).toContain('preparePgliteRuntimeRole(db: PGlite): Promise<void> {\n  await db.exec(projectHarnessCandidateBoundarySql)')
  })
})
