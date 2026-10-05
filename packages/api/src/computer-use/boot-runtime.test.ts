import { MutableProviderAvailability, registryRow } from '@use-brian/shared/model-registry'
import { resolveChatModelSelection } from '../model-resolution.js'
import { createOpenAICompatProvider } from '../../../core/src/providers/openai-compat.js'
import { nativeAccountingFor, registerNativeAccounting } from './accounting-capability.js'
import type { NativeBillingSettlement } from './accounting.js'
import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { NativeRunTrace, NativeTraceEventSchema, NATIVE_NEXT_ACTION, calculateCost, type LLMProvider, type ToolContext, type NativeModelInput } from '@use-brian/core'
import type { NativeTaskGrant as NativeGrant } from '@use-brian/computer-control/protocol.js'
import { createNativeComputerBootRuntimeFactory, createNativeConfiguredGrounderApproval, inspectNativeComputerModelReadiness, type NativeBootOptions } from './boot-runtime.js'

function fixture() {
  const requests: unknown[] = []
  const provider: LLMProvider = { name: 'mock', models: ['exact-grounder'], createSession: vi.fn(), stream: async function* (request) {
    requests.push(request)
    yield { type: 'message_start', model: request.model }
    yield { type: 'text_delta', text: '{"steps":[]}' }
    yield { type: 'message_end', nativeMetadata: { actualModel: request.model, usage: { inputTokens: 10, outputTokens: 4 } }, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 4 } }
  } }
  const context = { userId: 'u', workspaceId: 'w', sessionId: 'c', assistantId: 'a' } as ToolContext
  const target = { appId: 'com.apple.TextEdit', processId: 1, processInstanceId: 'p', windowId: 'w', windowInstanceId: 'wi' }
  const grant = { identity: { userId: 'u', workspaceId: 'w', conversationId: 'c', sessionId: '00000000-0000-4000-8000-000000000001', taskId: 'task' }, grantId: 'grant', targets: [target], goal: 'Write a greeting' } as NativeGrant
  const input = { goal: grant.goal, signal: new AbortController().signal, deadlineAt: Date.now() + 10000, candidates: [], observation: { target, identity: grant.identity, epoch: 1, id: 'observation', capturedAt: Date.now(), monotonicMs: 1, bounds: { x: 0, y: 0, width: 640, height: 480 }, displayLayoutVersion: 'layout', foreground: true, completeness: 'complete', nodes: [] } } as unknown as NativeModelInput
  const recordAttempt = vi.fn(async () => {})
  const recordUsage = vi.fn(async () => {})
  const options: NativeBootOptions = { recordAttempt, provider, configuredProviders: new Set(['gemini']), getWorkspacePlan: async () => 'enterprise', resolveWorkspaceCustomLlm: vi.fn(async () => null), decisionRuntime: { resolveRoute: vi.fn(async () => ({ mode: 'llm_only' as const })), run: vi.fn(), observe: vi.fn() }, usageStore: { recordUsage } as unknown as NativeBootOptions['usageStore'] }
  const prepared = new Map<string, NativeBillingSettlement>()
  // Unit capability stub. SQL insertion/receipt semantics are exercised with the
  // real OSS capability in native-metering and oss-native-accounting tests.
  registerNativeAccounting(options.usageStore!, { backend: 'oss-native-v1',
    admit: async () => ({ status: 'admitted' }),
    prepare: async settlement => {
      await (recordAttempt as (r: unknown) => Promise<void>)({ claimBilling: false, sessionId: grant.identity.sessionId,grantId: grant.grantId,
        scope: { userId: context.userId,workspaceId: context.workspaceId,assistantId: context.assistantId,conversationId: context.sessionId,taskId: grant.identity.taskId },attempt: settlement.attempt })
      if (!settlement.attempt.model || !settlement.attempt.usage || !settlement.price) return { status: 'not_ready' }
      prepared.set(settlement.key.invocationId, settlement)
      return { status: 'prepared', intentHash: 'a'.repeat(64) }
    },
    reconcile: async key => {
      const settlement = prepared.get(key.invocationId)!
      await (recordUsage as (r: unknown) => Promise<void>)({ userId: context.userId,actorUserId: context.workspaceActorUserId ?? context.userId,
        workspaceId: context.workspaceId,assistantId: context.assistantId,sessionId: context.sessionId,model: settlement.ledgerModel,
        actualCostUsd: Number(settlement.price!.amountUsd),providerKeySource: settlement.attempt.providerKeySource })
      return { status: 'recorded',receipt: { version: 1,kind: 'native_usage_inserted',backend: 'oss-native-v1',key,intentHash: 'a'.repeat(64),ledgerId: randomUUID(),amountUsd: settlement.price!.amountUsd } }
    },reconcileBatch: async () => [],
  })
  return { options, provider, context, grant, input, requests, recordUsage, recordAttempt, runtime: (trace?: NativeRunTrace) => createNativeComputerBootRuntimeFactory(options)(context, grant, trace) }
}

function managedRoute(f: ReturnType<typeof fixture>, model: string, provider = f.provider, providerKeySource: 'platform' | 'user' = 'platform') {
  provider.models = [...provider.models, model]
  const row = registryRow(model)
  if (row) f.options.configuredProviders = new Set([...f.options.configuredProviders, row.provider])
  f.options.resolveWorkspaceCustomLlm = vi.fn(async () => ({ provider, selector: model, routeKind: 'managed', profileId: null,
    fallback: { enabled: false }, inputTokenLimit: 32768, maxTokens: 2048, supportsVision: true, providerKeySource } as never))
  f.options.resolveGrounder = async (_context, selected) => ({ ...selected, nativeGrounding: true })
}

describe('native boot composition', () => {
  it.each(['default', 'vision', 'custom', 'blocked', 'policy', 'budget', 'missing', 'fallback'] as const)('inspects %s readiness without invoking models, reserving, or writing accounting', async scenario => {
    const f = fixture()
    managedRoute(f, 'claude-sonnet-4-6')
    if (scenario === 'vision') f.options.budget = { tokens: 10000000, costUsd: 1000, attemptTokens: 32768, attemptCostUsd: 3.2768 }
    if (scenario === 'custom' || scenario === 'fallback') {
      const resolve = f.options.resolveWorkspaceCustomLlm
      f.options.resolveWorkspaceCustomLlm = async args => ({ ...(await resolve(args))!, routeKind: 'custom',
        selector: 'custom:00000000-0000-4000-8000-000000000000', fallback: { enabled: scenario === 'fallback' } as never })
    }
    if (scenario === 'blocked') f.options.checkCreditBudget = async () => ({ status: 'blocked' } as never)
    if (scenario === 'policy') f.options.decisionRuntime.resolveRoute = async () => ({ mode: 'llm_only', llm: null })
    if (scenario === 'budget') f.options.budget = { tokens: 1, costUsd: 1, attemptTokens: 1, attemptCostUsd: 1 }
    if (scenario === 'missing') { f.options.resolveWorkspaceCustomLlm = async () => null; f.options.configuredProviders = new Set() }
    const accounting = nativeAccountingFor(f.options.usageStore!)!
    const admit = vi.spyOn(accounting, 'admit'), prepare = vi.spyOn(accounting, 'prepare'), reconcile = vi.spyOn(accounting, 'reconcile')
    const result = await inspectNativeComputerModelReadiness(f.options, 'w')
    const blockers: Partial<Record<typeof scenario, string>> = { blocked: 'credits_blocked', policy: 'policy_denied', budget: 'budget_invalid', missing: 'model_unavailable', fallback: 'provider_unsupported' }
    const blocker = blockers[scenario]
    expect(result.blockers).toEqual(blocker ? [blocker] : [])
    expect(result.visionAttemptFitsBudget).toBe(scenario === 'vision')
    if (!blocker) expect(result.imageSupported).toBe(scenario !== 'custom')
    expect(f.requests).toHaveLength(0)
    expect(f.provider.createSession).not.toHaveBeenCalled()
    expect(f.options.decisionRuntime.run).not.toHaveBeenCalled()
    expect(f.recordUsage).not.toHaveBeenCalled(); expect(f.recordAttempt).not.toHaveBeenCalled()
    expect(admit).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toMatch(/gpt|custom:|modelId/)
  })
  it('does not report a built-in text task ready when its routed LLM completion is Codex', async () => {
    const f = fixture()
    f.options.decisionRuntime.resolveRoute = async () => ({ mode: 'llm_only', llm: { provider: { ...f.provider, name: 'openai-codex' }, modelId: 'gpt-5.6-luna' } })
    const report = await inspectNativeComputerModelReadiness(f.options, 'w')
    expect(report.blockers).toEqual(['provider_unsupported'])
    expect(report.warnings).toContain('native_strict_adapter_unverified')
    expect(f.requests).toHaveLength(0)
    expect(f.options.decisionRuntime.run).not.toHaveBeenCalled()
    expect(f.recordUsage).not.toHaveBeenCalled()
  })
  it.each(['credentials', 'catalog'] as const)('refuses a persisted managed model after its %s are removed, without substituting or invoking anything', async removed => {
    const f = fixture(), model = 'claude-haiku-4-5', row = registryRow(model)!
    managedRoute(f, model)
    const availability = new MutableProviderAvailability(['gemini', row.provider])
    availability.setModelCatalog(row.provider, new Set([row.apiModelId]))
    f.options.configuredProviders = availability
    expect((await inspectNativeComputerModelReadiness(f.options, 'w')).blockers).toEqual([])
    const accounting = nativeAccountingFor(f.options.usageStore!)!
    const admit = vi.spyOn(accounting, 'admit'), prepare = vi.spyOn(accounting, 'prepare'), reconcile = vi.spyOn(accounting, 'reconcile')
    if (removed === 'credentials') availability.setStaticProvider(row.provider, false)
    else availability.setModelCatalog(row.provider, new Set(['some-other-wire-model']))
    // The stale facade still advertises the selected model, and Gemini remains
    // configured. Neither is authority to serve or substitute the managed route.
    expect(f.provider.models).toContain(model)
    expect(availability.has('gemini')).toBe(true)
    expect(await inspectNativeComputerModelReadiness(f.options, 'w')).toMatchObject({ blockers: ['model_unavailable'], imageSupported: false })
    expect(await f.runtime()).toBeNull()
    expect(f.requests).toHaveLength(0)
    expect(f.provider.createSession).not.toHaveBeenCalled()
    expect(f.options.decisionRuntime.run).not.toHaveBeenCalled()
    expect(f.recordUsage).not.toHaveBeenCalled(); expect(f.recordAttempt).not.toHaveBeenCalled()
    expect(admit).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled()
  })
  it.each(['text', 'vision'] as const)('rechecks managed availability before %s provider dispatch on an existing runtime', async lane => {
    const f = fixture(), model = 'claude-haiku-4-5', row = registryRow(model)!
    managedRoute(f, model)
    const availability = new MutableProviderAvailability(['gemini', row.provider])
    f.options.configuredProviders = availability
    f.grant.targets[0]!.appId = 'com.usebrian.NativeComputerFixture'
    f.grant.allowCapture = true; f.grant.allowControl = true
    f.grant.goal = f.input.goal = 'Activate the outlined triangle; finish when Result is Triangle.'
    f.input.observation.captureCohort = 'public-shapes-v1'
    f.input.observation.frame = { id: 'frame', width: 100, height: 100, mimeType: 'image/png', data: 'private', bounds: f.input.observation.bounds, displayLayoutVersion: 'layout' }
    const runtime = (await f.runtime())!
    availability.setStaticProvider(row.provider, false)
    if (lane === 'text') delete f.input.observation.captureCohort
    await expect(lane === 'text' ? runtime.llm.plan!(f.input) : runtime.llm.vision!.propose(f.input)).rejects.toThrow()
    expect(f.requests).toHaveLength(0)
    expect(f.recordUsage).not.toHaveBeenCalled()
  })
  it.each(['missing','unregistered'] as const)('denies %s native accounting before resolving models or exposing task effects', async mode => {
    const f = fixture()
    f.options.usageStore = mode === 'missing' ? undefined : { recordUsage: f.recordUsage } as unknown as NativeBootOptions['usageStore']
    f.options.getWorkspacePlan = vi.fn(async () => 'enterprise')
    expect(await f.runtime()).toBeNull()
    expect(f.options.getWorkspacePlan).not.toHaveBeenCalled()
    expect(f.options.resolveWorkspaceCustomLlm).not.toHaveBeenCalled()
    expect(f.options.decisionRuntime.resolveRoute).not.toHaveBeenCalled()
    expect(f.requests).toHaveLength(0)
    expect(f.recordAttempt).not.toHaveBeenCalled()
    expect(f.recordUsage).not.toHaveBeenCalled()
  })
  it('does not expose unattributed legacy observation inference through the native facade', async () => {
    const f = fixture(), runtime = (await f.runtime())!
    await expect(runtime.decisionRuntime!.observe({ workspaceId: 'other-workspace' } as never)).rejects.toThrow('scoped run')
    expect(f.options.decisionRuntime.observe).not.toHaveBeenCalled()
    expect(f.options.decisionRuntime.run).not.toHaveBeenCalled()
    expect(f.requests).toHaveLength(0)
    await runtime.decisionRuntime!.resolveRoute({ workspaceId: 'other-workspace' } as never)
    expect(f.options.decisionRuntime.resolveRoute).toHaveBeenLastCalledWith({ workspaceId: 'w' })
  })
  it('runs the default concrete planner, meters trusted identity, and does not enable generic vision', async () => {
    const f = fixture(), runtime = (await f.runtime())!
    expect(runtime.decisionRuntime).toBeDefined()
    expect(runtime.llm.vision).toBeUndefined()
    expect(await runtime.llm.plan!(f.input)).toEqual([])
    expect(f.requests).toHaveLength(1)
    expect(f.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u', actorUserId: 'u', workspaceId: 'w', assistantId: 'a', sessionId: 'c', providerKeySource: 'platform' }))
  })
  it('uses custom endpoints without platform Hydra or failure fallback and attributes user-key usage', async () => {
    const f = fixture()
    f.options.resolveWorkspaceCustomLlm = vi.fn(async () => ({ provider: f.provider, selector: 'custom:00000000-0000-4000-8000-000000000000', fallback: { enabled: false }, inputTokenLimit: 32768, maxTokens: 2048, supportsVision: true, providerKeySource: 'user' } as never))
    const runtime = (await f.runtime())!
    expect(runtime.decisionRuntime).toBeUndefined()
    expect(runtime.llm.vision).toBeUndefined()
    await runtime.llm.plan!(f.input)
    expect(f.options.resolveWorkspaceCustomLlm).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w', allowFailureFallback: false }))
    expect(f.requests[0]).toMatchObject({ model: 'custom:00000000-0000-4000-8000-000000000000', allowProviderFallback: false })
    expect(f.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ providerKeySource: 'user', actualCostUsd: 0 }))
    expect(f.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({ attempt: expect.objectContaining({ model: 'custom:00000000-0000-4000-8000-000000000000', providerKind: 'custom', providerKeySource: 'user', incurredCostUsd: null, estimatedBilledCostUsd: 0 }) }))
  })
  it.each(['failed', 'partial', 'ok'] as const)('audits %s streams without inventing usage', async mode => {
    const f = fixture()
    f.options.nativeAccounting = nativeAccountingFor(f.options.usageStore)
    f.options.usageStore = undefined // Explicit native port, not a generic void store.
    f.provider.name = 'https://user:credential@example.test/token'
    f.provider.stream = async function* () {
      yield { type: 'text_delta', text: mode === 'ok' ? '{"steps":[]}' : 'private AX payload' }
      if (mode === 'ok') yield { type: 'message_end', stopReason: 'end_turn' } as never // Simulate a provider omitting usage at runtime.
      if (mode === 'failed') throw new Error('raw error with token material')
    }
    const runtime = (await f.runtime())!
    await expect(runtime.llm.plan!(f.input)).rejects.toThrow()
    expect(f.recordAttempt).toHaveBeenCalledTimes(mode === 'ok' ? 3 : 2)
    expect(f.recordAttempt).toHaveBeenCalledWith({
      claimBilling: false, sessionId: '00000000-0000-4000-8000-000000000001', grantId: 'grant',
      scope: { userId: 'u', workspaceId: 'w', assistantId: 'a', conversationId: 'c', taskId: 'task' },
      attempt: expect.objectContaining({ lane: 'text', outcome: 'failed', durationMs: expect.any(Number), usage: null, incurredCostUsd: null, estimatedBilledCostUsd: null, providerKeySource: 'platform' }),
    })
    expect(JSON.stringify(f.recordAttempt.mock.calls)).not.toMatch(/credential|private AX|raw error|token material|https:/)
    expect(f.recordUsage).not.toHaveBeenCalled()
  })
  it('records known partial usage/cost once even when parsing fails', async () => {
    const f = fixture()
    f.provider.stream = async function* (request) {
      yield { type: 'message_start', model: request.model }
      yield { type: 'text_delta', text: 'not JSON' }
      yield { type: 'message_end', nativeMetadata: { actualModel: request.model, usage: { inputTokens: 10, outputTokens: 4, calculatedCostUsd: 0.25 } }, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 4, calculatedCostUsd: 0.25 } }
    }
    await expect((await f.runtime())!.llm.plan!(f.input)).rejects.toThrow()
    expect(f.recordAttempt).toHaveBeenCalledTimes(3)
    const model = f.recordAttempt.mock.calls.map(c => (c as unknown as [{attempt:{model:string}}])[0]).find(c => c.attempt.model)?.attempt.model!
    const cost = calculateCost(model, { inputTokens: 10,outputTokens: 4 })
    expect(f.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({ attempt: expect.objectContaining({ outcome: 'failed', usage: { inputTokens: 10, outputTokens: 4 }, incurredCostUsd: cost, estimatedBilledCostUsd: cost }) }))
    expect(f.recordUsage).toHaveBeenCalledTimes(1)
    expect(f.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ actualCostUsd: Number(cost.toFixed(10)) }))
  })
  it.each([false, true])('audits failed vision with optional usage=%s and user-key costs', async knownUsage => {
    const f = fixture()
    f.grant.targets[0]!.appId = 'com.usebrian.NativeComputerFixture'
    f.grant.allowCapture = true; f.grant.allowControl = true
    f.grant.goal = f.input.goal = 'Activate the outlined triangle; finish when Result is Triangle.'
    f.input.observation.captureCohort = 'public-shapes-v1'
    f.input.observation.frame = { id: 'frame', width: 1, height: 1, mimeType: 'image/png', data: 'private image', bounds: f.input.observation.bounds, displayLayoutVersion: 'layout' }
    managedRoute(f, 'gpt-5.2', f.provider, 'user')
    f.provider.stream = async function* (request) {
      yield { type: 'message_start', model: request.model }
      yield { type: 'text_delta', text: 'partial raw output' }
      if (knownUsage) yield { type: 'message_end', nativeMetadata: { actualModel: request.model, usage: { inputTokens: 5, outputTokens: 2, calculatedCostUsd: 0.1 } }, stopReason: 'max_tokens', usage: { inputTokens: 5, outputTokens: 2, calculatedCostUsd: 0.1 } }
      throw new Error('raw provider error secret')
    }
    await expect((await f.runtime())!.llm.vision!.propose(f.input)).rejects.toThrow()
    expect(f.recordAttempt).toHaveBeenCalledTimes(knownUsage ? 3 : 2)
    expect(f.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({ attempt: expect.objectContaining({ model: knownUsage ? 'gpt-5.2' : null, lane: 'vision', outcome: 'failed', providerKeySource: 'user',
      usage: knownUsage ? { inputTokens: 5, outputTokens: 2 } : null,
      incurredCostUsd: knownUsage ? calculateCost('gpt-5.2', { inputTokens: 5, outputTokens: 2 }) : null, estimatedBilledCostUsd: knownUsage ? 0 : null }) }))
    expect(f.recordUsage).toHaveBeenCalledTimes(knownUsage ? 1 : 0)
    expect(JSON.stringify(f.recordAttempt.mock.calls)).not.toMatch(/private image|raw output|secret/)
  })
  it.each([undefined, 0.01])('meters Hydra actual route only with known pricing: %s', async calculatedCostUsd => {
    const f = fixture()
    f.provider.stream = async function* (request) {
      yield { type: 'message_start', model: request.model }
      yield { type: 'text_delta', text: '{"id":"abstain"}' }
      yield { type: 'message_end', nativeMetadata: { actualModel: request.model, usage: { inputTokens: 10, outputTokens: 4, calculatedCostUsd } }, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 4, calculatedCostUsd } }
    }
    const selected = (await f.runtime())!.llm.select(f.input, { provider: f.provider, modelId: 'exact-grounder' })
    await expect(selected).rejects.toThrow('Native accounting unavailable')
    expect(f.recordAttempt).toHaveBeenCalledTimes(3)
    expect(f.recordUsage).not.toHaveBeenCalled()
    expect(f.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({ attempt: expect.objectContaining({ model: 'exact-grounder',incurredCostUsd: null,estimatedBilledCostUsd: null }) }))
  })
  it.each(['user', 'platform'] as const)('prices the actual wire model, retaining custom route and %s key attribution', async providerKeySource => {
    const f = fixture(), requestedModel = 'custom:00000000-0000-4000-8000-000000000000'
    const model = 'claude-haiku-4-5-20251001', usage = { inputTokens: 1000, outputTokens: 100 }
    f.provider.name = 'https://user:credential@private.example'
    f.options.resolveWorkspaceCustomLlm = async () => ({ provider: f.provider, selector: requestedModel, fallback: { enabled: false }, inputTokenLimit: 32768, maxTokens: 2048, providerKeySource } as never)
    f.provider.stream = async function* (request) {
      f.requests.push(request)
      yield { type: 'message_start', model }
      yield { type: 'text_delta', text: '{"steps":[]}' }
      yield { type: 'message_end', stopReason: 'end_turn', usage, nativeMetadata: { actualModel: model, usage } }
    }
    await (await f.runtime())!.llm.plan!(f.input)
    expect(f.requests[0]).toMatchObject({ model: requestedModel })
    expect(f.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({ attempt: expect.objectContaining({ requestedModel, model,
      providerKind: 'custom', providerKeySource, incurredCostUsd: calculateCost(model, usage),
      estimatedBilledCostUsd: providerKeySource === 'user' ? 0 : calculateCost(model, usage) }) }))
    expect(f.recordUsage).toHaveBeenCalledTimes(1)
    expect(f.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ model, providerKeySource,
      actualCostUsd: providerKeySource === 'user' ? 0 : calculateCost(model, usage) }))
    expect(JSON.stringify(f.recordAttempt.mock.calls)).not.toContain('credential')
  })
  it('resolves provider kind and pricing from the actual model when the provider is a routing facade', async () => {
    const f = fixture(), model = 'claude-sonnet-4-6', usage = { inputTokens: 1000, outputTokens: 100 }
    f.provider.name = 'routing'
    f.provider.stream = async function* (request) {
      f.requests.push(request)
      yield { type: 'message_start', model }
      yield { type: 'text_delta', text: '{"steps":[]}' }
      yield { type: 'message_end', stopReason: 'end_turn', usage, nativeMetadata: { actualModel: model, usage } }
    }
    await (await f.runtime())!.llm.plan!(f.input)
    const requestedModel = (f.requests[0] as { model: string }).model
    expect(requestedModel).not.toBe(model)
    expect(f.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({ attempt: expect.objectContaining({ requestedModel, model, providerKind: 'anthropic' }) }))
    expect(f.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ model, actualCostUsd: Number(calculateCost(model, usage).toFixed(10)) }))
    expect(calculateCost(model, usage)).not.toBe(calculateCost(requestedModel, usage))
  })
  it.each([
    ['missing usage', 'claude-haiku-4-5-20251001', undefined, false, false],
    ['alias is not wire identity', 'claude-haiku-4-5', { prompt_tokens: 12, completion_tokens: 3 }, false, true],
    ['substituted model', 'claude-sonnet-4-6', { prompt_tokens: 12, completion_tokens: 3 }, false, true],
    ['unpriced substitution', 'unregistered-grounder', { prompt_tokens: 12, completion_tokens: 3 }, false, false],
    ['explicit zero', 'claude-haiku-4-5-20251001', { prompt_tokens: 0, completion_tokens: 0 }, true, true],
    ['substituted zero', 'claude-sonnet-4-6', { prompt_tokens: 0, completion_tokens: 0 }, false, true],
  ] as const)('real OpenAI-compatible native grounder: %s', async (_label, actualModel, usage, usable, billable) => {
    const f = fixture(), requestedModel = 'claude-haiku-4-5', wireModel = 'claude-haiku-4-5-20251001'
    f.grant.targets[0]!.appId = 'com.usebrian.NativeComputerFixture'
    f.grant.allowCapture = true; f.grant.allowControl = true
    f.grant.goal = f.input.goal = 'Activate the outlined triangle; finish when Result is Triangle.'
    f.input.observation.captureCohort = 'public-shapes-v1'
    f.input.observation.frame = { id: 'frame', width: 640, height: 480, mimeType: 'image/png', data: 'fixture-pixels',
      bounds: f.input.observation.bounds, displayLayoutVersion: 'layout' }
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(
      `data: ${JSON.stringify({ model: actualModel, choices: [{ delta: { content: '{"x":10,"y":20}' }, finish_reason: 'stop' }] })}\n\n`
      + (usage ? `data: ${JSON.stringify({ model: actualModel, choices: [], usage })}\n\n` : '')
      + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }))
    // Real parser/adapter: its display identity is deliberately the requested
    // alias. Only actual wire provenance can authorize the grounding output.
    const provider = createOpenAICompatProvider({ baseURL: 'https://mock.invalid/v1', label: 'fixture',
      wireModel, recordedModel: requestedModel, models: [requestedModel], fetchFn })
    managedRoute(f, requestedModel, provider)
    const runtime = (await f.runtime())!, useOutput = vi.fn()
    const result = runtime.llm.vision!.propose(f.input).then(value => { useOutput(value); return value })
    if (usable) await expect(result).resolves.toMatchObject({ kind: 'visualInvoke', x: 10, y: 20 })
    else await expect(result).rejects.toThrow()
    expect(useOutput).toHaveBeenCalledTimes(usable ? 1 : 0)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toBe('https://mock.invalid/v1/chat/completions')
    expect(init).toMatchObject({ redirect: 'error' })
    expect(JSON.parse(init!.body as string)).toMatchObject({ model: wireModel, stream_options: { include_usage: true } })
    const records = (f.recordAttempt.mock.calls as unknown as [{ attempt: { attemptId: string } }][]).map(([record]) => record.attempt)
    expect(new Set(records.map(record => record.attemptId)).size).toBe(1)
    expect(records.at(-1)).toMatchObject({ requestedModel, model: actualModel, lane: 'vision', invocationState: 'settled',
      outcome: usable ? 'ok' : 'failed', usage: usage ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens } : null })
    expect(f.recordUsage).toHaveBeenCalledTimes(billable ? 1 : 0)
    if (billable) expect(f.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ model: actualModel,
      actualCostUsd: Number(calculateCost(actualModel, { inputTokens: usage!.prompt_tokens, outputTokens: usage!.completion_tokens }).toFixed(10)) }))
    else expect(records.at(-1)).toMatchObject({ incurredCostUsd: null, estimatedBilledCostUsd: null })
  })
  it('uses the resolved built-in task route for the image rather than a separate grounder', async () => {
    const f = fixture()
    const model = resolveChatModelSelection('standard', 'enterprise', 'ok', f.options.configuredProviders).servingModel
    f.provider.models = [model]
    f.options.resolveGrounder = createNativeConfiguredGrounderApproval(true, model)
    f.grant.targets[0]!.appId = 'com.usebrian.NativeComputerFixture'
    f.grant.allowCapture = true; f.grant.allowControl = true
    f.grant.goal = f.input.goal = 'Activate the outlined triangle; finish when Result is Triangle.'
    f.input.observation.captureCohort = 'public-shapes-v1'
    f.input.observation.frame = { id: 'frame', width: 100, height: 100, data: 'private-pixels', mimeType: 'image/png', bounds: f.input.observation.bounds, displayLayoutVersion: 'layout' }
    f.provider.stream = async function* (request) {
      f.requests.push(request)
      yield { type: 'text_delta', text: 'null' }
      yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 4 },
        nativeMetadata: { actualModel: registryRow(model)!.apiModelId, usage: { inputTokens: 10, outputTokens: 4 } } }
    }
    const runtime = (await f.runtime())!
    expect(await runtime.llm.vision!.propose(f.input)).toBeNull()
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]).toMatchObject({ model, nativeStrict: true, allowProviderFallback: false })
    expect(f.recordUsage).toHaveBeenCalledTimes(1)
  })
  it.each(['gpt-5.2', 'claude-haiku-4-5'])('uses exactly the managed task provider/model for text and approved images: %s', async model => {
    const f = fixture()
    managedRoute(f, model)
    f.options.resolveGrounder = createNativeConfiguredGrounderApproval(true, model)
    f.grant.targets[0]!.appId = 'com.usebrian.NativeComputerFixture'
    f.grant.allowCapture = true; f.grant.allowControl = true
    f.grant.goal = f.input.goal = 'Activate the outlined triangle; finish when Result is Triangle.'
    f.input.observation.captureCohort = 'public-shapes-v1'
    f.input.observation.frame = { id: 'frame', width: 100, height: 100, data: 'private-pixels', mimeType: 'image/png', bounds: f.input.observation.bounds, displayLayoutVersion: 'layout' }
    f.provider.stream = async function* (request) {
      f.requests.push(request)
      const image = JSON.stringify(request.messages).includes('private-pixels')
      yield { type: 'text_delta', text: image ? '{"x":10,"y":20}' : '{"steps":[]}' }
      yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 4 }, nativeMetadata: { actualModel: model === 'claude-haiku-4-5' ? 'claude-haiku-4-5-20251001' : model, usage: { inputTokens: 10, outputTokens: 4 } } }
    }
    const runtime = (await f.runtime())!
    delete f.input.observation.captureCohort
    await runtime.llm.plan!(f.input)
    f.input.observation.captureCohort = 'public-shapes-v1'
    expect(await runtime.llm.vision!.propose(f.input)).toMatchObject({ kind: 'visualInvoke', x: 10, y: 20 })
    expect(f.requests).toHaveLength(2)
    for (const request of f.requests) expect(request).toMatchObject({ model, nativeStrict: true, allowProviderFallback: false })
    expect(JSON.stringify(f.requests[0])).not.toContain('private-pixels')
    expect(JSON.stringify(f.requests[1])).toContain('private-pixels')
    expect(f.recordUsage).toHaveBeenCalledTimes(2)
  })
  it.each(['different-global-hint', 'not-accepted', 'different-provider', 'different-key-source', 'no-image', 'registry-no-image', 'unknown-model', 'custom', 'custom-no-image'] as const)('does not expose images for %s or silently substitute a route', async scenario => {
    const f = fixture()
    managedRoute(f, scenario === 'unknown-model' ? 'unknown-model' : scenario === 'registry-no-image' ? 'qwen3.7-plus' : 'gpt-5.2')
    if (scenario === 'different-global-hint') f.options.resolveGrounder = createNativeConfiguredGrounderApproval(true, 'claude-haiku-4-5')
    if (scenario === 'not-accepted') f.options.resolveGrounder = createNativeConfiguredGrounderApproval(false, 'gpt-5.2')
    if (scenario === 'different-provider') f.options.resolveGrounder = async (_c, r) => ({ ...r, provider: { ...f.provider }, nativeGrounding: true })
    if (scenario === 'different-key-source') f.options.resolveGrounder = async (_c, r) => ({ ...r, providerKeySource: 'user', nativeGrounding: true })
    if (['no-image', 'custom', 'custom-no-image'].includes(scenario)) {
      const original = f.options.resolveWorkspaceCustomLlm
      f.options.resolveWorkspaceCustomLlm = async args => ({ ...(await original(args))!,
        ...(scenario.startsWith('custom') ? { routeKind: 'custom' as const, selector: 'custom:00000000-0000-4000-8000-000000000000' } : {}),
        supportsVision: scenario === 'custom',
      })
    }
    const runtime = (await f.runtime())!
    if (scenario === 'unknown-model') expect(runtime).toBeNull()
    else { expect(runtime).not.toBeNull(); expect(runtime.llm.vision).toBeUndefined() }
    expect(f.requests).toHaveLength(0)
    expect(f.recordUsage).not.toHaveBeenCalled()
  })
  it.each(['before-upload', 'during-upload', 'policy-revoked', 'approval-revoked', 'vision-revoked', 'provider-removed'] as const)('refuses a changed configured image route: %s', async when => {
    const f = fixture()
    managedRoute(f, 'gpt-5.2')
    f.grant.targets[0]!.appId = 'com.usebrian.NativeComputerFixture'
    f.grant.allowCapture = true; f.grant.allowControl = true
    f.grant.goal = f.input.goal = 'Activate the outlined triangle; finish when Result is Triangle.'
    f.input.observation.captureCohort = 'public-shapes-v1'
    f.input.observation.frame = { id: 'frame', width: 100, height: 100, data: 'private-pixels', mimeType: 'image/png', bounds: f.input.observation.bounds, displayLayoutVersion: 'layout' }
    const runtime = (await f.runtime())!
    const changeModel = () => { managedRoute(f, 'claude-haiku-4-5') }
    f.provider.stream = async function* (request) {
      f.requests.push(request)
      changeModel()
      yield { type: 'text_delta', text: '{"x":10,"y":20}' }
      yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 4 }, nativeMetadata: { actualModel: 'gpt-5.2', usage: { inputTokens: 10, outputTokens: 4 } } }
    }
    if (when === 'before-upload') changeModel()
    if (when === 'policy-revoked') f.options.decisionRuntime.resolveRoute = async () => ({ mode: 'llm_only', llm: null })
    if (when === 'approval-revoked') f.options.resolveGrounder = async () => null
    if (when === 'provider-removed') f.provider.models = []
    if (when === 'vision-revoked') {
      const resolve = f.options.resolveWorkspaceCustomLlm
      f.options.resolveWorkspaceCustomLlm = async args => ({ ...(await resolve(args))!, supportsVision: false })
    }
    await expect(runtime.llm.vision!.propose(f.input)).rejects.toThrow()
    expect(f.requests).toHaveLength(when === 'during-upload' ? 1 : 0)
    // On-time consumed usage is still settled even when route drift denies output.
    expect(f.recordUsage).toHaveBeenCalledTimes(when === 'during-upload' ? 1 : 0)
  })
  it('fails closed for identity, blocked credits, denied data lane and no provider', async () => {
    const f = fixture()
    f.context.userId = 'other'; expect(await f.runtime()).toBeNull(); f.context.userId = 'u'
    f.options.checkCreditBudget = async () => ({ status: 'blocked' } as never)
    expect(await f.runtime()).toBeNull(); f.options.checkCreditBudget = undefined
    f.options.decisionRuntime.resolveRoute = async () => ({ mode: 'llm_only', llm: null })
    expect(await f.runtime()).toBeNull()
    f.options.decisionRuntime.resolveRoute = async () => ({ mode: 'llm_only' })
    f.options.configuredProviders = new Set()
    expect(await f.runtime()).toBeNull(); expect(f.requests).toHaveLength(0)
  })
  it('requires the progress LLM lane before admitting any goal or inference', async () => {
    const f = fixture()
    f.options.decisionRuntime.resolveRoute = vi.fn(async request => ({ mode: 'llm_only' as const, ...(request.operation.id === 'computer.verify-progress' ? { llm: null } : {}) }))
    expect(await f.runtime()).toBeNull()
    expect(f.options.decisionRuntime.resolveRoute).toHaveBeenCalledWith(expect.objectContaining({ operation: expect.objectContaining({ id: 'computer.verify-progress', version: '1' }) }))
    expect(f.options.resolveWorkspaceCustomLlm).not.toHaveBeenCalled()
    expect(f.requests).toHaveLength(0)
  })
  it('requires separate exact grounding approval and reserves conservatively', async () => {
    const f = fixture()
    managedRoute(f, 'gpt-5.2', f.provider, 'user')
    const runtime = (await f.runtime())!
    expect(runtime.llm.vision?.nativeGrounding).toBe(true)
    expect(await runtime.inferenceBudget!.reserve({ lane: 'vision', maxAttempts: 1, signal: f.input.signal, deadlineAt: f.input.deadlineAt })).toBe(false)
    f.options.resolveGrounder = async () => ({ provider: f.provider, model: 'not-approved-route', nativeGrounding: true, providerKeySource: 'user' })
    expect((await f.runtime())!.llm.vision).toBeUndefined()
  })
})


describe('native boot lifecycle observer seam', () => {
  it.each(['throws', 'rejects', 'hangs'] as const)('observer that %s does not change model execution or billing', async mode => {
    const f = fixture(), trace = new NativeRunTrace(() => {
      if (mode === 'throws') throw new Error('private observer credential')
      if (mode === 'rejects') return Promise.reject(new Error('private observer credential'))
      return new Promise<void>(() => {})
    })
    const runtime = (await f.runtime(trace))!
    for (let n = 0; n < 4; n++) {
      const span = trace.startSpan('generation', n)!
      f.input.trace = span.correlation
      expect(await runtime.llm.plan!(f.input)).toEqual([])
      span.settle('fulfilled')
    }
    trace.terminal('completed', 4)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.recordUsage).toHaveBeenCalledTimes(4)
    expect(f.requests).toHaveLength(4)
    expect(trace.snapshot()).toMatchObject({ logicalTerminal: true, pendingInvocations: 0, evidence: 'poisoned' })
    expect(trace.snapshot().poisonReasons).toContain(mode === 'hangs' ? 'observer_backpressure' : 'observer_failed')
    expect(trace.snapshot().invocations).toHaveLength(4)
    expect(JSON.stringify(trace.snapshot())).not.toContain('private observer')
    expect(JSON.stringify(f.requests)).not.toContain(trace.runId)
    for (const e of trace.snapshot().events) expect(NativeTraceEventSchema.safeParse(e).success).toBe(true)
  })
  it('poisons missing adapter correlation instead of making up a phase or suppressing execution', async () => {
    const f = fixture(), trace = new NativeRunTrace()
    trace.startSpan('generation', 0)
    expect(await (await f.runtime(trace))!.llm.plan!(f.input)).toEqual([])
    expect(trace.snapshot()).toMatchObject({ evidence: 'poisoned', invocations: [], pendingInvocations: 0 })
    expect(f.recordUsage).toHaveBeenCalledTimes(1)
  })
  it('rejects a Jev attempt with mismatched Hydra run correlation without manufacturing an invocation', async () => {
    const f = fixture(), trace = new NativeRunTrace(), span = trace.startSpan('selection', 0)!
    f.options.decisionRuntime.run = async request => {
      await request.prepareNativeAttempt?.({ runId: randomUUID(), invocationId: randomUUID(), invocationState: 'pending', interrupted: false,
        stage: 'primary_decision', operationId: NATIVE_NEXT_ACTION.id, attempt: 1, providerId: 'typesafe', modelCatalogId: 'typesafe-jev-1.13',
        modelWireId: 'jev-1.13.0', latencyMs: 0, outcome: 'success', configuredMode: 'hybrid', effectiveMode: 'hybrid', operatorOverride: false })
      return undefined as never
    }
    await (await f.runtime(trace))!.decisionRuntime!.run({ request: { runId: span.correlation.spanId } } as never)
    expect(trace.snapshot()).toMatchObject({ evidence: 'poisoned', invocations: [] })
    expect(f.recordAttempt).toHaveBeenCalledTimes(1)
    expect(f.recordUsage).not.toHaveBeenCalled() // No new primary accounting owner.
  })
  it('missing headers stay unresolved with known usage and unknown incurred cost in the trace', async () => {
    const f = fixture(), trace = new NativeRunTrace(), span = trace.startSpan('generation', 0)!
    f.input.trace = span.correlation
    f.provider.stream = async function* () {
      yield { type: 'text_delta', text: '{"steps":[]}' }
      yield { type: 'message_end', nativeMetadata: { actualModel: null, usage: { inputTokens: 0, outputTokens: 0 } }, stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } }
    }
    await expect((await f.runtime(trace))!.llm.plan!(f.input)).rejects.toThrow('Native accounting unavailable')
    expect(trace.snapshot()).toMatchObject({ evidence: 'valid', pendingInvocations: 0 })
    expect(trace.snapshot().invocations[0]!.inference).toMatchObject({ model: null, usage: { inputTokens: 0, outputTokens: 0 }, incurredCostUsd: null, estimatedBilledCostUsd: null })
    expect(f.recordUsage).not.toHaveBeenCalled()
  })
})
