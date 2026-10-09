/**
 * [COMP:api/turn-lease] — channel turns hold the same lease as web turns.
 *
 * Before the turn kernel, a messaging-channel turn blind-set
 * `status='running'` with no lease: the sweeper fell back to
 * `last_active_at` and could time out a live channel turn, and web Stop could
 * not reach it. The channel pipeline now runs through `runAssistantTurn` with
 * a held lease the kernel heart-beats and registers for in-process Stop.
 *
 * Spec: docs/architecture/engine/turn-kernel.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const state = vi.hoisted(() => ({ touches: 0, releases: [] as string[] }))

vi.mock('../../db/sessions.js', async (original) => ({
  ...await original<any>(),
  touchTurnLease: vi.fn(async () => { state.touches++; return { held: true, cancelRequested: false } }),
  releaseTurnLease: vi.fn(async (_id: string, reason: string) => { state.releases.push(reason); return true }),
  findSessionById: vi.fn(async (id: string) => ({ id, userId: 'u', assistantId: 'a', channelType: 'telegram', channelId: '1', status: 'running', visibility: 'owner', mode: null })),
  requestTurnCancel: vi.fn(async () => true),
  reclaimStaleTurn: vi.fn(async () => false),
}))
vi.mock('../../session-read-authority.js', () => ({ gateSessionRead: vi.fn(async () => null), anchorReadGate: vi.fn() }))
vi.mock('../../routes/route-helpers.js', async (original) => ({
  ...await original<any>(), resolveUser: async () => ({ id: 'u', name: 'Tester' }),
}))
vi.mock('@use-brian/core', async (original) => ({
  ...await original<any>(),
  queryLoop: vi.fn(async function* (options: { context?: { abortSignal?: AbortSignal } }) {
    yield { type: 'text_delta', text: 'working' }
    // Hold the turn open until something aborts it (or the test releases it).
    await new Promise<void>((resolve) => {
      holdOpen.release = resolve
      options.context?.abortSignal?.addEventListener('abort', () => resolve())
    })
  }),
}))

const holdOpen: { release: null | (() => void) } = { release: null }

import { runAssistantTurn } from '../kernel.js'
import { TURN_LEASE_STALE_AFTER_MS } from '../../db/sessions.js'
import { chatRoutes } from '../../routes/chat.js'

function channelTurn(abortController: AbortController) {
  return runAssistantTurn({
    sessionId: 'channel-session',
    policy: { admission: 'personal' },
    abortController,
    lease: { mode: 'held', token: 'channel-token' },
    model: { provider: {} as never, model: 'gemini-flash', configuredProviders: undefined, customLlm: null },
    loop: { ledger: {} as never, systemPrompt: '', messages: [], tools: new Map(), context: { abortSignal: abortController.signal } as never },
    sink: { kind: 'adapter' },
  })
}

beforeEach(() => {
  state.touches = 0
  state.releases = []
  holdOpen.release = null
})
afterEach(() => vi.useRealTimers())

describe('[COMP:api/turn-lease] channel turns hold the kernel lease', () => {
  it('heart-beats a channel turn past the stale window, so the sweeper never sees it as dead', async () => {
    vi.useFakeTimers()
    const abortController = new AbortController()
    const turn = channelTurn(abortController)
    await vi.advanceTimersByTimeAsync(TURN_LEASE_STALE_AFTER_MS + 30_000)
    // A 20 s heartbeat over 120 s: the lease was refreshed well inside every
    // 90 s window the sweeper measures.
    expect(state.touches).toBeGreaterThanOrEqual(5)
    expect(abortController.signal.aborted).toBe(false)
    holdOpen.release?.()
    await turn
  })

  it('POST /api/chat/stop aborts a channel turn running in this process', async () => {
    const abortController = new AbortController()
    const turn = channelTurn(abortController)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => { (req as { userId?: string }).userId = 'u'; next() })
    app.use('/chat', chatRoutes({ publishSessionEvent: () => {} } as never))
    const res = await request(app).post('/chat/stop').send({ sessionId: 'channel-session' })
    expect(res.body.via).toBe('aborted')
    expect(abortController.signal.aborted).toBe(true)
    await turn
  })
})
