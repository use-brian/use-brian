/** Typed CRM adapters share the canonical current-member source gate. */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AccessContext, EntityRecord } from '@use-brian/core'

const transactionClient=vi.hoisted(() => ({query:vi.fn(),release:vi.fn()}))
vi.mock('../client.js', () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  queryGated: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  queryWithRLS: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  getAppPool: vi.fn(() => ({connect:async () => transactionClient})),
  applyRLSGucs:vi.fn(),
  rollbackAndRelease: vi.fn(),
}))

vi.mock('../entities-store.js', () => ({
  assertNativeEntityFieldWrites: vi.fn(),
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
  transactionClient.query.mockImplementation(async(sql:string)=>({rows:[sql==='SHOW transaction_isolation'?{transaction_isolation:'read committed'}:{id:'e-1'}],rowCount:1}))
})

describe('[COMP:crm/update] CRM source authority threading', () => {
  it('uses the guarded no-op read before a contact patch', async () => {
    vi.mocked(updateEntity).mockResolvedValueOnce(entity()).mockResolvedValueOnce(entity()).mockResolvedValueOnce(entity({ displayName: 'New' }))
    const updated = await updateContact('u-viewer', 'e-1', { name: 'New' }, undefined, CTX)
    expect(updated?.name).toBe('New')
    expect(transactionClient.query.mock.calls.some(call => String(call[0]).includes('FOR UPDATE'))).toBe(true)
    expect(transactionClient.query).toHaveBeenCalledWith('COMMIT')
    expect(updateEntity).toHaveBeenNthCalledWith(1, 'u-viewer', 'e-1', {}, CTX, transactionClient)
    expect(getEntityById).not.toHaveBeenCalled()
    expect(getEntityByIdSystem).not.toHaveBeenCalled()
    expect(vi.mocked(updateEntity).mock.calls[1]![3]).toBe(CTX)
  })

  it('keeps the authenticated actor on a context-free source read', async () => {
    vi.mocked(updateEntity).mockResolvedValue(entity({workspaceId:'ws-row'}))
    await updateContact('u-viewer', 'e-1', { name: 'New' })
    expect(updateEntity).toHaveBeenNthCalledWith(1, 'u-viewer', 'e-1', {}, undefined, transactionClient)
    expect(getEntityByIdSystem).not.toHaveBeenCalled()
    expect(vi.mocked(updateEntity).mock.calls[1]![3]).toMatchObject({ workspaceId: 'ws-row', userId: 'u-viewer' })
  })

  it('does not submit a patch after an inaccessible source read', async () => {
    vi.mocked(updateEntity).mockResolvedValue(null)
    expect(await updateContact('u-viewer', 'e-hidden', { name: 'X' }, undefined, CTX)).toBeNull()
    expect(updateEntity).toHaveBeenCalledExactlyOnceWith('u-viewer', 'e-hidden', {}, CTX, transactionClient)
  })

  it('propagates a mutation refusal after an authorized source read', async () => {
    vi.mocked(updateEntity).mockResolvedValueOnce(entity()).mockResolvedValueOnce(entity()).mockResolvedValueOnce(null)
    expect(await updateContact('u-viewer', 'e-1', { name: 'X' }, undefined, CTX)).toBeNull()
    expect(vi.mocked(updateEntity).mock.calls[1]![3]).toBe(CTX)
  })

  it('refuses an absent company transaction actor without raw mutation fallback',async()=>{
    await expect(updateCompany('u-viewer','e-1',{name:'X'},CTX)).rejects.toMatchObject({code:'access_unavailable'})
    expect(updateEntity).not.toHaveBeenCalled()
    expect(getEntityById).not.toHaveBeenCalled()
    expect(getEntityByIdSystem).not.toHaveBeenCalled()
    expect(transactionClient.query).toHaveBeenCalledWith('ROLLBACK')
    expect(transactionClient.query).not.toHaveBeenCalledWith('COMMIT')
  })

  it('threads explicit access through both stage operations', async () => {
    vi.mocked(updateEntity).mockResolvedValueOnce(entity({ kind: 'deal', attributes: { stage: 'lead' } }))
      .mockResolvedValueOnce(entity({ kind: 'deal', attributes: { stage: 'lead' } }))
      .mockResolvedValueOnce(entity({ kind: 'deal', attributes: { stage: 'won' } }))
    expect((await setDealStage('u-viewer', 'e-1', 'won', CTX))?.stage).toBe('won')
    expect(vi.mocked(updateEntity).mock.calls.map(call => call[3])).toEqual([CTX, CTX, CTX])
  })

  it('uses the shared correction client for the source read and write', async () => {
    const client = { query: vi.fn(async(sql:string) => ({rows:[sql==='SHOW transaction_isolation'?{transaction_isolation:'read committed'}:{id:'e-1'}],rowCount:1})) } as never
    vi.mocked(updateEntity).mockResolvedValueOnce(entity({ kind: 'deal', attributes: { stage: 'lead', amount: 50000 } }))
      .mockResolvedValueOnce(entity({ kind: 'deal', attributes: { stage: 'lead', amount: 50000 } }))
      .mockResolvedValueOnce(entity({ kind: 'deal', attributes: { stage: 'won', amount: 50000 } }))
    await setDealStage('u-viewer', 'e-1', 'won', CTX, client)
    expect(vi.mocked(updateEntity).mock.calls.map(call => call[4])).toEqual([client, client, client])
    expect(vi.mocked(updateEntity).mock.calls[2]![2]).toMatchObject({ attributes: { stage: 'won', amount: 50000 } })
  })
})
