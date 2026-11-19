import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { projectHarnessRoutes } from '../project-harness.js'
import { WorkspaceAccessError } from '../../workspace-access/policy.js'
import type { HarnessRevision, ProjectHarnessStore } from '../../project-harness/contracts.js'

const [actor, workspaceId, projectId, productId, componentId] = [1, 2, 3, 4, 5].map(i => `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
const base = `/api/workspaces/${workspaceId}/projects/${projectId}/harness`
const definition = { schemaVersion: 1 as const, rules: [], codeChecks: [], acceptanceScenarios: [] }
const root: HarnessRevision = { id: actor, workspaceId, projectId, scope: { kind: 'project' }, revision: 1,
  definition, createdBy: actor, createdAt: '2026-11-18T00:00:00Z' }
const store = {
  tree: vi.fn(), createProduct: vi.fn(), updateProduct: vi.fn(), createComponent: vi.fn(), updateComponent: vi.fn(),
  definition: vi.fn(), history: vi.fn(), putDefinition: vi.fn(), lineage: vi.fn(),
} satisfies ProjectHarnessStore
function app(signedIn = true) {
  const server = express()
  server.use(express.json())
  server.use((req, _res, next) => { if (signedIn) req.userId = actor; next() })
  server.use('/api', projectHarnessRoutes({ store }))
  return server
}
beforeEach(() => {
  vi.resetAllMocks()
  store.tree.mockResolvedValue({ products: [], components: [] })
  store.definition.mockResolvedValue(null)
  store.history.mockResolvedValue([root])
  store.putDefinition.mockResolvedValue(root)
  store.lineage.mockResolvedValue([root])
})

describe('[COMP:api/project-harness] authenticated definition routes', () => {
  it('requires authentication before touching storage and disables shared caches', async () => {
    const res = await request(app(false)).get(`${base}/tree`)
    expect(res.status).toBe(401)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(store.tree).not.toHaveBeenCalled()
  })
  it('passes authenticated actor and complete ancestry to the store', async () => {
    const res = await request(app()).get(`${base}/tree`)
    expect(res.status).toBe(200)
    expect(store.tree).toHaveBeenCalledWith(actor, workspaceId, projectId)
    expect(res.body).toEqual({ products: [], components: [] })
  })
  it('creates products/components without accepting caller-assigned identity', async () => {
    store.createProduct.mockResolvedValue({ id: productId })
    expect((await request(app()).post(`${base}/products`).send({ name: ' Frontend ' })).status).toBe(201)
    expect(store.createProduct).toHaveBeenCalledWith(actor, workspaceId, projectId, { name: 'Frontend' })
    store.createComponent.mockResolvedValue({ id: componentId })
    expect((await request(app()).post(`${base}/products/${productId}/components`).send({ name: 'Calendar picker' })).status).toBe(201)
    expect(store.createComponent).toHaveBeenCalledWith(actor, workspaceId, projectId, productId, { name: 'Calendar picker' })
    expect((await request(app()).post(`${base}/products`).send({ name: 'Frontend', projectId: productId })).status).toBe(400)
    expect(store.createProduct).toHaveBeenCalledTimes(1)
  })
  it('requires optimistic revisions on node and definition writes', async () => {
    expect((await request(app()).patch(`${base}/products/${productId}`).send({ name: 'New' })).status).toBe(400)
    expect((await request(app()).put(`${base}/definition`).send({ scope: { kind: 'project' }, definition })).status).toBe(400)
    expect(store.updateProduct).not.toHaveBeenCalled()
    expect(store.putDefinition).not.toHaveBeenCalled()
  })
  it('passes exact ancestry and revisions on updates/restoration', async () => {
    await request(app()).patch(`${base}/products/${productId}`).send({ expectedRevision: 1, status: 'archived' }).expect(200)
    expect(store.updateProduct).toHaveBeenCalledWith(actor, workspaceId, projectId, productId, { expectedRevision: 1, status: 'archived' })
    await request(app()).patch(`${base}/products/${productId}/components/${componentId}`).send({ expectedRevision: 2, status: 'active' }).expect(200)
    expect(store.updateComponent).toHaveBeenCalledWith(actor, workspaceId, projectId, productId, componentId, { expectedRevision: 2, status: 'active' })
  })
  it('accepts a new definition with expected revision zero but no approval/actor fields', async () => {
    const input = { scope: { kind: 'component', productId, componentId }, expectedRevision: 0, definition }
    const res = await request(app()).put(`${base}/definition`).send(input)
    expect(res.status).toBe(200)
    expect(store.putDefinition).toHaveBeenCalledWith(actor, workspaceId, projectId, input)
    expect((await request(app()).put(`${base}/definition`).send({ ...input, approved: true })).status).toBe(400)
    expect((await request(app()).put(`${base}/definition`).send({ ...input, userId: actor })).status).toBe(400)
    expect(store.putDefinition).toHaveBeenCalledTimes(1)
  })
  it.each([
    '?scope=component', `?scope=component&componentId=${componentId}`, `?scope=project&productId=${productId}`,
    '?scope=product&productId=invalid', '?scope=project&actorId=anything', '?scope=project&scope=component',
  ])('rejects malformed or ambiguous scope query %s', async query => {
    expect((await request(app()).get(`${base}/definition${query}`)).status).toBe(400)
    expect(store.definition).not.toHaveBeenCalled()
  })
  it('validates target through the store even when no definition exists', async () => {
    const res = await request(app()).get(`${base}/definition?scope=component&productId=${productId}&componentId=${componentId}`)
    expect(res.body).toEqual({ definition: null })
    expect(store.definition).toHaveBeenCalledWith(actor, workspaceId, projectId, { kind: 'component', productId, componentId })
  })
  it('reports bounded history and resolves an authorized lineage with provenance', async () => {
    const history = await request(app()).get(`${base}/history?scope=project`)
    expect(history.body).toEqual({ revisions: [root], limit: 100 })
    const result = await request(app()).get(`${base}/effective?scope=component&productId=${productId}&componentId=${componentId}`)
    expect(store.lineage).toHaveBeenCalledWith(actor, workspaceId, projectId, { kind: 'component', productId, componentId })
    expect(result.body.effective).toMatchObject({ status: 'resolved', sources: [{ revisionId: root.id, scope: root.scope }], conflicts: [] })
  })
  it.each([
    ['harness_not_found', 404], ['harness_requires_shared_project', 409], ['harness_owner_required', 403],
    ['harness_revision_stale', 409], ['harness_archived', 409], ['harness_unavailable', 503],
  ])('preserves typed error %s without exposing database details', async (code, status) => {
    store.putDefinition.mockRejectedValue(new WorkspaceAccessError(code as string, status as number))
    const res = await request(app()).put(`${base}/definition`).send({ scope: { kind: 'project' }, expectedRevision: 0, definition })
    expect(res.status).toBe(status)
    expect(res.body).toEqual({ error: code })
  })
  it('does not expose draft definitions as executable verification', async () => {
    expect((await request(app()).post(`${base}/verify`).send({ approved: true })).status).toBe(404)
    expect((await request(app()).post(`${base}/execute`).send({ command: 'anything' })).status).toBe(404)
  })
  it('does not query storage for invalid project/workspace IDs', async () => {
    expect((await request(app()).get('/api/workspaces/invalid/projects/invalid/harness/tree')).status).toBe(404)
    expect(store.tree).not.toHaveBeenCalled()
  })
})
