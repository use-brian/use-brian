/**
 * Department owners and edges (permission model v2, Phase 1) on a
 * migration-replayed PostgreSQL: the 648 backfill, and the store's I4, I5, I6
 * and I17 guarantees. Run through `scripts/crm/local-fixture.mjs`, which
 * supplies DATABASE_URL (owner) and DATABASE_URL_APP (a NOBYPASSRLS role).
 * Skips when no such database is reachable.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool } from '../client.js'
import { createDepartmentStore } from '../department-store.js'

async function available(): Promise<boolean> {
  if (!process.env.DATABASE_URL || !process.env.DATABASE_URL_APP) return false
  try {
    await getPool().query('SELECT 1 FROM department_edges LIMIT 1')
    return true
  } catch {
    return false
  }
}
const ok = await available()
const describeIf = ok ? describe : describe.skip
const pool = ok ? getPool() : undefined!
const store = createDepartmentStore()
const q = (sql: string, values: unknown[] = []) => pool.query(sql, values)

afterAll(async () => {
  if (!ok) return
  await getAppPool().end()
  await pool.end()
})

async function user(): Promise<string> {
  return (await q(`INSERT INTO users(auth_provider,auth_provider_id) VALUES('test',$1) RETURNING id`, [randomUUID()])).rows[0].id
}
async function member(w: string, role: 'owner' | 'admin' | 'member', clearance = 'internal', mode = 'assigned', compartments: string[] | null = null) {
  const id = await user()
  await q(`INSERT INTO workspace_members(workspace_id,user_id,role,clearance,team_scope_mode,compartments) VALUES($1,$2,$3,$4,$5,$6)`,
    [w, id, role, clearance, mode, compartments])
  return id
}
async function team(w: string, createdBy: string, name: string) {
  const id = randomUUID(), key = `team:${id}`
  await q(`INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1,$2,$3,$4,'team',$1::uuid::text,$5)`, [id, w, name, createdBy, key])
  await q(`INSERT INTO workspace_compartments(workspace_id,key,label,created_by,managed_by,managed_ref_id) VALUES($1,$2,$3,$4,'team',$5)`, [w, key, name, createdBy, id])
  return { id, key }
}
async function edges(w: string) {
  return (await q(`SELECT department_id AS d, principal_kind AS k, coalesce(user_id,assistant_id) AS p, clearance AS c, expires_at AS x, origin AS o
                     FROM department_edges WHERE workspace_id=$1 ORDER BY 1,2,3`, [w])).rows
}
const edgeOf = (rows: Awaited<ReturnType<typeof edges>>, d: string, p: string) => rows.find(r => r.d === d && r.p === p)

/** Ava owns the workspace, Jun is an admin, Maya and Priya are members, Omar is a former member. */
async function workspace() {
  const ava = await user()
  // Born on the legacy model, as every workspace was before the cutover (650).
  const w = (await q(`INSERT INTO workspaces(name,purpose,owner_user_id,is_personal,department_read_v2) VALUES('Fictional Co','test',$1,false,false) RETURNING id`, [ava])).rows[0].id as string
  await q(`INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')`, [w, ava])
  const jun = await member(w, 'admin', 'confidential')
  const maya = await member(w, 'member', 'internal')
  const priya = await member(w, 'member', 'confidential')
  const platform = await team(w, jun, 'Platform')
  const finance = await team(w, jun, 'Finance')
  const sales = await team(w, ava, 'Sales')
  return { w, ava, jun, maya, priya, platform, finance, sales }
}

describeIf('[COMP:access/department-store] Department owners and edges', () => {
  it('backfills edges that reproduce legacy reach, owners, grants and assistants, idempotently', async () => {
    const f = await workspace()
    // Legacy state: Maya is a Platform member whose Team bundles Finance;
    // Priya manages Finance; a legacy-mode member with no compartments has the
    // universe; Maya holds a live read grant on Sales.
    await q(`INSERT INTO workspace_group_members(group_id,user_id) VALUES($1,$2)`, [f.platform.id, f.maya])
    await q(`INSERT INTO workspace_group_compartment_grants(group_id,compartment_key) VALUES($1,$2)`, [f.platform.id, f.finance.key])
    await q(`INSERT INTO workspace_group_members(group_id,user_id) VALUES($1,$2)`, [f.finance.id, f.priya])
    await q(`INSERT INTO workspace_team_managers(workspace_id,team_id,user_id,capabilities,granted_by) VALUES($1,$2,$3,ARRAY['manage_members'],$4)`, [f.w, f.finance.id, f.priya, f.ava])
    const universe = await member(f.w, 'member', 'public', 'legacy', null)
    const expires = new Date(Date.now() + 7 * 86_400_000)
    const request = (await q(`INSERT INTO workspace_access_requests(workspace_id,requester_user_id,beneficiary_kind,beneficiary_id,target_team_id,reason,starts_at,expires_at,payload_hash,policy_revision,status,decided_by,decided_at)
      VALUES($1,$2,'member',$2,$3,'quarterly review',now()-interval '1 minute',$4,repeat('a',64),1,'approved',$5,now()) RETURNING id`, [f.w, f.maya, f.sales.id, expires, f.ava])).rows[0].id
    await q(`INSERT INTO workspace_access_grants(workspace_id,request_id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,approved_by)
      SELECT workspace_id,id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,decided_by FROM workspace_access_requests WHERE id=$1`, [request])
    const primary = (await q(`INSERT INTO assistants(name,workspace_id,kind,clearance) VALUES('Brian',$1,'primary','confidential') RETURNING id`, [f.w])).rows[0].id
    const ops = (await q(`INSERT INTO assistants(name,workspace_id,kind,clearance,team_scope_mode) VALUES('Ops',$1,'standard','internal','assigned') RETURNING id`, [f.w])).rows[0].id
    await q(`INSERT INTO workspace_group_assistants(group_id,assistant_id) VALUES($1,$2)`, [f.platform.id, ops])
    const key = (await q(`INSERT INTO brain_keys(workspace_id,name,key_hash,key_prefix,created_by) VALUES($1,'k',$2,'sk_brain_x',$3) RETURNING issuer_user_id`, [f.w, randomUUID(), f.jun])).rows[0]
    expect(key.issuer_user_id).toBe(f.jun)

    await q('SELECT department_edges_reconcile($1)', [f.w])
    const first = await edges(f.w)
    // Owners and admins: confidential everywhere, tagged migrated unless a real member.
    for (const d of [f.platform.id, f.finance.id, f.sales.id]) {
      expect(edgeOf(first, d, f.ava)?.c).toBe('confidential')
      expect(edgeOf(first, d, f.jun)?.c).toBe('confidential')
      expect(edgeOf(first, d, universe)).toMatchObject({ c: 'public', o: 'migrated' })
      expect(edgeOf(first, d, primary)).toMatchObject({ c: 'confidential', o: 'primary' })
    }
    expect(edgeOf(first, f.platform.id, f.maya)).toMatchObject({ c: 'internal', o: 'member', x: null })
    expect(edgeOf(first, f.finance.id, f.maya)).toMatchObject({ c: 'internal', o: 'migrated' })
    expect(edgeOf(first, f.sales.id, f.maya)).toMatchObject({ c: 'internal', o: 'grant' })
    expect(new Date(edgeOf(first, f.sales.id, f.maya)!.x).getTime()).toBe(expires.getTime())
    expect(edgeOf(first, f.finance.id, f.priya)).toMatchObject({ c: 'confidential', o: 'member' })
    expect(edgeOf(first, f.platform.id, f.priya)).toBeUndefined()
    // Ops reaches Platform (assigned) and its Finance bundle, at its own clearance.
    expect(edgeOf(first, f.platform.id, ops)).toMatchObject({ c: 'internal', o: 'assistant' })
    // Reach through a bundle, not an explicit assignment: kept, tagged for review (D23).
    expect(edgeOf(first, f.finance.id, ops)).toMatchObject({ c: 'internal', o: 'migrated' })
    expect(edgeOf(first, f.sales.id, ops)).toBeUndefined()
    // Owners: the live manager, plus each Team's creator.
    const owners = (await q('SELECT department_id AS d,user_id AS u FROM department_owners WHERE workspace_id=$1', [f.w])).rows
    expect(owners).toEqual(expect.arrayContaining([{ d: f.finance.id, u: f.priya }, { d: f.platform.id, u: f.jun }, { d: f.sales.id, u: f.ava }]))

    // Rerun: identical. Remove Maya from Platform: her member and bundle edges go.
    await q('SELECT department_edges_reconcile($1)', [f.w])
    expect(await edges(f.w)).toEqual(first)
    await q('DELETE FROM workspace_group_members WHERE group_id=$1 AND user_id=$2', [f.platform.id, f.maya])
    await q('SELECT department_edges_reconcile($1)', [f.w])
    const after = await edges(f.w)
    expect(edgeOf(after, f.platform.id, f.maya)).toBeUndefined()
    expect(edgeOf(after, f.finance.id, f.maya)).toBeUndefined()
    expect(edgeOf(after, f.sales.id, f.maya)?.o).toBe('grant')
  })

  it('I17: authority is rechecked in the transaction; repeats are idempotent; stale revisions fail', async () => {
    const f = await workspace()
    await q('SELECT department_edges_reconcile($1)', [f.w])
    // Jun created Platform, so Jun owns it. Maya is a plain member.
    const r0 = Number((await q('SELECT revision FROM department_revisions WHERE department_id=$1', [f.platform.id])).rows[0].revision)
    await expect(store.setEdge(f.maya, f.platform.id, { kind: 'user', id: f.priya }, 'internal', null))
      .rejects.toMatchObject({ code: 'department_owner_required' })
    const r1 = await store.setEdge(f.jun, f.platform.id, { kind: 'user', id: f.maya }, 'internal', null, r0)
    expect(r1).toBe(r0 + 1)
    // Same state again: success, no new revision, even with the old revision in hand.
    expect(await store.setEdge(f.jun, f.platform.id, { kind: 'user', id: f.maya }, 'internal', null, r0)).toBe(r1)
    // A different change presented with the stale revision fails.
    await expect(store.setEdge(f.jun, f.platform.id, { kind: 'user', id: f.maya }, 'public', null, r0))
      .rejects.toMatchObject({ code: 'department_revision_stale' })
    // An admin role confers nothing: Ava owns the workspace but not Platform.
    await expect(store.setEdge(f.ava, f.platform.id, { kind: 'user', id: f.priya }, 'internal', null))
      .rejects.toMatchObject({ code: 'department_owner_required' })
    // Losing ownership mid-way: the next call is refused.
    await store.addOwner(f.jun, f.platform.id, f.priya)
    await store.removeOwner(f.priya, f.platform.id, f.jun)
    await expect(store.setEdge(f.jun, f.platform.id, { kind: 'user', id: f.maya }, 'public', null))
      .rejects.toMatchObject({ code: 'department_owner_required' })
    // The last owner cannot leave.
    await expect(store.removeOwner(f.priya, f.platform.id, f.priya)).rejects.toMatchObject({ code: 'department_last_owner' })
    const audit = (await q('SELECT action FROM department_audit_events WHERE department_id=$1 ORDER BY created_at', [f.platform.id])).rows.map(r => r.action)
    expect(audit).toEqual(['edge_set', 'owner_added', 'owner_removed'])
  })

  it('I4: no owner grants above their own clearance in the department, and an owner edge cannot be lowered', async () => {
    const f = await workspace()
    await q('SELECT department_edges_reconcile($1)', [f.w])
    // An owner holds confidential in D by construction; that is the ceiling.
    await expect(q(`UPDATE department_edges SET clearance='internal' WHERE department_id=$1 AND user_id=$2`, [f.platform.id, f.jun]))
      .rejects.toThrow('department_owner_edge_required')
    await expect(q(`DELETE FROM department_edges WHERE department_id=$1 AND user_id=$2`, [f.platform.id, f.jun]))
      .rejects.toThrow('department_owner_edge_required')
    await expect(store.setEdge(f.jun, f.platform.id, { kind: 'user', id: f.jun }, 'internal', null))
      .rejects.toMatchObject({ code: 'department_owner_edge_required' })
    // A member who is not an owner cannot add anyone at any clearance.
    await store.setEdge(f.jun, f.platform.id, { kind: 'user', id: f.maya }, 'internal', null)
    for (const c of ['public', 'internal', 'confidential'] as const) {
      await expect(store.setEdge(f.maya, f.platform.id, { kind: 'user', id: f.priya }, c, null))
        .rejects.toMatchObject({ code: 'department_owner_required' })
    }
    // The ceiling check itself: an owner whose own edge reads below the
    // requested clearance is refused. The owner-edge guard forbids that state,
    // so it is staged with the guard off inside a rolled-back transaction.
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query('ALTER TABLE department_edges DISABLE TRIGGER department_edges_owner_guard')
      await c.query(`UPDATE department_edges SET clearance='internal' WHERE department_id=$1 AND user_id=$2`, [f.finance.id, f.jun])
      await c.query('ALTER TABLE department_edges ENABLE TRIGGER department_edges_owner_guard')
      await c.query("SELECT set_config('app.current_user_id',$1,true)", [f.jun])
      await expect(c.query(`SELECT department_set_edge($1,'user',$2,'confidential',NULL,NULL)`, [f.finance.id, f.maya]))
        .rejects.toThrow('department_clearance_above_own')
    } finally { await c.query('ROLLBACK'); c.release() }
  })

  it('I5: a department action changes no base clearance and no other department', async () => {
    const f = await workspace()
    await q('SELECT department_edges_reconcile($1)', [f.w])
    const base = async () => (await q('SELECT user_id,clearance,role FROM workspace_members WHERE workspace_id=$1 ORDER BY user_id', [f.w])).rows
    // Adding or removing someone also writes their Team membership (652), which
    // re-runs the reconcile; that may touch updated_at, never what an edge grants.
    const elsewhere = async () => (await q(`SELECT id, department_id, principal_kind, user_id, assistant_id, clearance, expires_at, origin
                                              FROM department_edges WHERE workspace_id=$1 AND department_id<>$2 ORDER BY id`, [f.w, f.platform.id])).rows
    const beforeBase = await base(), beforeOther = await elsewhere()
    await store.setEdge(f.jun, f.platform.id, { kind: 'user', id: f.maya }, 'confidential', null)
    await store.addOwner(f.jun, f.platform.id, f.maya)
    await store.removeEdge(f.jun, f.platform.id, { kind: 'user', id: f.priya })
    expect(await base()).toEqual(beforeBase)
    expect(await elsewhere()).toEqual(beforeOther)
  })

  it('I6: an expired edge is identical to a missing one for reads, rosters and authority', async () => {
    const f = await workspace()
    await q('SELECT department_edges_reconcile($1)', [f.w])
    await store.setEdge(f.jun, f.platform.id, { kind: 'user', id: f.maya }, 'internal', new Date(Date.now() + 60_000))
    expect(await store.clearanceIn(f.maya, { kind: 'user', id: f.maya }, f.platform.id)).toBe('internal')
    await q(`UPDATE department_edges SET expires_at=now()-interval '1 second' WHERE department_id=$1 AND user_id=$2`, [f.platform.id, f.maya])
    expect((await q('SELECT department_clearance_in($1,$2,$3) AS c', ['user', f.maya, f.platform.id])).rows[0].c).toBeNull()
    // Maya no longer sees the roster at all, and her clearance there is absent.
    expect(await store.listEdges(f.maya, f.platform.id)).toEqual([])
    expect(await store.clearanceIn(f.maya, { kind: 'user', id: f.maya }, f.platform.id)).toBeNull()
    expect((await store.listEdges(f.jun, f.platform.id)).some(e => e.principal.id === f.maya)).toBe(false)
  })

  it('a non-member sees nothing of a department, admin included; break-glass is the owner\'s audited way in', async () => {
    const f = await workspace()
    await q('SELECT department_edges_reconcile($1)', [f.w])
    // Board is created after the backfill by Priya: Ava and Jun hold no edge there.
    const board = await team(f.w, f.priya, 'Board')
    expect(await store.listEdges(f.jun, board.id)).toEqual([])
    expect(await store.clearanceIn(f.jun, { kind: 'user', id: f.priya }, board.id)).toBeNull()
    await expect(store.breakGlass(f.jun, board.id, 'recovery')).rejects.toMatchObject({ code: 'department_break_glass_owner_only' })
    await expect(store.breakGlass(f.ava, board.id, ' ')).rejects.toMatchObject({ code: 'department_break_glass_reason_required' })
    await store.breakGlass(f.ava, board.id, 'owner left the company')
    const seen = await store.listEdges(f.priya, board.id)
    expect(seen.find(e => e.principal.id === f.ava)?.clearance).toBe('confidential')
    const audit = (await q(`SELECT actor_user_id AS a, action, reason FROM department_audit_events WHERE department_id=$1`, [board.id])).rows
    expect(audit).toEqual([{ a: f.ava, action: 'break_glass', reason: 'owner left the company' }])
  })

  it('a Team created after 648 seeds its creator as owner and the primary assistant edge', async () => {
    const f = await workspace()
    const primary = (await q(`INSERT INTO assistants(name,workspace_id,kind,clearance) VALUES('Brian',$1,'primary','confidential') RETURNING id`, [f.w])).rows[0].id
    const board = await team(f.w, f.priya, 'Board')
    const rows = await edges(f.w)
    expect(edgeOf(rows, board.id, f.priya)).toMatchObject({ c: 'confidential', o: 'owner' })
    expect(edgeOf(rows, board.id, primary)).toMatchObject({ c: 'confidential', o: 'primary' })
    expect((await q('SELECT user_id FROM department_owners WHERE department_id=$1', [board.id])).rows).toEqual([{ user_id: f.priya }])
  })
})

describeIf('[COMP:access/department-store] After the cutover: edges, home departments and the directory (651)', () => {
  /** A v2 workspace as the cutover leaves it: flagged, reconciled. */
  async function flagged() {
    const f = await workspace()
    // The cutover's order: reconcile the legacy state, then flip.
    await q('SELECT department_edges_reconcile($1)', [f.w])
    await q('UPDATE workspaces SET department_read_v2=true WHERE id=$1', [f.w])
    return f
  }

  it('D23: a role never re-derives an edge; a removed migrated edge stays removed after any sync', async () => {
    const f = await flagged()
    // Jun (admin) holds a migrated edge in Sales only because of the role.
    const migrated = (await edges(f.w)).find(e => e.d === f.sales.id && e.p === f.jun)
    expect(migrated?.o).toBe('migrated')
    await store.removeEdge(f.ava, f.sales.id, { kind: 'user', id: f.jun })
    // Any legacy membership write re-runs the reconcile (650 sync).
    const newcomer = await member(f.w, 'admin', 'confidential')
    await q('SELECT department_edges_reconcile($1)', [f.w])
    const after = await edges(f.w)
    expect(edgeOf(after, f.sales.id, f.jun)).toBeUndefined()
    expect(after.filter(e => e.p === newcomer)).toEqual([])
    // A real membership still derives an edge.
    await q('INSERT INTO workspace_group_members(group_id,user_id) VALUES($1,$2)', [f.platform.id, newcomer])
    expect(edgeOf(await edges(f.w), f.platform.id, newcomer)).toMatchObject({ o: 'member', c: 'confidential' })
  })

  it('D24: a write naming no department lands in the writer\'s home; explicit General and labelled writes are untouched', async () => {
    const f = await flagged()
    await store.setEdge(f.jun, f.platform.id, { kind: 'user', id: f.maya }, 'internal', null)
    await expect(store.setHome(f.maya, f.w, { kind: 'user', id: f.maya }, f.finance.id)).rejects.toMatchObject({ code: 'department_home_requires_edge' })
    await expect(store.setHome(f.maya, f.w, { kind: 'user', id: f.priya }, f.platform.id)).rejects.toMatchObject({ code: 'department_home_not_allowed' })
    await store.setHome(f.maya, f.w, { kind: 'user', id: f.maya }, f.platform.id)
    const task = async (labels: string[] = []) => (await q(`INSERT INTO tasks(workspace_id,title,created_by_user_id,compartments) VALUES($1,'bg',$2,$3) RETURNING compartments`, [f.w, f.maya, labels])).rows[0].compartments
    expect(await task()).toEqual([f.platform.key])
    expect(await task([f.finance.key])).toEqual([f.finance.key])
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query("SELECT set_config('app.explicit_general','true',true)")
      expect((await c.query(`INSERT INTO tasks(workspace_id,title,created_by_user_id) VALUES($1,'general',$2) RETURNING compartments`, [f.w, f.maya])).rows[0].compartments).toEqual([])
    } finally { await c.query('ROLLBACK'); c.release() }
    // The assistant's home wins over the person's.
    const ops = (await q(`INSERT INTO assistants(name,workspace_id,kind,clearance,owner_user_id) VALUES('Ops',$1,'standard','internal',$2) RETURNING id`, [f.w, f.maya])).rows[0].id
    await store.setEdge(f.jun, f.platform.id, { kind: 'assistant', id: ops }, 'internal', null)
    await q('INSERT INTO workspace_group_members(group_id,user_id) VALUES($1,$2)', [f.finance.id, f.maya])
    await store.setEdge(f.jun, f.finance.id, { kind: 'assistant', id: ops }, 'internal', null)
    await store.setHome(f.maya, f.w, { kind: 'assistant', id: ops }, f.finance.id)
    expect((await q(`INSERT INTO tasks(workspace_id,user_id,created_by_user_id,created_by_assistant_id,title) VALUES($1,$2,$2,$3,'dream') RETURNING compartments`, [f.w, f.maya, ops])).rows[0].compartments).toEqual([f.finance.key])
    // A flag-off workspace is never stamped.
    await q('UPDATE workspaces SET department_read_v2=false WHERE id=$1', [f.w])
    expect(await task()).toEqual([])
    await q('UPDATE workspaces SET department_read_v2=true WHERE id=$1', [f.w])
    // Losing the edge loses the home.
    await store.removeEdge(f.jun, f.platform.id, { kind: 'user', id: f.maya })
    expect((await q('SELECT home_department_id h FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.w, f.maya])).rows[0].h).toBeNull()
  })

  it('directory: members see their departments; the workspace owner sees names and owners only; an admin sees nothing it is not in', async () => {
    const f = await flagged()
    const board = await team(f.w, f.priya, 'Board')
    const ids = (rows: { departmentId: string }[]) => rows.map(r => r.departmentId)
    expect(ids(await store.directory(f.priya, f.w))).toContain(board.id)
    expect(ids(await store.directory(f.jun, f.w))).not.toContain(board.id)
    const owners = (await store.directory(f.ava, f.w)).find(d => d.departmentId === board.id)
    expect(owners).toMatchObject({ myClearance: null, isOwner: false, ownerIds: [f.priya] })
    expect(await store.listEdges(f.ava, board.id)).toEqual([])
  })

  it('D26: one roster: the panel and Team membership move together, and a removal sticks', async () => {
    const f = await flagged()
    const isMember = async (d: string, u: string) => (await q('SELECT 1 FROM workspace_group_members WHERE group_id=$1 AND user_id=$2', [d, u])).rows.length === 1
    // Adding Maya in the panel makes her a Team member, at the clearance the owner chose.
    await store.setEdge(f.jun, f.platform.id, { kind: 'user', id: f.maya }, 'public', null)
    expect(await isMember(f.platform.id, f.maya)).toBe(true)
    await q('SELECT department_edges_reconcile($1)', [f.w])
    expect(edgeOf(await edges(f.w), f.platform.id, f.maya)).toMatchObject({ c: 'public', o: 'store' })
    // Removing her ends the membership, so no later sync brings her back.
    await store.removeEdge(f.jun, f.platform.id, { kind: 'user', id: f.maya })
    expect(await isMember(f.platform.id, f.maya)).toBe(false)
    await member(f.w, 'member')
    await q('SELECT department_edges_reconcile($1)', [f.w])
    expect(edgeOf(await edges(f.w), f.platform.id, f.maya)).toBeUndefined()
    // The other direction: ending the membership elsewhere ends a panel-written edge too.
    await store.setEdge(f.jun, f.platform.id, { kind: 'user', id: f.maya }, 'internal', null)
    await q('DELETE FROM workspace_group_members WHERE group_id=$1 AND user_id=$2', [f.platform.id, f.maya])
    expect(edgeOf(await edges(f.w), f.platform.id, f.maya)).toBeUndefined()
    // An owner's edge survives losing the membership (Jun created Platform).
    await q('DELETE FROM workspace_group_members WHERE group_id=$1 AND user_id=$2', [f.platform.id, f.jun])
    expect(edgeOf(await edges(f.w), f.platform.id, f.jun)?.c).toBe('confidential')
    // Assistants: assignment and edge move together.
    const ops = (await q(`INSERT INTO assistants(name,workspace_id,kind,clearance) VALUES('Ops',$1,'standard','internal') RETURNING id`, [f.w])).rows[0].id
    await store.setEdge(f.jun, f.platform.id, { kind: 'assistant', id: ops }, 'internal', null)
    expect((await q('SELECT 1 FROM workspace_group_assistants WHERE group_id=$1 AND assistant_id=$2', [f.platform.id, ops])).rows).toHaveLength(1)
    await store.removeEdge(f.jun, f.platform.id, { kind: 'assistant', id: ops })
    expect((await q('SELECT 1 FROM workspace_group_assistants WHERE group_id=$1 AND assistant_id=$2', [f.platform.id, ops])).rows).toHaveLength(0)
    expect(edgeOf(await edges(f.w), f.platform.id, ops)).toBeUndefined()
  })

  it('D26: sources the panel cannot end are refused by name instead of silently returning', async () => {
    const f = await flagged()
    const primary = (await q(`INSERT INTO assistants(name,workspace_id,kind,clearance) VALUES('Brian',$1,'primary','confidential') RETURNING id`, [f.w])).rows[0].id
    await q('SELECT department_edges_reconcile($1)', [f.w])
    await expect(store.removeEdge(f.jun, f.platform.id, { kind: 'assistant', id: primary })).rejects.toMatchObject({ code: 'department_primary_assistant' })
    // Maya reads Platform through an approved access grant.
    const request = (await q(`INSERT INTO workspace_access_requests(workspace_id,requester_user_id,beneficiary_kind,beneficiary_id,target_team_id,reason,starts_at,expires_at,payload_hash,policy_revision,status,decided_by,decided_at)
      VALUES($1,$2,'member',$2,$3,'audit',now()-interval '1 minute',now()+interval '7 days',repeat('b',64),1,'approved',$4,now()) RETURNING id`, [f.w, f.maya, f.platform.id, f.jun])).rows[0].id
    await q(`INSERT INTO workspace_access_grants(workspace_id,request_id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,approved_by)
      SELECT workspace_id,id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,decided_by FROM workspace_access_requests WHERE id=$1`, [request])
    expect(edgeOf(await edges(f.w), f.platform.id, f.maya)?.o).toBe('grant')
    await expect(store.removeEdge(f.jun, f.platform.id, { kind: 'user', id: f.maya })).rejects.toMatchObject({ code: 'department_access_via_grant' })
    expect(edgeOf(await edges(f.w), f.platform.id, f.maya)?.o).toBe('grant')
  })
})
