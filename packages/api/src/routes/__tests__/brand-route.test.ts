/**
 * [COMP:brand/routes] — `/api/workspaces/:workspaceId/brand`.
 *
 * The thing worth testing here is the authorisation split. Every route needs
 * workspace membership, but **approve** additionally needs `owner` or
 * `admin`, because approval is the irreversible step: it mints the version
 * every assistant in the workspace then ambiently believes. A row predicate
 * cannot express "who may approve", so if this check regresses nothing else
 * catches it.
 *
 * The second thing is that a draft write validates the MERGED record, not the
 * patch — a patch can be individually valid and still leave the draft
 * incoherent — and that it merges onto the in-flight draft rather than the
 * approved record, so a colleague's unapproved work is not discarded.
 *
 * Fixture data is invented.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
  getAppPool: vi.fn(),
  rollbackAndRelease: vi.fn(),
}))

vi.mock('../../db/workspace-store.js', async (io) => ({
  ...(await io<typeof import('../../db/workspace-store.js')>()),
  getWorkspaceMembershipWithClearanceSystem: vi.fn(),
}))

import { brandRoutes } from '../brand.js'
import { getWorkspaceMembershipWithClearanceSystem } from '../../db/workspace-store.js'
import type { BrandDetail, BrandStore } from '@use-brian/core'

const USER = 'u-1'
const WORKSPACE = 'ws-1'
const BRAND = 'b-1'
const MOUNT = '/api/workspaces/:workspaceId/brand'
const URL = `/api/workspaces/${WORKSPACE}/brand`

const APPROVED = {
  naming: { name: 'Northwind Ferry', domains: [], handles: [], restrictedTerms: [] },
  messaging: {
    oneLine: 'Scheduled coastal freight you can plan around.',
    pillars: [], voice: [], toneNotes: [], preferred: [], avoid: [],
  },
  colors: [], typography: [], logoVariants: [],
  applications: [], claims: [], rights: [], sources: [],
} as unknown as BrandDetail['activeRecord']

function detail(overrides: Partial<BrandDetail> = {}): BrandDetail {
  return {
    id: BRAND,
    workspaceId: WORKSPACE,
    slug: 'northwind',
    name: 'Northwind Ferry',
    isDefault: true,
    status: 'active',
    activeVersionId: 'v-1',
    activeVersion: 1,
    hasDraft: false,
    sensitivity: 'internal',
    createdBy: USER,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-07T00:00:00Z'),
    draft: null,
    activeRecord: APPROVED,
    ...overrides,
  }
}

function fakeStore(overrides: Partial<BrandStore> = {}): BrandStore {
  return {
    list: vi.fn(async () => [detail()]),
    get: vi.fn(async () => detail()),
    create: vi.fn(async () => detail()),
    saveDraft: vi.fn(async () => detail({ hasDraft: true })),
    approve: vi.fn(async () => ({ brand: detail(), version: { id: 'v-2', brandId: BRAND, version: 2, record: APPROVED!, approvedBy: USER, approvedAt: new Date() } })),
    listVersions: vi.fn(async () => []),
    getVersion: vi.fn(async () => null),
    ...overrides,
  } as unknown as BrandStore
}

/** Seed the membership lookup the route's gate runs. */
function asRole(role: 'owner' | 'admin' | 'member' | null) {
  vi.mocked(getWorkspaceMembershipWithClearanceSystem).mockResolvedValue(
    role ? { role, clearance: 'internal' } : null,
  )
}

/** `anonymous: true` mounts with no auth shim, so `req.userId` is absent. */
function app(store: BrandStore, opts?: { anonymous?: boolean }) {
  return createTestApp(MOUNT, brandRoutes({ store }), opts?.anonymous ? undefined : { userId: USER })
}

beforeEach(() => vi.clearAllMocks())

describe('[COMP:brand/routes] membership gate', () => {
  it('401s without a user', async () => {
    asRole('owner')
    await request(app(fakeStore(), { anonymous: true })).get(URL).expect(401)
  })

  it('403s a non-member', async () => {
    asRole(null)
    const res = await request(app(fakeStore())).get(URL).expect(403)
    expect(res.body.error).toMatch(/Not a member/)
  })

  it('lists for a plain member', async () => {
    asRole('member')
    const res = await request(app(fakeStore())).get(URL).expect(200)
    expect(res.body.brands).toHaveLength(1)
    // The client needs this to decide whether to render Approve at all.
    expect(res.body.canApprove).toBe(false)
  })

  it('reports canApprove for an owner', async () => {
    asRole('owner')
    const res = await request(app(fakeStore())).get(URL).expect(200)
    expect(res.body.canApprove).toBe(true)
  })
})

describe('[COMP:brand/routes] approve is owner/admin only', () => {
  it('403s a plain member and never reaches the store', async () => {
    asRole('member')
    const store = fakeStore()
    const res = await request(app(store)).post(`${URL}/${BRAND}/approve`).expect(403)
    expect(res.body.error).toMatch(/owner or admin/)
    expect(store.approve).not.toHaveBeenCalled()
  })

  it('allows an owner', async () => {
    asRole('owner')
    const store = fakeStore()
    await request(app(store)).post(`${URL}/${BRAND}/approve`).expect(200)
    expect(store.approve).toHaveBeenCalledTimes(1)
  })

  it('allows an admin', async () => {
    asRole('admin')
    const store = fakeStore()
    await request(app(store)).post(`${URL}/${BRAND}/approve`).expect(200)
    expect(store.approve).toHaveBeenCalledTimes(1)
  })

  it('reports "nothing to approve" as 409, not as a failure', async () => {
    asRole('owner')
    // A double-clicked Approve button must read as already-approved.
    const store = fakeStore({ approve: vi.fn(async () => null) as never })
    const res = await request(app(store)).post(`${URL}/${BRAND}/approve`).expect(409)
    expect(res.body.error).toMatch(/no unapproved draft/)
  })

  it('404s when the brand does not exist', async () => {
    asRole('owner')
    const store = fakeStore({
      approve: vi.fn(async () => null) as never,
      get: vi.fn(async () => null) as never,
    })
    await request(app(store)).post(`${URL}/${BRAND}/approve`).expect(404)
  })
})

describe('[COMP:brand/routes] draft upsert', () => {
  it('accepts a member patch and validates the merged record', async () => {
    asRole('member')
    const store = fakeStore()
    await request(app(store))
      .put(`${URL}/${BRAND}/draft`)
      .send({ changes: { messaging: { oneLine: 'Hourly crossings, published in advance.' } } })
      .expect(200)
    const saved = vi.mocked(store.saveDraft).mock.calls[0][3] as { messaging?: { oneLine?: string } }
    expect(saved.messaging?.oneLine).toBe('Hourly crossings, published in advance.')
  })

  it('rejects a patch that leaves the merged record invalid, with field paths', async () => {
    asRole('member')
    const store = fakeStore()
    const res = await request(app(store))
      .put(`${URL}/${BRAND}/draft`)
      .send({ changes: { messaging: { voice: [{ trait: 'Punctual' }] } } })
      .expect(400)
    expect(res.body.issues.map((i: { path: string }) => i.path).join(' ')).toContain('messaging.voice')
    expect(store.saveDraft).not.toHaveBeenCalled()
  })

  it('rejects an unknown field group rather than dropping it', async () => {
    asRole('member')
    const store = fakeStore()
    await request(app(store))
      .put(`${URL}/${BRAND}/draft`)
      .send({ changes: { designSystem: {} } })
      .expect(400)
    expect(store.saveDraft).not.toHaveBeenCalled()
  })

  it('merges onto the in-flight draft, not the approved record', async () => {
    asRole('member')
    const inFlight = {
      ...APPROVED,
      strategy: {
        positioning: 'A colleague was mid-edit here.',
        audience: [], differentiators: [], personality: [], notPersonality: [],
      },
    } as unknown as BrandDetail['draft']
    const store = fakeStore({ get: vi.fn(async () => detail({ draft: inFlight, hasDraft: true })) as never })
    await request(app(store))
      .put(`${URL}/${BRAND}/draft`)
      .send({ changes: { messaging: { oneLine: 'New line.' } } })
      .expect(200)
    const saved = vi.mocked(store.saveDraft).mock.calls[0][3] as { strategy?: { positioning?: string } }
    expect(saved.strategy?.positioning).toBe('A colleague was mid-edit here.')
  })

  it('leaves writtenBy at its user default (a human in Studio)', async () => {
    asRole('member')
    const store = fakeStore()
    await request(app(store))
      .put(`${URL}/${BRAND}/draft`)
      .send({ changes: { messaging: { oneLine: 'x' } } })
      .expect(200)
    // The chat tool and the brain-MCP bridge pass 'system'; this route must
    // not, or every Studio edit would look bot-authored to a workflow.
    expect(vi.mocked(store.saveDraft).mock.calls[0][4]).toBeUndefined()
  })

  it('404s for a brand the caller cannot see', async () => {
    asRole('member')
    const store = fakeStore({ get: vi.fn(async () => null) as never })
    await request(app(store))
      .put(`${URL}/${BRAND}/draft`)
      .send({ changes: { messaging: { oneLine: 'x' } } })
      .expect(404)
  })
})

describe('[COMP:brand/routes] create and read', () => {
  it('rejects a malformed slug', async () => {
    asRole('member')
    const store = fakeStore()
    await request(app(store)).post(URL).send({ slug: 'Northwind Ferry', name: 'Northwind' }).expect(400)
    expect(store.create).not.toHaveBeenCalled()
  })

  it('maps a slug collision to 409 with an actionable message', async () => {
    asRole('member')
    const store = fakeStore({
      create: vi.fn(async () => {
        throw new Error('duplicate key value violates unique constraint "idx_workspace_brands_slug"')
      }) as never,
    })
    const res = await request(app(store)).post(URL).send({ slug: 'northwind', name: 'Northwind' }).expect(409)
    expect(res.body.error).toMatch(/already exists/)
  })

  it('resolves the literal `default` to the workspace default brand', async () => {
    asRole('member')
    const store = fakeStore()
    await request(app(store)).get(`${URL}/default`).expect(200)
    // Undefined ref = the default brand, so the common case needs no prior
    // list call.
    expect(vi.mocked(store.get).mock.calls[0][2]).toBeUndefined()
  })

  it('passes an explicit id through as an id ref', async () => {
    asRole('member')
    const store = fakeStore()
    await request(app(store)).get(`${URL}/${BRAND}`).expect(200)
    expect(vi.mocked(store.get).mock.calls[0][2]).toEqual({ id: BRAND })
  })

  it('rejects a non-integer version', async () => {
    asRole('member')
    const store = fakeStore()
    await request(app(store)).get(`${URL}/${BRAND}/versions/latest`).expect(400)
    expect(store.getVersion).not.toHaveBeenCalled()
  })
})
