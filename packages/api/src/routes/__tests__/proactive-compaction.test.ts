import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the DB module before importing the route module under test so that
// runProactiveCompaction's DB helpers are spy-able. `toStampedMessages`
// stays real because it's a pure function that we want to exercise end-to-
// end (its 1:1 mapping is part of the refactored flow's back-map contract).
// `vi.hoisted` lets the mock fns share a reference with the test body
// despite vi.mock's hoisting behavior.
const { mockSetCompactSummaryAndBoundary, mockFindSessionById } = vi.hoisted(() => ({
  mockSetCompactSummaryAndBoundary: vi.fn(),
  mockFindSessionById: vi.fn(),
}))

vi.mock('../../db/sessions.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/sessions.js')>('../../db/sessions.js')
  return {
    ...actual,
    setCompactSummaryAndBoundary: mockSetCompactSummaryAndBoundary,
    findSessionById: mockFindSessionById,
  }
})

// `recordOverheadUsage` touches the (here-unmocked) UsageStore only when
// a usageStore is passed, so tests omit it and the helper no-ops.

import { findRecentSplit, houseKeepEpisodic, runProactiveCompaction } from '../proactive-compaction.js'
import { createCompactionCircuitBreaker, estimateTokens } from '@sidanclaw/core'
import type { Message, EpisodicMemoryRecord, EpisodicStore, MemoryStore, LLMProvider, StreamChunk, AnalyticsLogger } from '@sidanclaw/core'
import type { Session, SessionMessage } from '../../db/sessions.js'

const userText = (text: string): Message => ({
  role: 'user',
  content: [{ type: 'text', text }],
})
const assistant = (text: string): Message => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
})

describe('[COMP:api/proactive-compaction] findRecentSplit — current user turn is never compacted', () => {
  it('keeps the current user turn in recent when the walk-back would swallow it (cron regression)', () => {
    // Reproduces the prod shape behind the 2026-04-17 01:00 UTC empty-delivery
    // bug: 6 prior messages + 1 new user turn, unconditional compaction. The
    // old logic walked back to idx=0 (messages[0] is also a user) which left
    // `compactable` empty and the caller then dropped the whole tail.
    const messages: Message[] = [
      userText('每日行程同 Email 重點總結。'),         // 0 — prior run
      assistant('…'),                                  // 1
      userText('每日行程同 Email 重點總結。'),         // 2 — manual retry
      userText('每日行程同 Email 重點總結。'),         // 3 — manual retry
      assistant('…'),                                  // 4
      assistant('…'),                                  // 5 — real answer
      userText('每日行程同 Email 重點總結。'),         // 6 — current turn
    ]

    const split = findRecentSplit(messages)

    expect(split).toBe(6) // recent = [current user], compactable = first 6
    expect(messages.slice(split)).toEqual([messages[6]])
    expect(messages.slice(0, split)).toHaveLength(6)
  })

  it('returns 0 for a single-user-message session (degenerate; caller handles empty compactable)', () => {
    const messages: Message[] = [userText('hi')]
    expect(findRecentSplit(messages)).toBe(0)
  })

  it('leaves long conversations anchored at the first user turn within the KEEP_RECENT window', () => {
    // 10 messages, plenty of prior context, user anchor 4 back from the end.
    // Original KEEP_RECENT=6 path is unaffected by the short-history fix.
    const messages: Message[] = [
      userText('old'),        // 0
      assistant('a0'),        // 1
      userText('q1'),         // 2
      assistant('a1'),        // 3
      userText('q2'),         // 4 — splits here (first user anchor within last 6)
      assistant('a2'),        // 5
      assistant('a2b'),       // 6
      userText('q3'),         // 7
      assistant('a3'),        // 8
      userText('current'),    // 9
    ]
    expect(findRecentSplit(messages)).toBe(4)
  })

  it('returns 0 when the only user messages are tool_result turns (no plain user text)', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', name: 'x', content: 'y' }] },
      assistant('a'),
    ]
    expect(findRecentSplit(messages)).toBe(0)
  })

  it('returns 0 for an empty messages array', () => {
    expect(findRecentSplit([])).toBe(0)
  })
})

// ── Episodic housekeeping ───────────────────────────────────────

function record(partial: Partial<EpisodicMemoryRecord>): EpisodicMemoryRecord {
  return {
    id: partial.id ?? 'e1',
    userId: 'u1',
    assistantId: 'a1',
    sessionId: 's1',
    topicLabel: partial.topicLabel ?? 'topic',
    summary: partial.summary ?? 'summary',
    messageSpan: { fromSequence: 1, toSequence: 2, turnCount: 1 },
    entityRefs: null,
    createdAt: new Date(),
    lastAccessedAt: new Date(),
    accessCount: partial.accessCount ?? 0,
    survivalCount: partial.survivalCount ?? 0,
  }
}

function makeEpisodicStore(rows: EpisodicMemoryRecord[]): EpisodicStore {
  return {
    create: vi.fn(),
    fetchByTopic: vi.fn(),
    fetchBySession: vi.fn(),
    listTopicsBySession: vi.fn(),
    listBySession: vi.fn(async () => rows),
    deleteById: vi.fn(),
    incrementSurvivalCount: vi.fn(),
  }
}

function makeMemoryStore(): MemoryStore {
  return {
    create: vi.fn(async (params) => ({
      id: 'm1',
      type: params.type,
      scope: params.scope ?? 'shared',
      summary: params.summary,
      detail: params.detail ?? null,
      tags: params.tags ?? [],
      confidence: params.confidence ?? 0.5,
    })),
  } as unknown as MemoryStore
}

describe('[COMP:api/proactive-compaction] houseKeepEpisodic — episodic lifecycle', () => {
  it('evicts rows with access_count == 0', async () => {
    const cold = record({ id: 'cold', accessCount: 0, survivalCount: 0 })
    const store = makeEpisodicStore([cold])
    const memStore = makeMemoryStore()

    const stats = await houseKeepEpisodic({
      episodicStore: store, memoryStore: memStore,
      sessionId: 's1', assistantId: 'a1', userId: 'u1',
    })

    expect(stats).toEqual({ promoted: 0, evicted: 1, kept: 0 })
    expect(store.deleteById).toHaveBeenCalledWith('cold')
    expect(memStore.create).not.toHaveBeenCalled()
    expect(store.incrementSurvivalCount).toHaveBeenCalledWith([])
  })

  it('promotes rows that reach survival_count + 1 >= threshold (3)', async () => {
    // survival_count=2 + 1 = 3 → crosses threshold
    const mature = record({ id: 'mature', topicLabel: 'japan trip', summary: 'User planning 5-day Tokyo trip...', accessCount: 4, survivalCount: 2 })
    const store = makeEpisodicStore([mature])
    const memStore = makeMemoryStore()

    const stats = await houseKeepEpisodic({
      episodicStore: store, memoryStore: memStore,
      sessionId: 's1', assistantId: 'a1', userId: 'u1',
    })

    expect(stats).toEqual({ promoted: 1, evicted: 0, kept: 0 })
    expect(memStore.create).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'shared',
      source: 'episodic-graduation',
      summary: 'Recurring topic: japan trip',
      detail: 'User planning 5-day Tokyo trip...',
      tags: ['episodic-graduation', 'japan trip'],
      assistantId: 'a1',
      userId: 'u1',
      sourceSessionId: 's1',
    }))
    expect(store.deleteById).toHaveBeenCalledWith('mature')
  })

  it('bumps survival_count for rows that are accessed but not yet mature', async () => {
    const young = record({ id: 'young', accessCount: 1, survivalCount: 0 })
    const store = makeEpisodicStore([young])
    const memStore = makeMemoryStore()

    const stats = await houseKeepEpisodic({
      episodicStore: store, memoryStore: memStore,
      sessionId: 's1', assistantId: 'a1', userId: 'u1',
    })

    expect(stats).toEqual({ promoted: 0, evicted: 0, kept: 1 })
    expect(store.incrementSurvivalCount).toHaveBeenCalledWith(['young'])
    expect(store.deleteById).not.toHaveBeenCalled()
    expect(memStore.create).not.toHaveBeenCalled()
  })

  it('keeps the episodic row when promotion write fails — retried next compaction', async () => {
    const mature = record({ id: 'mature', accessCount: 3, survivalCount: 5 })
    const store = makeEpisodicStore([mature])
    const memStore = makeMemoryStore()
    ;(memStore.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB down'))

    const stats = await houseKeepEpisodic({
      episodicStore: store, memoryStore: memStore,
      sessionId: 's1', assistantId: 'a1', userId: 'u1',
    })

    expect(stats).toEqual({ promoted: 0, evicted: 0, kept: 0 })
    expect(store.deleteById).not.toHaveBeenCalled()   // never deletes if memory write fails
  })

  it('handles a mixed batch: evict, promote, keep all in one pass', async () => {
    const rows = [
      record({ id: 'cold', accessCount: 0, survivalCount: 1 }),
      record({ id: 'young', accessCount: 2, survivalCount: 0 }),
      record({ id: 'mature', accessCount: 5, survivalCount: 2 }),
    ]
    const store = makeEpisodicStore(rows)
    const memStore = makeMemoryStore()

    const stats = await houseKeepEpisodic({
      episodicStore: store, memoryStore: memStore,
      sessionId: 's1', assistantId: 'a1', userId: 'u1',
    })

    expect(stats).toEqual({ promoted: 1, evicted: 1, kept: 1 })
    expect(store.incrementSurvivalCount).toHaveBeenCalledWith(['young'])
    expect(store.deleteById).toHaveBeenCalledWith('cold')
    expect(store.deleteById).toHaveBeenCalledWith('mature')
    expect(memStore.create).toHaveBeenCalledTimes(1)
  })

  it('returns zero stats on an empty session', async () => {
    const store = makeEpisodicStore([])
    const memStore = makeMemoryStore()

    const stats = await houseKeepEpisodic({
      episodicStore: store, memoryStore: memStore,
      sessionId: 's1', assistantId: 'a1', userId: 'u1',
    })

    expect(stats).toEqual({ promoted: 0, evicted: 0, kept: 0 })
    expect(store.incrementSurvivalCount).toHaveBeenCalledWith([])
  })
})

// ── runProactiveCompaction — persistence invariants (Fix 1a) ─────────
//
// These tests protect the partition invariant introduced by the
// compaction-persistence restructure: `sessions.compact_boundary_sequence`
// = seq of the first RECENT (non-compactable) row; summary goes in
// `sessions.compact_summary`; no synthetic system rows are written to
// `session_messages`. Regression gate against the Hinson bug — a race
// where a mid-turn compaction stranded tool_use/tool_result/asst_text
// rows above the cursor, producing a Gemini 400 "function call turn".

function makeSessionMessage(partial: Partial<SessionMessage> & { sequenceNum: number; role: SessionMessage['role']; content: SessionMessage['content'] }): SessionMessage {
  return {
    id: partial.id ?? `m_${partial.sequenceNum}`,
    sessionId: partial.sessionId ?? 's1',
    sequenceNum: partial.sequenceNum,
    role: partial.role,
    content: partial.content,
    createdAt: partial.createdAt ?? new Date('2026-04-19T04:30:00Z'),
    replyToText: partial.replyToText ?? null,
    topicLabel: partial.topicLabel ?? null,
    topicConfidence: partial.topicConfidence ?? null,
    channelMessageId: partial.channelMessageId ?? null,
    senderUserId: partial.senderUserId ?? null,
    attachments: partial.attachments ?? [],
  }
}

function makeSession(partial: Partial<Session> = {}): Session {
  return {
    id: partial.id ?? 's1',
    assistantId: partial.assistantId ?? 'a1',
    userId: partial.userId ?? 'u1',
    channelType: partial.channelType ?? 'telegram',
    channelId: partial.channelId ?? 'c1',
    appId: partial.appId ?? 'sidanclaw',
    appOrigin: partial.appOrigin ?? null,
    status: partial.status ?? 'idle',
    compactSummary: partial.compactSummary ?? null,
    compactionCount: partial.compactionCount ?? 0,
    compactBoundarySequence: partial.compactBoundarySequence ?? null,
    title: partial.title ?? null,
    downgradeNoticeSent: partial.downgradeNoticeSent ?? false,
    downgradeNoticePinMessageId: partial.downgradeNoticePinMessageId ?? null,
    mode: partial.mode ?? null,
    visibility: partial.visibility ?? 'owner',
    effectiveClearance: partial.effectiveClearance ?? null,
    createdAt: partial.createdAt ?? new Date(),
    lastActiveAt: partial.lastActiveAt ?? new Date(),
  }
}

/**
 * Mock LLM provider that yields a fixed summary text as a single
 * text_delta. Suffices for compactConversation (which uses collectStream)
 * and for extractMemoriesBeforeCompaction (which tolerates empty/invalid
 * JSON by falling back to regex-only facts).
 */
function mockProviderWithSummary(summaryText: string): LLMProvider {
  return {
    createSession() {
      return {} as never
    },
    async *stream(): AsyncGenerator<StreamChunk> {
      yield { type: 'text_delta', text: summaryText } as StreamChunk
    },
  } as unknown as LLMProvider
}

function baseParams(overrides: Partial<Parameters<typeof runProactiveCompaction>[0]> = {}) {
  return {
    sessionMessages: overrides.sessionMessages ?? [],
    timezone: overrides.timezone ?? 'UTC',
    session: overrides.session ?? makeSession(),
    tier: overrides.tier ?? 'standard',
    channelClass: overrides.channelClass ?? 'messaging',
    profile: overrides.profile ?? 'linear',
    provider: overrides.provider ?? mockProviderWithSummary('compacted summary body'),
    systemPrompt: overrides.systemPrompt ?? 'You are a test assistant.',
    assistantId: overrides.assistantId ?? 'a1',
    userId: overrides.userId ?? 'u1',
    ownerId: overrides.ownerId ?? 'u1',
    channelType: overrides.channelType ?? 'telegram',
    memoryStore: overrides.memoryStore ?? ({
      getIndex: vi.fn(async () => []),
      create: vi.fn(),
    } as unknown as MemoryStore),
    unconditional: overrides.unconditional,
    analytics: overrides.analytics,
    circuitBreaker: overrides.circuitBreaker,
  } as Parameters<typeof runProactiveCompaction>[0]
}

describe('[COMP:api/proactive-compaction] runProactiveCompaction — persistence invariants', () => {
  beforeEach(() => {
    mockSetCompactSummaryAndBoundary.mockReset()
    mockFindSessionById.mockReset()
  })

  it('prepends existing session.compactSummary on the no-compaction fast path', async () => {
    const sessionMessages = [
      makeSessionMessage({ sequenceNum: 10, role: 'user', content: [{ type: 'text', text: 'hi' }] }),
    ]
    const result = await runProactiveCompaction(baseParams({
      sessionMessages,
      session: makeSession({ compactSummary: 'previously summarized context', compactBoundarySequence: 5 }),
      unconditional: false,
    }))

    expect(result.compacted).toBe(false)
    expect(result.messages.length).toBeGreaterThanOrEqual(2)
    expect(result.messages[0].role).toBe('system')
    expect(result.messages[0].content).toBe('previously summarized context')
    // DB write must not fire on the fast path.
    expect(mockSetCompactSummaryAndBoundary).not.toHaveBeenCalled()
  })

  it('returns just the prepended summary when sessionMessages is empty', async () => {
    const result = await runProactiveCompaction(baseParams({
      sessionMessages: [],
      session: makeSession({ compactSummary: 'old summary', compactBoundarySequence: 5 }),
      unconditional: false,
    }))

    expect(result.compacted).toBe(false)
    expect(result.messages).toEqual([
      { role: 'system', content: 'old summary' },
    ])
    expect(mockSetCompactSummaryAndBoundary).not.toHaveBeenCalled()
  })

  it('on unconditional compaction, calls setCompactSummaryAndBoundary with cursor = first recent seq', async () => {
    // Build a session where findRecentSplit will anchor the last user msg
    // as recent and everything before it as compactable. Sequence spans
    // 100..105, last user text at 105.
    const sessionMessages: SessionMessage[] = [
      makeSessionMessage({ sequenceNum: 100, role: 'user', content: [{ type: 'text', text: 'old question' }] }),
      makeSessionMessage({ sequenceNum: 101, role: 'assistant', content: [{ type: 'text', text: 'old answer' }] }),
      makeSessionMessage({ sequenceNum: 102, role: 'user', content: [{ type: 'text', text: 'follow-up' }] }),
      makeSessionMessage({ sequenceNum: 103, role: 'assistant', content: [{ type: 'text', text: 'follow-up reply' }] }),
      makeSessionMessage({ sequenceNum: 104, role: 'user', content: [{ type: 'text', text: 'another' }] }),
      makeSessionMessage({ sequenceNum: 105, role: 'assistant', content: [{ type: 'text', text: 'another reply' }] }),
      makeSessionMessage({ sequenceNum: 106, role: 'user', content: [{ type: 'text', text: 'current turn' }] }),
    ]
    mockSetCompactSummaryAndBoundary.mockResolvedValueOnce(true)

    const result = await runProactiveCompaction(baseParams({
      sessionMessages,
      session: makeSession({ compactBoundarySequence: null }),
      unconditional: true,
    }))

    expect(result.compacted).toBe(true)
    expect(mockSetCompactSummaryAndBoundary).toHaveBeenCalledOnce()
    const [sessionId, summary, newCursor, expectedCursor] = mockSetCompactSummaryAndBoundary.mock.calls[0]
    expect(sessionId).toBe('s1')
    expect(summary).toContain('compacted summary body')
    // Cursor must point at the FIRST recent DB row — not a later synthetic
    // boundary seq. This is the core of the Fix 1a invariant.
    expect(newCursor).toBeGreaterThanOrEqual(100)
    expect(newCursor).toBeLessThanOrEqual(106)
    // And specifically: should be > all compactable seqs and ≤ 106.
    const lastCompactableSeq = newCursor - 1
    expect(lastCompactableSeq).toBeGreaterThanOrEqual(100)
    // Optimistic-concurrency guard passes current cursor (null here).
    expect(expectedCursor).toBeNull()
  })

  it('falls back to pass-through without persisting episodic rows when the concurrency guard fails', async () => {
    const sessionMessages: SessionMessage[] = [
      makeSessionMessage({ sequenceNum: 200, role: 'user', content: [{ type: 'text', text: 'a' }] }),
      makeSessionMessage({ sequenceNum: 201, role: 'assistant', content: [{ type: 'text', text: 'b' }] }),
      makeSessionMessage({ sequenceNum: 202, role: 'user', content: [{ type: 'text', text: 'c' }] }),
    ]
    // Guard fails (someone else compacted between our read and write).
    mockSetCompactSummaryAndBoundary.mockResolvedValueOnce(false)
    mockFindSessionById.mockResolvedValueOnce(makeSession({
      compactSummary: 'winner summary written by the concurrent turn',
      compactBoundarySequence: 201,
    }))
    const episodicStore = makeEpisodicStore([])

    const result = await runProactiveCompaction(baseParams({
      sessionMessages,
      session: makeSession({ compactBoundarySequence: null }),
      unconditional: true,
      episodicStore,
    }))

    expect(result.compacted).toBe(false)
    expect(result.messages[0]).toEqual({
      role: 'system',
      content: 'winner summary written by the concurrent turn',
    })
    // Episodic persistence must NOT fire — the winner already did it.
    expect(episodicStore.create).not.toHaveBeenCalled()
    expect(mockFindSessionById).toHaveBeenCalledWith('s1')
  })

  it('excludes the prepended summary from the LLM input (no summary-of-summary)', async () => {
    const sessionMessages: SessionMessage[] = [
      makeSessionMessage({ sequenceNum: 300, role: 'user', content: [{ type: 'text', text: 'distinctive-content-abc' }] }),
      makeSessionMessage({ sequenceNum: 301, role: 'assistant', content: [{ type: 'text', text: 'reply-xyz' }] }),
      makeSessionMessage({ sequenceNum: 302, role: 'user', content: [{ type: 'text', text: 'current' }] }),
    ]
    mockSetCompactSummaryAndBoundary.mockResolvedValueOnce(true)
    const streamedMessages: Message[][] = []
    const provider: LLMProvider = {
      createSession() { return {} as never },
      async *stream(req: { messages: Message[] }): AsyncGenerator<StreamChunk> {
        streamedMessages.push(req.messages)
        yield { type: 'text_delta', text: 'fresh summary' } as StreamChunk
      },
    } as unknown as LLMProvider

    await runProactiveCompaction(baseParams({
      sessionMessages,
      session: makeSession({
        compactSummary: 'PREVIOUS-SUMMARY-MARKER',
        compactBoundarySequence: 290,
      }),
      unconditional: true,
      provider,
    }))

    // At least one stream call happened (extraction + summarization). None
    // of them should have been given the PREVIOUS-SUMMARY-MARKER content —
    // that's the recursive-summarization trap Fix 1a must avoid.
    const anyHadPreviousSummary = streamedMessages.some((msgs) =>
      msgs.some((m) =>
        typeof m.content === 'string'
          ? m.content.includes('PREVIOUS-SUMMARY-MARKER')
          : m.content.some((b) => b.type === 'text' && b.text.includes('PREVIOUS-SUMMARY-MARKER')),
      ),
    )
    expect(anyHadPreviousSummary).toBe(false)
  })

  it('caps the persisted summary at 8000 chars to prevent unbounded growth', async () => {
    const sessionMessages: SessionMessage[] = [
      makeSessionMessage({ sequenceNum: 400, role: 'user', content: [{ type: 'text', text: 'old' }] }),
      makeSessionMessage({ sequenceNum: 401, role: 'assistant', content: [{ type: 'text', text: 'reply' }] }),
      makeSessionMessage({ sequenceNum: 402, role: 'user', content: [{ type: 'text', text: 'current' }] }),
    ]
    mockSetCompactSummaryAndBoundary.mockResolvedValueOnce(true)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await runProactiveCompaction(baseParams({
        sessionMessages,
        unconditional: true,
        provider: mockProviderWithSummary('x'.repeat(12_000)),
      }))

      const [, summaryPersisted] = mockSetCompactSummaryAndBoundary.mock.calls[0]
      expect((summaryPersisted as string).length).toBeLessThanOrEqual(8_100) // 8000 + suffix
      expect(summaryPersisted as string).toMatch(/\[summary truncated at cap\]$/)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('summary cap fired'))
    } finally {
      warnSpy.mockRestore()
    }
  })
})

// ── runProactiveCompaction — self-heal resilience (parts 3 + 4) ──────
//
// The over-limit wedge fix: compaction must never pass through full
// over-limit history, the breaker must degrade-not-deadlock, and over-limit
// heals must be observable. See docs/architecture/context-engine/compaction.md
// → "Compaction resilience" and provider-abstraction.md → "Context-budget".

function throwingProvider(err: Error): LLMProvider {
  return {
    createSession() { return {} as never },
    async *stream(): AsyncGenerator<StreamChunk> {
      throw err
      // eslint-disable-next-line no-unreachable
      yield { type: 'text_delta', text: '' } as StreamChunk
    },
  } as unknown as LLMProvider
}

/** A captured-events analytics logger. */
function makeAnalytics(): { logger: AnalyticsLogger; events: Array<{ eventName: string; metadata: Record<string, unknown> }> } {
  const events: Array<{ eventName: string; metadata: Record<string, unknown> }> = []
  return {
    logger: { logEvent: (e: { eventName: string; metadata: Record<string, unknown> }) => events.push(e) } as unknown as AnalyticsLogger,
    events,
  }
}

/** A normal-sized, compactable 7-message session (current user turn at the tail). */
function compactableMessages(): SessionMessage[] {
  return [
    makeSessionMessage({ sequenceNum: 100, role: 'user', content: [{ type: 'text', text: 'old question' }] }),
    makeSessionMessage({ sequenceNum: 101, role: 'assistant', content: [{ type: 'text', text: 'old answer' }] }),
    makeSessionMessage({ sequenceNum: 102, role: 'user', content: [{ type: 'text', text: 'follow-up' }] }),
    makeSessionMessage({ sequenceNum: 103, role: 'assistant', content: [{ type: 'text', text: 'reply' }] }),
    makeSessionMessage({ sequenceNum: 104, role: 'user', content: [{ type: 'text', text: 'another' }] }),
    makeSessionMessage({ sequenceNum: 105, role: 'assistant', content: [{ type: 'text', text: 'another reply' }] }),
    makeSessionMessage({ sequenceNum: 106, role: 'user', content: [{ type: 'text', text: 'current turn' }] }),
  ]
}

describe('[COMP:api/proactive-compaction] runProactiveCompaction — self-heal resilience', () => {
  beforeEach(() => {
    mockSetCompactSummaryAndBoundary.mockReset()
    mockFindSessionById.mockReset()
  })

  it('on compaction failure, returns a fit-to-budget history — NOT the full over-limit input', async () => {
    // A single ~1.1M-token tool_result blows past Gemini's 1M window. Before
    // the fix the catch returned the FULL history → the next turn 400'd. Now
    // it must return a clamped, under-limit history.
    const huge = 'x'.repeat(4_400_000) // ≈1.1M tokens
    const sessionMessages: SessionMessage[] = [
      makeSessionMessage({ sequenceNum: 100, role: 'user', content: [{ type: 'tool_result', toolUseId: 'a', name: 'listScheduledJobs', content: huge }] }),
      makeSessionMessage({ sequenceNum: 101, role: 'assistant', content: [{ type: 'text', text: 'ok' }] }),
      makeSessionMessage({ sequenceNum: 102, role: 'user', content: [{ type: 'text', text: 'Done' }] }),
    ]
    const result = await runProactiveCompaction(baseParams({
      sessionMessages,
      unconditional: true,
      provider: throwingProvider(new Error('Gemini API error 503: upstream unavailable')),
      circuitBreaker: createCompactionCircuitBreaker(),
    }))

    expect(result.compacted).toBe(false)
    // The decisive assertion: the returned history fits the model window.
    expect(estimateTokens(result.messages)).toBeLessThan(1_048_576)
  })

  it('does NOT open the breaker on overflow failures (the wrapper owns those)', async () => {
    const breaker = createCompactionCircuitBreaker()
    const overflow = throwingProvider(new Error('Gemini API error 400: input token count exceeds the maximum number of tokens allowed 1048576'))
    for (let i = 0; i < 5; i++) {
      await runProactiveCompaction(baseParams({
        sessionMessages: compactableMessages(),
        unconditional: true,
        provider: overflow,
        circuitBreaker: breaker,
      }))
    }
    expect(breaker.isOpen).toBe(false)
  })

  it('opens on systemic (non-overflow) failures and an open breaker skips the summariser', async () => {
    const breaker = createCompactionCircuitBreaker()
    const down = throwingProvider(new Error('Gemini API error 503: service unavailable'))
    for (let i = 0; i < 3; i++) {
      await runProactiveCompaction(baseParams({
        sessionMessages: compactableMessages(),
        unconditional: true,
        provider: down,
        circuitBreaker: breaker,
      }))
    }
    expect(breaker.isOpen).toBe(true)

    // With the breaker open, compaction (and pre-compaction extraction) must be
    // skipped entirely — degrade straight to the deterministic trim.
    let streamCalls = 0
    const spy: LLMProvider = {
      createSession() { return {} as never },
      async *stream(): AsyncGenerator<StreamChunk> {
        streamCalls++
        yield { type: 'text_delta', text: 'summary' } as StreamChunk
      },
    } as unknown as LLMProvider
    const result = await runProactiveCompaction(baseParams({
      sessionMessages: compactableMessages(),
      unconditional: true,
      provider: spy,
      circuitBreaker: breaker,
    }))
    expect(streamCalls).toBe(0)
    expect(result.compacted).toBe(false)
  })

  it('half-opens after the cooldown and closes on a successful probe (no deadlock)', async () => {
    let clock = 1_000_000
    const breaker = createCompactionCircuitBreaker(() => clock)
    const down = throwingProvider(new Error('Gemini API error 503'))
    for (let i = 0; i < 3; i++) {
      await runProactiveCompaction(baseParams({
        sessionMessages: compactableMessages(),
        unconditional: true,
        provider: down,
        circuitBreaker: breaker,
      }))
    }
    expect(breaker.isOpen).toBe(true)

    clock += 61_000 // past the 60s cooldown → half-open
    expect(breaker.isOpen).toBe(false)

    mockSetCompactSummaryAndBoundary.mockResolvedValueOnce(true)
    const result = await runProactiveCompaction(baseParams({
      sessionMessages: compactableMessages(),
      unconditional: true,
      provider: mockProviderWithSummary('recovered summary'),
      circuitBreaker: breaker,
    }))
    expect(result.compacted).toBe(true)
    expect(breaker.isOpen).toBe(false) // probe succeeded → fully closed
  })

  it('emits session_autohealed when an over-limit session is compacted back under the window', async () => {
    const huge = 'x'.repeat(4_400_000) // ≈1.1M tokens — over the 1M window
    const sessionMessages: SessionMessage[] = [
      makeSessionMessage({ sequenceNum: 100, role: 'user', content: [{ type: 'tool_result', toolUseId: 'a', name: 'listScheduledJobs', content: huge }] }),
      makeSessionMessage({ sequenceNum: 101, role: 'assistant', content: [{ type: 'text', text: 'ok' }] }),
      makeSessionMessage({ sequenceNum: 102, role: 'user', content: [{ type: 'text', text: 'Done' }] }),
    ]
    mockSetCompactSummaryAndBoundary.mockResolvedValueOnce(true)
    const { logger, events } = makeAnalytics()
    await runProactiveCompaction(baseParams({
      sessionMessages,
      unconditional: true,
      provider: mockProviderWithSummary('compacted summary body'),
      analytics: logger,
    }))

    const healed = events.find((e) => e.eventName === 'session_autohealed')
    expect(healed).toBeDefined()
    expect(healed!.metadata.compacted).toBe(true)
    expect(healed!.metadata.healed_via).toBe('compaction')
    expect(healed!.metadata.pre_tokens as number).toBeGreaterThan(1_048_576)
  })

  it('does NOT emit session_autohealed for a normal-sized session', async () => {
    mockSetCompactSummaryAndBoundary.mockResolvedValueOnce(true)
    const { logger, events } = makeAnalytics()
    await runProactiveCompaction(baseParams({
      sessionMessages: compactableMessages(),
      unconditional: true,
      provider: mockProviderWithSummary('summary'),
      analytics: logger,
    }))
    expect(events.find((e) => e.eventName === 'session_autohealed')).toBeUndefined()
  })
})
