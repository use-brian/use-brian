/**
 * Unit tests for the workspace management routes.
 * Component tag: [COMP:api/workspaces-route].
 *
 * Mocks `query` / `findUserById` and mounts workspaceRoutes() with an
 * injected mock store. Verifies POST / (name + purpose validation, the
 * non-paid additional-workspace cap, create), GET /, GET /:workspaceId
 * (membership gate, detail shape), the requireWorkspaceRole level gate
 * on PATCH (admin) and DELETE (owner), and the add-member lookup.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))
vi.mock('../../db/users.js', () => ({
  findUserById: vi.fn(),
}))
vi.mock('../../db/workspace-flush.js', () => {
  class WorkspaceFlushNotOwnerError extends Error {}
  return {
    flushWorkspaceData: vi.fn(),
    WorkspaceFlushNotOwnerError,
  }
})

import { workspaceRoutes } from '../workspaces.js'
import { query, queryWithRLS } from '../../db/client.js'
import { findUserById } from '../../db/users.js'
import { InvalidRecordingBlueprintError } from '../../db/workspace-store.js'
import { flushWorkspaceData, WorkspaceFlushNotOwnerError } from '../../db/workspace-flush.js'

const mockQuery = vi.mocked(query)
const mockRls = vi.mocked(queryWithRLS)
const mockFindUser = vi.mocked(findUserById)

const workspaceStore = {
  getRole: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  listMembers: vi.fn(),
  update: vi.fn(),
  setDefaultRecordingBlueprint: vi.fn(),
  delete: vi.fn(),
  countFreeOwned: vi.fn(),
}

function app(userId?: string) {
  return createTestApp(
    '/api/workspaces',
    workspaceRoutes({ workspaceStore: workspaceStore as never }),
    userId ? { userId } : undefined,
  )
}

const LONG_PURPOSE = 'Share infrastructure and project decisions for the team.'

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('[COMP:api/workspaces-route] POST /', () => {
  it('rejects an unauthenticated request with 401', async () => {
    expect((await request(app()).post('/api/workspaces').send({})).status).toBe(401)
  })

  it('requires a name and a >=10 char purpose', async () => {
    expect((await request(app('u-1')).post('/api/workspaces').send({ purpose: LONG_PURPOSE })).status).toBe(400)
    expect(
      (await request(app('u-1')).post('/api/workspaces').send({ name: 'WS', purpose: 'short' })).status,
    ).toBe(400)
  })

  it('caps a non-paid user at 2 owned free workspaces (Personal counts)', async () => {
    mockFindUser.mockResolvedValueOnce({ id: 'u-1' } as never)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // owns no paid workspace
    workspaceStore.countFreeOwned.mockResolvedValueOnce(2) // Personal + 1 already
    const res = await request(app('u-1'))
      .post('/api/workspaces')
      .send({ name: 'Third WS', purpose: LONG_PURPOSE })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('plan_required')
  })

  it('lets a non-paid user create a second free workspace (under the cap)', async () => {
    mockFindUser.mockResolvedValueOnce({ id: 'u-1' } as never)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // owns no paid workspace
    workspaceStore.countFreeOwned.mockResolvedValueOnce(1) // only Personal so far
    workspaceStore.create.mockResolvedValueOnce({ id: 'ws-2', name: 'Second WS' })
    const res = await request(app('u-1'))
      .post('/api/workspaces')
      .send({ name: 'Second WS', purpose: LONG_PURPOSE })
    expect(res.status).toBe(201)
    expect(res.body.id).toBe('ws-2')
  })

  it('creates a workspace for a user who owns a paid workspace (cap lifted)', async () => {
    mockFindUser.mockResolvedValueOnce({ id: 'u-1' } as never)
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: 1 }], rowCount: 1 } as never) // owns a paid workspace
    workspaceStore.create.mockResolvedValueOnce({ id: 'ws-new', name: 'New WS' })
    const res = await request(app('u-1'))
      .post('/api/workspaces')
      .send({ name: 'New WS', purpose: LONG_PURPOSE })
    expect(res.status).toBe(201)
    expect(res.body.id).toBe('ws-new')
  })
})

describe('[COMP:api/workspaces-route] GET / and GET /:workspaceId', () => {
  it('lists the user\'s workspaces with the legacy teams alias', async () => {
    workspaceStore.list.mockResolvedValueOnce([{ id: 'ws-1' }])
    const res = await request(app('u-1')).get('/api/workspaces')
    expect(res.status).toBe(200)
    expect(res.body.workspaces).toEqual([{ id: 'ws-1' }])
    expect(res.body.teams).toEqual([{ id: 'ws-1' }])
  })

  it('rejects a non-member from reading workspace detail with 403', async () => {
    workspaceStore.getRole.mockResolvedValueOnce(null)
    expect((await request(app('u-1')).get('/api/workspaces/ws-1')).status).toBe(403)
  })

  it('returns 404 when the workspace does not exist', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('member')
    workspaceStore.get.mockResolvedValueOnce(null)
    expect((await request(app('u-1')).get('/api/workspaces/ws-1')).status).toBe(404)
  })

  it('returns the workspace detail with members and assistants for a member', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('member')
    workspaceStore.get.mockResolvedValueOnce({ id: 'ws-1', name: 'WS' })
    workspaceStore.listMembers.mockResolvedValueOnce([{ userId: 'u-1' }])
    mockRls.mockResolvedValueOnce({
      rows: [{ id: 'a-1', name: 'Bot', kind: 'primary' }],
      rowCount: 1,
    } as never)
    const res = await request(app('u-1')).get('/api/workspaces/ws-1')
    expect(res.status).toBe(200)
    expect(res.body.role).toBe('member')
    expect(res.body.primaryAssistantId).toBe('a-1')
  })
})

describe('[COMP:api/workspaces-route] requireWorkspaceRole gate', () => {
  it('PATCH /:workspaceId requires at least an admin role', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('member')
    const res = await request(app('u-1')).patch('/api/workspaces/ws-1').send({ name: 'Renamed' })
    expect(res.status).toBe(403)
    expect(res.body.error).toContain('admin')
  })

  it('PATCH /:workspaceId updates name for an admin', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('admin')
    workspaceStore.update.mockResolvedValueOnce({ id: 'ws-1', name: 'Renamed' })
    const res = await request(app('u-1')).patch('/api/workspaces/ws-1').send({ name: 'Renamed' })
    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Renamed')
  })

  it('DELETE /:workspaceId requires the owner role', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('admin')
    const res = await request(app('u-1')).delete('/api/workspaces/ws-1')
    expect(res.status).toBe(403)
    expect(res.body.error).toContain('owner')
  })

  it('DELETE /:workspaceId removes the workspace for an owner', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('owner')
    workspaceStore.delete.mockResolvedValueOnce(true)
    expect((await request(app('u-1')).delete('/api/workspaces/ws-1')).status).toBe(204)
  })

  it('DELETE /:workspaceId/data requires the owner role', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('admin')
    const res = await request(app('u-1')).delete('/api/workspaces/ws-1/data')
    expect(res.status).toBe(403)
    expect(vi.mocked(flushWorkspaceData)).not.toHaveBeenCalled()
  })

  it('DELETE /:workspaceId/data flushes for the owner and reports counts', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('owner')
    vi.mocked(flushWorkspaceData).mockResolvedValueOnce({
      deleted: { tasks: 1287, workflows: 225, memories: 0 },
      total: 1512,
    })
    const res = await request(app('u-1')).delete('/api/workspaces/ws-1/data')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.total).toBe(1512)
    expect(res.body.deleted.tasks).toBe(1287)
    expect(vi.mocked(flushWorkspaceData)).toHaveBeenCalledWith('u-1', 'ws-1')
  })

  it('DELETE /:workspaceId/data maps the store owner re-check to 403', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('owner')
    vi.mocked(flushWorkspaceData).mockRejectedValueOnce(new WorkspaceFlushNotOwnerError())
    const res = await request(app('u-1')).delete('/api/workspaces/ws-1/data')
    expect(res.status).toBe(403)
  })

  it('POST /:workspaceId/members 404s an email with no matching user', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('admin')
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    const res = await request(app('u-1'))
      .post('/api/workspaces/ws-1/members')
      .send({ email: 'nobody@example.com' })
    expect(res.status).toBe(404)
  })
})

describe('[COMP:api/workspaces-route] PATCH /:workspaceId default recording blueprint (migration 291)', () => {
  const BP = '11111111-1111-4111-8111-111111111111'

  it('sets a valid blueprint default (200, routed to the store setter)', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('admin')
    workspaceStore.setDefaultRecordingBlueprint.mockResolvedValueOnce({
      id: 'ws-1', name: 'WS', defaultRecordingBlueprintId: BP,
    })
    const res = await request(app('u-1'))
      .patch('/api/workspaces/ws-1')
      .send({ defaultRecordingBlueprintId: BP })
    expect(res.status).toBe(200)
    expect(res.body.defaultRecordingBlueprintId).toBe(BP)
    expect(workspaceStore.setDefaultRecordingBlueprint).toHaveBeenCalledWith('u-1', 'ws-1', BP)
    // The name/purpose update path is not touched when only the blueprint changes.
    expect(workspaceStore.update).not.toHaveBeenCalled()
  })

  it('clears the default with null (200)', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('admin')
    workspaceStore.setDefaultRecordingBlueprint.mockResolvedValueOnce({
      id: 'ws-1', name: 'WS', defaultRecordingBlueprintId: null,
    })
    const res = await request(app('u-1'))
      .patch('/api/workspaces/ws-1')
      .send({ defaultRecordingBlueprintId: null })
    expect(res.status).toBe(200)
    expect(res.body.defaultRecordingBlueprintId).toBeNull()
    expect(workspaceStore.setDefaultRecordingBlueprint).toHaveBeenCalledWith('u-1', 'ws-1', null)
  })

  it('400s a cross-workspace / non-blueprint template (store throws InvalidRecordingBlueprintError)', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('admin')
    workspaceStore.setDefaultRecordingBlueprint.mockRejectedValueOnce(
      new InvalidRecordingBlueprintError('Blueprint not found in this workspace'),
    )
    const res = await request(app('u-1'))
      .patch('/api/workspaces/ws-1')
      .send({ defaultRecordingBlueprintId: BP })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('Blueprint not found')
  })

  it('400s a malformed (non-uuid) blueprint id at the boundary, never hitting the store', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('admin')
    const res = await request(app('u-1'))
      .patch('/api/workspaces/ws-1')
      .send({ defaultRecordingBlueprintId: 'not-a-uuid' })
    expect(res.status).toBe(400)
    expect(workspaceStore.setDefaultRecordingBlueprint).not.toHaveBeenCalled()
  })

  it('requires at least an admin role (member → 403)', async () => {
    workspaceStore.getRole.mockResolvedValueOnce('member')
    const res = await request(app('u-1'))
      .patch('/api/workspaces/ws-1')
      .send({ defaultRecordingBlueprintId: BP })
    expect(res.status).toBe(403)
    expect(workspaceStore.setDefaultRecordingBlueprint).not.toHaveBeenCalled()
  })
})
