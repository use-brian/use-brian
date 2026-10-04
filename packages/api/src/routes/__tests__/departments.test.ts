import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { departmentRoutes } from '../departments.js'
import { WorkspaceAccessError } from '../../workspace-access/policy.js'
import type { DepartmentStore } from '../../db/department-store.js'

const W = '00000000-0000-4000-8000-000000000100'
const D = '00000000-0000-4000-8000-000000000d01'
const HIDDEN = '00000000-0000-4000-8000-000000000d04'
const U = '00000000-0000-4000-8000-000000000a03'

function mount(overrides: Partial<DepartmentStore> = {}) {
  const store = {
    directory: vi.fn().mockResolvedValue([{ departmentId: D, name: 'Platform', status: 'active', revision: 3, myClearance: 'confidential', isOwner: true, ownerIds: [U] }]),
    homes: vi.fn().mockResolvedValue([]),
    inWorkspace: vi.fn(async (_a: string, _w: string, id: string) => id === D),
    listEdges: vi.fn().mockResolvedValue([]),
    setEdge: vi.fn().mockResolvedValue(4),
    removeEdge: vi.fn().mockResolvedValue(4),
    addOwner: vi.fn().mockResolvedValue(4),
    removeOwner: vi.fn().mockResolvedValue(4),
    breakGlass: vi.fn().mockResolvedValue(4),
    setHome: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as DepartmentStore
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.userId = U; next() })
  app.use('/api', departmentRoutes(store))
  return { app, store }
}

describe('[COMP:api/departments-route] Department management routes', () => {
  it('lists the caller\'s directory and homes', async () => {
    const { app } = mount()
    const res = await request(app).get(`/api/workspaces/${W}/departments`)
    expect(res.status).toBe(200)
    expect(res.body.departments[0]).toMatchObject({ departmentId: D, isOwner: true })
  })

  it('sets an edge through the store as the authenticated caller, passing the expected revision', async () => {
    const { app, store } = mount()
    const res = await request(app).put(`/api/workspaces/${W}/departments/${D}/edges`)
      .send({ principal: { kind: 'user', id: U }, clearance: 'internal', expiresAt: null, expectedRevision: 3 })
    expect(res.body).toEqual({ revision: 4 })
    expect(store.setEdge).toHaveBeenCalledWith(U, D, { kind: 'user', id: U }, 'internal', null, 3)
  })

  it('answers 404 for a department the caller cannot see, revealing nothing (I2)', async () => {
    const { app, store } = mount()
    const res = await request(app).put(`/api/workspaces/${W}/departments/${HIDDEN}/edges`)
      .send({ principal: { kind: 'user', id: U }, clearance: 'internal' })
    expect(res.status).toBe(404)
    expect(store.setEdge).not.toHaveBeenCalled()
  })

  it('maps store refusals to their status and code', async () => {
    const { app } = mount({ setEdge: vi.fn().mockRejectedValue(new WorkspaceAccessError('department_revision_stale', 409)) })
    const res = await request(app).put(`/api/workspaces/${W}/departments/${D}/edges`)
      .send({ principal: { kind: 'user', id: U }, clearance: 'internal', expectedRevision: 1 })
    expect(res).toMatchObject({ status: 409, body: { error: 'department_revision_stale' } })
  })

  it('rejects malformed commands before reaching the store', async () => {
    const { app, store } = mount()
    expect((await request(app).put(`/api/workspaces/${W}/departments/${D}/edges`).send({ principal: { kind: 'user', id: U }, clearance: 'secret' })).status).toBe(400)
    expect((await request(app).post(`/api/workspaces/${W}/departments/${D}/break-glass`).send({ reason: ' ' })).status).toBe(400)
    expect(store.setEdge).not.toHaveBeenCalled()
    expect(store.breakGlass).not.toHaveBeenCalled()
  })

  it('sets and clears a home department', async () => {
    const { app, store } = mount()
    expect((await request(app).put(`/api/workspaces/${W}/departments/home`).send({ principal: { kind: 'user', id: U }, departmentId: D })).status).toBe(200)
    expect((await request(app).put(`/api/workspaces/${W}/departments/home`).send({ principal: { kind: 'user', id: U }, departmentId: null })).status).toBe(200)
    expect(store.setHome).toHaveBeenNthCalledWith(1, U, W, { kind: 'user', id: U }, D)
    expect(store.setHome).toHaveBeenNthCalledWith(2, U, W, { kind: 'user', id: U }, null)
  })
})
