/**
 * Pins the 33 permissive policies that carried a default-true
 * `app.system_bypass` leg until 8293, and the app-pool behaviour after it: no
 * policy reads the setting, so a pooled app connection admits the same
 * identities whether the setting was never set or a product elevation has
 * committed on it. The bypass-only policies are `USING (false)`; the four
 * bypass-or-member policies keep exactly their member leg. Any change to these
 * forms must be a reviewed successor migration that updates this suite.
 * The workspace-delete case changed on purpose with 8292 (definer alias
 * tombstone); see workspace-delete-alias-tombstone.integration.test.ts. The
 * caller fixes that preceded 8293 are pinned in bypass-leg-callers.integration.test.ts.
 *
 * Spec: docs/architecture/platform/database-schema.md, "Default-true bypass
 * legs retired (8293)" and "RLS bypass + connection state". Audit receipt:
 * docs/plans/evidence/oss-chat-replacement/canonical-publication/m6-bypass-policy-audit.md
 */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
// One app-pool connection, so "fresh" and "after an elevation" are the same backend on demand.
process.env.PG_POOL_MAX = '1'
const { getAppPool, getPool, queryWithRLS } = await import('../client.js')
const { readAdmissionPolicy } = await import('../../workspace-access/admission-policy-read.js')
const { createDbCrmEmailDraftStore, CrmEmailDraftAnchorConflictError } = await import('../crm-email-drafts.js')
const { rejectTask } = await import('../task-admission-store.js')
const { createWorkspaceStore } = await import('../workspace-store.js')

type Form = 'none' | 'member' | null
/** table, policy, command, USING form, WITH CHECK form after 8293. All permissive, all TO PUBLIC. */
const INVENTORY: ReadonlyArray<readonly [string, string, '*' | 'r', Form, Form]> = [
  ['crm_activities', 'crm_activities_system', '*', 'none', null],
  ['crm_consent_purpose_versions', 'crm_consent_versions_system', '*', 'none', 'none'],
  ['crm_consent_purposes', 'crm_consent_purposes_system', '*', 'none', 'none'],
  ['crm_deal_contacts', 'crm_deal_contacts_system', '*', 'none', null],
  ['crm_domain_event_outbox', 'crm_domain_event_outbox_system', '*', 'none', 'none'],
  ['crm_email_draft_session_anchors', 'crm_email_draft_session_anchors_system', '*', 'none', null],
  ['crm_email_draft_versions', 'crm_email_draft_versions_system', '*', 'none', null],
  ['crm_email_drafts', 'crm_email_drafts_system', '*', 'none', null],
  ['crm_field_definitions', 'crm_field_definitions_system', '*', 'none', null],
  ['crm_import_chunks', 'crm_import_chunks_system', '*', 'none', 'none'],
  ['crm_import_errors', 'crm_import_errors_system', '*', 'none', 'none'],
  ['crm_import_jobs', 'crm_import_jobs_system', '*', 'none', 'none'],
  ['crm_import_rows', 'crm_import_rows_system', '*', 'none', 'none'],
  ['crm_intake_credential_definitions', 'crm_intake_credential_definitions_system', '*', 'none', 'none'],
  ['crm_intake_credentials', 'crm_intake_credentials_system', '*', 'none', 'none'],
  ['crm_intake_definition_versions', 'crm_intake_definition_versions_system', '*', 'none', 'none'],
  ['crm_intake_definitions', 'crm_intake_definitions_system', '*', 'none', 'none'],
  ['crm_intake_idempotency', 'crm_intake_idempotency_system', '*', 'none', 'none'],
  ['crm_pipeline_stages', 'crm_pipeline_stages_system', '*', 'none', null],
  ['crm_pipelines', 'crm_pipelines_system', '*', 'none', null],
  ['crm_saved_views', 'crm_saved_views_system', '*', 'none', null],
  ['crm_segments', 'crm_segments_system', '*', 'none', 'none'],
  ['crm_suppression_events', 'crm_suppression_events_system', '*', 'none', 'none'],
  ['home_dock_layouts', 'home_dock_layouts_member', '*', 'member', null],
  ['page_link_aliases', 'page_link_aliases_member', '*', 'member', 'member'],
  ['realtime_thread_targets', 'realtime_thread_targets_system_bypass', '*', 'none', 'none'],
  ['task_candidates', 'task_candidates_system_bypass', '*', 'none', null],
  ['task_rules', 'task_rules_system_bypass', '*', 'none', null],
  ['task_tombstones', 'task_tombstones_system_bypass', '*', 'none', null],
  ['workspace_brand_versions', 'brand_versions_system_bypass', '*', 'none', null],
  ['workspace_brands', 'workspace_brands_system_bypass', '*', 'none', null],
  ['workspace_link_aliases', 'workspace_link_aliases_member', '*', 'member', 'member'],
  ['workspace_skill_scope_revisions', 'workspace_skill_scope_revision_member_read', 'r', 'member', null],
]
/** The retired default-true expression, still evaluated here to show how the setting reads per connection state. */
const BYPASS = "(COALESCE(current_setting('app.system_bypass'::text, true), 'true'::text) = 'true'::text)"

const pool = getPool()
const app = getAppPool()
afterAll(async () => { await app.end(); await pool.end() })

/** Destroy the single app connection so the next checkout is a fresh, never-elevated session. */
async function freshAppSession(): Promise<number> {
  // Let the connect-time sentinel seed finish before destroying the connection.
  const c = await app.connect(); await c.query('SELECT 1'); c.release(true)
  return (await app.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
}
/** The product's own transaction-local elevation, committed on the pooled app connection. */
async function afterProductElevation(workspaceId: string): Promise<number> {
  const c = await app.connect()
  try { await c.query('BEGIN'); await readAdmissionPolicy(c, workspaceId); await c.query('COMMIT') } finally { c.release() }
  return (await app.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
}
const sessionBypass = async () => (await app.query("SELECT current_setting('app.system_bypass',true) AS v")).rows[0].v as string | null

async function workspaceFixture() {
  const owner = randomUUID(), outsider = randomUUID(), workspaceId = randomUUID(), assistantId = randomUUID(), sessionId = randomUUID()
  for (const id of [owner, outsider]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Bypass audit fixture',$2)", [workspaceId, owner])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, owner])
  await pool.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind) VALUES($1,'Fixture assistant',$2,$3,'standard')", [assistantId, workspaceId, owner])
  await pool.query("INSERT INTO sessions(id,assistant_id,user_id,channel_type,channel_id,workspace_id) VALUES($1,$2,$3,'web','fixture',$4)", [sessionId, assistantId, owner, workspaceId])
  return { owner, outsider, workspaceId, assistantId, sessionId }
}
const draftInput = (f: Awaited<ReturnType<typeof workspaceFixture>>, userId: string) => ({ workspaceId: f.workspaceId, userId,
  assistantId: f.assistantId, sessionId: f.sessionId, to: ['person@example.test'], subject: 'Fictional follow-up', body: 'Fictional body' })

describe('[COMP:api/db-client] permissive default-true bypass policy inventory', () => {
  it('pins the 33 policies after 8293: none reads the setting, bypass-only legs are false, member legs are unchanged', async () => {
    const rows = (await pool.query(`SELECT c.relname,p.polname,p.polcmd,p.polpermissive,p.polroles=ARRAY[0::oid] AS public_role,
        c.relrowsecurity,c.relforcerowsecurity,pg_get_expr(p.polqual,p.polrelid) AS qual,pg_get_expr(p.polwithcheck,p.polrelid) AS wc
      FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN unnest($1::text[],$2::text[]) AS t(rel,pol) ON t.rel=c.relname AND t.pol=p.polname
      WHERE c.relnamespace='public'::regnamespace ORDER BY c.relname,p.polname`, [INVENTORY.map(r => r[0]), INVENTORY.map(r => r[1])])).rows
    const member = /^\((?:namespace_)?workspace_id IN \( SELECT (?:wm|workspace_members)\.workspace_id\n {3}FROM workspace_members(?: wm)?\n {2}WHERE \((?:wm|workspace_members)\.user_id = \((?:NULLIF\()?current_setting\('app\.current_user_id'::text, true\)(?:, ''::text\))?\)::uuid\)\)\)$/
    const form = (expr: string | null): Form => expr === null ? null : expr === 'false' ? 'none'
      : member.test(expr) ? 'member' : (() => { throw new Error(`unreviewed policy form: ${expr}`) })()
    expect(rows.map(r => [r.relname, r.polname, r.polcmd, form(r.qual), form(r.wc)])).toEqual(INVENTORY.map(row => [...row]))
    for (const r of rows) {
      expect(r).toMatchObject({ polpermissive: true, public_role: true, relrowsecurity: true, relforcerowsecurity: false })
      expect(`${r.qual}${r.wc ?? ''}`).not.toContain('app.system_bypass')
    }
    // No default-true form remains anywhere in the schema.
    expect((await pool.query(`SELECT count(*)::int AS n FROM pg_policy p
      WHERE position('COALESCE(current_setting(''app.system_bypass''' IN coalesce(pg_get_expr(p.polqual,p.polrelid),'')||coalesce(pg_get_expr(p.polwithcheck,p.polrelid),''))>0`)).rows[0].n).toBe(0)
  })

  it('still reads the setting as unset on a fresh app session and as empty after a product elevation (no policy consults it)', async () => {
    const f = await workspaceFixture()
    const pid = await freshAppSession()
    expect(await sessionBypass()).toBeNull()
    expect((await app.query(`SELECT ${BYPASS} AS passes`)).rows[0].passes).toBe(true)
    expect(await afterProductElevation(f.workspaceId)).toBe(pid)
    expect(await sessionBypass()).toBe('')
    expect((await app.query(`SELECT ${BYPASS} AS passes`)).rows[0].passes).toBe(false)
  })

  it('admits the worker sentinel identity to none of the 33 tables, whatever the setting holds', async () => {
    const tables = [...new Set(INVENTORY.map(([table]) => table))]
    const f = await workspaceFixture()
    await pool.query("INSERT INTO task_rules(workspace_id,status,effect,predicate,origin) VALUES($1,'active','deny','{\"lanes\":[\"extracted\"]}','user')", [f.workspaceId])
    const visible = async () => (await app.query(`SELECT count(*)::int AS n,current_setting('app.current_user_id') AS actor FROM task_rules WHERE workspace_id=$1`, [f.workspaceId])).rows[0]
    await freshAppSession()
    expect(await visible()).toEqual({ n: 0, actor: '00000000-0000-0000-0000-000000000000' })
    // The sentinel has no member row, and no default-true leg remains to admit it on a fresh session.
    for (const table of tables) await expect(app.query(`SELECT count(*)::int AS n FROM ${table}`), table).resolves.toBeDefined()
    await afterProductElevation(f.workspaceId)
    expect(await visible()).toEqual({ n: 0, actor: '00000000-0000-0000-0000-000000000000' })
  })
})

describe('[COMP:api/db-client] CRM and task app-pool paths, fresh and after an elevation', () => {
  it('CRM email drafts: a non-member is refused and the member admitted on a fresh and an elevated connection', async () => {
    const f = await workspaceFixture(), store = createDbCrmEmailDraftStore()
    await freshAppSession()
    expect(await sessionBypass()).toBeNull()
    expect(await store.saveRevision(draftInput(f, f.outsider))).toBeNull()
    expect(await store.list({ workspaceId: f.workspaceId, userId: f.outsider })).toEqual([])
    const first = await store.saveRevision(draftInput(f, f.owner))
    expect(first).toMatchObject({ workspaceId: f.workspaceId, createdByUserId: f.owner })

    await afterProductElevation(f.workspaceId)
    expect(await sessionBypass()).toBe('')
    expect(await store.list({ workspaceId: f.workspaceId, userId: f.outsider })).toEqual([])
    expect(await store.saveRevision(draftInput(f, f.outsider))).toBeNull()
    const own = await store.saveRevision(draftInput(f, f.owner))
    expect(own).toMatchObject({ workspaceId: f.workspaceId, createdByUserId: f.owner })
    expect((await store.list({ workspaceId: f.workspaceId, userId: f.owner })).map(d => d.id).sort()).toEqual([first!.id, own!.id].sort())
    expect((await pool.query('SELECT count(*)::int AS n FROM crm_email_drafts WHERE workspace_id=$1 AND created_by_user_id=$2', [f.workspaceId, f.outsider])).rows[0].n).toBe(0)
    await pool.query('DELETE FROM workspaces WHERE id=$1', [f.workspaceId]).catch(() => {})
  })

  it('CRM member reads through queryWithRLS: a non-member sees no configuration rows in either state', async () => {
    const f = await workspaceFixture()
    await pool.query("INSERT INTO crm_pipelines(workspace_id,name,is_default,position) VALUES($1,'Fictional pipeline',true,0)", [f.workspaceId])
    const read = (userId: string) => queryWithRLS<{ n: number }>(userId, 'SELECT count(*)::int AS n FROM crm_pipelines WHERE workspace_id=$1', [f.workspaceId])
    await freshAppSession()
    expect((await read(f.outsider)).rows[0].n).toBe(0)
    expect((await read(f.owner)).rows[0].n).toBe(1)
    await afterProductElevation(f.workspaceId)
    expect((await read(f.outsider)).rows[0].n).toBe(0)
    expect((await read(f.owner)).rows[0].n).toBe(1)
    await pool.query('DELETE FROM workspaces WHERE id=$1', [f.workspaceId]).catch(() => {})
  })

  it('CRM email drafts: a session anchor left in a workspace the user departed is never moved, in either state', async () => {
    const left = await workspaceFixture(), store = createDbCrmEmailDraftStore()
    const target = randomUUID()
    await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Bypass audit target',$2)", [target, left.owner])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member'),($3,$2,'member')", [left.workspaceId, left.outsider, target])
    await freshAppSession()
    await store.saveRevision(draftInput(left, left.outsider))
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [left.workspaceId, left.outsider])
    const anchorWorkspace = async () => (await pool.query('SELECT workspace_id FROM crm_email_draft_session_anchors WHERE session_id=$1', [left.sessionId])).rows[0].workspace_id
    await afterProductElevation(target)
    await expect(store.saveRevision({ ...draftInput(left, left.outsider), workspaceId: target })).rejects.toBeInstanceOf(CrmEmailDraftAnchorConflictError)
    expect(await anchorWorkspace()).toBe(left.workspaceId)
    await freshAppSession()
    await expect(store.saveRevision({ ...draftInput(left, left.outsider), workspaceId: target })).rejects.toBeInstanceOf(CrmEmailDraftAnchorConflictError)
    expect(await anchorWorkspace()).toBe(left.workspaceId)
    for (const id of [left.workspaceId, target]) await pool.query('DELETE FROM workspaces WHERE id=$1', [id]).catch(() => {})
  })

  it('workspace delete: since 8292 the definer alias tombstone trigger passes whatever the setting holds', async () => {
    const store = createWorkspaceStore()
    const withAlias = async () => {
      const f = await workspaceFixture()
      await pool.query(`INSERT INTO workspace_link_aliases(workspace_id,alias,alias_key,created_by)
        VALUES($1::uuid,'fictional',encode(sha256(convert_to($3,'UTF8')),'hex'),$2)`, [f.workspaceId, f.owner, f.workspaceId])
      return f
    }
    const tombstone = async (workspaceId: string) => (await pool.query('SELECT workspace_id,deleted_at IS NOT NULL AS tombstoned FROM workspace_link_aliases WHERE created_by IS NULL AND alias_key=encode(sha256(convert_to($1,\'UTF8\')),\'hex\')', [workspaceId])).rows
    const deleted = await withAlias(), elevated = await withAlias(), plain = await workspaceFixture()
    await freshAppSession()
    expect(await store.delete(deleted.owner, deleted.workspaceId)).toBe(true)
    expect(await tombstone(deleted.workspaceId)).toEqual([{ workspace_id: null, tombstoned: true }])
    await afterProductElevation(elevated.workspaceId)
    expect(await sessionBypass()).toBe('')
    // The tombstone writes workspace_id NULL, which no member leg can admit. Before 8292 this
    // delete was refused here; the owner-run definer no longer evaluates the alias policy.
    expect(await store.delete(elevated.owner, elevated.workspaceId)).toBe(true)
    expect(await tombstone(elevated.workspaceId)).toEqual([{ workspace_id: null, tombstoned: true }])
    expect((await pool.query('SELECT count(*)::int AS n FROM workspaces WHERE id=$1', [elevated.workspaceId])).rows[0].n).toBe(0)
    // Without an alias the same owner delete passes on the same connection.
    expect(await store.delete(plain.owner, plain.workspaceId)).toBe(true)
  })

  it('task rejection: membership is proven by the prior RLS task read, and the tombstone and rule writes pass on the member policy alone', async () => {
    const f = await workspaceFixture(), taskId = randomUUID()
    await pool.query("INSERT INTO tasks(id,workspace_id,title,created_by_user_id,sensitivity) VALUES($1,$2,'Fictional task',$3,'internal')", [taskId, f.workspaceId, f.owner])
    await freshAppSession()
    expect(await sessionBypass()).toBeNull()
    expect(await rejectTask({ workspaceId: f.workspaceId, userId: f.outsider, taskId, reason: 'Fictional' })).toBeNull()
    expect((await pool.query('SELECT count(*)::int AS n FROM task_tombstones WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)

    await afterProductElevation(f.workspaceId)
    expect(await sessionBypass()).toBe('')
    const accepted = await rejectTask({ workspaceId: f.workspaceId, userId: f.owner, taskId, reason: 'Fictional', createRule: true })
    expect(accepted).toMatchObject({ title: 'Fictional task' })
    expect(accepted!.activeRuleId).toBeTruthy()
    const counts = (await pool.query(`SELECT (SELECT count(*)::int FROM task_tombstones WHERE workspace_id=$1) AS tombstones,
      (SELECT count(*)::int FROM task_rules WHERE workspace_id=$1) AS rules`, [f.workspaceId])).rows[0]
    expect(counts).toEqual({ tombstones: 1, rules: 1 })
  })
})
