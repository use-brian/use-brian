/**
 * Migration 8285: the owner (system pool) reaches the eight former FORCE tables
 * by ownership, whatever a pooled connection's `app.system_bypass` holds.
 *
 * Spec: docs/architecture/platform/database-schema.md, "Owner-path forced RLS
 * retirement (8285)" and "RLS bypass + connection state".
 */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
// One owner connection, so the contaminated session is the one every later call reuses.
process.env.PG_POOL_MAX = '1'
const { getPool } = await import('../client.js')
const { readAdmissionPolicy } = await import('../../workspace-access/admission-policy-read.js')
const { createRule, listRules, setRuleStatus, listTombstones, deleteTombstone } = await import('../task-admission-store.js')

const RETIRED = ['page_link_aliases', 'realtime_thread_targets', 'task_candidates', 'task_rules', 'task_tombstones',
  'workspace_brand_versions', 'workspace_brands', 'workspace_link_aliases']

afterAll(async () => { await getPool().end() })

describe('[COMP:api/db-client] owner access after a transaction-local system_bypass', () => {
  it('keeps the eight tables RLS-enabled, unforced and with their policies, and no forced table defaults to bypass', async () => {
    const rows = (await getPool().query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,
        (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid=c.oid) policies
      FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1) ORDER BY c.relname`, [RETIRED])).rows
    expect(rows.map(row => row.relname)).toEqual(RETIRED)
    for (const row of rows) expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: false })
    expect(rows.every(row => row.policies > 0)).toBe(true)
    const forcedDefaultTrue = (await getPool().query(`SELECT c.relname FROM pg_class c JOIN pg_policy p ON p.polrelid=c.oid
      WHERE c.relforcerowsecurity AND position('COALESCE(current_setting(''app.system_bypass''' IN
        coalesce(pg_get_expr(p.polqual,p.polrelid),'')||coalesce(pg_get_expr(p.polwithcheck,p.polrelid),''))>0`)).rows
    expect(forcedDefaultTrue).toEqual([])
  })

  it('reads and writes task rules and tombstones on the same pooled connection after the admission policy read', async () => {
    const pool = getPool()
    const user = randomUUID(), workspace = randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [user])
    await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Forced RLS fixture',$2)", [workspace, user])
    const pid = (await pool.query('SELECT pg_backend_pid() pid')).rows[0].pid

    // The product's own transaction-local elevation, committed on the pooled owner connection.
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await readAdmissionPolicy(client, workspace)
      await client.query('COMMIT')
    } finally { client.release() }
    const session = (await pool.query("SELECT pg_backend_pid() pid,current_setting('app.system_bypass',true) value")).rows[0]
    // The setting no longer reads as unset: this is the state that used to refuse the owner.
    expect(session).toEqual({ pid, value: '' })

    const rule = await createRule({ workspaceId: workspace, userId: user, effect: 'deny', predicate: { lanes: ['extracted'] },
      nlClause: null, reason: 'Fictional standing rule', status: 'active' })
    expect((await listRules({ workspaceId: workspace, includeDisabled: true })).map(r => r.id)).toEqual([rule.id])
    expect(await setRuleStatus({ workspaceId: workspace, ruleId: rule.id, status: 'disabled' })).toMatchObject({ id: rule.id, status: 'disabled' })

    const tombstone = (await pool.query(`INSERT INTO task_tombstones(workspace_id,title,title_norm,reason,created_by_user_id)
      VALUES($1,'Fictional rejected task','fictional rejected task','Not wanted',$2) RETURNING id`, [workspace, user])).rows[0].id
    expect((await listTombstones(workspace)).map(t => t.id)).toEqual([tombstone])
    expect(await deleteTombstone(workspace, tombstone)).toBe(true)
    expect(await listTombstones(workspace)).toEqual([])

    // Every call above ran on the one contaminated backend.
    expect((await pool.query("SELECT pg_backend_pid() pid,current_setting('app.system_bypass',true) value")).rows[0]).toEqual({ pid, value: '' })
    await pool.query('DELETE FROM workspaces WHERE id=$1', [workspace]).catch(() => {})
  })
})
