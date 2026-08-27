/**
 * Person mutation identity boundary.
 *
 * [COMP:crm/person-write-identity]
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const entities = vi.hoisted(() => ({
  createEntity: vi.fn(),
  getEntityById: vi.fn(),
  getEntityByIdSystem: vi.fn(),
  updateEntity: vi.fn(),
}))
const identity = vi.hoisted(() => ({
  bindImportedCrmIdentity: vi.fn(),
  resolveCrmPersonIdentity: vi.fn(),
}))

vi.mock('../entities-store.js', () => entities)
vi.mock('../crm-identity-store.js', () => identity)
vi.mock('../client.js', () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  queryGated: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  queryWithRLS: vi.fn(async () => ({ rows: [], rowCount: 0 })),
}))
vi.mock('../access-predicate.js', () => ({
  buildAccessPredicate: vi.fn(() => ({ sql: 'TRUE', params: [], nextIdx: 1 })),
}))
vi.mock('../authorship-guard.js', () => ({ assertAuthorshipPresent: vi.fn() }))
vi.mock('../edge-hooks.js', () => ({
  emitCrmRelationEdge: vi.fn(),
  emitEdgeFireAndForget: vi.fn(),
  superseedCrmRelationEdge: vi.fn(),
}))

import {
  CrmPersonIdentityConflictError,
  createContact,
} from '../crm.js'

const NOW = new Date('2026-08-25T00:00:00Z')
const STABLE = {
  provider: 'slack',
  providerInstanceKey: 'T000001',
  subjectId: 'U000001',
}

function person(id: string, name: string, email: string | null = null) {
  return {
    id,
    kind: 'person' as const,
    displayName: name,
    canonicalId: email,
    attributes: { tags: [], ...(email ? { email } : {}) },
    aliases: [],
    sensitivity: 'internal' as const,
    workspaceId: '00000000-0000-4000-8000-000000000001',
    userId: null,
    assistantId: null,
    createdByUserId: '00000000-0000-4000-8000-000000000002',
    createdByAssistantId: null,
    source: 'user' as const,
    sourceEpisodeId: null,
    sourceSessionId: null,
    validFrom: NOW,
    validTo: null,
    supersededBy: null,
    retractedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

const BASE = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  name: 'Jordan Kim',
}

describe('[COMP:crm/person-write-identity] createContact', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    let next = 0
    entities.createEntity.mockImplementation(async (input: { displayName: string; canonicalId?: string | null }) => (
      person(`00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`, input.displayName, input.canonicalId ?? null)
    ))
    identity.resolveCrmPersonIdentity.mockResolvedValue({ status: 'not_found' })
    identity.bindImportedCrmIdentity.mockResolvedValue({
      status: 'bound',
      inserted: true,
      binding: {},
    })
  })

  it('creates distinct people for exact same name, email, phone, and alias metadata', async () => {
    const first = await createContact('00000000-0000-4000-8000-000000000002', {
      ...BASE,
      email: 'shared@example.test',
      phone: '+1 202 555 0100',
      externalRef: { alias: 'jk' },
    })
    const second = await createContact('00000000-0000-4000-8000-000000000002', {
      ...BASE,
      email: 'shared@example.test',
      phone: '+1 202 555 0100',
      externalRef: { alias: 'jk' },
    })

    expect(first.id).not.toBe(second.id)
    expect(entities.createEntity).toHaveBeenCalledTimes(2)
    expect(identity.resolveCrmPersonIdentity).not.toHaveBeenCalled()
  })

  it('uses one unambiguous stable binding as the only automatic target', async () => {
    const existing = person('00000000-0000-4000-8000-000000000099', 'Jordan Kim')
    identity.resolveCrmPersonIdentity.mockResolvedValue({
      status: 'resolved',
      binding: { entityId: existing.id },
    })
    entities.getEntityByIdSystem.mockResolvedValue(existing)

    const result = await createContact('00000000-0000-4000-8000-000000000002', {
      ...BASE,
      stableIdentity: STABLE,
    })

    expect(result.id).toBe(existing.id)
    expect(entities.createEntity).not.toHaveBeenCalled()
    expect(identity.resolveCrmPersonIdentity).toHaveBeenCalledWith(BASE.workspaceId, STABLE)
  })

  it('returns ambiguity and writes nothing for a conflicting stable binding', async () => {
    identity.resolveCrmPersonIdentity.mockResolvedValue({
      status: 'conflict',
      entityIds: ['00000000-0000-4000-8000-000000000090', '00000000-0000-4000-8000-000000000091'],
    })

    await expect(createContact('00000000-0000-4000-8000-000000000002', {
      ...BASE,
      stableIdentity: STABLE,
    })).rejects.toBeInstanceOf(CrmPersonIdentityConflictError)
    expect(entities.createEntity).not.toHaveBeenCalled()
    expect(identity.bindImportedCrmIdentity).not.toHaveBeenCalled()
  })

  it('never falls back to weak identity when a binding read fails', async () => {
    identity.resolveCrmPersonIdentity.mockRejectedValue(new Error('binding store unavailable'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await createContact('00000000-0000-4000-8000-000000000002', {
      ...BASE,
      stableIdentity: STABLE,
    })

    expect(result.id).toBe('00000000-0000-4000-8000-000000000001')
    expect(entities.createEntity).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalledWith(
      '[crm] stable person identity lookup unavailable; creating a distinct record',
    )
    error.mockRestore()
  })
})
