/**
 * Worker persistence — Phase 3 of askQuestion suspend-resume.
 *
 * Component tag: [COMP:core/worker-manager-persist].
 * Spec: docs/architecture/engine/askquestion-suspend-resume.md.
 *
 * Covers the WorkerManager's persistence wiring:
 *   - setPersistence + spawn → recordSpawn fires with the right fields
 *   - per-turn boundary → recordTurn fires with the history snapshot
 *   - completion → recordCompletion fires with status + result
 *   - reset() clears the persistence bindings (no writes after reset)
 *   - rehydrate(sessionId) loads completed rows into notifications and
 *     respawns running rows from their saved history
 */

import { describe, it, expect, vi } from 'vitest'
import { createWorkerManager } from '../worker.js'
import type { WorkerRunsStore } from '../worker.js'
import type {
  LLMProvider,
  ProviderSession,
  SessionOptions,
  StreamChunk,
  Message,
  ProviderRequest,
} from '../../providers/types.js'

function makeFakeProvider(responseText: string): LLMProvider {
  function* chunks(): Generator<StreamChunk> {
    yield { type: 'message_start', model: 'gemini-flash' }
    yield { type: 'text_delta', text: responseText }
    yield {
      type: 'message_end',
      stopReason: 'end_turn',
      usage: { inputTokens: 5, outputTokens: 5 },
    }
  }
  return {
    name: 'fake',
    models: ['gemini-flash'],
    async *stream(_req: ProviderRequest) { yield* chunks() },
    createSession(_o: SessionOptions): ProviderSession {
      return {
        send(_messages: Message[]): AsyncIterable<StreamChunk> {
          return (async function* () { yield* chunks() })()
        },
      }
    },
  }
}

const ctx = {
  assistantId: 'a1',
  userId: 'u1',
  sessionId: 's1',
  appId: 'sidanclaw',
  channelType: 'web' as const,
  channelId: 'c1',
  abortSignal: new AbortController().signal,
}

function makeStore(): WorkerRunsStore & {
  spawns: Array<Parameters<WorkerRunsStore['recordSpawn']>[0]>
  turns: Array<Parameters<WorkerRunsStore['recordTurn']>[0]>
  completions: Array<Parameters<WorkerRunsStore['recordCompletion']>[0]>
  loadResult: Awaited<ReturnType<WorkerRunsStore['loadForSession']>>
} {
  const spawns: Array<Parameters<WorkerRunsStore['recordSpawn']>[0]> = []
  const turns: Array<Parameters<WorkerRunsStore['recordTurn']>[0]> = []
  const completions: Array<Parameters<WorkerRunsStore['recordCompletion']>[0]> = []
  const loadResult: Awaited<ReturnType<WorkerRunsStore['loadForSession']>> = []
  return {
    spawns,
    turns,
    completions,
    loadResult,
    async recordSpawn(params) { spawns.push(params) },
    async recordTurn(params) { turns.push(params) },
    async recordCompletion(params) { completions.push(params) },
    async loadForSession() { return loadResult },
    async deleteTerminalOlderThan() { return 0 },
  }
}

describe('[COMP:core/worker-manager-persist] setPersistence + spawn lifecycle', () => {
  it('records spawn → turn → completion on the happy path', async () => {
    const store = makeStore()
    const manager = createWorkerManager({
      provider: makeFakeProvider('found it'),
      model: 'gemini-flash',
      tools: new Map(),
    })
    manager.setPersistence({ store, sessionId: 's1', workspaceId: 'ws1' })

    const { workerId } = manager.spawn('what time is it?', ctx)!
    await manager.waitForNext()
    // Persistence is fire-and-forget — give the microtask queue a turn
    // so the recordCompletion promise settles.
    await new Promise((r) => setImmediate(r))

    expect(workerId).toBe('worker_1')
    expect(store.spawns).toHaveLength(1)
    expect(store.spawns[0]).toMatchObject({
      sessionId: 's1',
      workspaceId: 'ws1',
      workerId: 'worker_1',
      prompt: 'what time is it?',
      researchMode: false,
    })
    // Each spawn mints a UUID runId that threads through the later
    // recordTurn / recordCompletion calls — they all target the same row.
    const runId = store.spawns[0].runId
    expect(runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    // One turn boundary fired for the one-turn worker.
    expect(store.turns.length).toBeGreaterThanOrEqual(1)
    expect(store.turns[0]).toMatchObject({
      runId,
      sessionId: 's1',
      workerId: 'worker_1',
      turnCount: 1,
    })
    expect(Array.isArray(store.turns[0].history)).toBe(true)
    // Completion fired with the final result.
    expect(store.completions).toHaveLength(1)
    expect(store.completions[0]).toMatchObject({
      runId,
      sessionId: 's1',
      workerId: 'worker_1',
      status: 'completed',
      result: 'found it',
    })
  })

  it('runs in legacy in-memory-only mode when setPersistence is not called', async () => {
    const store = makeStore()
    const manager = createWorkerManager({
      provider: makeFakeProvider('hi'),
      model: 'gemini-flash',
      tools: new Map(),
    })
    // Intentionally do NOT call setPersistence.
    manager.spawn('hi', ctx)!
    await manager.waitForNext()
    await new Promise((r) => setImmediate(r))

    expect(store.spawns).toHaveLength(0)
    expect(store.turns).toHaveLength(0)
    expect(store.completions).toHaveLength(0)
  })

  it('reset() clears persistence — no writes for subsequent spawns', async () => {
    const store = makeStore()
    const manager = createWorkerManager({
      provider: makeFakeProvider('hi'),
      model: 'gemini-flash',
      tools: new Map(),
    })
    manager.setPersistence({ store, sessionId: 's1', workspaceId: 'ws1' })
    manager.reset()

    manager.spawn('hi', ctx)!
    await manager.waitForNext()
    await new Promise((r) => setImmediate(r))

    expect(store.spawns).toHaveLength(0)
  })
})

describe('[COMP:core/worker-manager-persist] rehydrate', () => {
  it('pushes completed rows into the notifications queue', async () => {
    const store = makeStore()
    store.loadResult.push({
      runId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      workerId: 'worker_3',
      status: 'completed',
      description: 'check pricing',
      prompt: 'find their pricing',
      researchMode: true,
      model: 'gemini-3.1-pro-preview',
      turnCount: 4,
      result: 'pricing is $X/month',
      history: [],
    })
    store.loadResult.push({
      runId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      workerId: 'worker_4',
      status: 'failed',
      description: 'check competitors',
      prompt: 'who competes',
      researchMode: true,
      model: 'gemini-3.1-pro-preview',
      turnCount: 1,
      result: 'protocol violation',
      history: [],
    })
    const manager = createWorkerManager({
      provider: makeFakeProvider('unused'),
      model: 'gemini-flash',
      tools: new Map(),
    })
    manager.setPersistence({ store, sessionId: 's1', workspaceId: 'ws1' })

    const { respawned, notificationsReady } = await manager.rehydrate('s1', ctx)

    expect(respawned).toBe(0)
    expect(notificationsReady).toBe(2)
    expect(manager.hasNotifications).toBe(true)
    const notifications = manager.drainNotifications()
    expect(notifications).toHaveLength(2)
    expect(notifications.find((n) => n.workerId === 'worker_3')?.status).toBe('completed')
    expect(notifications.find((n) => n.workerId === 'worker_4')?.status).toBe('failed')
  })

  it('respawns running rows seeded with their saved history', async () => {
    const store = makeStore()
    // The provider yields a final text turn — the seeded history is the
    // worker's prior conversational state; we only check that respawn
    // produces a `completed` notification, indicating the worker ran.
    store.loadResult.push({
      runId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      workerId: 'worker_7',
      status: 'running',
      description: 'in-flight work',
      prompt: 'original prompt',
      researchMode: false,
      model: 'gemini-flash',
      turnCount: 2,
      result: null,
      history: [
        { role: 'user', content: 'original prompt' },
        { role: 'assistant', content: [{ type: 'text', text: 'midway' }] },
      ],
    })
    const manager = createWorkerManager({
      provider: makeFakeProvider('finished from rehydrate'),
      model: 'gemini-flash',
      tools: new Map(),
    })
    manager.setPersistence({ store, sessionId: 's1', workspaceId: 'ws1' })

    const { respawned, notificationsReady } = await manager.rehydrate('s1', ctx)
    expect(respawned).toBe(1)
    expect(notificationsReady).toBe(0)

    // Wait for the respawned worker to settle.
    await manager.waitForNext()
    await new Promise((r) => setImmediate(r))
    const notifications = manager.drainNotifications()
    expect(notifications).toHaveLength(1)
    expect(notifications[0].workerId).toBe('worker_7')
    expect(notifications[0].status).toBe('completed')
    expect(notifications[0].result).toBe('finished from rehydrate')

    // The respawned worker writes recordCompletion against the
    // pre-existing row's runId (loaded from loadForSession) — never
    // mints a new one. This is what makes resume idempotent.
    expect(store.completions).toHaveLength(1)
    expect(store.completions[0].runId).toBe('cccccccc-cccc-cccc-cccc-cccccccccccc')
    expect(store.completions[0].workerId).toBe('worker_7')
  })

  it('bumps the workerCounter past existing rows so subsequent spawns do not collide', async () => {
    const store = makeStore()
    store.loadResult.push({
      runId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      workerId: 'worker_5',
      status: 'completed',
      description: 'd',
      prompt: 'p',
      researchMode: false,
      model: 'gemini-flash',
      turnCount: 1,
      result: 'r',
      history: [],
    })
    const manager = createWorkerManager({
      provider: makeFakeProvider('next'),
      model: 'gemini-flash',
      tools: new Map(),
    })
    manager.setPersistence({ store, sessionId: 's1', workspaceId: 'ws1' })
    await manager.rehydrate('s1', ctx)
    // Drain so the rehydrated row doesn't pre-resolve waitForNext for the
    // fresh worker below.
    manager.drainNotifications()

    const fresh = manager.spawn('new gap', ctx)!
    // Should not collide with worker_5 — counter must be >5.
    expect(fresh.workerId).toBe('worker_6')
  })

  it('is a no-op when no persistence store is set', async () => {
    const manager = createWorkerManager({
      provider: makeFakeProvider('unused'),
      model: 'gemini-flash',
      tools: new Map(),
    })
    const result = await manager.rehydrate('s1', ctx)
    expect(result).toEqual({ respawned: 0, notificationsReady: 0 })
  })
})
