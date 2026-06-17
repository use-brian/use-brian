import { describe, it, expect, beforeEach } from 'vitest'
import { runDeepConsolidation, bucketDomains } from '../phases.js'
import type { MemoryStore, MemoryWithMetrics, MemoryRecord } from '../../memory/types.js'

// ── Fake store — captures what the Deep orchestrator writes ──

type StoreState = {
  memoriesWithMetrics: MemoryWithMetrics[]
  scores: Map<string, { score: number; boosted: boolean }>
  deleted: Set<string>
  updates: Array<{ id: string; summary?: string; detail?: string }>
  soulSynthInput: Map<string, { selfEntityAttributes: Record<string, unknown> | null; preferences: MemoryRecord[] }>
  soulWrites: Array<{ appId: string | null; content: string }>
  soulReads: Map<string, string>
  domainUpserts: Array<{ appId: string | null; domain: string; summary: string; memoryIds: string[] }>
  domainPrunes: Array<{ appId: string | null; keep: string[] }>
  logs: Array<{ phase: string; summary: string; memoriesAffected: string[] }>
  /**
   * What `listCronContextCandidatesForPrune` returns. The fake honours the
   * `minAgeDays` argument by filtering on a `ageDays` hint each candidate
   * carries (defaults to 0 which means "always-eligible"). Tests set
   * `ageDays` on candidates that should be filtered out.
   */
  cronContextCandidates: Array<{ id: string; summary: string; detail?: string | null; ageDays?: number }>
}

function freshState(): StoreState {
  return {
    memoriesWithMetrics: [],
    scores: new Map(),
    deleted: new Set(),
    updates: [],
    soulSynthInput: new Map(),
    soulWrites: [],
    soulReads: new Map(),
    domainUpserts: [],
    domainPrunes: [],
    logs: [],
    cronContextCandidates: [],
  }
}

function mem(partial: Partial<MemoryWithMetrics> & { id: string; summary: string }): MemoryWithMetrics {
  return {
    id: partial.id,
    scope: partial.scope ?? 'shared',
    summary: partial.summary,
    detail: partial.detail ?? null,
    tags: partial.tags ?? [],
    confidence: partial.confidence ?? 0.8,
    sensitivity: partial.sensitivity ?? 'internal',
    assistantId: partial.assistantId ?? 'a1',
    userId: partial.userId ?? 'u1',
    appId: partial.appId ?? null,
    recallCount: partial.recallCount ?? 0,
    usefulRecallCount: partial.usefulRecallCount ?? 0,
    uniqueQueries: partial.uniqueQueries ?? 0,
    recallDays: partial.recallDays ?? 0,
    ageDays: partial.ageDays ?? 0,
    createdAt: partial.createdAt ?? new Date(),
  }
}

function makeFakeStore(state: StoreState): MemoryStore {
  const notImpl = () => { throw new Error('not used by Deep phase') }
  return {
    create: notImpl as never,
    async update(id, u) {
      state.updates.push({ id, summary: u.summary, detail: u.detail })
      return null
    },
    getById: notImpl as never,
    getByIdSystem: notImpl as never,
    search: notImpl as never,
    getIdentity: notImpl as never,
    getIndex: notImpl as never,
    getIndexSystem: notImpl as never,
    getWorkspaceIndexSystem: notImpl as never,
    getIndexRanked: notImpl as never,
    trackRecall: notImpl as never,
    trackRecallOutcome: notImpl as never,
    getWorkspaceIdentity: notImpl as never,
    getWorkspaceIndex: notImpl as never,
    getWorkspaceMemoriesByCategory: notImpl as never,
    searchTeam: notImpl as never,
    listWorkspaceMemoryGroups: notImpl as never,
    listTeamWithMetrics: notImpl as never,
    getLastWorkspacePhaseAt: notImpl as never,
    logWorkspaceConsolidation: notImpl as never,
    count: notImpl as never,
    listForReflection: notImpl as never,
    listOpenCommitments: notImpl as never,

    async listWithMetrics() {
      return state.memoriesWithMetrics.filter((m) => !state.deleted.has(m.id))
    },
    async writeConsolidationScore(id, score, boostConfidence) {
      state.scores.set(id, { score, boosted: boostConfidence })
    },
    async deleteMemory(id) {
      state.deleted.add(id)
    },
    async listForSoulSynthesis(_a, _u, appId) {
      const key = appId ?? '__shared__'
      return state.soulSynthInput.get(key) ?? { selfEntityAttributes: null, preferences: [] }
    },
    async upsertSoul(_a, _u, appId, content) {
      state.soulWrites.push({ appId, content })
    },
    async getSoul(_a, _u, appId) {
      const key = appId ?? '__shared__'
      return state.soulReads.get(key) ?? null
    },
    async upsertDomainSummary(params) {
      state.domainUpserts.push({
        appId: params.appId ?? null,
        domain: params.domain,
        summary: params.summary,
        memoryIds: params.memoryIds,
      })
    },
    async pruneStaleDomainSummaries(_a, _u, appId, keepDomains) {
      state.domainPrunes.push({ appId, keep: keepDomains })
      return 0
    },
    async logConsolidation(params) {
      state.logs.push({
        phase: params.phase,
        summary: params.summary,
        memoriesAffected: params.memoriesAffected,
      })
    },
    async listMemoryUsers() { return [] },
    async getLastPhaseAt() { return null },
    async hasRecentActivity() { return true },
    async listCronContextCandidatesForPrune(_a, _u, minAgeDays) {
      return state.cronContextCandidates
        .filter((c) => (c.ageDays ?? 0) >= minAgeDays)
        .filter((c) => !state.deleted.has(c.id))
        .map((c) => ({ id: c.id, summary: c.summary, detail: c.detail ?? null }))
    },
  }
}

// ── Tests ────────────────────────────────────────────────────

describe('[COMP:consolidation/deep-orchestrator] runDeepConsolidation — scoring + pruning', () => {
  let state: StoreState
  let store: MemoryStore

  beforeEach(() => {
    state = freshState()
    store = makeFakeStore(state)
  })

  it('scores every memory and persists the result', async () => {
    state.memoriesWithMetrics = [
      mem({ id: 'm1', summary: 'fresh memory', ageDays: 2, recallCount: 1 }),
      mem({ id: 'm2', summary: 'older memory', ageDays: 10, recallCount: 0 }),
    ]

    await runDeepConsolidation(store, 'a1', 'u1', async () => 'NO_SOUL')

    expect(state.scores.size).toBe(2)
    expect(state.scores.get('m1')!.score).toBeGreaterThan(0)
    expect(state.scores.get('m2')!.score).toBeGreaterThan(0)
  })

  it('promotes confidence on high-scoring memories', async () => {
    state.memoriesWithMetrics = [
      mem({
        id: 'hot',
        summary: 'popular',
        recallCount: 20,
        usefulRecallCount: 15,
        uniqueQueries: 10,
        recallDays: 10,
        ageDays: 1,
        tags: ['food', 'preference', 'restaurants', 'cantonese', 'budget', 'vegetarian'],
      }),
    ]

    await runDeepConsolidation(store, 'a1', 'u1', async () => 'NO_SOUL')

    expect(state.scores.get('hot')!.boosted).toBe(true)
  })

  it('prunes memories scoring below 0.3 that are older than 30 days', async () => {
    state.memoriesWithMetrics = [
      mem({ id: 'stale', summary: 'never recalled', ageDays: 60, recallCount: 0 }),
    ]

    await runDeepConsolidation(store, 'a1', 'u1', async () => 'NO_SOUL')

    expect(state.deleted.has('stale')).toBe(true)
    const log = state.logs.find((l) => l.phase === 'deep')
    expect(log?.memoriesAffected).toContain('stale')
  })

  // Post-Phase-4 (retire-memory-type): identity is no longer a memory
  // type — it lives on the user's self entity attributes. The
  // "never prune identity" guard in Deep consolidation is therefore
  // dead code; the equivalent invariant is "self entity attributes
  // aren't subject to memory consolidation at all" (entities are a
  // separate primitive). Test deleted as the contract it asserted is
  // gone. (See docs/architecture/context-engine/memory-system.md.)

  it('does not prune low-scoring memories younger than 30 days', async () => {
    state.memoriesWithMetrics = [
      mem({ id: 'young', summary: 'fresh but unused', ageDays: 10, recallCount: 0 }),
    ]

    await runDeepConsolidation(store, 'a1', 'u1', async () => 'NO_SOUL')

    expect(state.deleted.has('young')).toBe(false)
  })

  it('respects custom prune thresholds', async () => {
    state.memoriesWithMetrics = [
      mem({ id: 'borderline', summary: 'medium score', ageDays: 5, recallCount: 0 }),
    ]

    await runDeepConsolidation(store, 'a1', 'u1', async () => 'NO_SOUL', {
      pruneAfterDays: 1,
      pruneScoreThreshold: 0.5,
    })

    expect(state.deleted.has('borderline')).toBe(true)
  })
})

describe('[COMP:consolidation/deep-orchestrator] runDeepConsolidation — cron-source operational prune', () => {
  let state: StoreState
  let store: MemoryStore

  beforeEach(() => {
    state = freshState()
    store = makeFakeStore(state)
  })

  it('prunes cron-context memories whose summary matches operational patterns', async () => {
    state.cronContextCandidates = [
      { id: 'op1', summary: 'Pill reminder active (April 22) - 30m overdue, 2nd follow-up sent', ageDays: 14 },
      { id: 'op2', summary: 'Pill reminder active (April 22) - 150m overdue, 10th follow-up sent', ageDays: 14 },
      { id: 'op3', summary: 'Awaiting confirmation for the morning pill', ageDays: 14 },
    ]

    await runDeepConsolidation(store, 'a1', 'u1', async () => 'NO_SOUL')

    expect(state.deleted.has('op1')).toBe(true)
    expect(state.deleted.has('op2')).toBe(true)
    expect(state.deleted.has('op3')).toBe(true)
  })

  it('does NOT prune cron-context memories with non-operational summaries', async () => {
    state.cronContextCandidates = [
      { id: 'durable', summary: 'User mentioned visiting Tokyo last March', ageDays: 30 },
      { id: 'noisy', summary: '2nd follow-up sent at 14:30', ageDays: 30 },
    ]

    await runDeepConsolidation(store, 'a1', 'u1', async () => 'NO_SOUL')

    expect(state.deleted.has('durable')).toBe(false)
    expect(state.deleted.has('noisy')).toBe(true)
  })

  it('respects the cronOpPruneAgeDays gate (does not prune candidates younger than the gate)', async () => {
    state.cronContextCandidates = [
      // ageDays=3 is below the explicit gate of 7 — fake's filter drops it.
      { id: 'fresh', summary: '3rd follow-up sent', ageDays: 3 },
      { id: 'aged', summary: '3rd follow-up sent', ageDays: 14 },
    ]

    await runDeepConsolidation(store, 'a1', 'u1', async () => 'NO_SOUL', {
      cronOpPruneAgeDays: 7,
    })

    expect(state.deleted.has('fresh')).toBe(false)
    expect(state.deleted.has('aged')).toBe(true)
  })

  it('skips the operational prune when cronOpPruneDisabled is true', async () => {
    state.cronContextCandidates = [
      { id: 'op', summary: '5th follow-up sent', ageDays: 30 },
    ]

    await runDeepConsolidation(store, 'a1', 'u1', async () => 'NO_SOUL', {
      cronOpPruneDisabled: true,
    })

    expect(state.deleted.has('op')).toBe(false)
  })

  it('emits opPruned in the consolidation_completed event', async () => {
    state.cronContextCandidates = [
      { id: 'op1', summary: '2nd follow-up sent', ageDays: 14 },
      { id: 'op2', summary: '150m overdue', ageDays: 14 },
    ]
    let opPrunedCount: number | undefined
    await runDeepConsolidation(store, 'a1', 'u1', async () => 'NO_SOUL', {
      onEvent: (e) => {
        if (e.type === 'consolidation_completed' && e.phase === 'deep') {
          opPrunedCount = e.opPruned
        }
      },
    })

    expect(opPrunedCount).toBe(2)
  })

  // ── Detail-field scan ───────────────────────────────────────
  // A benign summary ("Pill reminder completed") can still carry
  // operational phrasing in `detail` ("2.5 hours overdue"). The 2026-04-23
  // Cynthia incident was the model pattern-matching that detail text
  // onto today's clock — so the prune must scan detail too, not just
  // summary. See `docs/architecture/context-engine/memory-consolidation.md`.
  it('prunes rows whose operational phrasing lives in `detail`, not `summary`', async () => {
    state.cronContextCandidates = [
      {
        id: 'sneaky',
        summary: 'Pill reminder completed (April 22)',
        detail:
          'Pill reminder for April 22 completed at 4:35 PM HKT (8:35 AM UTC). 2.5 hours overdue.',
        ageDays: 1,
      },
      {
        id: 'clean',
        summary: 'Pill reminder completed (April 22)',
        detail: 'Pill reminder for April 22 completed at 4:35 PM HKT.',
        ageDays: 1,
      },
    ]

    await runDeepConsolidation(store, 'a1', 'u1', async () => 'NO_SOUL')

    expect(state.deleted.has('sneaky')).toBe(true)
    expect(state.deleted.has('clean')).toBe(false)
  })
})

describe('[COMP:consolidation/deep-orchestrator] runDeepConsolidation — SOUL synthesis', () => {
  let state: StoreState
  let store: MemoryStore

  beforeEach(() => {
    state = freshState()
    store = makeFakeStore(state)
  })

  it('synthesises and writes the shared SOUL from self-entity attributes + preferences', async () => {
    state.soulSynthInput.set('__shared__', {
      selfEntityAttributes: { diet: 'Vegetarian' },
      preferences: [{ id: 'p1', scope: 'shared', summary: 'Prefers tea', detail: null, tags: [], confidence: 1, sensitivity: 'internal' }],
    })

    let prompt = ''
    await runDeepConsolidation(store, 'a1', 'u1', async (p) => {
      prompt = p
      return 'Be concise. User is a vegetarian tea drinker. No emojis.'
    })

    expect(prompt).toContain('Vegetarian')
    expect(prompt).toContain('Prefers tea')
    expect(state.soulWrites).toHaveLength(1)
    expect(state.soulWrites[0].appId).toBe(null)
    expect(state.soulWrites[0].content).toContain('vegetarian')
  })

  it('skips SOUL write when the model returns NO_SOUL', async () => {
    state.soulSynthInput.set('__shared__', {
      selfEntityAttributes: { name: 'User' },
      preferences: [],
    })

    await runDeepConsolidation(store, 'a1', 'u1', async () => 'NO_SOUL')

    expect(state.soulWrites).toHaveLength(0)
  })

  it('synthesises per-app SOUL deltas when appIds are provided', async () => {
    state.soulSynthInput.set('__shared__', {
      selfEntityAttributes: { role: 'Senior dev' },
      preferences: [],
    })
    state.soulSynthInput.set('sidantrip', {
      selfEntityAttributes: null,
      preferences: [{ id: 'p1', scope: 'app', summary: 'HKD budget', detail: null, tags: [], confidence: 1, sensitivity: 'internal' }],
    })

    const prompts: string[] = []
    await runDeepConsolidation(store, 'a1', 'u1', async (p) => {
      prompts.push(p)
      return 'Technical style. Direct.'
    }, { appIds: ['sidantrip'] })

    // Shared prompt + app prompt = 2 LLM calls.
    expect(prompts.length).toBe(2)
    expect(state.soulWrites.map((w) => w.appId).sort()).toEqual([null, 'sidantrip'])

    // The app-scoped prompt should include the shared SOUL to deduplicate.
    const appPrompt = prompts[1]
    expect(appPrompt).toContain('SHARED SOUL')
  })

  it('fires soul_updated events with change magnitude', async () => {
    state.soulSynthInput.set('__shared__', {
      selfEntityAttributes: { name: 'User' },
      preferences: [],
    })
    state.soulReads.set('__shared__', 'old soul')

    const events: Array<{ type: string; changeMagnitude?: number }> = []
    await runDeepConsolidation(store, 'a1', 'u1', async () => 'new soul paragraph', {
      onEvent: (e) => events.push(e as typeof events[number]),
    })

    const soulUpdated = events.find((e) => e.type === 'soul_updated')
    expect(soulUpdated).toBeDefined()
    expect(soulUpdated!.changeMagnitude).toBeGreaterThan(0)
  })
})

describe('[COMP:consolidation/deep-orchestrator] runDeepConsolidation — domain summary generation', () => {
  let state: StoreState
  let store: MemoryStore

  beforeEach(() => {
    state = freshState()
    store = makeFakeStore(state)
  })

  it('does not run domain summary generation below the threshold', async () => {
    state.memoriesWithMetrics = Array.from({ length: 10 }, (_, i) =>
      mem({ id: `m${i}`, summary: `memory ${i}`, tags: ['food'] }),
    )

    await runDeepConsolidation(store, 'a1', 'u1', async () => 'NO_SOUL', {
      domainSummaryThreshold: 50,
    })

    expect(state.domainUpserts).toHaveLength(0)
  })

  it('summarises domains once the threshold is crossed', async () => {
    state.memoriesWithMetrics = [
      mem({ id: 'f1', summary: 'vegetarian restaurants', tags: ['food'] }),
      mem({ id: 'f2', summary: 'no dairy', tags: ['food'] }),
      mem({ id: 't1', summary: 'tokyo window seat', tags: ['travel'] }),
      mem({ id: 't2', summary: 'budget hotels', tags: ['travel'] }),
    ]

    const summaryText = 'User is a vegetarian with specific food preferences.'
    await runDeepConsolidation(store, 'a1', 'u1', async () => summaryText, {
      domainSummaryThreshold: 2,
    })

    const domains = state.domainUpserts.map((u) => u.domain).sort()
    expect(domains).toEqual(['food', 'travel'])

    // Stale rows for domains not in this run should have been pruned.
    expect(state.domainPrunes).toHaveLength(1)
    expect(state.domainPrunes[0].keep.sort()).toEqual(['food', 'travel'])
  })

  it('buckets domains by tag (post-Phase-4: identity no longer a special case)', async () => {
    // Post-Phase-4 (retire-memory-type): no identity-type guard. All
    // memories bucket by their first tag; what matters is the food
    // bucket lands a domain summary.
    state.memoriesWithMetrics = [
      mem({ id: 'i1', summary: 'A self-profile-tagged row', tags: ['self-profile'] }),
      mem({ id: 'f1', summary: 'indian food', tags: ['food'] }),
      mem({ id: 'f2', summary: 'spicy ok', tags: ['food'] }),
    ]

    await runDeepConsolidation(store, 'a1', 'u1', async () => 'gist of food', {
      domainSummaryThreshold: 2,
    })

    const domains = state.domainUpserts.map((u) => u.domain)
    expect(domains).toContain('food')
  })
})

describe('[COMP:consolidation/deep-orchestrator] runDeepConsolidation — logging', () => {
  it('writes a consolidation_logs row with phase=deep even when nothing changed', async () => {
    const state = freshState()
    const store = makeFakeStore(state)

    await runDeepConsolidation(store, 'a1', 'u1', async () => 'NO_SOUL')

    expect(state.logs).toHaveLength(1)
    expect(state.logs[0].phase).toBe('deep')
    expect(state.logs[0].summary).toContain('Scored 0')
  })
})

describe('[COMP:consolidation/deep-orchestrator] runDeepConsolidation — LLM dedup sweep', () => {
  let state: StoreState
  let store: MemoryStore

  beforeEach(() => {
    state = freshState()
    store = makeFakeStore(state)
  })

  /** Build a bunch of filler memories that fit the same (tag, sensitivity) bucket.
   *  Post-Phase-4 (retire-memory-type): bucketing is by first tag, so we
   *  put the same tag on every filler row to keep them in one bucket. */
  function fillerBucket(count: number, tag = 'context'): MemoryWithMetrics[] {
    return Array.from({ length: count }, (_, i) =>
      mem({
        id: `f${i}`,
        tags: [tag],
        summary: `Filler about topic ${i} with different words`,
        ageDays: 1,
        recallCount: 5,
        usefulRecallCount: 3,
        uniqueQueries: 2,
        recallDays: 2,
      }),
    )
  }

  it('skips the sweep when total memory count is below dedupSweepMinTotal', async () => {
    state.memoriesWithMetrics = fillerBucket(5)
    let called = false
    await runDeepConsolidation(store, 'a1', 'u1', async (p) => {
      if (p.includes('Review these memories')) called = true
      return 'NO_SOUL'
    }, { dedupSweepMinTotal: 10 })
    expect(called).toBe(false)
    expect(state.updates).toHaveLength(0)
    expect(state.deleted.size).toBe(0)
  })

  it('skips per-bucket calls when group is below dedupSweepMinGroup', async () => {
    // 10 total memories spread across 5 tag-buckets — each bucket has 2.
    state.memoriesWithMetrics = Array.from({ length: 10 }, (_, i) =>
      mem({ id: `m${i}`, tags: [`t${i % 5}`], summary: `s${i}`, ageDays: 1, recallCount: 5, usefulRecallCount: 3 }),
    )
    let calls = 0
    await runDeepConsolidation(store, 'a1', 'u1', async (p) => {
      if (p.includes('Review these memories')) calls++
      return 'NO_CLUSTERS'
    }, { dedupSweepMinTotal: 5, dedupSweepMinGroup: 3 })
    expect(calls).toBe(0)
  })

  it('merges duplicate clusters — updates keeper, deletes merged', async () => {
    state.memoriesWithMetrics = fillerBucket(3)
    const response = [
      'KEEP: f0',
      'MERGE: f1, f2',
      'COMBINED_SUMMARY: Consolidated hook',
      'COMBINED_DETAIL: Full merged explanation with specifics',
    ].join('\n')
    await runDeepConsolidation(store, 'a1', 'u1', async (p) => {
      if (p.includes('Review these memories')) return response
      return 'NO_SOUL'
    }, { dedupSweepMinTotal: 3, dedupSweepMinGroup: 3 })

    expect(state.updates).toHaveLength(1)
    expect(state.updates[0].id).toBe('f0')
    expect(state.updates[0].summary).toBe('Consolidated hook')
    expect(state.updates[0].detail).toContain('Full merged explanation')
    expect(state.deleted.has('f1')).toBe(true)
    expect(state.deleted.has('f2')).toBe(true)
  })

  it('handles NO_CLUSTERS response by doing nothing', async () => {
    state.memoriesWithMetrics = fillerBucket(4)
    await runDeepConsolidation(store, 'a1', 'u1', async (p) => {
      if (p.includes('Review these memories')) return 'NO_CLUSTERS'
      return 'NO_SOUL'
    }, { dedupSweepMinTotal: 3, dedupSweepMinGroup: 3 })
    expect(state.updates).toHaveLength(0)
    expect(state.deleted.size).toBe(0)
  })

  // Post-Phase-4 (retire-memory-type): the dedup sweep no longer
  // has an "identity" skip — identity facts live on entities, not
  // memories. The sweep operates uniformly across all memory tags.
  // Test deleted as the contract it asserted is gone.

  it('reports merge count in the final summary and event', async () => {
    state.memoriesWithMetrics = fillerBucket(4)
    const events: Array<{ type: string; merged?: number }> = []
    const response = [
      'KEEP: f0',
      'MERGE: f1',
      'COMBINED_SUMMARY: Hook',
      'COMBINED_DETAIL: Detail',
    ].join('\n')
    await runDeepConsolidation(store, 'a1', 'u1', async (p) => {
      if (p.includes('Review these memories')) return response
      return 'NO_SOUL'
    }, {
      dedupSweepMinTotal: 3,
      dedupSweepMinGroup: 3,
      onEvent: (e) => events.push(e as typeof events[number]),
    })
    const log = state.logs.find((l) => l.phase === 'deep')
    expect(log?.summary).toContain('merged 1')
    const completed = events.find((e) => e.type === 'consolidation_completed')
    expect(completed?.merged).toBe(1)
  })

  it('does not merge across sensitivity tiers even if model asks', async () => {
    state.memoriesWithMetrics = [
      mem({ id: 's1', summary: 'public thing', sensitivity: 'public', ageDays: 1, recallCount: 5, usefulRecallCount: 3 }),
      mem({ id: 's2', summary: 'confidential thing', sensitivity: 'confidential', ageDays: 1, recallCount: 5, usefulRecallCount: 3 }),
      mem({ id: 's3', summary: 'another confidential', sensitivity: 'confidential', ageDays: 1, recallCount: 5, usefulRecallCount: 3 }),
    ]
    // Bucketing splits these into (context, public)=[s1] and (context,confidential)=[s2, s3].
    // Neither bucket hits minGroupSize=3, so no LLM call happens. This test
    // verifies the bucketing itself, not cross-tier rejection.
    let calls = 0
    await runDeepConsolidation(store, 'a1', 'u1', async (p) => {
      if (p.includes('Review these memories')) calls++
      return 'NO_CLUSTERS'
    }, { dedupSweepMinTotal: 3, dedupSweepMinGroup: 3 })
    expect(calls).toBe(0)
    expect(state.deleted.size).toBe(0)
  })
})

describe('[COMP:consolidation/deep-orchestrator] bucketDomains', () => {
  it('caps domains at maxDomains and lumps overflow into "other"', () => {
    const memories: MemoryWithMetrics[] = Array.from({ length: 5 }, (_, i) =>
      mem({ id: `m${i}`, summary: `memory ${i}`, tags: [`tag${i}`] }),
    )

    const bucketed = bucketDomains(memories, 3)

    expect(bucketed.size).toBeLessThanOrEqual(3)
    expect(bucketed.has('other')).toBe(true)
  })

  it('buckets untagged memories into the `untagged` bucket', () => {
    // Post-Phase-4 (retire-memory-type): no `type` fallback. Untagged
    // memories share the 'untagged' bucket.
    const memories = [
      mem({ id: 'm1', summary: 'a', tags: [] }),
      mem({ id: 'm2', summary: 'b', tags: [] }),
    ]

    const bucketed = bucketDomains(memories, 10)

    expect(bucketed.has('untagged')).toBe(true)
    expect(bucketed.get('untagged')).toHaveLength(2)
  })
})
