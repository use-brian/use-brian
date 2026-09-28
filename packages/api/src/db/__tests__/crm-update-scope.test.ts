/** Typed CRM adapters share the canonical current-member source gate. */

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
  vi.resetAllMocks()
})

describe('[COMP:crm/update] CRM source authority threading', () => {
  it('uses the guarded no-op read before a contact patch', async () => {
    vi.mocked(updateEntity).mockResolvedValueOnce(entity()).mockResolvedValueOnce(entity({ displayName: 'New' }))
    const updated = await updateContact('u-viewer', 'e-1', { name: 'New' }, undefined, CTX)
    expect(updated?.name).toBe('New')
    expect(updateEntity).toHaveBeenNthCalledWith(1, 'u-viewer', 'e-1', {}, CTX, undefined)
    expect(getEntityById).not.toHaveBeenCalled()
    expect(getEntityByIdSystem).not.toHaveBeenCalled()
    expect(vi.mocked(updateEntity).mock.calls[1]![3]).toBe(CTX)
  })

  it('keeps the authenticated actor on a context-free source read', async () => {
    vi.mocked(updateEntity).mockResolvedValueOnce(entity({ workspaceId: 'ws-row' })).mockResolvedValueOnce(entity())
    await updateContact('u-viewer', 'e-1', { name: 'New' })
    expect(updateEntity).toHaveBeenNthCalledWith(1, 'u-viewer', 'e-1', {}, undefined, undefined)
    expect(getEntityByIdSystem).not.toHaveBeenCalled()
    expect(vi.mocked(updateEntity).mock.calls[1]![3]).toMatchObject({ workspaceId: 'ws-row', userId: 'u-viewer' })
  })

  it('does not submit a patch after an inaccessible source read', async () => {
    vi.mocked(updateEntity).mockResolvedValue(null)
    expect(await updateContact('u-viewer', 'e-hidden', { name: 'X' }, undefined, CTX)).toBeNull()
    expect(updateEntity).toHaveBeenCalledExactlyOnceWith('u-viewer', 'e-hidden', {}, CTX, undefined)
  })

  it('propagates a mutation refusal after an authorized source read', async () => {
    vi.mocked(updateEntity).mockResolvedValueOnce(entity({ kind: 'company' })).mockResolvedValueOnce(null)
    expect(await updateCompany('u-viewer', 'e-1', { name: 'X' }, CTX)).toBeNull()
    expect(vi.mocked(updateEntity).mock.calls[1]![3]).toBe(CTX)
  })

  it('threads explicit access through both stage operations', async () => {
    vi.mocked(updateEntity).mockResolvedValueOnce(entity({ kind: 'deal', attributes: { stage: 'lead' } }))
      .mockResolvedValueOnce(entity({ kind: 'deal', attributes: { stage: 'won' } }))
    expect((await setDealStage('u-viewer', 'e-1', 'won', CTX))?.stage).toBe('won')
    expect(vi.mocked(updateEntity).mock.calls.map(call => call[3])).toEqual([CTX, CTX])
  })

  it('uses the shared correction client for the source read and write', async () => {
    const client = { query: vi.fn() } as never
    vi.mocked(updateEntity).mockResolvedValueOnce(entity({ kind: 'deal', attributes: { stage: 'lead', amount: 50000 } }))
      .mockResolvedValueOnce(entity({ kind: 'deal', attributes: { stage: 'won', amount: 50000 } }))
    await setDealStage('u-viewer', 'e-1', 'won', CTX, client)
    expect(vi.mocked(updateEntity).mock.calls.map(call => call[4])).toEqual([client, client])
    expect(vi.mocked(updateEntity).mock.calls[1]![2]).toMatchObject({ attributes: { stage: 'won', amount: 50000 } })
  })
})
