/**
 * Workspace delete with link aliases through the real workspace store on the
 * app pool, independent of `app.system_bypass` connection state (migration
 * 8292). Before 8292 the invoker tombstone trigger was admitted only by the
 * default-true bypass leg, so the delete was refused on a connection that had
 * already committed a product elevation.
 *
 * Spec: docs/architecture/platform/database-schema.md, "Workspace alias
 * tombstone as the table owner (8292)" and "RLS bypass + connection state".
 * Receipt: docs/plans/evidence/oss-chat-replacement/canonical-publication/m6-workspace-delete-tombstone-fix.md
 */
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
// One app-pool connection, so "fresh" and "after an elevation" are the same backend on demand.
process.env.PG_POOL_MAX = '1'
const { getAppPool, getPool, queryWithRLS } = await import('../client.js')
const { readAdmissionPolicy } = await import('../../workspace-access/admission-policy-read.js')
const { createWorkspaceStore } = await import('../workspace-store.js')

/** sha256 of the 553 body, which 8292 keeps byte-identical. */
const BODY_SHA = '740ca94cef20a8b52738de56474d292cf5b1cc477c3b7415595dcc3af3365b83'
const BYPASS = "(COALESCE(current_setting('app.system_bypass'::text, true), 'true'::text) = 'true'::text)"
/** The member leg of workspace_link_aliases_member, all that remains after 8293. */
const MEMBER_LEG = "(workspace_id IN ( SELECT wm.workspace_id\n   FROM workspace_members wm\n  WHERE (wm.user_id = (NULLIF(current_setting('app.current_user_id'::text, true), ''::text))::uuid)))"
const FN = 'public.tombstone_workspace_link_aliases()'

const pool = getPool()
const app = getAppPool()
const created: string[] = []
afterAll(async () => {
  for (const id of created) await pool.query('DELETE FROM workspaces WHERE id=$1', [id]).catch(() => {})
  await app.end(); await pool.end()
})

const aliasKey = (value: string) => createHash('sha256').update(value).digest('hex')
const backendPid = async () => (await app.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number
const sessionBypass = async () => (await app.query("SELECT current_setting('app.system_bypass',true) AS v")).rows[0].v as string | null

/** Destroy the single app connection so the next checkout is a fresh, never-elevated session. */
async function freshAppSession(): Promise<number> {
  const c = await app.connect(); await c.query('SELECT 1'); c.release(true)
  return backendPid()
}
/** The product's own transaction-local elevation, committed on the pooled app connection. */
async function afterProductElevation(workspaceId: string): Promise<number> {
  const c = await app.connect()
  try { await c.query('BEGIN'); await readAdmissionPolicy(c, workspaceId); await c.query('COMMIT') } finally { c.release() }
  return backendPid()
}

/** A workspace with an owner, a non-owner member, a current alias and a historical alias. */
async function workspaceWithAliases(label: string) {
  const owner = randomUUID(), member = randomUUID(), outsider = randomUUID(), workspaceId = randomUUID()
  for (const id of [owner, member, outsider]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional tombstone fixture',$2)", [workspaceId, owner])
  created.push(workspaceId)
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [workspaceId, owner, member])
  const keys = [aliasKey(`${label}-${workspaceId}-current`), aliasKey(`${label}-${workspaceId}-history`)]
  await pool.query(`INSERT INTO workspace_link_aliases(workspace_id,alias,alias_key,is_current,created_by)
    VALUES($1,'fictional-current',$2,true,$4),($1,'fictional-history',$3,false,$4)`, [workspaceId, keys[0], keys[1], owner])
  return { owner, member, outsider, workspaceId, keys }
}
const aliasRows = async (keys: string[]) => (await pool.query(`SELECT workspace_id,alias,is_current,created_by,deleted_at IS NOT NULL AS tombstoned
  FROM workspace_link_aliases WHERE alias_key=ANY($1::text[]) ORDER BY alias_key`, [keys])).rows
const TOMBSTONE = { workspace_id: null, alias: null, is_current: false, created_by: null, tombstoned: true }
const workspaceExists = async (id: string) => (await pool.query('SELECT count(*)::int AS n FROM workspaces WHERE id=$1', [id])).rows[0].n === 1

describe('[COMP:api/db-client] workspace delete tombstones aliases as the table owner (8292)', () => {
  it('installs the 553 body unchanged as an owner-executable SECURITY DEFINER with a pinned search_path', async () => {
    const fn = (await pool.query(`SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS sha,p.prosecdef,p.proconfig,
        p.proowner=(SELECT relowner FROM pg_class WHERE oid='public.workspace_link_aliases'::regclass) AS table_owner,
        (SELECT array_agg(a.grantee=p.proowner ORDER BY a.grantee) FROM aclexplode(p.proacl) a) AS grantees_are_owner,
        has_function_privilege('app_user',p.oid,'EXECUTE') AS app_user_execute,
        (SELECT relforcerowsecurity FROM pg_class WHERE oid='public.workspace_link_aliases'::regclass) AS forced,
        (SELECT array_agg(tgrelid::regclass::text||'.'||tgname) FROM pg_trigger WHERE tgfoid=p.oid) AS triggers
      FROM pg_proc p WHERE p.oid=$1::regprocedure`, [FN])).rows[0]
    expect(fn).toEqual({ sha: BODY_SHA, prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], table_owner: true,
      grantees_are_owner: [true], app_user_execute: false, forced: false, triggers: ['workspaces.workspaces_tombstone_internal_links'] })
    // 8292 fixed the caller, not the policy. 8293 then dropped the bypass leg, so the
    // member leg is all that remains and the definer tombstone no longer needs either.
    const policy = (await pool.query(`SELECT pg_get_expr(polqual,polrelid) AS qual,pg_get_expr(polwithcheck,polrelid) AS wc FROM pg_policy
      WHERE polrelid='public.workspace_link_aliases'::regclass AND polname='workspace_link_aliases_member'`)).rows[0]
    expect(policy.qual).toBe(MEMBER_LEG)
    expect(policy.wc).toBe(MEMBER_LEG)
    expect(`${policy.qual}${policy.wc}`).not.toContain(BYPASS)
  })

  it('the owner deletes a workspace with aliases on a fresh app session and on the same backend after a product elevation', async () => {
    const store = createWorkspaceStore()
    const first = await workspaceWithAliases('fresh'), second = await workspaceWithAliases('elevated'), bystander = await workspaceWithAliases('bystander')

    const pid = await freshAppSession()
    expect(await sessionBypass()).toBeNull()
    expect(await store.delete(first.owner, first.workspaceId)).toBe(true)
    expect(await workspaceExists(first.workspaceId)).toBe(false)
    expect(await aliasRows(first.keys)).toEqual([TOMBSTONE, TOMBSTONE])

    expect(await afterProductElevation(second.workspaceId)).toBe(pid)
    expect(await sessionBypass()).toBe('')
    // Before 8292 this was refused with an RLS violation on workspace_link_aliases and the workspace remained.
    expect(await store.delete(second.owner, second.workspaceId)).toBe(true)
    expect(await backendPid()).toBe(pid)
    expect(await workspaceExists(second.workspaceId)).toBe(false)
    expect(await aliasRows(second.keys)).toEqual([TOMBSTONE, TOMBSTONE])

    // Only rows keyed by OLD.id are rewritten.
    const kept = (await aliasRows(bystander.keys)).map(r => ({ workspace_id: r.workspace_id, is_current: r.is_current, tombstoned: r.tombstoned }))
    expect(kept).toHaveLength(2)
    expect(kept).toEqual(expect.arrayContaining([
      { workspace_id: bystander.workspaceId, is_current: true, tombstoned: false },
      { workspace_id: bystander.workspaceId, is_current: false, tombstoned: false },
    ]))
    // A tombstoned reservation stays unique: the digest cannot be reissued to another workspace.
    await expect(pool.query("INSERT INTO workspace_link_aliases(workspace_id,alias,alias_key) VALUES($1,'fictional-reuse',$2)",
      [bystander.workspaceId, second.keys[0]])).rejects.toMatchObject({ code: '23505' })
  })

  it('a non-member or a non-owner member cannot delete, in either connection state, and a non-member cannot read', async () => {
    const store = createWorkspaceStore(), f = await workspaceWithAliases('refused')
    const readWorkspace = async (userId: string) => (await queryWithRLS<{ n: number }>(userId,
      'SELECT count(*)::int AS n FROM workspaces WHERE id=$1', [f.workspaceId])).rows[0].n
    const readAliases = async (userId: string) => (await queryWithRLS<{ n: number }>(userId,
      'SELECT count(*)::int AS n FROM workspace_link_aliases WHERE workspace_id=$1', [f.workspaceId])).rows[0].n
    const live = [
      { workspace_id: f.workspaceId, alias: 'fictional-current', is_current: true, created_by: f.owner, tombstoned: false },
      { workspace_id: f.workspaceId, alias: 'fictional-history', is_current: false, created_by: f.owner, tombstoned: false },
    ].sort((a, b) => a.alias.localeCompare(b.alias))
    const aliasesByName = async () => (await aliasRows(f.keys)).sort((a, b) => a.alias.localeCompare(b.alias))

    await freshAppSession()
    for (const userId of [f.outsider, f.member]) expect(await store.delete(userId, f.workspaceId)).toBe(false)
    expect(await readWorkspace(f.outsider)).toBe(0)
    expect(await workspaceExists(f.workspaceId)).toBe(true)
    expect(await aliasesByName()).toEqual(live)

    await afterProductElevation(f.workspaceId)
    expect(await sessionBypass()).toBe('')
    for (const userId of [f.outsider, f.member]) expect(await store.delete(userId, f.workspaceId)).toBe(false)
    expect(await readWorkspace(f.outsider)).toBe(0)
    expect(await readAliases(f.outsider)).toBe(0)
    expect(await readAliases(f.owner)).toBe(2)
    expect(await workspaceExists(f.workspaceId)).toBe(true)
    expect(await aliasesByName()).toEqual(live)
  })

  it('app_user cannot bind the definer to a table of its own', async () => {
    const c = await app.connect()
    try {
      await c.query('BEGIN')
      // The runtime role can create a temporary table, so the attach vector is real without the owner-only ACL.
      await c.query('CREATE TEMP TABLE fictional_attach(id uuid) ON COMMIT DROP')
      await expect(c.query(`CREATE TRIGGER fictional_attach_tombstone BEFORE DELETE ON fictional_attach
        FOR EACH ROW EXECUTE FUNCTION ${FN}`)).rejects.toThrow(/permission denied for function (public\.)?tombstone_workspace_link_aliases/)
    } finally { await c.query('ROLLBACK').catch(() => {}); c.release() }
  })
})
