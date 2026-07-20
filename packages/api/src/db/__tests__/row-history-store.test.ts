/**
 * `getRowHistory` orchestration — bi-temporal row history (WU-6.9 / D.7).
 * Component tag: [COMP:brain/row-history-store].
 *
 * Pure unit tests. `getMemoryHistory` is mocked so the supersession chain
 * is fully controlled — this exercises the orchestration logic that runs
 * in plain `pnpm test` (no DB): input validation, status derivation,
 * `as_of` projection, `include_retracted` filtering, and `current_id`
 * head identification. The DB-backed walkers themselves are covered by
 * `row-history-store.integration.test.ts`.
 *
 * Spec: docs/architecture/brain/corrections.md §D.7; retrieval.md
 * §getRowHistory.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { RetrievalActor } from '@use-brian/core'

vi.mock('../memories.js', async (importActual) => ({
  ...(await importActual<typeof import('../memories.js')>()),
  getMemoryHistory: vi.fn(),
}))

import { createDbRowHistoryStore } from '../row-history-store.js'
import { getMemoryHistory } from '../memories.js'

const mockMemoryHistory = vi.mocked(getMemoryHistory)

const ACTOR: RetrievalActor = {
  workspaceId: '00000000-0000-0000-0000-0000000000aa',
  userId: '00000000-0000-0000-0000-0000000000bb',
  assistantId: '00000000-0000-0000-0000-0000000000cc',
  assistantKind: 'standard',
  clearance: 'internal',
}
const ROW_ID = '00000000-0000-0000-0000-000000000001'

const DAY1 = new Date('2026-01-01T00:00:00Z')
const DAY2 = new Date('2026-01-02T00:00:00Z')

type FakeMem = {
  id: string
  validFrom: Date
  validTo: Date | null
  supersededBy: string | null
  retractedAt: Date | null
  retractedReason: string | null
  createdByUserId: string | null
  createdByAssistantId: string | null
  createdAt: Date
  summary: string
  tags: string[]
}

function mem(p: Partial<FakeMem> & { id: string }): FakeMem {
  // Post-Phase-4 (retire-memory-type): no `type` / `category` fields.
  return {
    validFrom: DAY1,
    validTo: null,
    supersededBy: null,
    retractedAt: null,
    retractedReason: null,
    createdByUserId: 'user-1',
    createdByAssistantId: null,
    createdAt: DAY1,
    summary: 'a memory',
    tags: [],
    ...p,
  }
}

/** Drive `getMemoryHistory` to return the given (oldest-first) chain. */
function withChain(chain: FakeMem[]): void {
  mockMemoryHistory.mockResolvedValue({
    chain,
    currentId: chain.find((m) => m.validTo === null)?.id ?? null,
  } as Awaited<ReturnType<typeof getMemoryHistory>>)
}

const store = createDbRowHistoryStore()

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:brain/row-history-store] getRowHistory input validation', () => {
  it('throws on an unknown primitive', async () => {
    await expect(
      store.getRowHistory(ACTOR, { primitive: 'bogus' as never, row_id: ROW_ID }),
    ).rejects.toThrow(/unknown primitive/)
  })

  it('throws on a non-UUID row_id', async () => {
    await expect(
      store.getRowHistory(ACTOR, { primitive: 'memories', row_id: 'not-a-uuid' }),
    ).rejects.toThrow(/must be a UUID/)
  })

  it('throws on an invalid as_of timestamp', async () => {
    withChain([mem({ id: 'm0' })])
    await expect(
      store.getRowHistory(ACTOR, {
        primitive: 'memories',
        row_id: ROW_ID,
        as_of: 'not-a-date',
      }),
    ).rejects.toThrow(/invalid as_of/)
  })
})

describe('[COMP:brain/row-history-store] getRowHistory chain assembly', () => {
  it('returns null when the chain is empty', async () => {
    withChain([])
    const res = await store.getRowHistory(ACTOR, {
      primitive: 'memories',
      row_id: ROW_ID,
    })
    expect(res).toBeNull()
  })

  it('derives active / superseded / retracted status per version', async () => {
    withChain([
      mem({ id: 'm0', validFrom: DAY1, validTo: DAY2, supersededBy: 'm1' }),
      mem({ id: 'm1', validFrom: DAY2, validTo: null }),
      mem({ id: 'mr', validFrom: DAY1, retractedAt: DAY2 }),
    ])
    const res = await store.getRowHistory(ACTOR, {
      primitive: 'memories',
      row_id: ROW_ID,
    })
    const byId = Object.fromEntries(
      (res?.data.chain ?? []).map((v) => [v.id, v.status]),
    )
    expect(byId).toEqual({ m0: 'superseded', m1: 'active', mr: 'retracted' })
  })

  it('picks current_id as the open version with no as_of', async () => {
    withChain([
      mem({ id: 'm0', validFrom: DAY1, validTo: DAY2, supersededBy: 'm1' }),
      mem({ id: 'm1', validFrom: DAY2, validTo: null }),
    ])
    const res = await store.getRowHistory(ACTOR, {
      primitive: 'memories',
      row_id: ROW_ID,
    })
    expect(res?.data.current_id).toBe('m1')
  })

  it('serializes timestamps to ISO strings and carries the display block', async () => {
    withChain([mem({ id: 'm0', summary: 'hello', })])
    const res = await store.getRowHistory(ACTOR, {
      primitive: 'memories',
      row_id: ROW_ID,
    })
    const v = res?.data.chain[0]
    expect(v?.valid_from).toBe(DAY1.toISOString())
    expect(v?.display).toMatchObject({ summary: 'hello', })
  })
})

describe('[COMP:brain/row-history-store] getRowHistory as_of projection', () => {
  it('drops versions that did not yet exist at the pivot', async () => {
    withChain([
      mem({ id: 'm0', validFrom: DAY1, validTo: DAY2, supersededBy: 'm1' }),
      mem({ id: 'm1', validFrom: DAY2, validTo: null }),
    ])
    const res = await store.getRowHistory(ACTOR, {
      primitive: 'memories',
      row_id: ROW_ID,
      as_of: '2026-01-01T12:00:00Z',
    })
    expect(res?.data.chain.map((v) => v.id)).toEqual(['m0'])
    // current_id is the version active at the pivot, not the live head.
    expect(res?.data.current_id).toBe('m0')
  })
})

describe('[COMP:brain/row-history-store] getRowHistory include_retracted', () => {
  it('keeps retracted versions by default', async () => {
    withChain([mem({ id: 'mr', retractedAt: DAY2, retractedReason: 'wrong' })])
    const res = await store.getRowHistory(ACTOR, {
      primitive: 'memories',
      row_id: ROW_ID,
    })
    expect(res?.data.chain.map((v) => v.id)).toEqual(['mr'])
  })

  it('filters retracted versions when include_retracted is false', async () => {
    withChain([
      mem({ id: 'm1', validTo: null }),
      mem({ id: 'mr', retractedAt: DAY2 }),
    ])
    const res = await store.getRowHistory(ACTOR, {
      primitive: 'memories',
      row_id: ROW_ID,
      include_retracted: false,
    })
    expect(res?.data.chain.map((v) => v.id)).toEqual(['m1'])
  })
})
