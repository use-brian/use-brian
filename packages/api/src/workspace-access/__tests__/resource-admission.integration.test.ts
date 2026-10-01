import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getPool } from '../../db/client.js'
import { runWithAgentAccess } from '../../db/agent-access-context.js'
import { admitWorkspaceResource, type AdmissionInput } from '../resource-admission.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
let db: PoolClient
const query = (sql: string, values: unknown[] = []) => db.query(sql, values)
async function fixture(mode: 'simple' | 'departments' = 'simple') {
  const workspaceId = randomUUID(), owner = randomUUID(), member = randomUUID(), outsider = randomUUID()
  for (const id of [owner, member, outsider]) await query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Admission fixture',$2)", [workspaceId, owner])
  await query("INSERT INTO workspace_members(workspace_id,user_id,role,team_scope_mode) VALUES($1,$2,'owner','assigned')", [workspaceId, owner])
  async function team() {
    const id = randomUUID(), compartment = `team:${id}`
    await query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1,$2,'Department',$3,'team',$1::uuid::text,$4)", [id, workspaceId, owner, compartment])
    await query("INSERT INTO workspace_compartments(workspace_id,key,label,created_by,managed_by,managed_ref_id) VALUES($1,$2,'Department',$3,'team',$4)", [workspaceId, compartment, owner, id])
    await query('INSERT INTO workspace_group_compartment_grants(group_id,compartment_key,granted_by_user_id) VALUES($1,$2,$3)', [id, compartment, owner])
    return { id, compartment }
  }
  const department = await team(), other = await team()
  await query("UPDATE workspace_access_policies SET access_mode=$2,default_department_id=$3,setup_state='ready' WHERE workspace_id=$1", [workspaceId, mode, department.id])
  // Schema 620 admits newly joined Simple members to its default department.
  await query("INSERT INTO workspace_members(workspace_id,user_id,role,team_scope_mode) VALUES($1,$2,'member','assigned')", [workspaceId, member])
  if (mode === 'departments') await query('INSERT INTO workspace_group_members(group_id,user_id) VALUES($1,$2)', [department.id, member])
  async function project() {
    const id = randomUUID()
    await query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,$1::uuid::text,$1::uuid::text,$3)", [id, workspaceId, owner])
    return id
  }
  const projectId = await project()
  await query('INSERT INTO workspace_project_members(project_id,user_id) VALUES($1,$2)', [projectId, member])
  const revision = async () => (await query('SELECT revision::text FROM workspace_access_policies WHERE workspace_id=$1', [workspaceId])).rows[0].revision as string
  const input = async (patch: Partial<AdmissionInput> = {}): Promise<AdmissionInput> => ({ expectedPolicyRevision: await revision(), visibility: 'workspace', sensitivity: 'internal', ...patch })
  const admit = async (patch: Partial<AdmissionInput> = {}, actor = member) => admitWorkspaceResource(db, workspaceId, actor, await input(patch))
  return { workspaceId, owner, member, outsider, department, other, projectId, project, revision, input, admit }
}

// Adapter contract only: authentication is the caller's responsibility. No HTTP
// route or production resource writer is mocked into appearing wired here.
describe('canonical resource admission PostgreSQL integration', () => {
  beforeAll(async () => {
    db = await pool.connect()
    expect((await query("SELECT count(*)::int n FROM _migrations WHERE name='620_workspace_access_modes.sql'")).rows[0].n).toBe(1)
    await query('CREATE TEMP TABLE admission_test_writes(id uuid PRIMARY KEY, envelope jsonb NOT NULL)')
  })
  beforeEach(async () => { await query('BEGIN') })
  afterEach(async () => { await query('ROLLBACK') })
  afterAll(async () => { db?.release(); await pool.end() })

  it('uses current membership, not merely an authenticated user ID', async () => {
    const f = await fixture()
    await expect(f.admit({}, f.outsider)).rejects.toMatchObject({ code: 'not_found', status: 404 })
    await expect(f.admit()).resolves.toMatchObject({ origin: 'workspace_default' })
    await query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.member])
    await expect(f.admit()).rejects.toMatchObject({ code: 'not_found', status: 404 })
  })

  it('assigns exactly the Simple default, preserves private roots and refuses conflicting explicit intent', async () => {
    const f = await fixture()
    expect(await f.admit()).toEqual({ policyRevision: await f.revision(), origin: 'workspace_default', departmentId: f.department.id,
      envelope: { visibility: 'workspace', sensitivity: 'internal', compartments: [f.department.compartment], projectIds: [] } })
    expect(await f.admit({ visibility: 'private' })).toMatchObject({ origin: 'private', departmentId: null, envelope: { visibility: 'private', compartments: [] } })
    await expect(f.admit({ destination: { kind: 'general' } })).rejects.toMatchObject({ code: 'access_mode_destination_conflict', status: 409 })
    await expect(f.admit({ destination: { kind: 'department', departmentId: f.other.id } }, f.owner)).rejects.toMatchObject({ code: 'access_mode_destination_conflict' })
  })

  it('requires explicit Departments selection without unioning all memberships', async () => {
    const f = await fixture('departments')
    await query('INSERT INTO workspace_group_members(group_id,user_id) VALUES($1,$2)', [f.other.id, f.member])
    await expect(f.admit()).rejects.toMatchObject({ code: 'context_selection_required', status: 409 })
    expect(await f.admit({ destination: { kind: 'department', departmentId: f.department.id } })).toMatchObject({ origin: 'explicit', departmentId: f.department.id, envelope: { compartments: [f.department.compartment] } })
    expect(await f.admit({ destination: { kind: 'general' } })).toMatchObject({ envelope: { compartments: [] } })
  })

  it('rejects stale revisions and rechecks current setup and clearance', async () => {
    const f = await fixture(), stale = await f.input()
    await query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.member])
    await expect(admitWorkspaceResource(db, f.workspaceId, f.member, stale)).rejects.toMatchObject({ code: 'access_policy_conflict', status: 409 })
    await expect(f.admit()).rejects.toMatchObject({ code: 'context_not_available', status: 404 })
    await expect(f.admit({ sensitivity: 'public' })).resolves.toMatchObject({ envelope: { sensitivity: 'public' } })
    await query("UPDATE workspace_access_policies SET setup_state='legacy' WHERE workspace_id=$1", [f.workspaceId])
    await expect(f.admit({ sensitivity: 'public' })).rejects.toMatchObject({ code: 'access_mode_setup_required', status: 409 })
  })

  it('rejects foreign, archived and non-Team groups even for an owner', async () => {
    const f = await fixture('departments'), foreign = await fixture()
    await query("UPDATE workspace_groups SET status='archived' WHERE id=$1", [f.other.id])
    const sharing = randomUUID()
    await query("INSERT INTO workspace_groups(id,workspace_id,name,created_by) VALUES($1,$2,'Sharing',$3)", [sharing, f.workspaceId, f.owner])
    for (const id of [foreign.department.id, f.other.id, sharing, randomUUID()]) {
      await expect(f.admit({ destination: { kind: 'department', departmentId: id } }, f.owner)).rejects.toMatchObject({ code: 'context_not_available', status: 404 })
    }
  })

  it('retains inherited privacy, compartment, Project and sensitivity floors', async () => {
    const f = await fixture('departments')
    const inherited = { visibility: 'private' as const, sensitivity: 'confidential' as const, compartments: [f.department.compartment], projectIds: [f.projectId] }
    const patch: Partial<AdmissionInput> = { sensitivity: 'public', destination: { kind: 'general' }, inherited }
    await expect(f.admit(patch)).rejects.toMatchObject({ code: 'context_not_available' })
    await query("UPDATE workspace_members SET clearance='confidential' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.member])
    expect((await f.admit(patch)).envelope).toEqual(inherited)
    await query('DELETE FROM workspace_project_members WHERE project_id=$1 AND user_id=$2', [f.projectId, f.member])
    await expect(f.admit(patch)).rejects.toMatchObject({ code: 'context_not_available' })
    expect((await f.admit(patch, f.owner)).envelope).toEqual(inherited)
  })

  it('checks selected Projects for membership, workspace and active status', async () => {
    const f = await fixture('departments'), foreign = await fixture(), unassigned = await f.project()
    const select = (projectId: string) => ({ destination: { kind: 'general' as const, projectId } })
    expect((await f.admit(select(f.projectId))).envelope.projectIds).toEqual([f.projectId])
    await expect(f.admit(select(unassigned))).rejects.toMatchObject({ code: 'context_not_available' })
    await expect(f.admit(select(foreign.projectId), f.owner)).rejects.toMatchObject({ code: 'context_not_available' })
    await query("UPDATE workspace_projects SET status='archived' WHERE id=$1", [f.projectId])
    await expect(f.admit(select(f.projectId), f.owner)).rejects.toMatchObject({ code: 'context_not_available' })
  })

  it('intersects ambient ceilings: null is universe, undefined fails closed, and owners remain bounded', async () => {
    const f = await fixture()
    const patch: Partial<AdmissionInput> = { destination: { kind: 'department', departmentId: f.department.id, projectId: f.projectId } }
    const access = { workspaceId: f.workspaceId, userId: f.owner, clearance: 'confidential', compartments: null, mutationCompartments: null, projectIds: null }
    await expect(runWithAgentAccess(access, () => f.admit(patch, f.owner))).resolves.toMatchObject({ envelope: { projectIds: [f.projectId] } })
    for (const ceiling of [
      { ...access, clearance: 'public' },
      { ...access, compartments: undefined, mutationCompartments: undefined },
      { ...access, mutationCompartments: [] },
      { ...access, projectIds: undefined },
      { ...access, projectIds: [] },
    ]) await expect(runWithAgentAccess(ceiling, () => f.admit(patch, f.owner))).rejects.toMatchObject({ code: 'context_not_available', status: 404 })
    await expect(runWithAgentAccess({ ...access, userId: f.member }, () => f.admit({}, f.owner))).rejects.toMatchObject({ code: 'not_found' })
    await expect(runWithAgentAccess({ ...access, workspaceId: randomUUID() }, () => f.admit({}, f.owner))).rejects.toMatchObject({ code: 'not_found' })
    // Universe does not widen the live member's database clearance.
    await expect(runWithAgentAccess({ ...access, userId: f.member }, () => f.admit({ sensitivity: 'confidential' }))).rejects.toMatchObject({ code: 'context_not_available' })
  })

  it('does not turn a current read-only grant into creation authority', async () => {
    const f = await fixture('departments'), requestId = randomUUID()
    await query(`INSERT INTO workspace_access_requests(id,workspace_id,requester_user_id,beneficiary_kind,beneficiary_id,target_team_id,reason,starts_at,expires_at,payload_hash,policy_revision,status,decided_by,decided_at)
      VALUES($1,$2,$3,'member',$3,$4,'Admission read grant',now(),now()+interval '1 day',repeat('a',64),1,'approved',$5,now())`, [requestId, f.workspaceId, f.member, f.other.id, f.owner])
    await query(`INSERT INTO workspace_access_grants(workspace_id,request_id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,approved_by)
      SELECT workspace_id,id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,decided_by FROM workspace_access_requests WHERE id=$1`, [requestId])
    const reach = (await query('SELECT effective_member_read_compartments($1,$2) AS read,effective_member_team_compartments($1,$2) AS mutation', [f.member, f.workspaceId])).rows[0]
    expect(reach.read).toContain(f.other.compartment)
    expect(reach.mutation).not.toContain(f.other.compartment)
    await expect(f.admit({ destination: { kind: 'department', departmentId: f.other.id } })).rejects.toMatchObject({ code: 'context_not_available' })
  })

  it('keeps admission and a test-only writer in the caller transaction on rollback', async () => {
    const f = await fixture(), id = randomUUID(), before = await f.revision()
    // This deliberately does not exercise or certify any production resource writer.
    await query('SAVEPOINT admission_and_writer')
    await query("UPDATE workspace_access_policies SET access_mode='departments' WHERE workspace_id=$1", [f.workspaceId])
    const admission = await f.admit({ destination: { kind: 'general' } })
    expect(admission.policyRevision).not.toBe(before)
    await query('INSERT INTO admission_test_writes VALUES($1,$2)', [id, admission.envelope])
    await expect(query('INSERT INTO admission_test_writes VALUES($1,$2)', [id, admission.envelope])).rejects.toMatchObject({ code: '23505' })
    await query('ROLLBACK TO SAVEPOINT admission_and_writer')
    expect((await query('SELECT * FROM admission_test_writes WHERE id=$1', [id])).rows).toEqual([])
    expect(await f.revision()).toBe(before)
    expect(await f.admit()).toMatchObject({ origin: 'workspace_default' })
  })
})
