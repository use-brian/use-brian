/**
 * Unit tests for the Tasks operator surface's flat list route.
 * Component tag: [COMP:brain/tasks-list-http].
 *
 * Mocks `resolveWorkspaceViewpoint` + the `listTasks` db helper and mounts
 * `brainRoutes()` with stub stores. Verifies the auth/param/membership
 * gates and the wire projection (ISO dates, attributes passthrough, the
 * all-statuses + cap-500 read the surface owns client-side).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))
vi.mock('../../db/workspace-viewpoint.js', () => ({
  resolveWorkspaceViewpoint: vi.fn(),
}))
vi.mock('../../db/tasks.js', () => ({
  listTasks: vi.fn(),
}))

import { brainRoutes } from '../brain.js'
import { resolveWorkspaceViewpoint } from '../../db/workspace-viewpoint.js'
import { listTasks } from '../../db/tasks.js'

const mockResolve = vi.mocked(resolveWorkspaceViewpoint)
const mockList = vi.mocked(listTasks)

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeApp(userId?: string) {
  const router = brainRoutes({
    entitiesStore: {} as any,
    entityLinksStore: {} as any,
    retrievalStore: { search: vi.fn() } as any,
    knowledgeStore: {
      listForBrain: vi.fn(),
      getById: vi.fn(),
      listForGraph: vi.fn(),
      listByIds: vi.fn(),
      getSource: vi.fn(),
    } as any,
  })
  return createTestApp('/api/brain', router, userId ? { userId } : undefined)
}

const CTX = { workspaceId: 'w1', userId: 'u1' } as any

describe('[COMP:brain/tasks-list-http] GET /api/brain/tasks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('401s without a user', async () => {
    const res = await request(makeApp()).get('/api/brain/tasks?workspaceId=w1')
    expect(res.status).toBe(401)
  })

  it('400s without workspaceId', async () => {
    const res = await request(makeApp('u1')).get('/api/brain/tasks')
    expect(res.status).toBe(400)
  })

  it('404s for a non-member (viewpoint resolves null)', async () => {
    mockResolve.mockResolvedValue(null)
    const res = await request(makeApp('u1')).get('/api/brain/tasks?workspaceId=w1')
    expect(res.status).toBe(404)
  })

  it('returns the flat operator projection — all statuses, cap 500, ISO dates', async () => {
    mockResolve.mockResolvedValue(CTX)
    mockList.mockResolvedValue([
      {
        id: 't1',
        workspaceId: 'w1',
        title: 'Ship the deck',
        status: 'todo',
        assigneeId: 'm1',
        due: new Date('2026-08-01T00:00:00Z'),
        tags: ['project:launch'],
        parentId: null,
        attributes: { priority: 'high' },
        updatedAt: new Date('2026-07-20T00:00:00Z'),
      } as any,
    ])
    const res = await request(makeApp('u1')).get('/api/brain/tasks?workspaceId=w1')
    expect(res.status).toBe(200)
    expect(res.body.tasks).toEqual([
      {
        id: 't1',
        title: 'Ship the deck',
        status: 'todo',
        assigneeId: 'm1',
        due: '2026-08-01T00:00:00.000Z',
        tags: ['project:launch'],
        parentId: null,
        attributes: { priority: 'high' },
        updatedAt: '2026-07-20T00:00:00.000Z',
      },
    ])
    // The surface owns the active/completed fold client-side, so the read
    // asks for EVERY status (incl. archived) at the operator cap.
    const filters = mockList.mock.calls[0][1]
    expect(filters.status).toEqual(['todo', 'in_progress', 'blocked', 'done', 'archived'])
    expect(filters.limit).toBe(500)
  })

  it('500s (not a crash) when the store read fails', async () => {
    mockResolve.mockResolvedValue(CTX)
    mockList.mockRejectedValue(new Error('boom'))
    const res = await request(makeApp('u1')).get('/api/brain/tasks?workspaceId=w1')
    expect(res.status).toBe(500)
  })
})
