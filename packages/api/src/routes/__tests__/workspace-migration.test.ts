import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { workspaceAccessRoutes } from '../workspace-access.js'
import { WorkspaceAccessError } from '../../workspace-access/policy.js'
import { migrationPlanCreateSchema } from '../../workspace-access/migration-service.js'
const mocks = vi.hoisted(() => ({ createMigrationPlan: vi.fn(), getMigrationPlan: vi.fn(), listMigrationPlans: vi.fn(), prepareMigrationItem: vi.fn(), applyMigrationItem: vi.fn(), setMigrationPlanState: vi.fn(), getWorkspaceAccessMode: vi.fn() }))
vi.mock('../../workspace-access/migration-service.js', async original => ({ ...await original<typeof import('../../workspace-access/migration-service.js')>(), ...mocks }))
vi.mock('../../workspace-access/mode-policy.js', () => ({ getWorkspaceAccessMode: mocks.getWorkspaceAccessMode }))
vi.mock('../../workspace-access/access-inspection.js', () => ({ explainWorkspaceAccess: vi.fn(), getWorkspaceAccessEvents: vi.fn(), getWorkspaceDepartmentRegistry: vi.fn() }))
vi.mock('../../workspace-access/organization-command-review.js', () => ({ prepareOrganizationCommand: vi.fn(), applyOrganizationCommand: vi.fn() }))
vi.mock('../../workspace-access/command-review.js', () => ({ prepareDepartmentCommand: vi.fn(), applyDepartmentCommand: vi.fn() }))
vi.mock('../../workspace-access/service.js', () => ({ getWorkspaceAccess: vi.fn(), getWorkspaceAccessHistory: vi.fn() }))
vi.mock('../../workspace-access/scope-review.js', () => ({ executeWorkspaceScopeReview: vi.fn(), getWorkspaceScopeInventory: vi.fn() }))
vi.mock('../../db/org-chart-store.js', () => ({ getOrganizationChart: vi.fn(), OrganizationError: class extends Error {} }))
const w = '10000000-0000-4000-8000-000000000001', p = '20000000-0000-4000-8000-000000000002', i = '30000000-0000-4000-8000-000000000003'
const base = `/api/workspaces/${w}/access`, plan = `${base}/migrations/${p}`, item = `${plan}/items/${i}`
const proof = { type: 'access.command.apply', reviewId: i, payloadHash: 'b'.repeat(64) }
const proposal = { targetMode: 'simple', idempotencyKey: p, items: [{ command: { type: 'department.member.set', teamId: i, userId: i, enabled: true }, reason: 'Pilot' }] }
function app(userId: string | undefined = 'verified') { const server = express(); server.use(express.json()); server.use((req, _res, next) => { req.userId = userId; next() }); server.use('/api', workspaceAccessRoutes()); return server }
beforeEach(() => { vi.resetAllMocks(); for (const mock of Object.values(mocks)) mock.mockResolvedValue({}); mocks.createMigrationPlan.mockImplementation(async (_w, _u, input) => { if (!migrationPlanCreateSchema.safeParse(input).success) throw new WorkspaceAccessError('invalid_command', 400); return { id: p } }) })
describe('migration HTTP adapters', () => {
  it('passes only authenticated identity and route workspace to each service, with no-store reads', async () => {
    for (const path of [`${base}/mode?userId=attacker&workspaceId=other`, `${base}/migrations`, plan]) { const res = await request(app()).get(path); expect(res.status).toBe(200); expect(res.headers['cache-control']).toBe('no-store') }
    expect(mocks.getWorkspaceAccessMode).toHaveBeenCalledWith(w, 'verified')
    expect(mocks.listMigrationPlans).toHaveBeenCalledWith(w, 'verified', undefined)
    expect(mocks.getMigrationPlan).toHaveBeenCalledWith(w, 'verified', p)
    expect((await request(app()).post(`${base}/migrations`).send(proposal)).status).toBe(200)
    expect(mocks.createMigrationPlan).toHaveBeenCalledWith(w, 'verified', proposal)
    expect((await request(app()).post(`${item}/review`).send({})).status).toBe(200)
    expect(mocks.prepareMigrationItem).toHaveBeenCalledWith(w, 'verified', p, i)
    expect(mocks.applyMigrationItem).not.toHaveBeenCalled()
    expect((await request(app()).post(`${item}/apply`).send(proof)).status).toBe(200)
    expect(mocks.applyMigrationItem).toHaveBeenCalledWith(w, 'verified', p, i, proof)
    expect((await request(app()).post(`${plan}/state`).send({ state: 'paused' })).status).toBe(200)
    expect(mocks.setMigrationPlanState).toHaveBeenCalledWith(w, 'verified', p, 'paused')
  })
  it('accepts the closed RESOURCE action and exact saved resource confirmation',async()=>{
    const resource={...proposal,items:[{reason:'One selected root',command:{type:'resource.scope',resourceKind:'memory',resourceId:i,action:'hold'}}]}
    expect((await request(app()).post(`${base}/migrations`).send(resource)).status).toBe(200)
    const confirmation={kind:'resource',reviewId:i,expectedVersion:'1',payloadHash:'a'.repeat(64),expiresAt:'2030-01-01T00:00:00.000Z'}
    expect((await request(app()).post(`${item}/apply`).send(confirmation)).status).toBe(200)
    expect(mocks.applyMigrationItem).toHaveBeenCalledWith(w,'verified',p,i,confirmation)
    const {expectedVersion:_,...missing}=confirmation
    expect((await request(app()).post(`${item}/apply`).send(missing)).status).toBe(400)
    expect((await request(app()).post(`${item}/apply`).send({...confirmation,resourceId:i})).status).toBe(400)
  })
  it('rejects actor injection and raw toggles before review/apply/state services', async () => {
    for (const [path, body] of [[`${item}/review`, { actorUserId: i }], [`${item}/apply`, { ...proof, userId: i }], [`${item}/apply`, { ...proof, command: {} }], [`${item}/apply`, {}], [`${plan}/state`, { state: 'paused', workspaceId: i }], [`${plan}/state`, { mode: 'simple' }]] as const) expect((await request(app()).post(path).send(body)).status).toBe(400)
    expect((await request(app()).get(`${base}/migrations?actorUserId=${i}`)).status).toBe(400)
    for (const name of ['prepareMigrationItem', 'applyMigrationItem', 'setMigrationPlanState', 'listMigrationPlans'] as const) expect(mocks[name]).not.toHaveBeenCalled()
    // Creation intentionally delegates strict validation to the canonical service schema.
    for (const body of [{ ...proposal, actorUserId: i }, { mode: 'simple' }, { ...proposal, items: [{ command: { type: 'workspace.access_mode.set', mode: 'simple' }, reason: 'Toggle' }] }]) expect((await request(app()).post(`${base}/migrations`).send(body)).status).toBe(400)
    expect((await request(app()).post(`${base}/mode`).send({ mode: 'simple' })).status).toBe(404)
  })
  it('keeps unauthenticated, malformed identifiers and canonical refusal fail-closed', async () => {
    expect((await request(app('')).get(`${base}/mode`)).status).toBe(401)
    expect((await request(app()).get('/api/workspaces/bad/access/mode')).status).toBe(404)
    expect((await request(app()).get(`${base}/migrations/bad`)).status).toBe(404)
    expect((await request(app()).post(`${plan}/items/bad/review`).send({})).status).toBe(404)
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled()
    mocks.applyMigrationItem.mockRejectedValueOnce(new WorkspaceAccessError('access_review_changed', 409))
    const res = await request(app()).post(`${item}/apply`).send(proof)
    expect(res.status).toBe(409); expect(res.body).toEqual({ error: 'access_review_changed' })
  })
})
