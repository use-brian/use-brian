import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getPool } from '../client.js'
import { createWorkspaceStore } from '../workspace-store.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool(), store = createWorkspaceStore()
let db: PoolClient
let workspace: string, owner: string, member: string, department: string
let shared: string[], privateAssistant: string, ownAssistant: string
const query = (sql: string, values: unknown[] = []) => db.query(sql, values)
const rows = async (sql: string, values: unknown[] = []) => (await query(sql, values)).rows
const admit = (method: 'addMember' | 'ensureMemberSystem') => method === 'addMember'
  ? store.addMember(owner, workspace, member)
  : store.ensureMemberSystem(workspace, member)

// Real committed fixtures: store methods must manage their own transactions.
// The marker check above refuses any database not owned by the disposable harness.
describe('workspace member admission atomicity', () => {
  beforeAll(async () => { db = await pool.connect() })
  beforeEach(async () => {
    workspace = randomUUID(); owner = randomUUID(); member = randomUUID(); department = randomUUID()
    for (const id of [owner, member]) await query('INSERT INTO users(id,auth_provider_id) VALUES($1,$1::uuid::text)', [id])
    await query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Member admission',$2)", [workspace, owner])
    await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')", [workspace, owner])
    await query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1,$2,'Default',$3,'team',$1::uuid::text,$4)", [department, workspace, owner, `team:${department}`])
    await query("INSERT INTO workspace_compartments(workspace_id,key,label,created_by,managed_by,managed_ref_id) VALUES($1,$2,'Default',$3,'team',$4)", [workspace, `team:${department}`, owner, department])
    await query('INSERT INTO workspace_group_compartment_grants(group_id,compartment_key) VALUES($1,$2)', [department, `team:${department}`])
    await query("UPDATE workspace_access_policies SET access_mode='simple',default_department_id=$2,setup_state='ready' WHERE workspace_id=$1", [workspace, department])
    shared = []
    for (const [kind, user] of [['standard', null], ['primary', owner], ['app', owner], ['standard', owner], ['standard', member]]) {
      const [{ id }] = await rows("INSERT INTO assistants(name,workspace_id,owner_user_id,kind,app_type) VALUES('Admission',$1,$2,$3,CASE WHEN $3='app' THEN 'distribution' ELSE NULL END) RETURNING id", [workspace, user, kind])
      if (kind !== 'standard' || user === null) shared.push(id)
      else if (user === owner) privateAssistant = id
      else ownAssistant = id
    }
  })
  afterEach(async () => {
    await query('DELETE FROM workspaces WHERE id=$1', [workspace])
    await query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[owner, member]])
  })
  afterAll(async () => { db?.release(); await pool.end() })

  it.each(['addMember', 'ensureMemberSystem'] as const)('%s admits Simple defaults without sharing personal assistants', async method => {
    await admit(method)
    expect(await rows('SELECT role,clearance,team_scope_mode FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspace, member]))
      .toEqual([{ role: 'member', clearance: 'internal', team_scope_mode: 'assigned' }])
    expect(await rows('SELECT group_id FROM workspace_group_members WHERE user_id=$1', [member])).toEqual([{ group_id: department }])
    const memberships = await rows('SELECT assistant_id FROM assistant_members WHERE user_id=$1', [member])
    expect(memberships.map(r => r.assistant_id).sort()).toEqual([...shared, ownAssistant].sort())
    expect(memberships.map(r => r.assistant_id)).not.toContain(privateAssistant)
    expect(await rows('SELECT tm.user_id FROM teamspace_members tm JOIN teamspaces t ON t.id=tm.teamspace_id WHERE t.workspace_id=$1 ORDER BY tm.user_id', [workspace]))
      .toEqual([owner, member].sort().map(user_id => ({ user_id })))
  })

  for (const method of ['addMember', 'ensureMemberSystem'] as const) {
    it.each(['assistant_members', 'teamspace_members'] as const)(`${method} rolls back every admission write on %s failure`, async table => {
      const trigger = `admission_fault_${randomUUID().replaceAll('-', '')}`
      await query(`CREATE FUNCTION pg_temp.${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.user_id = '${member}'::uuid THEN RAISE EXCEPTION 'member admission fault'; END IF;
        RETURN NEW; END $$`)
      await query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION pg_temp.${trigger}()`)
      const revision = await rows('SELECT revision FROM workspace_access_policies WHERE workspace_id=$1', [workspace])
      try {
        await expect(admit(method)).rejects.toThrow('member admission fault')
        for (const relation of ['workspace_members', 'assistant_members', 'workspace_group_members', 'teamspace_members']) {
          expect(await rows(`SELECT user_id FROM ${relation} WHERE user_id=$1`, [member])).toEqual([])
        }
        expect(await rows('SELECT id FROM teamspaces WHERE workspace_id=$1', [workspace])).toEqual([])
        expect(await rows('SELECT revision FROM workspace_access_policies WHERE workspace_id=$1', [workspace])).toEqual(revision)
      } finally {
        await query(`DROP TRIGGER ${trigger} ON ${table}`)
        await query(`DROP FUNCTION pg_temp.${trigger}()`)
      }
      await expect(admit(method)).resolves.toMatchObject({ userId: member })
    })
  }

  it('concurrent JIT retries are idempotent and preserve existing role, clearance and assistant ownership', async () => {
    const initial = await store.addMember(owner, workspace, member, 'admin')
    await query("UPDATE workspace_members SET can_draft=false,clearance='public' WHERE workspace_id=$1 AND user_id=$2", [workspace, member])
    await query("UPDATE assistant_members SET role='owner' WHERE assistant_id=$1 AND user_id=$2", [ownAssistant, member])
    const [a, b] = await Promise.all([store.ensureMemberSystem(workspace, member), store.ensureMemberSystem(workspace, member)])
    expect(a).toEqual(b)
    expect(a).toMatchObject({ id: initial.id, role: 'admin', clearance: 'public', canDraft: false, joinedAt: initial.joinedAt })
    expect(await rows('SELECT role FROM assistant_members WHERE assistant_id=$1 AND user_id=$2', [ownAssistant, member])).toEqual([{ role: 'owner' }])
    expect(await rows('SELECT group_id FROM workspace_group_members WHERE user_id=$1', [member])).toEqual([{ group_id: department }])
    expect((await rows('SELECT * FROM teamspace_members WHERE user_id=$1', [member])).length).toBe(1)
    await expect(store.addMember(owner, workspace, member)).rejects.toMatchObject({ code: '23505' })
  })

  it('waits on the workspace lock and admits against the policy committed by its holder', async () => {
    await query('BEGIN')
    await query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspace])
    const [{ pid }] = await rows('SELECT pg_backend_pid() pid')
    const pending = store.ensureMemberSystem(workspace, member)
    try {
      await expect.poll(async () => (await rows(
        'SELECT count(*)::int n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid],
      ))[0].n).toBe(1)
      expect(await rows('SELECT id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspace, member])).toEqual([])
      await query("UPDATE workspace_access_policies SET access_mode='departments' WHERE workspace_id=$1", [workspace])
      await query('COMMIT')
      await pending
      expect(await rows('SELECT team_scope_mode FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspace, member])).toEqual([{ team_scope_mode: 'legacy' }])
      expect(await rows('SELECT group_id FROM workspace_group_members WHERE user_id=$1', [member])).toEqual([])
    } finally {
      await query('ROLLBACK')
      await pending
    }
  })

  it('JIT reacceptance does not convert existing legacy members when the workspace becomes Simple', async () => {
    await query("UPDATE workspace_access_policies SET access_mode='departments' WHERE workspace_id=$1", [workspace])
    await store.ensureMemberSystem(workspace, member)
    await query("UPDATE workspace_access_policies SET access_mode='simple' WHERE workspace_id=$1", [workspace])
    await store.ensureMemberSystem(workspace, member)
    expect(await rows('SELECT team_scope_mode FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspace, member])).toEqual([{ team_scope_mode: 'legacy' }])
    expect(await rows('SELECT group_id FROM workspace_group_members WHERE user_id=$1', [member])).toEqual([])
  })
})
