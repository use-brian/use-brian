/**
 * CRM-typed-field adjust tests — the write lane behind the CRM operator
 * surface's inline cells (crm.md → "Operator surface"). Extends the
 * `[COMP:crm/update]` access-scoping contract to the REST boundary:
 * typed fields apply through the access-scoped crm.ts helpers under the
 * viewer's workspace projection, `stage` routes ONLY through
 * `setDealStage` (crm.md decision 13 — never `updateDeal`), a field sent
 * to the wrong kind is a 400, and app-layer frozen-v1 constraint
 * violations surface as 400s, not 500s.
 *
 * [COMP:crm/update] (REST-boundary flavour)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))
vi.mock('../../db/tasks.js', () => ({ updateTask: vi.fn() }))
vi.mock('../../brain-stream/notify.js', () => ({ notifyBrainInboxChange: vi.fn() }))
vi.mock('../../db/memories.js', () => ({
  updateMemory: vi.fn(),
  getMemoryByIdSystem: vi.fn(),
  markVerifiedDirect: vi.fn(),
}))
vi.mock('../../db/memory-verifications-store.js', () => ({ recordVerification: vi.fn() }))
vi.mock('../../db/entities-store.js', () => ({
  updateEntity: vi.fn(),
  reclassifyEntityKind: vi.fn(),
  promoteEntityToCrm: vi.fn(),
  addEntityAlias: vi.fn(),
  removeEntityAlias: vi.fn(),
}))
vi.mock('../../db/brain-inbox-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/brain-inbox-store.js')>()
  return {
    ...actual,
    appendBrainVerification: vi.fn().mockResolvedValue(undefined),
  }
})
vi.mock('../../db/crm.js', () => ({
  updateContact: vi.fn(),
  updateCompany: vi.fn(),
  updateDeal: vi.fn(),
  setDealStage: vi.fn(),
}))

import { brainInboxRoutes } from '../brain-inbox.js'
import { query } from '../../db/client.js'
import { appendBrainVerification } from '../../db/brain-inbox-store.js'
import { updateEntity } from '../../db/entities-store.js'
import { setDealStage, updateCompany, updateContact, updateDeal } from '../../db/crm.js'

const mockQuery = vi.mocked(query)
const mockUpdateEntity = vi.mocked(updateEntity)
const mockUpdateContact = vi.mocked(updateContact)
const mockUpdateCompany = vi.mocked(updateCompany)
const mockUpdateDeal = vi.mocked(updateDeal)
const mockSetDealStage = vi.mocked(setDealStage)

const WS = 'e1799b0e-9f64-46d5-8ed8-132a2194943d'
const ROW = 'f4b30b32-1771-4c90-b5af-b1b42311f543'
const COMPANY = 'a7c21c04-3d19-4e10-9b7c-6a3f5f2b8d01'

const ENTITY_LINKS = { marker: 'entity-links' } as never

/** The viewer-workspace projection the route builds (membership verified). */
const ACCESS = {
  workspaceId: WS,
  userId: 'u_caller',
  assistantId: '',
  assistantKind: 'primary',
}

function makeApp(role: string | null = 'member') {
  const workspaceStore = { getRole: vi.fn().mockResolvedValue(role) } as never
  return createTestApp(
    '/api/brain-inbox',
    brainInboxRoutes({ workspaceStore, entityLinks: ENTITY_LINKS }),
    { userId: 'u_caller' },
  )
}

/** Seed the `before` SELECT the CRM adjust branch runs first. */
function seedBefore(attributes: Record<string, unknown> = {}) {
  mockQuery.mockResolvedValueOnce({
    rows: [
      {
        workspaceId: WS,
        name: 'Acme',
        sensitivity: 'internal',
        entityId: ROW,
        attributes,
      },
    ],
  } as never)
}

describe('[COMP:crm/update] CRM adjust — typed fields (REST boundary)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('contact email/phone/company_id/tags apply via updateContact under the viewer projection', async () => {
    seedBefore({ email: 'old@acme.com' })
    mockUpdateContact.mockResolvedValueOnce({ id: ROW } as never)

    const res = await request(makeApp())
      .post(`/api/brain-inbox/${WS}/contact/${ROW}/adjust`)
      .send({ email: 'sam@acme.com', phone: null, company_id: COMPANY, tags: ['vip'] })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, stamped: true })
    expect(mockUpdateContact).toHaveBeenCalledWith(
      'u_caller',
      ROW,
      { email: 'sam@acme.com', phone: null, companyId: COMPANY, tags: ['vip'] },
      ENTITY_LINKS,
      ACCESS,
    )
    // Shared-field path untouched: no display_name/sensitivity sent.
    expect(mockUpdateEntity).not.toHaveBeenCalled()
    // The audit records under 'entity' — the CRM row IS its entity, and the
    // brain_verifications.target_kind CHECK rejects raw CRM kinds (the
    // post-write 500 this normalization exists to prevent).
    expect(vi.mocked(appendBrainVerification)).toHaveBeenCalledWith(
      expect.objectContaining({ targetKind: 'entity', action: 'adjust_attributes' }),
    )
  })

  it('company domain applies via updateCompany', async () => {
    seedBefore({ domain: 'old.com' })
    mockUpdateCompany.mockResolvedValueOnce({ id: ROW } as never)

    const res = await request(makeApp())
      .post(`/api/brain-inbox/${WS}/company/${ROW}/adjust`)
      .send({ domain: 'acme.com' })

    expect(res.status).toBe(200)
    expect(mockUpdateCompany).toHaveBeenCalledWith(
      'u_caller',
      ROW,
      { domain: 'acme.com' },
      ACCESS,
    )
  })

  it('deal stage routes ONLY through setDealStage — never updateDeal (decision 13)', async () => {
    seedBefore({ stage: 'proposal' })
    mockSetDealStage.mockResolvedValueOnce({ id: ROW } as never)

    const res = await request(makeApp())
      .post(`/api/brain-inbox/${WS}/deal/${ROW}/adjust`)
      .send({ stage: 'negotiation' })

    expect(res.status).toBe(200)
    expect(mockSetDealStage).toHaveBeenCalledWith('u_caller', ROW, 'negotiation', ACCESS)
    expect(mockUpdateDeal).not.toHaveBeenCalled()
  })

  it('deal amount + close_date apply via updateDeal; stage still splits to setDealStage', async () => {
    seedBefore({ stage: 'proposal' })
    mockUpdateDeal.mockResolvedValueOnce({ id: ROW } as never)
    mockSetDealStage.mockResolvedValueOnce({ id: ROW } as never)

    const res = await request(makeApp())
      .post(`/api/brain-inbox/${WS}/deal/${ROW}/adjust`)
      .send({ amount: 50000, close_date: '2026-09-30', stage: 'won' })

    expect(res.status).toBe(200)
    expect(mockUpdateDeal).toHaveBeenCalledWith(
      'u_caller',
      ROW,
      { amount: 50000, closeDate: new Date('2026-09-30') },
      ENTITY_LINKS,
      ACCESS,
    )
    expect(mockSetDealStage).toHaveBeenCalledWith('u_caller', ROW, 'won', ACCESS)
    // The updateDeal fields object must never carry stage.
    expect(mockUpdateDeal.mock.calls[0][2]).not.toHaveProperty('stage')
  })

  it('nullable clears pass null through (deal amount/close_date)', async () => {
    seedBefore({ stage: 'lead', amount: 5, close_date: '2026-01-01' })
    mockUpdateDeal.mockResolvedValueOnce({ id: ROW } as never)

    const res = await request(makeApp())
      .post(`/api/brain-inbox/${WS}/deal/${ROW}/adjust`)
      .send({ amount: null, close_date: null })

    expect(res.status).toBe(200)
    expect(mockUpdateDeal).toHaveBeenCalledWith(
      'u_caller',
      ROW,
      { amount: null, closeDate: null },
      ENTITY_LINKS,
      ACCESS,
    )
  })

  it('400s a typed field sent to the wrong kind (domain on a contact)', async () => {
    const res = await request(makeApp())
      .post(`/api/brain-inbox/${WS}/contact/${ROW}/adjust`)
      .send({ domain: 'acme.com' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/domain is not a valid field for contact/)
    expect(mockUpdateContact).not.toHaveBeenCalled()
    expect(mockUpdateCompany).not.toHaveBeenCalled()
  })

  it('400s an invalid stage before touching the store', async () => {
    const res = await request(makeApp())
      .post(`/api/brain-inbox/${WS}/deal/${ROW}/adjust`)
      .send({ stage: 'closed_won' })
    expect(res.status).toBe(400)
    expect(mockSetDealStage).not.toHaveBeenCalled()
  })

  it('400s a negative amount before touching the store', async () => {
    const res = await request(makeApp())
      .post(`/api/brain-inbox/${WS}/deal/${ROW}/adjust`)
      .send({ amount: -1 })
    expect(res.status).toBe(400)
    expect(mockUpdateDeal).not.toHaveBeenCalled()
  })

  it('404s when the helper misses under the viewer projection (null return)', async () => {
    seedBefore()
    mockUpdateContact.mockResolvedValueOnce(null)
    const res = await request(makeApp())
      .post(`/api/brain-inbox/${WS}/contact/${ROW}/adjust`)
      .send({ email: 'sam@acme.com' })
    expect(res.status).toBe(404)
  })

  it('surfaces an app-layer constraint violation as a 400, not a 500', async () => {
    seedBefore()
    mockUpdateContact.mockRejectedValueOnce(
      new Error('company_id must reference a row in the same workspace'),
    )
    const res = await request(makeApp())
      .post(`/api/brain-inbox/${WS}/contact/${ROW}/adjust`)
      .send({ company_id: COMPANY })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/same workspace/)
  })
})
