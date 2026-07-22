/**
 * Unit tests for the CRM operator surface's flat read route.
 * Component tag: [COMP:brain/crm-list-http].
 *
 * Mocks `resolveWorkspaceViewpoint` + the crm.ts list helpers and mounts
 * `brainRoutes()` with stub stores. Verifies the auth/param/membership
 * gates and the wire projection: one payload with all three kinds at the
 * operator cap (500 each), ISO timestamps, and the calendar-date
 * `closeDate` serialized from LOCAL date components (pg parses DATE to a
 * local-midnight JS Date; toISOString would shift the day on a UTC+ box).
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
vi.mock('../../db/crm.js', () => ({
  listCompanies: vi.fn(),
  listContacts: vi.fn(),
  listDeals: vi.fn(),
}))

import { brainRoutes } from '../brain.js'
import { resolveWorkspaceViewpoint } from '../../db/workspace-viewpoint.js'
import { listCompanies, listContacts, listDeals } from '../../db/crm.js'

const mockResolve = vi.mocked(resolveWorkspaceViewpoint)
const mockDeals = vi.mocked(listDeals)
const mockContacts = vi.mocked(listContacts)
const mockCompanies = vi.mocked(listCompanies)

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

describe('[COMP:brain/crm-list-http] GET /api/brain/crm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('401s without a user', async () => {
    const res = await request(makeApp()).get('/api/brain/crm?workspaceId=w1')
    expect(res.status).toBe(401)
  })

  it('400s without workspaceId', async () => {
    const res = await request(makeApp('u1')).get('/api/brain/crm')
    expect(res.status).toBe(400)
  })

  it('404s for a non-member (viewpoint resolves null)', async () => {
    mockResolve.mockResolvedValue(null)
    const res = await request(makeApp('u1')).get('/api/brain/crm?workspaceId=w1')
    expect(res.status).toBe(404)
  })

  it('returns all three kinds in one payload at the operator cap', async () => {
    mockResolve.mockResolvedValue(CTX)
    // pg parses DATE columns to LOCAL midnight — mirror that here so the
    // serialization assertion catches a toISOString() day-shift regression.
    const closeDate = new Date(2026, 8, 30) // Sep 30, local midnight
    mockDeals.mockResolvedValue([
      {
        id: 'd1',
        workspaceId: 'w1',
        entityId: 'd1',
        name: 'Deal - Acme',
        contactId: 'c1',
        companyId: 'co1',
        stage: 'negotiation',
        amount: 50000,
        closeDate,
        updatedAt: new Date('2026-07-20T00:00:00Z'),
      } as any,
    ])
    mockContacts.mockResolvedValue([
      {
        id: 'c1',
        workspaceId: 'w1',
        entityId: 'c1',
        name: 'Sam Lee',
        email: 'sam@acme.com',
        phone: '+852 1234',
        companyId: 'co1',
        tags: ['vip'],
        updatedAt: new Date('2026-07-19T00:00:00Z'),
      } as any,
    ])
    mockCompanies.mockResolvedValue([
      {
        id: 'co1',
        workspaceId: 'w1',
        entityId: 'co1',
        name: 'Acme',
        domain: 'acme.com',
        tags: [],
        updatedAt: new Date('2026-07-18T00:00:00Z'),
      } as any,
    ])

    const res = await request(makeApp('u1')).get('/api/brain/crm?workspaceId=w1')
    expect(res.status).toBe(200)
    expect(res.body.deals).toEqual([
      {
        id: 'd1',
        name: 'Deal - Acme',
        stage: 'negotiation',
        amount: 50000,
        closeDate: '2026-09-30',
        contactId: 'c1',
        companyId: 'co1',
        updatedAt: '2026-07-20T00:00:00.000Z',
      },
    ])
    expect(res.body.contacts).toEqual([
      {
        id: 'c1',
        name: 'Sam Lee',
        email: 'sam@acme.com',
        phone: '+852 1234',
        companyId: 'co1',
        tags: ['vip'],
        updatedAt: '2026-07-19T00:00:00.000Z',
      },
    ])
    expect(res.body.companies).toEqual([
      {
        id: 'co1',
        name: 'Acme',
        domain: 'acme.com',
        tags: [],
        updatedAt: '2026-07-18T00:00:00.000Z',
      },
    ])
    // Operator cap: the surface reads the whole working set (500/kind);
    // filtering happens client-side.
    expect(mockDeals.mock.calls[0][1]).toEqual({ limit: 500 })
    expect(mockContacts.mock.calls[0][1]).toEqual({ limit: 500 })
    expect(mockCompanies.mock.calls[0][1]).toEqual({ limit: 500 })
  })

  it('500s (not a crash) when a store read fails', async () => {
    mockResolve.mockResolvedValue(CTX)
    mockDeals.mockRejectedValue(new Error('boom'))
    mockContacts.mockResolvedValue([])
    mockCompanies.mockResolvedValue([])
    const res = await request(makeApp('u1')).get('/api/brain/crm?workspaceId=w1')
    expect(res.status).toBe(500)
  })
})
