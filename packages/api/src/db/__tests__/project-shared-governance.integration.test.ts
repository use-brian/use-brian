/**
 * Shared Project governance (platform docs/plans/project-shared-spaces-implementation.md
 * §15.5): atomic provisioning, the one people/assistant roster, REST and
 * Brian parity over the same actor-bound commands, concurrent revision
 * refusal, transfer/recovery/last-owner, idempotent reviewed conversion and
 * preserved legacy history. Real SQL on a migration-replayed database; runs
 * only through scripts/crm/local-fixture.mjs.
 * Spec: docs/architecture/features/project-shared-spaces.md.
 */
import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it } from 'vitest'
import type { ToolContext } from '@use-brian/core'
import { getAppPool, getPool } from '../client.js'
import { contextScopeRoutes } from '../../routes/context-scopes.js'
import { createWorkspaceStore } from '../workspace-store.js'
import { createProjectSharedStore } from '../project-shared-store.js'
import { createProjectAccessTools } from '../../workspace-access/project-access-tools.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

const pool = getPool()
const q = (sql: string, values: unknown[] = []) => pool.query(sql, values)
const store = createProjectSharedStore()
const [inspectTool, manageTool] = createProjectAccessTools(store)

async function fixture(opts: { enabled?: boolean } = {}) {
  const workspaceId = randomUUID()
  const [owner, admin, lead, member, outsider] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()]
  for (const id of [owner, admin, lead, member, outsider]) await q(`INSERT INTO users(id,auth_provider_id,name) VALUES($1,$2,'Fictional person')`, [id, id])
  await q(`INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional governance fixture',$2)`, [workspaceId, owner])
  const roles: [string, string][] = [[owner, 'owner'], [admin, 'admin'], [lead, 'admin'], [member, 'member'], [outsider, 'member']]
  for (const [id, role] of roles) await q('INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,$4)', [workspaceId, id, role, 'internal'])
  const brian = randomUUID(), ops = randomUUID()
  await q(`INSERT INTO assistants(id,workspace_id,name,kind,clearance) VALUES($1,$2,'Brian','primary','confidential')`, [brian, workspaceId])
  await q(`INSERT INTO assistants(id,workspace_id,name,kind,clearance) VALUES($1,$2,'Ops','standard','internal')`, [ops, workspaceId])
  await q('UPDATE workspaces SET department_read_v2=true, project_shared_spaces=$2 WHERE id=$1', [workspaceId, opts.enabled ?? true])
  return { workspaceId, owner, admin, lead, member, outsider, brian, ops }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

function appFor(userId: string) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as { userId?: string }).userId = userId; next() })
  app.use('/api', contextScopeRoutes({ workspaceStore: createWorkspaceStore() }))
  return app
}
const ctx = (f: Fixture, userId: string) => ({ workspaceId: f.workspaceId, workspaceActorUserId: userId } as unknown as ToolContext)
const roster = async (projectId: string) => (await q(
  `SELECT principal_kind AS kind, coalesce(user_id,assistant_id)::text AS id FROM project_shared_members WHERE project_id=$1 ORDER BY 1,2`, [projectId])).rows
const owners = async (projectId: string) => (await q('SELECT user_id::text AS id FROM project_shared_owners WHERE project_id=$1 ORDER BY 1', [projectId])).rows.map(r => r.id)
/** A read as the member on the app role (RLS), no assistant acting. */
const queryAsMember = async (userId: string, sql: string, values: unknown[]) => {
  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('app.current_user_id',$1,true)`, [userId])
    return (await client.query(sql, values)).rows
  } finally { await client.query('ROLLBACK'); client.release() }
}
const revision = async (projectId: string) => Number((await q('SELECT revision FROM project_shared_scopes WHERE project_id=$1', [projectId])).rows[0].revision)

describe('[COMP:api/project-shared-governance] Shared Project roster, ownership and conversion', () => {
  afterAll(async () => { await getAppPool().end(); await pool.end() })

  it('provisions a Project, its restricted scope, creator ownership and the visible selection atomically (D17, D20, D21, D23)', async () => {
    const f = await fixture()
    const res = await request(appFor(f.lead)).post(`/api/workspaces/${f.workspaceId}/projects`)
      .send({ name: 'Atlas launch', participants: { userIds: [f.member], assistantIds: [f.brian] } })
    expect(res.status).toBe(201)
    const id = res.body.project.id
    expect(res.body.shared).toMatchObject({ revision: 1, status: 'active', myRole: 'owner' })
    expect(await owners(id)).toEqual([f.lead])
    expect(await roster(id)).toEqual([
      { kind: 'assistant', id: f.brian },
      ...[f.lead, f.member].sort().map(id => ({ kind: 'user', id })),
    ].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)))
    // One roster: legacy participation metadata is not written for a shared Project.
    expect((await q('SELECT count(*)::int n FROM workspace_project_members WHERE project_id=$1', [id])).rows[0].n).toBe(0)
    expect((await q('SELECT count(*)::int n FROM assistant_project_grants WHERE project_id=$1', [id])).rows[0].n).toBe(0)
    // No objective is generated from the name.
    expect((await q('SELECT description FROM workspace_projects WHERE id=$1', [id])).rows[0].description).toBeNull()
    expect((await q(`SELECT action FROM project_shared_audit_events WHERE project_id=$1`, [id])).rows.map(r => r.action)).toEqual(['provisioned'])
  })

  it('refuses an unavailable assistant before committing anything, and stays legacy while the capability is off', async () => {
    const f = await fixture()
    const foreignAssistant = randomUUID()
    const res = await request(appFor(f.lead)).post(`/api/workspaces/${f.workspaceId}/projects`)
      .send({ name: 'Beacon', participants: { userIds: [], assistantIds: [foreignAssistant] } })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('project_assistant_unavailable')
    expect((await q('SELECT count(*)::int n FROM workspace_projects WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
    const off = await fixture({ enabled: false })
    const legacy = await request(appFor(off.lead)).post(`/api/workspaces/${off.workspaceId}/projects`).send({ name: 'Legacy' })
    expect(legacy.status).toBe(201)
    expect((await q('SELECT count(*)::int n FROM project_shared_scopes WHERE workspace_id=$1', [off.workspaceId])).rows[0].n).toBe(0)
    const withParticipants = await request(appFor(off.lead)).post(`/api/workspaces/${off.workspaceId}/projects`)
      .send({ name: 'Other', participants: { userIds: [off.member], assistantIds: [] } })
    expect(withParticipants.body.error).toBe('project_shared_disabled')
  })

  it('Brian preselects the primary assistant unless deselected and discloses the exact roster before it runs', async () => {
    const f = await fixture()
    const lines = (await manageTool.describeConfirmation!({ action: 'create', name: 'Comet', userIds: [f.member] } as never, ctx(f, f.lead))) ?? []
    expect(lines.join(' ')).toContain(`assistant ${f.brian}`)
    const created = await manageTool.execute({ action: 'create', name: 'Comet', userIds: [f.member] } as never, ctx(f, f.lead))
    const id = (created as { data: { projectId: string } }).data.projectId
    expect((await roster(id)).filter(r => r.kind === 'assistant').map(r => r.id)).toEqual([f.brian])
    const without = await manageTool.execute({ action: 'create', name: 'Dune', excludePrimaryAssistant: true } as never, ctx(f, f.lead))
    const other = (without as { data: { projectId: string } }).data.projectId
    expect((await roster(other)).filter(r => r.kind === 'assistant')).toEqual([])
    // Removing Brian sticks: nothing re-enrolls it.
    await store.removeMember(f.lead, id, { kind: 'assistant', id: f.brian })
    await store.setMember(f.lead, id, { kind: 'user', id: f.outsider }, null)
    expect((await roster(id)).some(r => r.id === f.brian)).toBe(false)
  })

  it('REST and Brian share authority and errors: participants and outsiders cannot govern, a hidden Project is not_found', async () => {
    const f = await fixture()
    const id = await store.create(f.lead, f.workspaceId, { name: 'Echo', userIds: [f.member], assistantIds: [] })
    const add = { principal: { kind: 'user', id: f.outsider } }
    const viaRest = await request(appFor(f.member)).put(`/api/workspaces/${f.workspaceId}/projects/${id}/shared/members`).send(add)
    const viaBrian = await manageTool.execute({ action: 'add_participant', projectId: id, ...add } as never, ctx(f, f.member))
    expect(viaRest.status).toBe(403)
    expect({ rest: viaRest.body.error, brian: (viaBrian as { data: { error: string } }).data.error }).toEqual({ rest: 'project_owner_required', brian: 'project_owner_required' })
    // An admin outside the roster: the Project does not exist for them.
    const hidden = await request(appFor(f.admin)).get(`/api/workspaces/${f.workspaceId}/projects/${id}`)
    expect(hidden.status).toBe(404)
    const listed = await request(appFor(f.admin)).get(`/api/workspaces/${f.workspaceId}/projects`)
    expect(listed.body.projects.map((p: { id: string }) => p.id)).not.toContain(id)
    const adminBrian = await inspectTool.execute({ projectId: id } as never, ctx(f, f.admin))
    expect((adminBrian as { data: { error: string } }).data.error).toBe('project_not_found')
    // The legacy participation routes refuse a shared Project.
    const legacy = await request(appFor(f.lead)).put(`/api/workspaces/${f.workspaceId}/projects/${id}/members/${f.outsider}`).send({ role: 'member' })
    expect(legacy.body.error).toBe('project_shared_use_roster')
    // The owner adds through REST; Brian sees the same revision and roster.
    const ok = await request(appFor(f.lead)).put(`/api/workspaces/${f.workspaceId}/projects/${id}/shared/members`).send({ ...add, expectedRevision: 1 })
    expect(ok.body).toEqual({ revision: 2 })
    const seen = (await inspectTool.execute({ projectId: id } as never, ctx(f, f.lead))) as { data: { roster: { revision: number; members: { principal: { id: string } }[] } } }
    expect(seen.data.roster.revision).toBe(2)
    expect(seen.data.roster.members.map(m => m.principal.id)).toContain(f.outsider)
  })

  it('the workspace owner sees governance metadata and reads the roster through oversight without joining (D26/D27)', async () => {
    const f = await fixture()
    const id = await store.create(f.lead, f.workspaceId, { name: 'Fjord', userIds: [], assistantIds: [] })
    const detail = await request(appFor(f.owner)).get(`/api/workspaces/${f.workspaceId}/projects/${id}`)
    expect(detail.status).toBe(200)
    expect(detail.body.project.shared.myRole).toBe('oversight')
    expect(detail.body.project.shared.oversight).toEqual([{ userId: f.owner, name: 'Fictional person', isMember: false }])
    expect(detail.body.project.shared.members.map((m: { principal: { id: string } }) => m.principal.id)).not.toContain(f.owner)
    // Oversight is not governance: the owner cannot add people without recovering ownership.
    await expect(store.setMember(f.owner, id, { kind: 'user', id: f.member }, null)).rejects.toMatchObject({ code: 'project_not_found' })
  })

  it('refuses a stale or concurrent roster change; no lost update and no duplicate edge', async () => {
    const f = await fixture()
    const id = await store.create(f.lead, f.workspaceId, { name: 'Gale', userIds: [], assistantIds: [] })
    const results = await Promise.allSettled([
      store.setMember(f.lead, id, { kind: 'user', id: f.member }, null, 1),
      store.setMember(f.lead, id, { kind: 'user', id: f.outsider }, null, 1),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'project_revision_stale' } })
    expect(await revision(id)).toBe(2)
    // Repeating the state that already holds is a no-op on any revision.
    const winner = (await roster(id)).find(r => r.id === f.member || r.id === f.outsider)!
    expect(await store.setMember(f.lead, id, { kind: 'user', id: winner.id }, null, 1)).toBe(2)
    expect((await q('SELECT count(*)::int n FROM project_shared_members WHERE project_id=$1 AND user_id=$2', [id, winner.id])).rows[0].n).toBe(1)
  })

  it('keeps one accountable owner: last-owner removal refused, transfer is atomic, an owner edge cannot be removed', async () => {
    const f = await fixture()
    const id = await store.create(f.lead, f.workspaceId, { name: 'Harbor', userIds: [f.member], assistantIds: [] })
    await expect(store.removeOwner(f.lead, id, f.lead)).rejects.toMatchObject({ code: 'project_last_owner' })
    await expect(store.removeMember(f.lead, id, { kind: 'user', id: f.lead })).rejects.toMatchObject({ code: 'project_owner_edge_required' })
    await store.transferOwner(f.lead, id, f.member)
    expect(await owners(id)).toEqual([f.member])
    expect((await roster(id)).map(r => r.id)).toContain(f.lead)
    expect((await q(`SELECT action FROM project_shared_audit_events WHERE project_id=$1 ORDER BY created_at`, [id])).rows.map(r => r.action)).toContain('owner_transferred')
  })

  it('recovers ownership at any time through the workspace owner only, keeping existing owners (D26)', async () => {
    const f = await fixture()
    const id = await store.create(f.lead, f.workspaceId, { name: 'Iris', userIds: [], assistantIds: [f.brian] })
    await expect(store.recover(f.admin, id, null, 'covering a leave')).rejects.toMatchObject({ code: 'project_not_found' })
    await expect(store.recover(f.owner, id, null, '  ')).rejects.toMatchObject({ code: 'project_recovery_reason_required' })
    await store.recover(f.owner, id, f.member, 'Lead on leave; member takes over')
    expect(await owners(id)).toEqual([f.lead, f.member].sort())
    const audit = (await q(`SELECT before_state, after_state, reason, actor_user_id::text AS actor FROM project_shared_audit_events WHERE project_id=$1 AND action='recovered'`, [id])).rows[0]
    expect(audit).toMatchObject({ actor: f.owner, reason: 'Lead on leave; member takes over', before_state: { owners: [f.lead] } })
    // An orphan (the only owner left the workspace) is recoverable without prior membership.
    const orphan = await store.create(f.lead, f.workspaceId, { name: 'Juniper', userIds: [], assistantIds: [] })
    await q('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.lead])
    expect(await owners(orphan)).toEqual([])
    await store.recover(f.owner, orphan, null, 'Owner left the company')
    expect(await owners(orphan)).toEqual([f.owner])
    // Recovery never re-enrolls an assistant.
    expect((await roster(orphan)).filter(r => r.kind === 'assistant')).toEqual([])
  })

  it('converts a legacy Project only through a reviewed, idempotent workspace-owner command that relabels nothing', async () => {
    const f = await fixture()
    await q('UPDATE workspaces SET project_shared_spaces=false WHERE id=$1', [f.workspaceId])
    const made = await request(appFor(f.lead)).post(`/api/workspaces/${f.workspaceId}/projects`).send({ name: 'Kestrel' })
    await q('UPDATE workspaces SET project_shared_spaces=true WHERE id=$1', [f.workspaceId])
    expect(made.status).toBe(201)
    const id = made.body.project.id
    // Old participation metadata exists but is never preselected.
    await q(`INSERT INTO workspace_project_members(project_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING`, [id, f.outsider])
    await q(`INSERT INTO assistant_project_grants(assistant_id,project_id) VALUES($1,$2)`, [f.ops, id])
    const taskId = randomUUID()
    await q(`INSERT INTO tasks(id,workspace_id,title,sensitivity,compartments,project_ids) VALUES($1,$2,'linked work','internal','{}',$3)`, [taskId, f.workspaceId, [id]])
    const base = `/api/workspaces/${f.workspaceId}/projects/${id}/shared/convert`
    const refused = await request(appFor(f.admin)).post(base).send({ mode: 'preview', userIds: [f.member], assistantIds: [] })
    expect(refused.body.error).toBe('project_recovery_owner_only')
    const preview = (await request(appFor(f.owner)).post(base).send({ mode: 'preview', ownerUserId: f.lead, userIds: [f.member], assistantIds: [f.brian] })).body.preview
    expect(preview).toMatchObject({ ownerUserId: f.lead, userIds: [f.lead, f.member].sort(), assistantIds: [f.brian], relabelled: 0,
      legacyParticipation: { userIds: expect.arrayContaining([f.outsider]), assistantIds: [f.ops] } })
    const apply = { mode: 'apply', ownerUserId: f.lead, userIds: [f.member], assistantIds: [f.brian], idempotencyKey: randomUUID(), requestHash: preview.requestHash }
    const tampered = await request(appFor(f.owner)).post(base).send({ ...apply, assistantIds: [f.brian, f.ops] })
    expect(tampered.body.error).toBe('project_conversion_review_changed')
    const first = (await request(appFor(f.owner)).post(base).send(apply)).body.receipt
    expect(first).toMatchObject({ projectId: id, owners: [f.lead], relabelled: 0, replayed: false })
    const again = (await request(appFor(f.owner)).post(base).send(apply)).body.receipt
    expect(again).toMatchObject({ ...first, replayed: true })
    expect(await roster(id)).not.toContainEqual({ kind: 'user', id: f.outsider })
    expect(await roster(id)).not.toContainEqual({ kind: 'assistant', id: f.ops })
    // History preserved: legacy rows untouched, linked material not relabelled.
    expect((await q('SELECT count(*)::int n FROM workspace_project_members WHERE project_id=$1', [id])).rows[0].n).toBeGreaterThan(0)
    expect((await q('SELECT compartments FROM tasks WHERE id=$1', [taskId])).rows[0].compartments).toEqual([])
    const second = await request(appFor(f.owner)).post(base).send({ ...apply, idempotencyKey: randomUUID() })
    expect(second.body.error).toBe('project_already_shared')
  })


  it('upgrade: an existing legacy Project keeps its meaning; linked material is counted, not relabelled, by the preview', async () => {
    const f = await fixture({ enabled: false })
    const made = await request(appFor(f.lead)).post(`/api/workspaces/${f.workspaceId}/projects`).send({ name: 'Meridian' })
    const id = made.body.project.id
    const taskId = randomUUID()
    await q(`INSERT INTO tasks(id,workspace_id,title,sensitivity,compartments,project_ids) VALUES($1,$2,'legacy linked work','internal','{}',$3)`, [taskId, f.workspaceId, [id]])
    await q('UPDATE workspaces SET project_shared_spaces=true WHERE id=$1', [f.workspaceId])
    // Enabling shared spaces changes nothing for an existing Project: every member still sees it and its linked work.
    const listed = await request(appFor(f.outsider)).get(`/api/workspaces/${f.workspaceId}/projects`)
    expect(listed.body.projects.find((p: { id: string }) => p.id === id)).toMatchObject({ shared: null })
    const read = await queryAsMember(f.outsider, 'SELECT id FROM tasks WHERE id=$1', [taskId])
    expect(read).toHaveLength(1)
    const preview = await store.previewConversion(f.owner, f.workspaceId, id, { userIds: [], assistantIds: [] })
    expect(preview.linkedMaterial).toMatchObject({ tasks: 1 })
    await store.applyConversion(f.owner, f.workspaceId, id, { userIds: [], assistantIds: [], idempotencyKey: randomUUID(), requestHash: preview.requestHash })
    // Converted: the scope exists, but the historical row is not relabelled and stays readable as before.
    expect((await q('SELECT compartments FROM tasks WHERE id=$1', [taskId])).rows[0].compartments).toEqual([])
    expect(await queryAsMember(f.outsider, 'SELECT id FROM tasks WHERE id=$1', [taskId])).toHaveLength(1)
  })

  it('quarantine and capability disable make Project material unavailable (never General) and are reversible through product commands', async () => {
    const f = await fixture()
    const id = await store.create(f.lead, f.workspaceId, { name: 'Nimbus', userIds: [f.member], assistantIds: [] })
    const taskId = randomUUID()
    await q(`INSERT INTO tasks(id,workspace_id,title,sensitivity,compartments,project_ids) VALUES($1,$2,'shared note','internal',$3,$4)`,
      [taskId, f.workspaceId, [`project:${id}`], [id]])
    const memberSees = async () => (await queryAsMember(f.member, 'SELECT id FROM tasks WHERE id=$1', [taskId])).length === 1
    expect(await memberSees()).toBe(true)
    await expect(store.setStatus(f.lead, id, 'quarantined', 'review', undefined)).rejects.toMatchObject({ code: 'project_recovery_owner_only' })
    await store.setStatus(f.owner, id, 'quarantined', 'Suspected mislabel')
    expect(await memberSees()).toBe(false)
    expect(await queryAsMember(f.outsider, 'SELECT id FROM tasks WHERE id=$1', [taskId])).toHaveLength(0)
    await store.setStatus(f.owner, id, 'active', 'Reviewed')
    expect(await memberSees()).toBe(true)
    await store.setCapability(f.owner, f.workspaceId, false)
    expect(await memberSees()).toBe(false)
    expect(await queryAsMember(f.owner, 'SELECT id FROM tasks WHERE id=$1', [taskId])).toHaveLength(0)
    await store.setCapability(f.owner, f.workspaceId, true)
    expect(await memberSees()).toBe(true)
  })

  it('archive pauses bound unattended work and restore does not restart it; capability is the workspace owner\'s switch', async () => {
    const f = await fixture()
    const id = await store.create(f.lead, f.workspaceId, { name: 'Lumen', userIds: [], assistantIds: [] })
    await q(`INSERT INTO workflows(id,workspace_id,created_by,name,definition,enabled,context_project_id) VALUES($1,$2,$3,'fictional flow','{}'::jsonb,true,$4)`, [randomUUID(), f.workspaceId, f.lead, id])
    await store.archive(f.lead, id, true)
    expect((await q('SELECT enabled, paused_reason FROM workflows WHERE context_project_id=$1', [id])).rows[0]).toEqual({ enabled: false, paused_reason: 'project_archived' })
    await store.archive(f.lead, id, false)
    expect((await q('SELECT enabled FROM workflows WHERE context_project_id=$1', [id])).rows[0].enabled).toBe(false)
    await expect(store.setCapability(f.admin, f.workspaceId, false)).rejects.toMatchObject({ code: 'project_recovery_owner_only' })
    expect(await store.setCapability(f.owner, f.workspaceId, false)).toBe(false)
    await expect(store.create(f.lead, f.workspaceId, { name: 'Off', userIds: [], assistantIds: [] })).rejects.toMatchObject({ code: 'project_shared_disabled' })
  })
})
