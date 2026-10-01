import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { getPool } from '../../db/client.js'
import { workspaceAccessRoutes } from '../../routes/workspace-access.js'
// Only unrelated route dependencies are mocked; mode projection uses real SQL.
vi.mock('../../workspace-access/access-inspection.js', () => ({ explainWorkspaceAccess: vi.fn(), getWorkspaceAccessEvents: vi.fn(), getWorkspaceDepartmentRegistry: vi.fn() }))
vi.mock('../../workspace-access/organization-command-review.js', () => ({ prepareOrganizationCommand: vi.fn(), applyOrganizationCommand: vi.fn() }))
vi.mock('../../workspace-access/command-review.js', () => ({ prepareDepartmentCommand: vi.fn(), applyDepartmentCommand: vi.fn() }))
vi.mock('../../workspace-access/service.js', () => ({ getWorkspaceAccess: vi.fn(), getWorkspaceAccessHistory: vi.fn() }))
vi.mock('../../workspace-access/scope-review.js', () => ({ executeWorkspaceScopeReview: vi.fn(), getWorkspaceScopeInventory: vi.fn() }))
vi.mock('../../db/org-chart-store.js', () => ({ getOrganizationChart: vi.fn(), OrganizationError: class extends Error {} }))
vi.mock('../migration-service.js', () => ({ createMigrationPlan: vi.fn(), getMigrationPlan: vi.fn(), listMigrationPlans: vi.fn(), prepareMigrationItem: vi.fn(), applyMigrationItem: vi.fn(), setMigrationPlanState: vi.fn() }))
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
async function fixture() {
  const w = randomUUID(), owner = randomUUID(), member = randomUUID(), outsider = randomUUID(), group = randomUUID()
  for (const id of [owner, member, outsider]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Mode projection fixture',$2)", [w, owner])
  for (const [id, role] of [[owner, 'owner'], [member, 'member']]) await pool.query('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3)', [w, id, role])
  await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key,directory_visibility) VALUES($1,$2,'Hidden default',$3,'team',$1::uuid::text,$4,'members')", [group, w, owner, `team:${group}`])
  await pool.query("UPDATE workspace_access_policies SET access_mode='simple',setup_state='ready',default_department_id=$2 WHERE workspace_id=$1", [w, group])
  const server = express()
  server.use((req, _res, next) => { req.userId = String(req.headers['x-test-user']); next() })
  server.use('/api', workspaceAccessRoutes())
  const get = (user: string) => request(server).get(`/api/workspaces/${w}/access/mode`).set('x-test-user', user)
  return { w, owner, member, outsider, group, get }
}
describe('mode GET real PostgreSQL projection', () => {
  afterAll(async () => { await pool.end() })
  it('denies outsiders and does not leak hidden default department metadata to nonmembers', async () => {
    const f = await fixture()
    const denied = await f.get(f.outsider)
    expect(denied.status).toBe(404); expect(denied.body).toEqual({ error: 'not_found' })
    const member = await f.get(f.member)
    expect(member.status).toBe(200); expect(member.headers['cache-control']).toBe('no-store')
    expect(member.body).toMatchObject({ workspaceId: f.w, mode: 'simple', setupState: 'ready', canAdminister: false, defaultDepartmentId: null, defaultDepartmentName: null })
    expect(JSON.stringify(member.body)).not.toContain(f.group)
    expect(JSON.stringify(member.body)).not.toContain('Hidden default')
    expect(member.body.validForMs).toBeGreaterThan(0); expect(member.body.validForMs).toBeLessThanOrEqual(30_000)
    const admin = await f.get(f.owner)
    expect(admin.body).toMatchObject({ canAdminister: true, defaultDepartmentId: f.group, defaultDepartmentName: 'Hidden default' })
    await pool.query('INSERT INTO workspace_group_members(group_id,user_id) VALUES($1,$2)', [f.group, f.member])
    expect((await f.get(f.member)).body).toMatchObject({ defaultDepartmentId: f.group, defaultDepartmentName: 'Hidden default' })
    await pool.query('DELETE FROM workspace_group_members WHERE group_id=$1 AND user_id=$2', [f.group, f.member])
    await pool.query("UPDATE workspace_groups SET directory_visibility='workspace' WHERE id=$1", [f.group])
    expect((await f.get(f.member)).body.defaultDepartmentId).toBe(f.group)
  })
  it('projects missing policy metadata as legacy Departments without creating policy or authorizing outsiders', async () => {
    const f = await fixture()
    // Emulate a pre-metadata upgrade snapshot. Production correctly forbids
    // deleting policy rows; bypass triggers only in this disposable PG fixture.
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL session_replication_role = replica')
      await client.query('DELETE FROM workspace_access_policies WHERE workspace_id=$1', [f.w])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    for (const user of [f.owner, f.member]) {
      const res = await f.get(user)
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ mode: 'departments', setupState: 'legacy', policyRevision: '1', canAdminister: user === f.owner, defaultDepartmentId: null, defaultDepartmentName: null })
    }
    expect((await f.get(f.outsider)).status).toBe(404)
    expect((await pool.query('SELECT 1 FROM workspace_access_policies WHERE workspace_id=$1', [f.w])).rows).toHaveLength(0)
  })
})
