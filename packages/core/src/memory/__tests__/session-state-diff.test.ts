import { describe, it, expect, vi } from 'vitest'
import { runSessionStateDiff } from '../session-state-diff.js'
import type {
  SessionStateRecord,
  SessionStateStore,
} from '../session-state-types.js'
import type { LLMProvider, StreamChunk } from '../../providers/types.js'

function record(overrides: Partial<SessionStateRecord> = {}): SessionStateRecord {
  return {
    id: 'r1',
    sessionId: 's1',
    userId: 'u1',
    assistantId: 'a1',
    key: 'pill:today',
    status: 'open',
    summary: 'Confirm pill',
    detail: null,
    source: 'tool',
    createdAt: new Date(),
    updatedAt: new Date(),
    resolvedAt: null,
    ...overrides,
  }
}

function makeStore(initial: SessionStateRecord[] = []): SessionStateStore {
  let rows = [...initial]
  return {
    upsert: vi.fn(async (p) => {
      const row = record({ key: p.key, summary: p.summary, detail: p.detail ?? null, source: p.source })
      rows = rows.filter((r) => r.key !== p.key).concat(row)
      return row
    }),
    resolve: vi.fn(async (p) => {
      const hit = rows.find((r) => r.key === p.key)
      if (!hit) return null
      const updated = { ...hit, status: 'resolved' as const, resolvedAt: new Date() }
      rows = rows.map((r) => (r.key === p.key ? updated : r))
      return updated
    }),
    listOpenBySession: vi.fn(async () => rows.filter((r) => r.status === 'open')),
    listRecentBySession: vi.fn(async () => rows),
    purgeResolvedOlderThan: vi.fn(),
  }
}

function makeProvider(jsonOutput: string | 'throw'): LLMProvider {
  async function* stream(): AsyncIterable<StreamChunk> {
    if (jsonOutput === 'throw') {
      throw new Error('provider exploded')
    }
    yield { type: 'message_start', model: 'fake-flash' }
    yield { type: 'text_delta', text: jsonOutput }
    yield {
      type: 'message_end',
      stopReason: 'end_turn',
      usage: { inputTokens: 20, outputTokens: 10 },
    }
  }
  return {
    stream: () => stream(),
    createSession: () => ({}) as never,
  } as unknown as LLMProvider
}

/**
 * Provider whose Nth `stream()` call yields `outputs[N]` (clamped to the
 * last entry). Lets a test exercise the retry path — fail first, succeed
 * second.
 */
function makeFlakyProvider(outputs: string[]): LLMProvider {
  let call = 0
  async function* stream(): AsyncIterable<StreamChunk> {
    const out = outputs[Math.min(call, outputs.length - 1)]
    call += 1
    yield { type: 'message_start', model: 'fake-flash' }
    yield { type: 'text_delta', text: out }
    yield {
      type: 'message_end',
      stopReason: 'end_turn',
      usage: { inputTokens: 20, outputTokens: 10 },
    }
  }
  return {
    stream: () => stream(),
    createSession: () => ({}) as never,
  } as unknown as LLMProvider
}

describe('[COMP:memory/session-state-diff] runSessionStateDiff', () => {
  it('returns zero counts on empty input', async () => {
    const store = makeStore()
    const res = await runSessionStateDiff({
      provider: makeProvider('{"upserts":[],"resolves":[]}'),
      model: 'flash',
      sessionId: 's1',
      userId: 'u1',
      assistantId: 'a1',
      store,
      recentTurns: [],
      openCommitments: [],
    })
    expect(res).toEqual({ upserts: 0, resolves: 0, usage: null, model: null })
  })

  it('upserts new commitments emitted by the LLM', async () => {
    const store = makeStore()
    const res = await runSessionStateDiff({
      provider: makeProvider(
        '{"upserts":[{"key":"pill:today","summary":"Confirm pill by 2pm"}],"resolves":[]}',
      ),
      model: 'flash',
      sessionId: 's1',
      userId: 'u1',
      assistantId: 'a1',
      store,
      recentTurns: [{ role: 'user', content: 'remind me to take my pill' }],
      openCommitments: [],
    })
    expect(res.upserts).toBe(1)
    expect(store.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'pill:today', source: 'diff-pass' }),
    )
  })

  it('skips upserts whose key + summary + detail already match an open row', async () => {
    const existing = record({ key: 'pill:today', summary: 'Confirm pill' })
    const store = makeStore([existing])
    const res = await runSessionStateDiff({
      provider: makeProvider(
        '{"upserts":[{"key":"pill:today","summary":"Confirm pill"}],"resolves":[]}',
      ),
      model: 'flash',
      sessionId: 's1',
      userId: 'u1',
      assistantId: 'a1',
      store,
      recentTurns: [{ role: 'user', content: 'noop' }],
      openCommitments: [existing],
    })
    expect(res.upserts).toBe(0)
    expect(store.upsert).not.toHaveBeenCalled()
  })

  it('only resolves keys that are currently open', async () => {
    const existing = record({ key: 'pill:today' })
    const store = makeStore([existing])
    const res = await runSessionStateDiff({
      provider: makeProvider(
        '{"upserts":[],"resolves":[{"key":"pill:today"},{"key":"phantom:key"}]}',
      ),
      model: 'flash',
      sessionId: 's1',
      userId: 'u1',
      assistantId: 'a1',
      store,
      recentTurns: [{ role: 'user', content: 'done' }],
      openCommitments: [existing],
    })
    expect(res.resolves).toBe(1)
    // phantom:key should not have triggered a resolve
    expect(store.resolve).toHaveBeenCalledTimes(1)
    expect(store.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'pill:today' }),
    )
  })

  it('returns zero counts on malformed JSON output', async () => {
    const store = makeStore()
    const res = await runSessionStateDiff({
      provider: makeProvider('not json at all'),
      model: 'flash',
      sessionId: 's1',
      userId: 'u1',
      assistantId: 'a1',
      store,
      recentTurns: [{ role: 'user', content: 'x' }],
      openCommitments: [],
    })
    expect(res.upserts).toBe(0)
    expect(res.resolves).toBe(0)
    expect(res.errorMessage).toBeDefined()
  })

  it('returns zero counts and error on provider failure', async () => {
    const store = makeStore()
    const res = await runSessionStateDiff({
      provider: makeProvider('throw'),
      model: 'flash',
      sessionId: 's1',
      userId: 'u1',
      assistantId: 'a1',
      store,
      recentTurns: [{ role: 'user', content: 'x' }],
      openCommitments: [],
    })
    expect(res.upserts).toBe(0)
    expect(res.usage).toBeNull()
    expect(res.errorMessage).toBe('provider exploded')
  })

  it('retries once and recovers when the first call returns no JSON', async () => {
    const store = makeStore()
    const res = await runSessionStateDiff({
      // First attempt: empty body → `no-json`. Second: a valid diff.
      provider: makeFlakyProvider([
        '',
        '{"upserts":[{"key":"pill:today","summary":"Confirm pill by 2pm"}],"resolves":[]}',
      ]),
      model: 'flash',
      sessionId: 's1',
      userId: 'u1',
      assistantId: 'a1',
      store,
      recentTurns: [{ role: 'user', content: 'remind me to take my pill' }],
      openCommitments: [],
    })
    expect(res.errorMessage).toBeUndefined()
    expect(res.upserts).toBe(1)
    // Usage is summed across both attempts (20+20 in, 10+10 out).
    expect(res.usage).toEqual({ inputTokens: 40, outputTokens: 20 })
  })

  it('surfaces the failure when the call and its retry both return no JSON', async () => {
    const store = makeStore()
    const res = await runSessionStateDiff({
      provider: makeFlakyProvider(['', '']),
      model: 'flash',
      sessionId: 's1',
      userId: 'u1',
      assistantId: 'a1',
      store,
      recentTurns: [{ role: 'user', content: 'x' }],
      openCommitments: [],
    })
    expect(res.upserts).toBe(0)
    expect(res.errorMessage).toBe('no-json')
  })
})
