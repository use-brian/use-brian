import { beforeEach, describe, expect, it, vi } from 'vitest'

const leaseCalls: string[] = []
vi.mock('../../db/sessions.js', () => ({
  claimTurnSlot: vi.fn(async () => { leaseCalls.push('claim'); return true }),
  takeTurnSlot: vi.fn(async () => { leaseCalls.push('take') }),
  isTurnLeaseLive: vi.fn(async () => false),
  reclaimStaleTurn: vi.fn(async () => false),
  startTurnLease: vi.fn(async () => { leaseCalls.push('start'); return 'tok-1' }),
  touchTurnLease: vi.fn(async () => { leaseCalls.push('touch'); return { held: true, cancelRequested: false } }),
  releaseTurnLease: vi.fn(async () => { leaseCalls.push('release'); return true }),
  TURN_HEARTBEAT_INTERVAL_MS: 5,
}))

let loopEvents: unknown[] = []
let loopThrows: Error | null = null
const loopOptions: Array<Record<string, unknown>> = []
vi.mock('@use-brian/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@use-brian/core')>()
  return {
    ...actual,
    queryLoop: vi.fn(async function* (options: Record<string, unknown>) {
      loopOptions.push(options)
      for (const event of loopEvents) yield event
      if (loopThrows) throw loopThrows
    }),
  }
})

import { runAssistantTurn, TurnRefusal, servedTurnModel, turnUsageIdentity, type TurnSinkKind } from '../kernel.js'
import { resolveTurnBilling } from '../billing.js'
import { isTurnLeaseLive, releaseTurnLease } from '../../db/sessions.js'

const textTurn = (text: string) => ({
  type: 'assistant_turn',
  response: { content: [{ type: 'text', text }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
})

function params(sink: TurnSinkKind, over: Partial<Parameters<typeof runAssistantTurn>[0]> = {}) {
  return {
    sessionId: 's-1',
    policy: { admission: 'personal' as const },
    sink: { kind: sink },
    abortController: new AbortController(),
    model: { provider: {} as never, model: 'gemini-flash', configuredProviders: undefined, customLlm: null },
    loop: { ledger: {} as never, systemPrompt: '', messages: [], tools: new Map(), context: {} as never },
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  leaseCalls.length = 0
  loopEvents = []
  loopThrows = null
  loopOptions.length = 0
  vi.mocked(isTurnLeaseLive).mockResolvedValue(false)
})

describe('[COMP:api/turn-kernel] runAssistantTurn', () => {
  for (const sink of ['sse', 'adapter', 'json', 'return', 'none'] as const) {
    it(`${sink} sink: takes the lease, runs, and releases it on success`, async () => {
      loopEvents = [textTurn('hello')]
      await runAssistantTurn(params(sink))
      expect(leaseCalls[0]).toBe('take')
      expect(leaseCalls).toContain('start')
      expect(leaseCalls.at(-1)).toBe('release')
    })
  }

  it('releases the lease when the loop throws, and re-throws', async () => {
    loopThrows = new Error('provider exploded')
    await expect(runAssistantTurn(params('adapter'))).rejects.toThrow('provider exploded')
    expect(leaseCalls.at(-1)).toBe('release')
  })

  it('releases the lease when the sink throws', async () => {
    loopEvents = [textTurn('x')]
    await expect(runAssistantTurn(params('sse', { sink: { kind: 'sse', onEvent: () => { throw new Error('sink') } } })))
      .rejects.toThrow('sink')
    expect(leaseCalls.at(-1)).toBe('release')
  })

  it('releases the lease on an aborted turn', async () => {
    const abortController = new AbortController()
    abortController.abort()
    const result = await runAssistantTurn(params('adapter', { abortController }))
    expect(result.aborted).toBe(true)
    expect(leaseCalls.at(-1)).toBe('release')
  })

  it('heart-beats while the turn runs', async () => {
    loopEvents = [textTurn('x')]
    await runAssistantTurn(params('none', {
      sink: { kind: 'none', onEvent: () => new Promise((r) => setTimeout(r, 30)) },
    }))
    expect(leaseCalls).toContain('touch')
  })

  it('refuses a personal turn while a live lease holds the session', async () => {
    vi.mocked(isTurnLeaseLive).mockResolvedValueOnce(true)
    await expect(runAssistantTurn(params('adapter'))).rejects.toBeInstanceOf(TurnRefusal)
    expect(leaseCalls).not.toContain('start')
  })

  it('claims room admission atomically for a workspace session', async () => {
    await runAssistantTurn(params('sse', { policy: { admission: 'room' } }))
    expect(leaseCalls[0]).toBe('claim')
  })

  it('heart-beats a held lease and leaves its release to the runner', async () => {
    loopEvents = [textTurn('x')]
    await runAssistantTurn(params('sse', {
      lease: { mode: 'held', token: 'held-tok' },
      sink: { kind: 'sse', onEvent: () => new Promise((r) => setTimeout(r, 30)) },
    }))
    expect(leaseCalls).toContain('touch')
    expect(leaseCalls).not.toContain('release')
  })

  it('stops delivering events once the turn is aborted', async () => {
    const abortController = new AbortController()
    const seen: unknown[] = []
    loopEvents = [textTurn('a'), textTurn('b')]
    await runAssistantTurn(params('sse', {
      abortController,
      sink: { kind: 'sse', onEvent: (e) => { seen.push(e); abortController.abort() } },
    }))
    expect(seen).toHaveLength(1)
  })

  it('takes no lease when the turn has no sessions row', async () => {
    await runAssistantTurn(params('return', { lease: { mode: 'none' } }))
    expect(leaseCalls).toEqual([])
    expect(vi.mocked(releaseTurnLease)).not.toHaveBeenCalled()
  })

  it('sanitizes final text for final-only sinks, not for the SSE stream', async () => {
    loopEvents = [textTurn('Enjoy your Sunday! (Word count: ~65)')]
    const adapter = await runAssistantTurn(params('adapter'))
    expect(adapter.finalText).toBe('Enjoy your Sunday!')
    const sse = await runAssistantTurn(params('sse'))
    expect(sse.finalText).toBeNull()
  })

  it('runs the loop under the stall watchdog, never a wall clock', async () => {
    await runAssistantTurn(params('return'))
    expect(typeof loopOptions[0]?.stallIdleMs).toBe('number')
  })

  it('serves a custom endpoint as resolved and a registry model only when servable', () => {
    const custom = { provider: {} as never, model: 'custom:abc', configuredProviders: new Set(['gemini']) as never, customLlm: {} as never }
    expect(servedTurnModel(custom)).toBe('custom:abc')
    const platform = { provider: {} as never, model: 'gemini-flash', configuredProviders: undefined, customLlm: null }
    expect(servedTurnModel(platform)).toBe('gemini-flash')
  })
})

describe('[COMP:api/turn-kernel] turn billing (D2)', () => {
  const assistant = { id: 'a', ownerUserId: null, workspaceId: 'w' }

  it('bills a workspace-audience turn to the workspace party and records the addresser', async () => {
    const billing = await resolveTurnBilling({
      policy: { billing: 'workspace' }, assistant, actorUserId: 'addresser',
      resolveWorkspaceParty: async () => 'workspace-owner',
    })
    expect(turnUsageIdentity(billing)).toEqual({ userId: 'workspace-owner', actorUserId: 'addresser' })
  })

  it('bills a personal turn to its human', async () => {
    const billing = await resolveTurnBilling({
      policy: { billing: 'user' }, assistant, actorUserId: 'me',
      resolveWorkspaceParty: async () => 'workspace-owner',
    })
    expect(turnUsageIdentity(billing)).toEqual({ userId: 'me', actorUserId: 'me' })
  })

  it('takes a machine lane\'s explicit payer', async () => {
    const billing = await resolveTurnBilling({
      policy: { billing: 'workspace' }, assistant, actorUserId: null, explicitPayerUserId: 'caller',
    })
    expect(turnUsageIdentity(billing)).toEqual({ userId: 'caller' })
  })
})
