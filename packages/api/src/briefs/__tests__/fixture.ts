/**
 * Shared seeding for the Brief DB suites. Fictional identities only; every
 * call creates an isolated workspace so suites can run in one disposable
 * database. Only used by suites running through scripts/crm/local-fixture.mjs.
 */
import { randomUUID } from 'node:crypto'
import { getPool } from '../../db/client.js'
import { createProjectSharedStore } from '../../db/project-shared-store.js'

const q = (sql: string, values: unknown[] = []) => getPool().query(sql, values)

export type BriefFixture = Awaited<ReturnType<typeof briefFixture>>

export async function briefFixture() {
  const workspaceId = randomUUID()
  const people = {
    owner: randomUUID(),      // workspace owner, not on the Project roster
    lead: randomUUID(),       // Project owner
    member: randomUUID(),     // Project participant
    outsider: randomUUID(),   // workspace member outside the Project
    financeLead: randomUUID(),// Finance Department owner, also a Project participant
  }
  for (const id of Object.values(people)) await q(`INSERT INTO users(id,auth_provider_id,name) VALUES($1,$2,'Fictional person')`, [id, id])
  await q(`INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional Brief Co',$2)`, [workspaceId, people.owner])
  const roles: Record<keyof typeof people, string> = { owner: 'owner', lead: 'admin', member: 'member', outsider: 'member', financeLead: 'member' }
  for (const [name, id] of Object.entries(people) as [keyof typeof people, string][]) {
    await q('INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,$4)', [workspaceId, id, roles[name], 'internal'])
  }
  const assistants = { brian: randomUUID(), ops: randomUUID() }
  await q(`INSERT INTO assistants(id,workspace_id,name,kind,clearance) VALUES($1,$2,'Brian','primary','confidential')`, [assistants.brian, workspaceId])
  await q(`INSERT INTO assistants(id,workspace_id,name,kind,clearance) VALUES($1,$2,'Ops','standard','internal')`, [assistants.ops, workspaceId])

  // Finance Department with its linked teamspace, owner and members.
  const finance = randomUUID()
  await q(`INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1,$2,'Finance',$3,'team',$4,$5)`,
    [finance, workspaceId, people.financeLead, finance, `team:${finance}`])
  await q(`INSERT INTO workspace_compartments(workspace_id,key,label,created_by,managed_by,managed_ref_id) VALUES($1,$2,'Finance',$3,'team',$4)`,
    [workspaceId, `team:${finance}`, people.financeLead, finance])
  const financeSpace = randomUUID()
  await q(`INSERT INTO teamspaces(id,workspace_id,name,sensitivity,created_by,workspace_group_id) VALUES($1,$2,'Finance','internal',$3,$4)`,
    [financeSpace, workspaceId, people.financeLead, finance])
  await q('INSERT INTO department_owners(workspace_id,department_id,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [workspaceId, finance, people.financeLead])
  const edge = async (kind: 'user' | 'assistant', principal: string, clearance = 'internal') => {
    const column = kind === 'user' ? 'user_id' : 'assistant_id'
    await q(`INSERT INTO department_edges(workspace_id,department_id,principal_kind,${column},clearance,origin) VALUES($1,$2,$3,$4,$5,'store')
      ON CONFLICT DO NOTHING`, [workspaceId, finance, kind, principal, clearance])
  }
  await edge('user', people.financeLead)
  await edge('assistant', assistants.brian)

  await q('UPDATE workspaces SET department_read_v2=true, project_shared_spaces=true WHERE id=$1', [workspaceId])
  const projects = createProjectSharedStore()
  const projectId = await projects.create(people.lead, workspaceId, {
    name: 'Atlas pilot', userIds: [people.member, people.financeLead], assistantIds: [assistants.brian],
  })
  return { workspaceId, people, assistants, finance, financeSpace, projectId, edge, q }
}

export const actorOf = (f: BriefFixture, userId: string, assistantId: string | null = null) =>
  ({ userId, workspaceId: f.workspaceId, assistantId })
