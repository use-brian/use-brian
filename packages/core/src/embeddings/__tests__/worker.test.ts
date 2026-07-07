import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createEmbeddingWorker, createEmbeddingUsageRecorder } from '../worker.js'
import type {
  EmbeddingCandidate,
  EmbeddingFailure,
  EmbeddingPrimitive,
  EmbeddingResult,
  EmbeddingStore,
  EmbeddingUsageBatch,
} from '../worker.js'
import type { UsageStore } from '../../billing/cost-tracker.js'

function makeCandidate(
  overrides: Partial<EmbeddingCandidate> & { id: string; primitive: EmbeddingPrimitive },
): EmbeddingCandidate {
  return {
    text: `text for ${overrides.id}`,
    contentHash: `hash_${overrides.id}`,
    ...overrides,
  }
}

/**
 * In-memory EmbeddingStore. `withClaimedRows` splices up to `limit` rows
 * out of the per-primitive queue (mirrors SELECT FOR UPDATE SKIP LOCKED —
 * claimed rows are invisible to subsequent claims), invokes the handler,
 * and on COMMIT records committed/failed ids. If the handler throws, the
 * unprocessed rows are restored to the front of the queue (ROLLBACK).
 */
function makeFakeStore(initial: Partial<Record<EmbeddingPrimitive, EmbeddingCandidate[]>> = {}) {
  const queues = new Map<EmbeddingPrimitive, EmbeddingCandidate[]>()
  for (const [p, rows] of Object.entries(initial)) {
    queues.set(p as EmbeddingPrimitive, [...(rows ?? [])])
  }
  const commits: EmbeddingResult[] = []
  const failures: EmbeddingFailure[] = []
  const claimsByPrimitive = new Map<EmbeddingPrimitive, number>()

  const store: EmbeddingStore = {
    async withClaimedRows(primitive, limit, handler) {
      claimsByPrimitive.set(primitive, (claimsByPrimitive.get(primitive) ?? 0) + 1)
      const queue = queues.get(primitive) ?? []
      const claimed = queue.splice(0, limit)
      const txCommitted: string[] = []
      try {
        const result = await handler(claimed, {
          commit: async (results) => {
            for (const r of results) {
              commits.push(r)
              txCommitted.push(r.id)
            }
          },
          fail: async (failed) => {
            for (const f of failed) {
              failures.push(f)
              txCommitted.push(f.id)
            }
          },
        })
        return result
      } catch (err) {
        const survivors = claimed.filter((c) => !txCommitted.includes(c.id))
        queue.unshift(...survivors)
        queues.set(primitive, queue)
        throw err
      }
    },
  }

  return {
    store,
    commits,
    failures,
    claims: claimsByPrimitive,
    queue(primitive: EmbeddingPrimitive) {
      return queues.get(primitive) ?? []
    },
  }
}

function makeFakeEmbedder(opts: { fail?: Error } = {}) {
  const calls: string[][] = []
  const embedder = {
    dimensions: 768,
    model_id: 'gemini:text-embedding-004',
    embed: vi.fn(async (texts: string[]) => {
      calls.push(texts)
      if (opts.fail) throw opts.fail
      return texts.map((_, i) => new Array(768).fill(0).map((_v, j) => (i + j) / 1000))
    }),
    estimateCost: () => 0,
  }
  return { embedder, calls }
}

describe('[COMP:brain/embedding-worker] createEmbeddingWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('drains rows across multiple primitives in a single tick', async () => {
    const fake = makeFakeStore({
      memories: [
        makeCandidate({ id: 'm1', primitive: 'memories' }),
        makeCandidate({ id: 'm2', primitive: 'memories' }),
      ],
      entities: [makeCandidate({ id: 'e1', primitive: 'entities' })],
      kb_chunks: [makeCandidate({ id: 'k1', primitive: 'kb_chunks' })],
    })
    const { embedder } = makeFakeEmbedder()
    const worker = createEmbeddingWorker({
      store: fake.store,
      embedder,
      primitives: ['memories', 'entities', 'kb_chunks'],
      intervalMs: 60_000,
    })

    worker.start()
    await vi.waitFor(() => {
      expect(fake.commits.map((c) => c.id).sort()).toEqual(['e1', 'k1', 'm1', 'm2'])
    })
    expect(fake.claims.get('memories')).toBe(1)
    expect(fake.claims.get('entities')).toBe(1)
    expect(fake.claims.get('kb_chunks')).toBe(1)
    worker.stop()
  })

  it('is a clean no-op when every primitive queue is empty', async () => {
    const fake = makeFakeStore({})
    const { embedder } = makeFakeEmbedder()
    const worker = createEmbeddingWorker({
      store: fake.store,
      embedder,
      primitives: ['memories', 'entities'],
      intervalMs: 60_000,
    })

    worker.start()
    await vi.waitFor(() => {
      expect(fake.claims.get('memories') ?? 0).toBeGreaterThanOrEqual(1)
      expect(fake.claims.get('entities') ?? 0).toBeGreaterThanOrEqual(1)
    })
    expect(embedder.embed).not.toHaveBeenCalled()
    expect(fake.commits).toEqual([])
    expect(fake.failures).toEqual([])
    worker.stop()
  })

  it('routes every batch row to fail() when the embedder throws', async () => {
    const fake = makeFakeStore({
      memories: [
        makeCandidate({ id: 'm1', primitive: 'memories' }),
        makeCandidate({ id: 'm2', primitive: 'memories' }),
      ],
    })
    const { embedder } = makeFakeEmbedder({ fail: new Error('rate limited') })
    const worker = createEmbeddingWorker({
      store: fake.store,
      embedder,
      primitives: ['memories'],
      intervalMs: 60_000,
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    worker.start()
    await vi.waitFor(() => {
      expect(fake.failures.map((f) => f.id).sort()).toEqual(['m1', 'm2'])
    })
    expect(fake.commits).toEqual([])
    expect(fake.failures.every((f) => f.reason === 'rate limited')).toBe(true)
    worker.stop()
    errSpy.mockRestore()
  })

  it('passes embedder.model_id through to every commit row', async () => {
    const fake = makeFakeStore({
      entities: [makeCandidate({ id: 'e1', primitive: 'entities' })],
    })
    const { embedder } = makeFakeEmbedder()
    const worker = createEmbeddingWorker({
      store: fake.store,
      embedder,
      primitives: ['entities'],
      intervalMs: 60_000,
    })

    worker.start()
    await vi.waitFor(() => {
      expect(fake.commits).toHaveLength(1)
    })
    expect(fake.commits[0].embeddingModelId).toBe('gemini:text-embedding-004')
    expect(fake.commits[0].contentHash).toBe('hash_e1')
    expect(fake.commits[0].embedding).toHaveLength(768)
    worker.stop()
  })

  it('restricts claims to the configured primitives subset', async () => {
    const fake = makeFakeStore({
      memories: [makeCandidate({ id: 'm1', primitive: 'memories' })],
      entities: [makeCandidate({ id: 'e1', primitive: 'entities' })],
      kb_chunks: [makeCandidate({ id: 'k1', primitive: 'kb_chunks' })],
    })
    const { embedder } = makeFakeEmbedder()
    const worker = createEmbeddingWorker({
      store: fake.store,
      embedder,
      primitives: ['memories'],
      intervalMs: 60_000,
    })

    worker.start()
    await vi.waitFor(() => {
      expect(fake.commits.map((c) => c.id)).toEqual(['m1'])
    })
    expect(fake.claims.get('entities')).toBeUndefined()
    expect(fake.claims.get('kb_chunks')).toBeUndefined()
    worker.stop()
  })

  it('skips overlapping ticks via the re-entry guard', async () => {
    const fake = makeFakeStore({
      memories: [makeCandidate({ id: 'm1', primitive: 'memories' })],
    })
    let release!: () => void
    const blocker = new Promise<void>((resolve) => {
      release = resolve
    })
    const embedder = {
      dimensions: 768,
      model_id: 'gemini:text-embedding-004',
      embed: vi.fn(async (texts: string[]) => {
        await blocker
        return texts.map(() => new Array(768).fill(0))
      }),
      estimateCost: () => 0,
    }
    const worker = createEmbeddingWorker({
      store: fake.store,
      embedder,
      primitives: ['memories'],
      intervalMs: 1_000,
    })

    worker.start()
    await vi.waitFor(() => expect(embedder.embed).toHaveBeenCalledTimes(1))

    // Several intervals while the first tick is still awaiting `blocker` —
    // the running guard must keep claim count at 1.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fake.claims.get('memories')).toBe(1)

    release()
    worker.stop()
  })

  it('reflects start()/stop() in isRunning and is idempotent', () => {
    const fake = makeFakeStore({})
    const { embedder } = makeFakeEmbedder()
    const worker = createEmbeddingWorker({
      store: fake.store,
      embedder,
      primitives: ['memories'],
    })

    expect(worker.isRunning).toBe(false)
    worker.start()
    expect(worker.isRunning).toBe(true)
    // Second start() is a no-op — no second timer to leak.
    worker.start()
    expect(worker.isRunning).toBe(true)
    worker.stop()
    expect(worker.isRunning).toBe(false)
  })

  // ── COGS attribution (overhead:embedding — embeddings.md §"Cost model") ──

  it('reports committed batches to the usage recorder grouped by (workspace, user)', async () => {
    const fake = makeFakeStore({
      memories: [
        makeCandidate({ id: 'm1', primitive: 'memories', workspaceId: 'ws-1', userId: 'u-1', text: 'abcd'.repeat(10) }),
        makeCandidate({ id: 'm2', primitive: 'memories', workspaceId: 'ws-1', userId: 'u-1', text: 'abcd'.repeat(5) }),
        makeCandidate({ id: 'm3', primitive: 'memories', workspaceId: 'ws-1', userId: null, text: 'xyz' }),
        makeCandidate({ id: 'm4', primitive: 'memories', workspaceId: 'ws-2', userId: 'u-2', text: 'q' }),
      ],
    })
    const { embedder } = makeFakeEmbedder()
    const usage = vi.fn(async (_batches: EmbeddingUsageBatch[]) => {})
    const worker = createEmbeddingWorker({
      store: fake.store,
      embedder,
      primitives: ['memories'],
      intervalMs: 60_000,
      usage,
    })

    worker.start()
    await vi.waitFor(() => expect(usage).toHaveBeenCalledTimes(1))
    worker.stop()

    const batches: EmbeddingUsageBatch[] = usage.mock.calls[0][0]
    const byKey = new Map(batches.map((b) => [`${b.workspaceId}::${b.userId ?? ''}`, b]))
    expect(byKey.size).toBe(3)
    // 40 chars + 20 chars at ~4 chars/token → 10 + 5 tokens.
    expect(byKey.get('ws-1::u-1')).toMatchObject({ rowCount: 2, inputTokensEstimated: 15, primitive: 'memories' })
    expect(byKey.get('ws-1::')).toMatchObject({ rowCount: 1, userId: null, inputTokensEstimated: 1 })
    expect(byKey.get('ws-2::u-2')).toMatchObject({ rowCount: 1, inputTokensEstimated: 1 })
  })

  it('skips usage rows without a workspaceId and never calls the recorder on embed failure', async () => {
    const failing = makeFakeStore({
      memories: [makeCandidate({ id: 'm1', primitive: 'memories', workspaceId: 'ws-1', userId: 'u-1' })],
    })
    const { embedder: failEmbedder } = makeFakeEmbedder({ fail: new Error('quota') })
    const usage = vi.fn(async (_batches: EmbeddingUsageBatch[]) => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failWorker = createEmbeddingWorker({
      store: failing.store,
      embedder: failEmbedder,
      primitives: ['memories'],
      intervalMs: 60_000,
      usage,
    })
    failWorker.start()
    await vi.waitFor(() => expect(failing.failures).toHaveLength(1))
    failWorker.stop()
    expect(usage).not.toHaveBeenCalled()
    errSpy.mockRestore()

    // Attribution-less rows (no workspaceId) embed fine but produce no batch.
    const bare = makeFakeStore({
      entities: [makeCandidate({ id: 'e1', primitive: 'entities' })],
    })
    const { embedder } = makeFakeEmbedder()
    const bareWorker = createEmbeddingWorker({
      store: bare.store,
      embedder,
      primitives: ['entities'],
      intervalMs: 60_000,
      usage,
    })
    bareWorker.start()
    await vi.waitFor(() => expect(bare.commits).toHaveLength(1))
    bareWorker.stop()
    expect(usage).not.toHaveBeenCalled()
  })

  it('logs and keeps the committed batch when the usage recorder throws', async () => {
    const fake = makeFakeStore({
      memories: [makeCandidate({ id: 'm1', primitive: 'memories', workspaceId: 'ws-1', userId: 'u-1' })],
    })
    const { embedder } = makeFakeEmbedder()
    const usage = vi.fn(async () => {
      throw new Error('usage store down')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const worker = createEmbeddingWorker({
      store: fake.store,
      embedder,
      primitives: ['memories'],
      intervalMs: 60_000,
      usage,
    })

    worker.start()
    await vi.waitFor(() => expect(usage).toHaveBeenCalledTimes(1))
    worker.stop()

    // The commit stands — the recorder failure is logged, not propagated.
    expect(fake.commits.map((c) => c.id)).toEqual(['m1'])
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('usage recording (memories) failed'),
      expect.any(Error),
    )
    warnSpy.mockRestore()
  })

  it('createEmbeddingUsageRecorder records one overhead:embedding row per group with workspace fallback', async () => {
    const recordUsage = vi.fn(async (_params: Parameters<UsageStore['recordUsage']>[0]) => {})
    const usageStore = { recordUsage } as unknown as UsageStore
    const recorder = createEmbeddingUsageRecorder(usageStore)

    await recorder([
      { primitive: 'memories', workspaceId: 'ws-1', userId: 'u-1', rowCount: 2, inputTokensEstimated: 1_000_000 },
      { primitive: 'kb_chunks', workspaceId: 'ws-1', userId: null, rowCount: 1, inputTokensEstimated: 40 },
    ])

    expect(recordUsage).toHaveBeenCalledTimes(2)
    expect(recordUsage.mock.calls[0][0]).toMatchObject({
      userId: 'u-1',
      assistantId: '',
      workspaceId: 'ws-1',
      sessionId: null,
      model: 'gemini:gemini-embedding-001',
      inputTokens: 1_000_000,
      outputTokens: 0,
      source: 'overhead:embedding',
      triggerKey: 'embedding_batch',
    })
    // $0.025 per million input tokens (cost-tracker PRICING via the alias).
    expect(recordUsage.mock.calls[0][0].actualCostUsd).toBeCloseTo(0.025, 6)
    // Workspace-shared rows pass a blank userId — the store fallback resolves it.
    expect(recordUsage.mock.calls[1][0]).toMatchObject({ userId: '', workspaceId: 'ws-1' })
  })
})
