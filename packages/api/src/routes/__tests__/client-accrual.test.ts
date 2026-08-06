/**
 * [COMP:api/client-accrual] — what a public-API turn leaves behind about the
 * external client it served, and who can read it afterwards.
 *
 * The isolation block at the end is the one that matters. It does not
 * re-implement the SQL: it asserts the minted row against the two functions
 * that *define* the read algebra (`subsetCompartments`, `canRead`) and against
 * the real `buildAccessPredicate` output, so a change to either side of the
 * gate shows up here.
 *
 * See `docs/plans/client-principal.md` §8, §8.1 (decisions D11, D12).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  canRead,
  clientCompartment,
  isClientCompartment,
  subsetCompartments,
  unionCompartments,
} from '@use-brian/core'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  queryWithRLS: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  getAppPool: vi.fn(() => { throw new Error('getAppPool must not be reached') }),
  rollbackAndRelease: vi.fn(),
}))

const contactCalls: unknown[] = []
let contactImpl: () => Promise<{ id: string }> = async () => ({ id: 'ent-client-1' })
vi.mock('../../db/entities-store.js', () => ({
  getOrCreateClientContactEntity: vi.fn(async (params: unknown) => {
    contactCalls.push(params)
    return contactImpl()
  }),
}))

const pairingUpserts: unknown[] = []
let existingPairing: unknown = null
vi.mock('../../db/linked-identity-store.js', () => ({
  createLinkedIdentityStore: () => ({
    findByProvider: vi.fn(async () => existingPairing),
    upsert: vi.fn(async (params: unknown) => {
      pairingUpserts.push(params)
      return params
    }),
    listForUser: vi.fn(),
    deleteForUser: vi.fn(),
  }),
}))

const { accrueClientPrincipal } = await import('../client-accrual.js')
const { buildAccessPredicate } = await import('../../db/access-predicate.js')

const CLIENT_A = { id: 'shadow-a', authProvider: 'channel', authProviderId: 'api:key-1:cust_a', name: 'Ada' }
const CLIENT_B = { id: 'shadow-b', authProvider: 'channel', authProviderId: 'api:key-1:cust_b', name: 'Grace' }
const TEAMMATE = { id: 'member-1', authProvider: 'google', authProviderId: '10293847', name: 'Owner' }

function input(overrides: Partial<Parameters<typeof accrueClientPrincipal>[0]> = {}) {
  return {
    user: CLIENT_A,
    workspaceId: 'ws-1',
    assistantId: 'asst-1',
    identityNamespace: 'api:key-1',
    externalUserId: 'cust_a',
    externalUserName: 'Ada Lovelace',
    email: 'ada@example.com',
    orgId: null,
    identified: true,
    ownerId: 'owner-1',
    ...overrides,
  } as Parameters<typeof accrueClientPrincipal>[0]
}

beforeEach(() => {
  contactCalls.length = 0
  pairingUpserts.length = 0
  existingPairing = null
  contactImpl = async () => ({ id: 'ent-client-1' })
  vi.clearAllMocks()
})

describe('[COMP:api/client-accrual] client-principal accrual', () => {
  it('stamps the client compartment and accrues a contact on an identified turn', async () => {
    const accrual = await accrueClientPrincipal(input())

    expect(accrual.compartments).toEqual(['client:cust_a'])
    expect(accrual.contactEntityId).toBe('ent-client-1')
    expect(contactCalls).toHaveLength(1)
    expect(contactCalls[0]).toMatchObject({
      userId: 'shadow-a',
      workspaceId: 'ws-1',
      externalUserId: 'cust_a',
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
    })
    expect(pairingUpserts[0]).toMatchObject({
      userId: 'shadow-a',
      provider: 'api:key-1',
      providerId: 'cust_a',
      metadata: { entityId: 'ent-client-1', email: 'ada@example.com' },
    })
  })

  it('accrues nothing for a resolved teammate', async () => {
    // A public-API turn whose claims.email matched an existing platform
    // account resolves to that member. They are a teammate arriving through an
    // odd door, not a client: no contact, and above all no compartment, which
    // would wall their writes off from the team that owns them.
    const accrual = await accrueClientPrincipal(input({ user: TEAMMATE }))

    expect(accrual).toEqual({ compartments: [], contactEntityId: null })
    expect(contactCalls).toHaveLength(0)
    expect(pairingUpserts).toHaveLength(0)
  })

  it('stamps a Tier 2 anonymous shadow but accrues no contact for it', async () => {
    const accrual = await accrueClientPrincipal(input({ identified: false, email: null }))

    expect(accrual.compartments).toEqual(['client:cust_a'])
    expect(accrual.contactEntityId).toBeNull()
    expect(contactCalls).toHaveLength(0)
  })

  it('keeps the compartment when contact accrual fails', async () => {
    // Losing the contact costs the team a CRM row. Losing the stamp would cost
    // a client their isolation, so the stamp is computed before any I/O.
    contactImpl = async () => { throw new Error('entities table unavailable') }
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const accrual = await accrueClientPrincipal(input())

    expect(accrual.compartments).toEqual(['client:cust_a'])
    expect(accrual.contactEntityId).toBeNull()
  })

  it('leaves an unchanged pairing alone and reports identity drift', async () => {
    existingPairing = {
      userId: 'shadow-a',
      metadata: { entityId: 'ent-client-1', email: 'ada@example.com' },
    }
    await accrueClientPrincipal(input())
    expect(pairingUpserts).toHaveLength(0)

    // Same external id, different email: the consumer's own code paths
    // disagree about who they authenticated. Surfaced, never used as authority.
    const logEvent = vi.fn()
    existingPairing = {
      userId: 'shadow-a',
      metadata: { entityId: 'ent-client-1', email: 'someone-else@example.com' },
    }
    await accrueClientPrincipal(input({ analytics: { logEvent } as never }))
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: 'client_identity_drift', metadata: expect.objectContaining({ emailDrift: true }) }),
    )
    expect(pairingUpserts).toHaveLength(1)
  })

  it('unions into the assistant default rather than replacing it', async () => {
    // The public turn passes `unionCompartments(assistant.defaultCompartments,
    // accrual.compartments)`; an operator's own default must survive.
    const accrual = await accrueClientPrincipal(input())
    expect(unionCompartments(['finance'], accrual.compartments).sort()).toEqual([
      'client:cust_a',
      'finance',
    ])
  })

  describe('isolation', () => {
    // The row a client turn accrues, in the D11 shape.
    const contactRow = { userId: null, sensitivity: 'internal' as const, compartments: ['client:cust_a'] }

    // A client shadow is a workspace non-member, so `effectiveReadCompartments`
    // gives it the EMPTY grant and `effectiveReadClearance` floors it to
    // `public`. Both are asserted directly in workspace-store.test.ts; this
    // block takes them as given and proves what they imply for the row.
    const clientViewer = { clearance: 'public' as const, compartments: [] as string[] }
    const teamViewer = { clearance: 'internal' as const, compartments: null }

    it("a second client's turn cannot read the first's contact", async () => {
      const b = await accrueClientPrincipal(input({ user: CLIENT_B, externalUserId: 'cust_b' }))
      expect(b.compartments).toEqual(['client:cust_b'])

      // Two independent gates, either one sufficient. That redundancy is the
      // point of D12: the compartment survives a write path stamping the
      // wrong sensitivity tier.
      expect(subsetCompartments(clientViewer.compartments, contactRow.compartments)).toBe(false)
      expect(canRead(clientViewer.clearance, contactRow.sensitivity)).toBe(false)

      // Client B's own grant does not reach client A's compartment either —
      // holding one client compartment is not holding another.
      expect(subsetCompartments(b.compartments, contactRow.compartments)).toBe(false)
    })

    it('the client it describes cannot read it back — write-only accrual', async () => {
      const a = await accrueClientPrincipal(input())
      expect(a.contactEntityId).toBe('ent-client-1')
      // The acting client is still a non-member with the empty grant; nothing
      // about authoring a row grants a read of it.
      expect(subsetCompartments(clientViewer.compartments, contactRow.compartments)).toBe(false)
    })

    it('the team reads it — which is the whole deliverable', () => {
      expect(subsetCompartments(teamViewer.compartments, contactRow.compartments)).toBe(true)
      expect(canRead(teamViewer.clearance, contactRow.sensitivity)).toBe(true)
      // `user_id` NULL is what puts it in front of the team at all: the
      // predicate's `(user_id IS NULL OR user_id = $viewer)` branch.
      expect(contactRow.userId).toBeNull()
    })

    it('the emitted predicate carries the compartment clause for a client viewer', () => {
      const ap = buildAccessPredicate({
        workspaceId: 'ws-1',
        userId: 'shadow-b',
        assistantId: 'asst-1',
        assistantKind: 'standard',
        clearance: clientViewer.clearance,
        compartments: clientViewer.compartments,
      })
      expect(ap.sql).toContain('compartments <@ $5::text[]')
      expect(ap.params[4]).toEqual([])
      expect(ap.sql).toContain('sensitivity_rank(sensitivity) <= sensitivity_rank($4)')
      expect(ap.params[3]).toBe('public')

      // A team member on the universe grant drops the clause entirely.
      const team = buildAccessPredicate({
        workspaceId: 'ws-1',
        userId: 'member-1',
        assistantId: 'asst-1',
        assistantKind: 'standard',
        clearance: 'internal',
        compartments: null,
      })
      expect(team.sql).not.toContain('compartments <@')
    })
  })

  describe('reserved namespace', () => {
    it('mints and recognises the client namespace', () => {
      expect(clientCompartment('cust_a')).toBe('client:cust_a')
      expect(isClientCompartment('client:cust_a')).toBe(true)
      // An operator key can never collide: the registry regex forbids a colon.
      expect(isClientCompartment('finance')).toBe(false)
      expect(isClientCompartment('client')).toBe(false)
    })
  })
})
