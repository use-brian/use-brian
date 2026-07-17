/**
 * [COMP:crm/update] — CRM update-by-id functions thread the viewer
 * projection into `updateEntity` (write-path half of the access-scoped
 * rule in `docs/architecture/features/crm.md`).
 *
 * `entities-store.js` is mocked; each assertion checks (a) the read used
 * to build the attribute merge respects `access` when given, and (b) the
 * `updateEntity` call carries the viewer context — the caller's own
 * `access` when passed, else the primary-reflector fallback derived from
 * the row's workspace.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AccessContext, EntityRecord } from '@use-brian/core'

vi.mock('../client.js', () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  queryGated: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  queryWithRLS: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  getAppPool: vi.fn(() => {
    throw new Error('app pool unused in this suite')
  }),
  rollbackAndRelease: vi.fn(),
}))

vi.mock('../entities-store.js', () => ({
  createEntity: vi.fn(),
  getEntityById: vi.fn(),
  getEntityByIdSystem: vi.fn(),
  updateEntity: vi.fn(),
}))

import { updateContact, updateCompany, setDealStage } from '../crm.js'
import { getEntityById, getEntityByIdSystem, updateEntity } from '../entities-store.js'

const CTX: AccessContext = {
  workspaceId: 'ws-1',
  userId: 'u-viewer',
  assistantId: 'a-1',
  assistantKind: 'standard',
}

function entity(over: Partial<EntityRecord> = {}): EntityRecord {
  return {
    id: 'e-1',
    kind: 'person',
    displayName: 'Someone',
    canonicalId: null,
    aliases: [],
    attributes: {},
    sensitivity: 'internal',
    workspaceId: 'ws-1',
    userId: null,
    assistantId: null,
    createdByUserId: null,
    createdByAssistantId: null,
    sourceEpisodeId: null,
    source: 'user',
    verifiedByUserId: null,
    verifiedAt: null,
    validFrom: new Date('2026-01-01T00:00:00Z'),
    validTo: null,
    supersededBy: null,
    retractedAt: null,
    retractedReason: null,
    retractedBy: null,
    centrality: null,
    centralityComputedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  } as EntityRecord
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:crm/update] CRM update-by-id viewer-projection threading', () => {
  it('updateContact with access: scoped read + access passed to updateEntity', async () => {
    vi.mocked(getEntityById).mockResolvedValue(entity())
    vi.mocked(updateEntity).mockResolvedValue(entity({ displayName: 'New' }))

    const updated = await updateContact('u-viewer', 'e-1', { name: 'New' }, undefined, CTX)
    expect(updated?.name).toBe('New')

    expect(getEntityById).toHaveBeenCalledWith(CTX, 'e-1')
    expect(getEntityByIdSystem).not.toHaveBeenCalled()
    expect(vi.mocked(updateEntity).mock.calls[0]![3]).toBe(CTX)
  })

  it('updateContact without access: system read + primary-reflector fallback', async () => {
    vi.mocked(getEntityByIdSystem).mockResolvedValue(entity({ workspaceId: 'ws-row' }))
    vi.mocked(updateEntity).mockResolvedValue(entity())

    await updateContact('u-viewer', 'e-1', { name: 'New' })

    expect(getEntityByIdSystem).toHaveBeenCalledWith('u-viewer', 'e-1')
    expect(vi.mocked(updateEntity).mock.calls[0]![3]).toEqual({
      workspaceId: 'ws-row',
      userId: 'u-viewer',
      assistantId: '',
      assistantKind: 'primary',
    })
  })

  it('updateContact returns null when the scoped read cannot see the row', async () => {
    vi.mocked(getEntityById).mockResolvedValue(null)
    const updated = await updateContact('u-viewer', 'e-hidden', { name: 'X' }, undefined, CTX)
    expect(updated).toBeNull()
    expect(updateEntity).not.toHaveBeenCalled()
  })

  it('updateCompany propagates a projection-refused write as null', async () => {
    vi.mocked(getEntityById).mockResolvedValue(entity({ kind: 'company' }))
    vi.mocked(updateEntity).mockResolvedValue(null)
    const updated = await updateCompany('u-viewer', 'e-1', { name: 'X' }, CTX)
    expect(updated).toBeNull()
    expect(vi.mocked(updateEntity).mock.calls[0]![3]).toBe(CTX)
  })

  it('setDealStage threads access into updateEntity', async () => {
    vi.mocked(getEntityById).mockResolvedValue(
      entity({ kind: 'deal', attributes: { stage: 'lead' } }),
    )
    vi.mocked(updateEntity).mockResolvedValue(
      entity({ kind: 'deal', attributes: { stage: 'won' } }),
    )
    const updated = await setDealStage('u-viewer', 'e-1', 'won', CTX)
    expect(updated?.stage).toBe('won')
    expect(vi.mocked(updateEntity).mock.calls[0]![3]).toBe(CTX)
  })
})
