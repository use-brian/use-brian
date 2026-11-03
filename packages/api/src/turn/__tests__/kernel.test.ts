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

let simulateModelBoundaries = false
let loopBeforeEvent: ((index: number) => void) | null = null
let loopEvents: unknown[] = []
let loopThrows: Error | null = null
let loopCleanup: (() => Promise<void>) | null = null
const loopOptions: Array<Record<string, unknown>> = []
vi.mock('@use-brian/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@use-brian/core')>()
  return {
    ...actual,
    queryLoop: vi.fn(async function* (options: Record<string, unknown>) {
      loopOptions.push(options)
      const context = options.context as import('@use-brian/core').ToolContext
      if (simulateModelBoundaries) await context.assertModelInputAuthority?.(context)
      for (const [index, event] of loopEvents.entries()) {
        loopBeforeEvent?.(index)
        if (simulateModelBoundaries) await actual.assertModelOutputAuthority(context)
        yield event
      }
      await loopCleanup?.()
      if (loopThrows) throw loopThrows
    }),
  }
})

// Keep the module's host-boundary exports available to the real kernel; only the
// live source checks are replaced with probes in this unit-test module.
vi.mock('../../application-platform/model-source-authority.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../application-platform/model-source-authority.js')>()
  return { ...actual, assertSourceModelInputAuthority: vi.fn(async () => {}), assertSourceModelOutputAuthority: vi.fn(async () => {}) }
})
vi.mock('../../context-scope/attended-audience.js', () => ({
  validateAttendedAudienceEvidence: vi.fn(), createAttendedDeliveryAudienceAuthorizer: vi.fn(),
}))

import { ContextScopeAccumulator, createExecutionContext, executionToolContext, type ScopeSource, type ToolContext } from '@use-brian/core'
import type { Session } from '../../db/sessions.js'
import { createWebResponsePermissionSnapshot } from '../../context-scope/response-permission-snapshot.js'
import { validateAttendedAudienceEvidence, createAttendedDeliveryAudienceAuthorizer } from '../../context-scope/attended-audience.js'
import { assertSourceModelInputAuthority, assertSourceModelOutputAuthority } from '../../application-platform/model-source-authority.js'
import { runAssistantTurn, TurnRefusal, servedTurnModel, turnUsageIdentity, type TurnSinkKind } from '../kernel.js'
import { resolveTurnBilling } from '../billing.js'
import { isTurnLeaseLive, releaseTurnLease } from '../../db/sessions.js'
import { createChatPostReplyBoundary } from '../../routes/chat-post-reply.js'
import { AuthorityChangedError } from '../../context-scope/authority-lease.js'

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
  simulateModelBoundaries = false
  loopBeforeEvent = null
  vi.mocked(assertSourceModelInputAuthority).mockReset().mockResolvedValue(undefined)
  vi.mocked(assertSourceModelOutputAuthority).mockReset().mockResolvedValue(undefined)
  vi.mocked(validateAttendedAudienceEvidence).mockReset().mockImplementation(async (_execution, evidence) => evidence)
  vi.mocked(createAttendedDeliveryAudienceAuthorizer).mockReset().mockReturnValue(vi.fn(async () => { throw new Error('Unexpected independent-source fallback') }))
  loopEvents = []
  loopThrows = null
  loopCleanup = null
  loopOptions.length = 0
  vi.mocked(isTurnLeaseLive).mockResolvedValue(false)
})

describe('[COMP:api/turn-kernel] runAssistantTurn', () => {
  it('settles reply presentation before delayed cleanup while keeping publication and lease held', async () => {
    const response = textTurn('Hello.').response
    loopEvents = [textTurn('Hello.'), { type: 'turn_complete', response, totalUsage: response.usage }]
    let finishCleanup!: () => void
    loopCleanup = () => new Promise<void>(resolve => { finishCleanup = resolve })
    const textComplete = vi.fn(), publish = vi.fn()
    const run = runAssistantTurn(params('sse', { sink: {
      kind: 'sse', onReplyTextComplete: textComplete, afterLoop: publish,
    } }))
    await vi.waitFor(() => expect(textComplete).toHaveBeenCalledOnce())
    expect(publish).not.toHaveBeenCalled()
    expect(leaseCalls).not.toContain('release')
    finishCleanup()
    await run
    expect(publish).toHaveBeenCalledOnce()
    expect(leaseCalls.at(-1)).toBe('release')
  })

  it('does not announce intermediate text, narration or output refused at the sink', async () => {
    const response = textTurn('Hello.').response
    for (const terminal of [false, true]) {
      loopEvents = [textTurn('Hello.')]
      if (terminal) loopEvents.push({ type: 'turn_complete', response, totalUsage: response.usage })
      const textComplete = vi.fn()
      const options = params('sse', { sink: { kind: 'sse', onReplyTextComplete: textComplete,
        ...(terminal ? { assertOutputAuthority: async () => { throw new AuthorityChangedError() } } : {}),
      } })
      if (terminal) {
        const authority = {}, executionContext = { security: { authority } }
        options.loop.context = { authority, executionContext, scopeAccumulator: { evidence: {} } } as never
      }
      if (terminal) await expect(runAssistantTurn(options)).rejects.toBeInstanceOf(AuthorityChangedError)
      else await runAssistantTurn(options)
      expect(textComplete).not.toHaveBeenCalled()
    }
    const narration = { ...response, content: [{ type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'call', name: 'search', input: {} }] }
    loopEvents = [{ type: 'assistant_turn', response: narration },
      { type: 'turn_complete', response: narration, totalUsage: response.usage }]
    const textComplete = vi.fn()
    await runAssistantTurn(params('sse', { sink: { kind: 'sse', onReplyTextComplete: textComplete } }))
    expect(textComplete).not.toHaveBeenCalled()
  })

  it('distinguishes a refused follow-up after a published reply from a failed publication', async () => {
    for (const publicationFails of [false, true]) {
      loopEvents = [textTurn('hello')]
      const boundary = createChatPostReplyBoundary(), abortController = new AbortController()
      const laterWork = vi.fn()
      let failure: unknown
      try {
        await runAssistantTurn(params('sse', { abortController, sink: {
          kind: 'sse', afterLoop: async result => {
            boundary.beginFinalization(result, false, abortController.signal)
            if (publicationFails) throw new AuthorityChangedError()
            boundary.recordPublishedReply([{ type: 'text', text: 'hello' }])
            throw new AuthorityChangedError()
          },
        } }))
        laterWork()
      } catch (error) { failure = error }
      expect(laterWork).not.toHaveBeenCalled()
      expect(leaseCalls.at(-1)).toBe('release')
      expect(boundary.notice(failure)?.code ?? null)
        .toBe(publicationFails ? null : 'post_reply_authority_changed')
    }
  })

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

  it('refuses a route output hook that replaces the invocation before final sink handling',async () => {
    const afterLoop = vi.fn(),context = { scopeAccumulator: undefined,
      assertModelOutputAuthority: async (current: { scopeAccumulator?: unknown }) => { current.scopeAccumulator = {} } }
    await expect(runAssistantTurn(params('return',{ loop: { ...params('return').loop,context: context as never },
      sink: { kind: 'return',afterLoop } }))).rejects.toMatchObject({ reason: 'authority_changed',retrySafe: false })
    expect(afterLoop).not.toHaveBeenCalled()
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

  it('keeps heartbeating through awaited post-turn persistence and propagates its refusal', async () => {
    loopEvents = [textTurn('Fictional final response')]
    const refused = Object.assign(new Error('Current context unavailable'), { reason: 'authority_changed' })
    await expect(runAssistantTurn(params('adapter', {
      sink: { kind: 'adapter', afterLoop: async () => {
        const touched = leaseCalls.filter(call => call === 'touch').length
        await new Promise(resolve => setTimeout(resolve, 30))
        expect(leaseCalls.filter(call => call === 'touch').length).toBeGreaterThan(touched)
        expect(leaseCalls).not.toContain('release')
        throw refused
      } },
    }))).rejects.toBe(refused)
    expect(leaseCalls.at(-1)).toBe('release')
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

function snapshotTurnFixture() {
  const controller = new AbortController()
  const authority = { assertCurrent: vi.fn(async () => {}), execute: async <T,>(operation: () => Promise<T>) => operation() }
  const execution = createExecutionContext({
    identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: 'actor', authenticationKind: 'native_session' } },
    ownership: { kind: 'workspace', workspaceId: 'workspace' },
    access: { workspaceId: 'workspace', userId: 'actor', assistantId: 'assistant', assistantKind: 'standard',
      clearance: 'confidential', compartments: null, mutationCompartments: null, projectIds: null, visibilityAssistantIds: ['assistant'] },
    writeDefaults: { compartments: [], projectIds: [] }, authority,
    lifecycle: { sessionId: 's-1', channelType: 'web', channelId: 'channel', abortSignal: controller.signal },
  })
  const initial: ScopeSource = { resourceKind: 'memory', resourceId: 'initial', version: '1', workspaceId: 'workspace',
    userId: 'actor', assistantId: null, sensitivity: 'internal', compartments: ['finance'], projectIds: [] }
  const accumulator = new ContextScopeAccumulator({ sources: [initial] })
  const context: ToolContext = { ...executionToolContext(execution, { appId: 'chat' }), scopeAccumulator: accumulator }
  const session = { id: 's-1', userId: 'actor', channelType: 'web', channelId: 'channel',
    visibility: 'personal', anchorKind: 'none', appOrigin: 'chat' } as Session
  const snapshot = createWebResponsePermissionSnapshot(execution, accumulator, session)!
  expect(snapshot).toBeDefined()
  const options = params('sse', { abortController: controller,
    loop: { ...params('sse').loop, context },
    sink: { kind: 'sse', responsePermissionSnapshot: snapshot, assertOutputAuthority: snapshot.assertOutputAuthority },
  })
  return { execution, authority, initial, accumulator, context, snapshot, options }
}

describe('[COMP:api/turn-kernel] response permission snapshot integration', () => {
  it('keeps model-input admission live while amortizing snapshot output across engine hooks, streamed events, and finalization', async () => {
    const f = snapshotTurnFixture(), routeInput = vi.fn(async () => {}), routeOutput = vi.fn(async () => {})
    f.context.assertModelInputAuthority = routeInput
    f.context.assertModelOutputAuthority = routeOutput
    simulateModelBoundaries = true
    loopEvents = Array.from({ length: 20 }, (_, index) => textTurn(`chunk ${index}`))
    const seen = vi.fn()
    f.options.sink.onEvent = seen
    await runAssistantTurn(f.options)
    expect(seen).toHaveBeenCalledTimes(20)
    expect(routeInput).toHaveBeenCalledTimes(1)
    expect(assertSourceModelInputAuthority).toHaveBeenCalledTimes(1)
    expect(routeOutput).toHaveBeenCalledTimes(21) // engine per event plus final core boundary
    expect(validateAttendedAudienceEvidence).toHaveBeenCalledTimes(1)
    expect(validateAttendedAudienceEvidence).toHaveBeenCalledWith(f.execution, f.accumulator.evidence,
      expect.objectContaining({ userId: 'actor' }), { directHumanSource: true })
    expect(assertSourceModelOutputAuthority).not.toHaveBeenCalled()
    expect(f.authority.assertCurrent).toHaveBeenCalled()
    // The exact hook handed to core remains a live input guard after a receipt exists.
    const coreContext = loopOptions[0].context as ToolContext
    await coreContext.assertModelInputAuthority!(coreContext)
    expect(assertSourceModelInputAuthority).toHaveBeenCalledTimes(2)
    vi.mocked(assertSourceModelInputAuthority).mockRejectedValueOnce(new Error('input source revoked'))
    await expect(coreContext.assertModelInputAuthority!(coreContext)).rejects.toThrow('input source revoked')
    expect(validateAttendedAudienceEvidence).toHaveBeenCalledTimes(1)
  })

  it('keeps live execution authority current even when unchanged output already has a snapshot receipt', async () => {
    const f = snapshotTurnFixture(), afterLoop = vi.fn()
    simulateModelBoundaries = true
    loopEvents = [textTurn('allowed'), textTurn('revoked')]
    const seen = vi.fn(() => {
      f.authority.assertCurrent.mockRejectedValue(new AuthorityChangedError())
    })
    f.options.sink.onEvent = seen
    f.options.sink.afterLoop = afterLoop
    await expect(runAssistantTurn(f.options)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(seen).toHaveBeenCalledTimes(1)
    expect(validateAttendedAudienceEvidence).toHaveBeenCalledTimes(1)
    expect(afterLoop).not.toHaveBeenCalled()
    expect(leaseCalls.at(-1)).toBe('release')
  })

  it('admits only newly observed tool evidence, with the full label floor, before rendering subsequent output', async () => {
    const f = snapshotTurnFixture()
    const toolSource: ScopeSource = { ...f.initial, resourceKind: 'workspace_file', resourceId: 'tool-result',
      sensitivity: 'confidential', compartments: ['legal'], projectIds: ['project'] }
    simulateModelBoundaries = true
    loopEvents = [textTurn('before tool'), textTurn('after tool'), textTurn('unchanged')]
    loopBeforeEvent = index => { if (index === 1) f.accumulator.note({ sources: [toolSource] }) }
    const counts: number[] = []
    f.options.sink.onEvent = () => { counts.push(vi.mocked(validateAttendedAudienceEvidence).mock.calls.length) }
    await runAssistantTurn(f.options)
    expect(counts).toEqual([1, 2, 2])
    expect(validateAttendedAudienceEvidence).toHaveBeenNthCalledWith(2, f.execution,
      { sources: [toolSource], sensitivity: 'confidential', compartments: ['finance', 'legal'], projectIds: ['project'] },
      expect.anything(), { directHumanSource: true })
    expect(assertSourceModelInputAuthority).toHaveBeenCalledTimes(1)
    expect(assertSourceModelOutputAuthority).not.toHaveBeenCalled()
  })

  it('does not render new tool evidence when snapshot admission refuses it', async () => {
    const f = snapshotTurnFixture(), seen = vi.fn(), afterLoop = vi.fn()
    simulateModelBoundaries = true
    loopEvents = [textTurn('safe'), textTurn('must not render')]
    loopBeforeEvent = index => {
      if (index !== 1) return
      f.accumulator.note({ sources: [{ ...f.initial, resourceId: 'new-tool-source' }] })
      vi.mocked(validateAttendedAudienceEvidence).mockRejectedValueOnce(new AuthorityChangedError())
    }
    f.options.sink.onEvent = seen
    f.options.sink.afterLoop = afterLoop
    await expect(runAssistantTurn(f.options)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(seen).toHaveBeenCalledTimes(1)
    expect(afterLoop).not.toHaveBeenCalled()
    expect(validateAttendedAudienceEvidence).toHaveBeenCalledTimes(2)
    expect(leaseCalls.at(-1)).toBe('release')
  })

  it.each(['sse', 'adapter', 'json', 'return', 'none'] as const)('retains full live checks without a snapshot on the %s sink', async kind => {
    const f = snapshotTurnFixture()
    f.options.sink = { kind }
    simulateModelBoundaries = true
    loopEvents = [textTurn('one'), textTurn('two')]
    await runAssistantTurn(f.options)
    // One model-input call, two engine output calls, and final output admission.
    expect(assertSourceModelInputAuthority).toHaveBeenCalledTimes(4)
    expect(assertSourceModelOutputAuthority).toHaveBeenCalledTimes(['sse', 'adapter', 'json'].includes(kind) ? 3 : 0)
    expect(validateAttendedAudienceEvidence).not.toHaveBeenCalled()
  })

  it('retains both source input and custom recipient checks for an unbranded SSE callback', async () => {
    const f = snapshotTurnFixture(), recipient = vi.fn(async () => {})
    f.options.sink = { kind: 'sse', assertOutputAuthority: recipient }
    simulateModelBoundaries = true
    loopEvents = [textTurn('one'), textTurn('two')]
    await runAssistantTurn(f.options)
    expect(assertSourceModelInputAuthority).toHaveBeenCalledTimes(4)
    expect(recipient).toHaveBeenCalledTimes(3)
    expect(validateAttendedAudienceEvidence).not.toHaveBeenCalled()
  })

  it.each(['forged snapshot', 'changed callback', 'foreign execution', 'foreign accumulator', 'replaced snapshot', 'non-SSE sink'] as const)(
    'rejects %s before rendering or publication', async kind => {
      const f = snapshotTurnFixture(), seen = vi.fn(), afterLoop = vi.fn(), counterfeit = vi.fn(async () => {})
      if (kind === 'forged snapshot') {
        f.options.sink.responsePermissionSnapshot = { ...f.snapshot, assertOutputAuthority: counterfeit }
        f.options.sink.assertOutputAuthority = counterfeit
      } else if (kind === 'changed callback') f.options.sink.assertOutputAuthority = counterfeit
      else if (kind === 'foreign execution') f.options.loop.context = snapshotTurnFixture().context
      else if (kind === 'foreign accumulator') f.context.scopeAccumulator = new ContextScopeAccumulator()
      else if (kind === 'non-SSE sink') f.options.sink.kind = 'adapter'
      else {
        // Replacement after the kernel has captured its response-bound capability.
        loopBeforeEvent = () => { f.options.sink.responsePermissionSnapshot = snapshotTurnFixture().snapshot }
      }
      simulateModelBoundaries = true
      loopEvents = [textTurn('not authorized')]
      f.options.sink.onEvent = seen
      f.options.sink.afterLoop = afterLoop
      await expect(runAssistantTurn(f.options)).rejects.toMatchObject({ reason: 'authority_changed', retrySafe: false })
      expect(seen).not.toHaveBeenCalled()
      expect(afterLoop).not.toHaveBeenCalled()
      expect(counterfeit).not.toHaveBeenCalled()
      expect(validateAttendedAudienceEvidence).not.toHaveBeenCalled()
      expect(leaseCalls.at(-1)).toBe('release')
    },
  )

  it('refuses nested ceiling grant mutation before rendering another event', async () => {
    const f = snapshotTurnFixture(), afterLoop = vi.fn()
    const seen = vi.fn(() => {
      (f.execution.security.ceiling.visibilityAssistantIds as string[]).push('another-assistant')
    })
    simulateModelBoundaries = true
    loopEvents = [textTurn('allowed'), textTurn('must not render')]
    f.options.sink.onEvent = seen
    f.options.sink.afterLoop = afterLoop
    await expect(runAssistantTurn(f.options)).rejects.toThrow()
    expect(seen).toHaveBeenCalledTimes(1)
    expect(afterLoop).not.toHaveBeenCalled()
    expect(validateAttendedAudienceEvidence).toHaveBeenCalledTimes(1)
    expect(leaseCalls.at(-1)).toBe('release')
  })

  it('rechecks callback identity after a rendered event rather than reusing its receipt', async () => {
    const f = snapshotTurnFixture(), replacement = vi.fn(async () => {}), seen = vi.fn(() => {
      f.options.sink.assertOutputAuthority = replacement
    })
    simulateModelBoundaries = true
    loopEvents = [textTurn('allowed'), textTurn('not allowed')]
    f.options.sink.onEvent = seen
    await expect(runAssistantTurn(f.options)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(seen).toHaveBeenCalledTimes(1)
    expect(replacement).not.toHaveBeenCalled()
    expect(validateAttendedAudienceEvidence).toHaveBeenCalledTimes(1)
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
