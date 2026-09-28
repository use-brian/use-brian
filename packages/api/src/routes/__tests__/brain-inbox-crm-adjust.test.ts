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
vi.mock('../../db/workspace-files.js', () => ({ updateWorkspaceFileMeta: vi.fn() }))
vi.mock('../../db/tasks.js', () => ({ updateTask: vi.fn() }))
vi.mock('../../brain-stream/notify.js', () => ({ notifyBrainInboxChange: vi.fn() }))
vi.mock('../../db/memories.js', () => ({
  updateMemory: vi.fn(),
  getMemoryByIdSystem: vi.fn(),
  markVerifiedDirect: vi.fn(),
}))
vi.mock('../../db/memory-verifications-store.js', () => ({
  adjustMemoryDecision: vi.fn(),
  recordVerification: vi.fn(),
}))
vi.mock('../../db/entities-store.js', () => ({
  updateEntity: vi.fn(),
  reclassifyEntityKind: vi.fn(),
  promoteEntityToCrm: vi.fn(),
  addEntityAlias: vi.fn(),
  removeEntityAlias: vi.fn(),
}))
vi.mock('../../db/brain-inbox-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/brain-inbox-store.js')>()
  const appendBrainVerification = vi.fn().mockResolvedValue(undefined)
  return {
    ...actual,
    getBrainInboxRow: vi.fn(),
    appendBrainVerification,
    applyBrainCorrection: vi.fn(async <T,>(params: {
      mutate: (client: never) => Promise<T>
      verifications: (result: T) => readonly unknown[]
    }) => {
      const result = await params.mutate({} as never)
      for (const verification of params.verifications(result)) {
        await appendBrainVerification(verification)
      }
      return result
    }),
  }
})
vi.mock('../../db/crm.js', () => ({
  updateContact: vi.fn(),
  updateCompany: vi.fn(),
  updateDeal: vi.fn(),
  setDealStage: vi.fn(),
}))
vi.mock('../../db/crm-r2.js', () => ({ appendCrmActivity: vi.fn().mockResolvedValue(null) }))

import { brainInboxRoutes } from '../brain-inbox.js'
import { query } from '../../db/client.js'
import { appendBrainVerification, getBrainInboxRow } from '../../db/brain-inbox-store.js'
import { updateWorkspaceFileMeta } from '../../db/workspace-files.js'
import {
  addEntityAlias,
  promoteEntityToCrm,
  reclassifyEntityKind,
  removeEntityAlias,
  updateEntity,
} from '../../db/entities-store.js'
import { notifyBrainInboxChange } from '../../brain-stream/notify.js'
import { setDealStage, updateCompany, updateContact, updateDeal } from '../../db/crm.js'
import { appendCrmActivity } from '../../db/crm-r2.js'

const mockQuery = vi.mocked(query)
const mockUpdateEntity = vi.mocked(updateEntity)
const mockAddEntityAlias = vi.mocked(addEntityAlias)
const mockRemoveEntityAlias = vi.mocked(removeEntityAlias)
const mockReclassifyEntityKind = vi.mocked(reclassifyEntityKind)
const mockPromoteEntityToCrm = vi.mocked(promoteEntityToCrm)
const mockUpdateContact = vi.mocked(updateContact)
const mockUpdateCompany = vi.mocked(updateCompany)
const mockUpdateDeal = vi.mocked(updateDeal)
const mockSetDealStage = vi.mocked(setDealStage)
const mockGetBrainInboxRow = vi.mocked(getBrainInboxRow)

const WS = 'e1799b0e-9f64-46d5-8ed8-132a2194943d'
const ROW = 'f4b30b32-1771-4c90-b5af-b1b42311f543'
const COMPANY = 'a7c21c04-3d19-4e10-9b7c-6a3f5f2b8d01'

const ENTITY_LINKS = { marker: 'entity-links' } as never

/** The viewer-workspace projection the route builds (membership verified). */
const ACCESS = {
  workspaceId: WS,
  userId: 'u_caller',
  assistantId: '',
  assistantKind: 'primary' as const,
}

function makeApp(role: string | null = 'member') {
  const workspaceStore = { getRole: vi.fn().mockResolvedValue(role) } as never
  return createTestApp(
    '/api/brain-inbox',
    brainInboxRoutes({
      workspaceStore,
      entityLinks: ENTITY_LINKS,
      resolveAccess: async () => ACCESS,
    }),
    { userId: 'u_caller' },
  )
}

function admittedRow(
  primitive: 'entity' | 'contact' | 'company' | 'deal' | 'workspace_file',
  attributes: Record<string, unknown> = {},
  sensitivity: 'public' | 'internal' | 'confidential' = 'confidential',
) {
  return {
    primitive, id: ROW, workspaceId: WS,
    createdAt: new Date(), updatedAt: new Date(), createdByAssistantId: null,
    verifiedByUserId: null, verifiedAt: null,
    body: {
      display_name: 'Fixture', name: 'Fixture', entity_id: ROW,
      sensitivity, tags: [], attributes, ...attributes,
    },
  } as never
}

/** Seed the mutation-scoped current row the shared mutator admits first. */
function seedBefore(attributes: Record<string, unknown> = {}) {
  mockGetBrainInboxRow.mockImplementationOnce(async ({ primitive }) =>
    admittedRow(primitive as 'entity' | 'contact' | 'company' | 'deal' | 'workspace_file', attributes, 'internal'))
}

describe('[COMP:crm/update] CRM adjust — typed fields (REST boundary)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetBrainInboxRow.mockImplementation(async ({ primitive }) =>
      admittedRow(primitive as 'entity' | 'contact' | 'company' | 'deal' | 'workspace_file'))
  })

  it('returns a release-required conflict for files without recording an audit',async()=>{
    mockQuery.mockResolvedValueOnce({rows:[{workspaceId:WS,sensitivity:'confidential',tags:[]}]} as never)
    vi.mocked(updateWorkspaceFileMeta).mockRejectedValueOnce(Object.assign(new Error('Audited release required'),{code:'scope_declassification_required'}))
    const res=await request(makeApp('owner')).post(`/api/brain-inbox/${WS}/workspace_file/${ROW}/adjust`)
      .send({sensitivity:'internal',tags:['changed']})
    expect(res.status).toBe(409)
    expect(res.body).toEqual({error:'Lowering sensitivity requires an audited release.',code:'scope_declassification_required'})
    expect(appendBrainVerification).not.toHaveBeenCalled()
  })

  it.each(['entity','contact','company','deal'])('returns an explicit release conflict for %s without an audit or partial field write',async primitive=>{
    mockQuery.mockResolvedValueOnce({rows:[{workspaceId:WS,name:'Fixture',displayName:'Fixture',sensitivity:'confidential',entityId:ROW,attributes:{}}]} as never)
    mockUpdateEntity.mockRejectedValueOnce(Object.assign(new Error('Lowering sensitivity requires an audited release.'),{code:'scope_declassification_required'}))
    const res=await request(makeApp('owner')).post(`/api/brain-inbox/${WS}/${primitive}/${ROW}/adjust`)
      .send({sensitivity:'internal',...(primitive==='entity'?{display_name:'Changed'}:{name:'Changed'}),...(primitive==='contact'?{email:'person@example.com'}:{})})
    expect(res.status).toBe(409)
    expect(res.body).toEqual({error:'Lowering sensitivity requires an audited release.',code:'scope_declassification_required'})
    expect(appendBrainVerification).not.toHaveBeenCalled()
    expect(appendCrmActivity).not.toHaveBeenCalled()
    expect(mockUpdateContact).not.toHaveBeenCalled()
  })

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
      expect.anything(),
    )
    // Shared-field path untouched: no display_name/sensitivity sent.
    expect(mockUpdateEntity).not.toHaveBeenCalled()
    // The audit records under 'entity' — the CRM row IS its entity, and the
    // brain_verifications.target_kind CHECK rejects raw CRM kinds (the
    // post-write 500 this normalization exists to prevent).
    expect(vi.mocked(appendBrainVerification)).toHaveBeenCalledWith(
      expect.objectContaining({ targetKind: 'entity', action: 'adjust_attributes' }),
    )
    expect(vi.mocked(appendCrmActivity)).toHaveBeenCalledWith(expect.objectContaining({
      entityId: ROW,
      activityType: 'field_change',
      metadata: expect.objectContaining({
        before: expect.objectContaining({ email: 'old@acme.com' }),
        after: expect.objectContaining({ email: 'sam@acme.com' }),
      }),
    }))
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
      expect.anything(),
    )
  })

  it('deal stage routes ONLY through setDealStage — never updateDeal (decision 13)', async () => {
    seedBefore({ stage: 'proposal' })
    mockSetDealStage.mockResolvedValueOnce({ id: ROW } as never)

    const res = await request(makeApp())
      .post(`/api/brain-inbox/${WS}/deal/${ROW}/adjust`)
      .send({ stage: 'negotiation' })

    expect(res.status).toBe(200)
    expect(mockSetDealStage).toHaveBeenCalledWith(
      'u_caller', ROW, 'negotiation', ACCESS, expect.anything(),
    )
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
      expect.anything(),
    )
    expect(mockSetDealStage).toHaveBeenCalledWith(
      'u_caller', ROW, 'won', ACCESS, expect.anything(),
    )
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
      expect.anything(),
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

describe('[COMP:api/entity-mutation-scope] CRM semantic corrections (REST boundary)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('adds and removes aliases through the complete access envelope without an owner-pool preflight', async () => {
    mockAddEntityAlias.mockResolvedValueOnce({ kind: 'ok', entity: { aliases: ['known-as'] } as never })
    mockRemoveEntityAlias.mockResolvedValueOnce({ aliases: [] } as never)
    const app = makeApp()

    const added = await request(app)
      .post(`/api/brain-inbox/${WS}/entity/${ROW}/aliases`)
      .send({ alias: 'Known-As' })
    const removed = await request(app)
      .delete(`/api/brain-inbox/${WS}/entity/${ROW}/aliases/known-as`)

    expect(added.status).toBe(200)
    expect(removed.status).toBe(200)
    expect(mockAddEntityAlias).toHaveBeenCalledWith('u_caller', ROW, 'Known-As', ACCESS)
    expect(mockRemoveEntityAlias).toHaveBeenCalledWith('u_caller', ROW, 'known-as', ACCESS)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('uses the locked previous kind for reclassification audit and treats an authorized no-op as idempotent', async () => {
    mockReclassifyEntityKind
      .mockResolvedValueOnce({ id: ROW, kind: 'product', previousKind: 'project', changed: true } as never)
      .mockResolvedValueOnce({ id: ROW, kind: 'product', previousKind: 'product', changed: false } as never)
    const app = makeApp()

    const changed = await request(app)
      .post(`/api/brain-inbox/${WS}/entity/${ROW}/reclassify`)
      .send({ kind: 'product', reason: 'Correction' })
    const noop = await request(app)
      .post(`/api/brain-inbox/${WS}/entity/${ROW}/reclassify`)
      .send({ kind: 'product' })

    expect(changed.status).toBe(200)
    expect(noop.body).toEqual({ ok: true, kind: 'product', idempotent: true })
    expect(mockReclassifyEntityKind).toHaveBeenCalledWith(
      'u_caller', ROW, { kind: 'product' }, ACCESS, expect.anything(),
    )
    expect(vi.mocked(appendBrainVerification)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(appendBrainVerification)).toHaveBeenCalledWith(expect.objectContaining({
      modelValue: { kind: 'project' }, userValue: { kind: 'product' },
    }))
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('promotes with relationship fields and audits the kind captured by the store lock', async () => {
    mockPromoteEntityToCrm.mockResolvedValueOnce({
      entity: { id: ROW, kind: 'deal' }, specializationId: ROW, previousKind: 'project',
    } as never)

    const res = await request(makeApp())
      .post(`/api/brain-inbox/${WS}/entity/${ROW}/promote-to-crm`)
      .send({ kind: 'deal', stage: 'proposal', companyId: COMPANY, contactId: 'contact-1', closeDate: '2026-10-01' })

    expect(res.status).toBe(200)
    expect(mockPromoteEntityToCrm).toHaveBeenCalledWith(
      'u_caller', ROW,
      expect.objectContaining({
        kind: 'deal', stage: 'proposal', companyId: COMPANY, contactId: 'contact-1',
        closeDate: new Date('2026-10-01'),
      }),
      ACCESS,
      expect.anything(),
    )
    expect(vi.mocked(appendBrainVerification)).toHaveBeenCalledWith(expect.objectContaining({
      modelValue: { kind: 'project' },
    }))
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it.each([
    ['alias', async (app: ReturnType<typeof makeApp>) => request(app).post(`/api/brain-inbox/${WS}/entity/${ROW}/aliases`).send({ alias: 'hidden' })],
    ['reclassify', async (app: ReturnType<typeof makeApp>) => request(app).post(`/api/brain-inbox/${WS}/entity/${ROW}/reclassify`).send({ kind: 'product' })],
    ['promotion', async (app: ReturnType<typeof makeApp>) => request(app).post(`/api/brain-inbox/${WS}/entity/${ROW}/promote-to-crm`).send({ kind: 'company' })],
  ] as const)('maps a hidden %s target to the same not-found response without notification', async (operation, invoke) => {
    const refusal = Object.assign(new Error('denied'), { code: 'scope_operation_denied' })
    if (operation === 'alias') mockAddEntityAlias.mockRejectedValueOnce(refusal)
    if (operation === 'reclassify') mockReclassifyEntityKind.mockRejectedValueOnce(refusal)
    if (operation === 'promotion') mockPromoteEntityToCrm.mockRejectedValueOnce(refusal)

    const res = await invoke(makeApp())

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Entity not found' })
    expect(mockQuery).not.toHaveBeenCalled()
    expect(notifyBrainInboxChange).not.toHaveBeenCalled()
  })
})
