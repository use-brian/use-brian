import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../db/client.js', () => ({ query: vi.fn() }))
import { query } from '../db/client.js'
import { queryLoop, wrapFallback, NOOP_TURN_LEDGER, type ToolContext, type Message, type ProviderRequest, type LLMProvider, type StreamChunk, type QueryEvent } from '@use-brian/core'
import { NATIVE_PROTOCOL, type NativeCommand, type NativeObservation, type NativeProfileGrant } from '@use-brian/computer-control/protocol.js'
import { composeComputerProfileTools } from './profile-tools.js'
import { createProfileImagePolicy, trackProfileImageRoutes } from './profile-image-policy.js'
import type { NativeComputerService } from './service.js'

const MODEL = 'gemini-3.8-flash'
const IMAGE = Buffer.from('synthetic closed public fixture screenshot').toString('base64')
const bounds = { x: 0, y: 0, width: 200, height: 100 }
const target = { appId: 'com.usebrian.NativeComputerFixture', processId: 1, processInstanceId: 'process', windowId: 'window', windowInstanceId: 'instance' }
const usage = { inputTokens: 10, outputTokens: 2 }
function fixture() {
  const identity = { deploymentId: 'deployment', userId: 'owner', workspaceId: 'workspace', deviceId: 'device', sessionId: 'lease', conversationId: 'chat', profileId: 'profile' }
  const grant: NativeProfileGrant = { protocol: NATIVE_PROTOCOL, identity, grantId: 'grant', epoch: 1, expiresAt: Date.now() + 60000,
    targets: [target], allowCapture: true, allowControl: true, requester: 'owner', purpose: 'chat-tools' }
  const observation = (id: string, capture = false): NativeObservation => ({ identity, epoch: 1, id, capturedAt: Date.now(), monotonicMs: 1,
    target, foreground: true, bounds, displayLayoutVersion: 'layout', completeness: 'complete', nodes: [], captureCohort: 'public-shapes-v1',
    ...(capture ? { frame: { id: 'original-frame', mimeType: 'image/png', data: IMAGE, width: 200, height: 100, bounds, displayLayoutVersion: 'layout' } } : {}) })
  let live = true
  let afterDispatch: (() => void) | undefined
  let patchObservation: ((observation: NativeObservation) => void) | undefined
  const dispatch = vi.fn(async (_scope: unknown, command: NativeCommand) => {
    const obs = observation(command.action.kind === 'capture' ? 'captured' : command.action.kind === 'observe' ? 'observed' : 'acted', command.action.kind === 'capture')
    patchObservation?.(obs)
    afterDispatch?.()
    return { outcome: 'executed', code: 'ok', observation: obs }
  })
  const service = { assertPolicy: vi.fn(async () => { if (!live) throw new Error('revoked') }),
    profiles: { list: vi.fn(async () => [{ id: 'profile', name: 'Fixture', connected: true, assistantRoutingNotes: {} }]), request: vi.fn(async () => ({ code: 'local_consent_required' })) },
    profileBinding: vi.fn(async (scope: unknown) => live ? { grant, scope: { ...(scope as object), taskId: null, profileId: 'profile', connectionId: 'connection' } } : null),
    assertProfilePublication: vi.fn(async () => { if (!live) throw new Error('revoked') }),
    releaseProfile: vi.fn(async () => { live = false }), revoke: vi.fn(async () => { live = false }), dispatch,
  } as unknown as NativeComputerService
  vi.mocked(query).mockResolvedValue({ rows: [{ id: 'profile' }] } as never)
  const requests: ProviderRequest[] = []
  let steps = ['computerObserve', 'computerCapture', 'computerAct', 'answer']
  let upstreamModel = MODEL
  let onImageUpload: (() => void) | undefined
  const provider: LLMProvider = { name: 'configured', models: [MODEL], createSession: vi.fn(() => { throw new Error('stateful forbidden') }),
    stream: vi.fn(async function* (req): AsyncGenerator<StreamChunk> {
      requests.push(req)
      if (req.nativeImageChat) onImageUpload?.()
      const step = steps.shift() ?? 'answer'
      yield { type: 'message_start', model: req.model }
      if (step === 'answer') yield { type: 'text_delta', text: 'Observed the fixture; no acceptance claim.' }
      else {
        const input = step === 'computerObserve' ? {} : step === 'computerCapture' ? { observationId: 'observed' }
          : { observationId: 'captured', action: { kind: 'visualInvoke', frameId: 'original-frame', x: 50, y: 30 } }
        yield { type: 'tool_use_start', id: step, name: step }
        yield { type: 'tool_use_delta', id: step, input: JSON.stringify(input) }
        yield { type: 'tool_use_end', id: step }
      }
      yield { type: 'message_end', stopReason: step === 'answer' ? 'end_turn' : 'tool_use', usage,
        ...(req.nativeImageChat ? { nativeMetadata: { actualModel: upstreamModel, usage } } : {}) }
    }) }
  const context: ToolContext = { userId: 'owner', workspaceId: 'workspace', assistantId: 'assistant', sessionId: 'chat', appId: 'chat', channelType: 'web', channelId: 'chat',
    abortSignal: new AbortController().signal, activeCapabilities: new Set(['native_computer']), engineRuntime: { provider, model: MODEL, imageUploads: true } }
  const options = { provider, configuredProviders: new Set(['gemini']), getWorkspacePlan: vi.fn(async () => 'enterprise'),
    resolveWorkspaceCustomLlm: vi.fn(async () => null), imageApproval: { accepted: true, model: MODEL },
    budget: { tokens: 10000000, costUsd: 1000, attemptTokens: 32768, attemptCostUsd: 3.2768 } }
  const settle = vi.fn(async () => {})
  const imageAccounting = vi.fn(async () => ({ settle }))
  const tools = () => composeComputerProfileTools(service, createProfileImagePolicy(options), imageAccounting)
  const events: QueryEvent[] = []
  const history: Message[] = [{ role: 'user', content: 'Observe, capture and propose one locally approved fixture action.' }]
  async function run(params: { provider?: LLMProvider; model?: string; messages?: Message[]; context?: ToolContext; onEvent?: (event: QueryEvent) => void } = {}) {
    const toolSet = tools()
    for await (const event of queryLoop({ ledger: NOOP_TURN_LEDGER, provider: params.provider ?? provider, model: params.model ?? MODEL,
      systemPrompt: 'Only the closed public fixture. Never claim native acceptance.', messages: params.messages ?? history.slice(0, 1),
      tools: new Map(Object.values(toolSet).map(t => [t.name, t])), context: params.context ?? context, maxTurns: 6 })) {
      events.push(event)
      if (event.type === 'assistant_turn') {
        history.push({ role: 'assistant', content: event.response.content })
        if (event.toolResults.length) history.push({ role: 'user', content: event.toolResults })
      }
      params.onEvent?.(event)
    }
  }
  return { grant, service, provider, context, options, requests, dispatch, tools, run, events, history, settle, imageAccounting,
    set live(value: boolean) { live = value }, set afterDispatch(value: (() => void) | undefined) { afterDispatch = value },
    set patchObservation(value: ((o: NativeObservation) => void) | undefined) { patchObservation = value },
    set steps(value: string[]) { steps = value }, set upstreamModel(value: string) { upstreamModel = value },
    set onImageUpload(value: (() => void) | undefined) { onImageUpload = value } }
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

async function capture(f: ReturnType<typeof fixture>) {
  const tools = f.tools()
  await tools.computerObserve.execute({}, f.context)
  const result = await tools.computerCapture.execute({ observationId: 'observed' }, f.context)
  return { tools, result }
}
function hasBytes(value: unknown) { return JSON.stringify(value).includes(IMAGE) }

describe('normal profile chat capture and visual actions', () => {
  it('runs observe → capture → SAME route image upload → one frame-bound visual action with normal accounting and opaque history', async () => {
    const f = fixture()
    // An inherited/forged parent lane cannot select the upload route.
    const parent = { ...f.provider, name: 'wrong-parent' }
    f.context.engineRuntime = { provider: parent, model: 'wrong', imageUploads: false }
    f.context.workerRuntime = { provider: parent, model: 'wrong' }
    await f.run()
    expect(f.provider.createSession).not.toHaveBeenCalled()
    expect(f.dispatch.mock.calls.map(c => c[1].action.kind)).toEqual(['observe', 'capture', 'visualInvoke'])
    expect(f.dispatch.mock.calls[2][1].action).toEqual({ kind: 'visualInvoke', target, observationId: 'captured', frameId: 'original-frame', x: 50, y: 30 })
    expect(f.requests).toHaveLength(4)
    expect(f.requests.map(hasBytes)).toEqual([false, false, true, false])
    expect(f.requests[2]).toMatchObject({ model: MODEL, nativeStrict: true, nativeImageChat: true, allowProviderFallback: false })
    expect(f.requests[2].tools?.some(t => t.name === 'computerAct')).toBe(true)
    expect(hasBytes(f.history)).toBe(false)
    expect(hasBytes(f.events)).toBe(false)
    expect(JSON.stringify(f.history)).toContain('native-image-ref:')
    expect(JSON.stringify(f.history)).toContain('original-frame')
    expect(JSON.stringify(f.history)).toContain('width')
    const completed = [...f.events].reverse().find(e => e.type === 'turn_complete')
    expect(completed).toMatchObject({ totalUsage: { inputTokens: 30, outputTokens: 6 } })
    expect(f.service.assertProfilePublication).toHaveBeenCalled()
  })

  it.each(['unaccepted', 'wrong_model', 'wrong_provider', 'custom_endpoint', 'budget', 'local_capture', 'revoked', 'cohort'] as const)('refuses %s before capture without alternate inference', async scenario => {
    const f = fixture()
    if (scenario === 'unaccepted') f.options.imageApproval.accepted = false
    if (scenario === 'wrong_model') f.options.imageApproval.model = 'other'
    if (scenario === 'wrong_provider') f.context.engineRuntime = { provider: { ...f.provider }, model: MODEL, imageUploads: true }
    if (scenario === 'custom_endpoint') f.options.resolveWorkspaceCustomLlm.mockResolvedValue({ routeKind: 'custom', selector: MODEL } as never)
    if (scenario === 'budget') f.options.budget.tokens = 262144
    if (scenario === 'local_capture') f.grant.allowCapture = false
    if (scenario === 'cohort') f.patchObservation = o => { delete o.captureCohort }
    const tools = f.tools()
    await tools.computerObserve.execute({}, f.context)
    if (scenario === 'revoked') f.live = false
    const result = await tools.computerCapture.execute({ observationId: 'observed' }, f.context)
    expect(result.isError).toBe(true)
    expect(result.images).toBeUndefined()
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.requests).toHaveLength(0)
  })

  it.each(['layout', 'bounds', 'identity', 'epoch', 'target', 'sensitive'] as const)('discards a capture receipt with mismatched %s binding', async scenario => {
    const f = fixture(), tools = f.tools()
    await tools.computerObserve.execute({}, f.context)
    f.patchObservation = o => {
      if (scenario === 'layout') o.frame!.displayLayoutVersion = 'other'
      if (scenario === 'bounds') o.frame!.bounds = { ...bounds, x: 1 }
      if (scenario === 'identity') o.identity = { ...o.identity, conversationId: 'other' }
      if (scenario === 'epoch') o.epoch++
      if (scenario === 'target') o.target = { ...o.target, windowInstanceId: 'other' }
      if (scenario === 'sensitive') o.nodes = [{ ref: 'secret', role: 'text', name: '', enabled: false, focused: false, selected: false, sensitive: true, actions: [] }]
    }
    const result = await tools.computerCapture.execute({ observationId: 'observed' }, f.context)
    expect(result.isError).toBe(true)
    expect(result.images).toBeUndefined()
    expect(hasBytes(result)).toBe(false)
  })

  it('rejects a model-supplied frame ID even after the actual cached image was uploaded', async () => {
    const f = fixture()
    f.patchObservation = o => { if (o.frame) o.frame.id = 'server-original-frame' }
    await f.run()
    expect(f.requests.some(hasBytes)).toBe(true)
    expect(f.dispatch.mock.calls.map(c => c[1].action.kind)).toEqual(['observe', 'capture'])
    expect(JSON.stringify(f.events)).toContain('fresh_frame_required')
  })

  it.each(['capture', 'observe'] as const)('preserves post-dispatch revalidation and discards revoked %s content', async kind => {
    const f = fixture(), tools = f.tools()
    if (kind === 'capture') await tools.computerObserve.execute({}, f.context)
    f.afterDispatch = () => { f.live = false }
    const result = await (kind === 'capture' ? tools.computerCapture.execute({ observationId: 'observed' }, f.context) : tools.computerObserve.execute({}, f.context))
    expect(result).toEqual({ data: { code: 'unavailable' }, isError: true })
  })

  it.each(['revoked', 'capture_revoked', 'credits', 'route_changed', 'expired'] as const)('withholds before upload when %s after tool publication', async scenario => {
    const f = fixture()
    if (scenario === 'expired') vi.useFakeTimers({ toFake: ['Date'] })
    await f.run({ onEvent(event) {
      if (event.type !== 'tool_result' || !event.results.some(b => b.type === 'image')) return
      if (scenario === 'revoked') f.live = false
      if (scenario === 'capture_revoked') f.grant.allowCapture = false
      if (scenario === 'credits') Object.assign(f.options, { checkCreditBudget: async () => ({ status: 'blocked' }) })
      if (scenario === 'route_changed') f.options.resolveWorkspaceCustomLlm.mockResolvedValue({ routeKind: 'custom', selector: MODEL } as never)
      if (scenario === 'expired') vi.setSystemTime(Date.now() + 5001)
    } })
    expect(f.requests.some(hasBytes)).toBe(false)
    expect(f.dispatch.mock.calls.some(c => c[1].action.kind === 'visualInvoke')).toBe(false)
    expect(JSON.stringify(f.requests)).toContain('screenshot withheld')
  })

  it.each(['wrong_model', 'revoked', 'stale'] as const)('buffers model tool calls until %s response provenance/authority is checked', async scenario => {
    const f = fixture()
    if (scenario === 'stale') vi.useFakeTimers({ toFake: ['Date'] })
    if (scenario === 'wrong_model') f.upstreamModel = 'substituted-model'
    if (scenario === 'revoked') f.onImageUpload = () => { f.live = false }
    if (scenario === 'stale') f.onImageUpload = () => { vi.setSystemTime(Date.now() + 5001) }
    await f.run()
    expect(f.requests.some(hasBytes)).toBe(true)
    expect(f.dispatch.mock.calls.some(c => c[1].action.kind === 'visualInvoke')).toBe(false)
    expect(f.settle).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', usage }))
    if (scenario === 'wrong_model') {
      expect(JSON.stringify(f.events)).toContain('response withheld')
      expect([...f.events].reverse().find(e => e.type === 'turn_complete')).toMatchObject({ totalUsage: { inputTokens: 20, outputTokens: 4 } })
    } else expect(f.events.some(e => e.type === 'error')).toBe(true)
  })

  it.each(['provider', 'model', 'owner', 'expired'] as const)('does not leak opaque persisted image history on future %s change', async scenario => {
    const f = fixture()
    if (scenario === 'expired') vi.useFakeTimers({ toFake: ['Date'] })
    f.steps = ['computerObserve', 'computerCapture', 'answer']
    await f.run()
    const prior = JSON.parse(JSON.stringify(f.history)) as Message[]
    const changed: LLMProvider = { ...f.provider, name: 'other' }
    const n = f.requests.length
    if (scenario === 'expired') vi.setSystemTime(Date.now() + 5001)
    await f.run({ messages: prior,
      provider: scenario === 'provider' ? changed : f.provider,
      model: scenario === 'model' ? 'claude-haiku-4-5' : MODEL,
      context: scenario === 'owner' ? { ...f.context, sessionId: 'other-chat' } : f.context })
    expect(f.requests.slice(n).some(hasBytes)).toBe(false)
  })

  it('rejects unknown/unseen/stale frame IDs and does not refresh timestamps on cache reuse', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const f = fixture(), { tools } = await capture(f)
    for (const frameId of ['unknown', 'original-frame']) {
      const result = await tools.computerAct.execute({ observationId: 'captured', action: { kind: 'visualInvoke', frameId, x: 20, y: 20 } }, f.context)
      expect(result.isError).toBe(true) // image was never uploaded to the approved model
    }
    vi.setSystemTime(Date.now() + 5001)
    const result = await tools.computerCapture.execute({ observationId: 'captured' }, f.context)
    expect(result).toMatchObject({ data: { code: 'fresh_observation_required' } })
    expect(f.dispatch).toHaveBeenCalledTimes(2)
  })

  it('neither retries nor fails over a screenshot; later failover receives only withheld opaque history', async () => {
    const f = fixture()
    const fallbackRequests: ProviderRequest[] = []
    const fallback: LLMProvider = { ...f.provider, name: 'fallback', stream: vi.fn(async function* (request: ProviderRequest): AsyncGenerator<StreamChunk> {
      fallbackRequests.push(request)
      yield { type: 'message_start', model: request.model }
      yield { type: 'text_delta', text: 'No screenshot available.' }
      yield { type: 'message_end', stopReason: 'end_turn', usage }
    }) }
    const wrapped = wrapFallback(f.provider, fallback)
    f.options.provider = wrapped
    f.context.engineRuntime = { provider: wrapped, model: MODEL, imageUploads: true }
    f.onImageUpload = () => { throw Object.assign(new Error('native_provider_failure'), { status: 503 }) }
    await f.run({ provider: wrapped })
    expect(f.requests.filter(hasBytes)).toHaveLength(1)
    expect(fallbackRequests).toHaveLength(0)
    expect(f.dispatch.mock.calls.map(c => c[1].action.kind)).toEqual(['observe', 'capture'])
    const failing: LLMProvider = { ...f.provider, stream: async function* () { throw Object.assign(new Error('503'), { status: 503 }) } }
    await f.run({ provider: wrapFallback(failing, fallback), messages: JSON.parse(JSON.stringify(f.history)) })
    expect(fallbackRequests).toHaveLength(1)
    expect(fallbackRequests.some(hasBytes)).toBe(false)
    expect(JSON.stringify(fallbackRequests)).toContain('screenshot withheld')
  })

  it('accepts registered managed instances, not a same-name/provider/model forged worker lane', async () => {
    const f = fixture()
    const managed = { ...f.provider }
    const tracked = trackProfileImageRoutes(async () => ({ provider: managed, selector: MODEL, routeKind: 'managed',
      providerKeySource: 'platform', modelTier: 'standard', supportsVision: true, fallback: { enabled: false } } as never))
    await tracked.resolve({ workspaceId: 'workspace', requestedTier: 'standard' })
    Object.assign(f.options, { resolveWorkspaceCustomLlm: tracked.resolve, managedRoutes: tracked.managedRoutes })
    await f.run({ provider: managed })
    expect(f.requests.map(hasBytes)).toEqual([false, false, true, false])
    expect(f.dispatch.mock.calls.map(c => c[1].action.kind)).toEqual(['observe', 'capture', 'visualInvoke'])
    const forged = { ...managed }
    const forgedContext = { ...f.context, engineRuntime: { provider: forged, model: MODEL, imageUploads: true },
      workerRuntime: { provider: forged, model: MODEL, modelTier: 'standard', providerKeySource: 'platform' as const } }
    expect(await createProfileImagePolicy({ ...f.options, managedRoutes: tracked.managedRoutes })(forgedContext,
      { id: 'new-grant', expiresAt: f.grant.expiresAt })).toBeNull()
  })

  it('preserves non-refundable per-lease reservations across captures and denies exhausted budgets', async () => {
    const f = fixture()
    f.options.budget.tokens = 4 * 1024 * 1024 + 32768
    const policy = createProfileImagePolicy(f.options)
    const lease = { id: f.grant.grantId, expiresAt: f.grant.expiresAt }
    const permit = (await policy(f.context, lease))!
    expect(permit).not.toBeNull()
    await permit.reserve(f.context, 1)
    await expect(permit.reserve(f.context, 1)).rejects.toThrow('budget exhausted')
    expect(await policy(f.context, lease)).toBeNull()
  })

  it('never reuses an observation after uncertain capture', async () => {
    const f = fixture(), tools = f.tools()
    await tools.computerObserve.execute({}, f.context)
    f.dispatch.mockResolvedValueOnce({ outcome: 'execution_unknown', code: 'uncertain' } as never)
    const result = await tools.computerCapture.execute({ observationId: 'observed' }, f.context)
    expect(result.isError).toBe(true)
    expect(result.images).toBeUndefined()
    expect(await tools.computerCapture.execute({ observationId: 'observed' }, f.context)).toMatchObject({ data: { code: 'fresh_observation_required' } })
    expect(f.dispatch).toHaveBeenCalledTimes(2)
  })
})
