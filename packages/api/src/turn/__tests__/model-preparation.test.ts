/** [COMP:api/assistant-run-preparation] Actual original owner, model resolver,
 * producer and billing boundary. Only owned SQL/authority/provider I/O is fake. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NOOP_TURN_LEDGER } from '@use-brian/agent-runtime/engine/turn-ledger.js'
import type { LLMProvider, ProviderRequest } from '@use-brian/agent-runtime/providers/types.js'
import { createRoutingProvider } from '@use-brian/agent-runtime/providers/routing.js'
import {
  createExecutionContext,
  executionToolContext
} from '@use-brian/agent-runtime/security/execution-context.js'
import type { CurrentAuthorityBoundary } from '@use-brian/agent-runtime/tools/types.js'
import { MODEL_REGISTRY, MutableProviderAvailability, chatTierDefaults } from '@use-brian/shared/model-registry'
vi.mock('../../turn/lease.js', async importOriginal => ({ ...await importOriginal<typeof import('../../turn/lease.js')>(),
  takeTurnLease: vi.fn(async () => ({ taken: true, token: 'model-token', turnId: 'a'.repeat(64) })),
  startLeaseHeartbeat: () => () => {}, releaseTurn: vi.fn(async () => true),
}))
vi.mock('../../application-platform/model-source-authority.js', () => ({
  admitModelSourceEvidence: async (context: { authority?: CurrentAuthorityBoundary }) => { await context.authority?.assertCurrent() },
}))
import { openAssistantTurn, type AssistantTurn } from '../kernel.js'
import { abortLocalTurn, releaseTurn } from '../lease.js'
import { createWorkspaceCustomLlmResolver, customLlmAlias, type ResolvedWorkspaceCustomLlm } from '../../custom-llm-runtime.js'
import type { WorkspaceCustomLlmEndpointStore } from '../../db/workspace-custom-llm-endpoints.js'
import type { TurnUsageBilling, TurnUsageRow } from '../billing.js'

const proModel = chatTierDefaults().pro

const owners: AssistantTurn[] = [], pending: (() => void)[] = []
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); pending.push(resolve); return { promise, resolve } }
afterEach(async () => { pending.splice(0).forEach(resolve => resolve()); for (const owner of owners.splice(0)) await owner.finish('failed') })
beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllEnvs())
const identity = { workspace: '00000000-0000-4000-8000-000000000030', assistant: 'fixture-assistant', user: 'fixture-user', session: 'fixture-session' }
async function fixture(assertCurrent = vi.fn(async () => {}), workspaceId: string = identity.workspace) {
  const abort = new AbortController(), authority: CurrentAuthorityBoundary = { assertCurrent, async execute(operation) { await assertCurrent(); return operation() } }
  const execution = createExecutionContext({ identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: identity.user, authenticationKind: 'native_session' } },
    ownership: workspaceId ? { kind: 'workspace', workspaceId } : { kind: 'personal', ownerUserId: identity.user },
    access: { workspaceId, userId: identity.user, assistantId: identity.assistant, assistantKind: 'standard', clearance: 'internal',
      compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: [identity.assistant] },
    writeDefaults: { compartments: [], projectIds: [] }, authority,
    lifecycle: { sessionId: identity.session, channelType: 'web', channelId: 'fixture', abortSignal: abort.signal } })
  const context = executionToolContext(execution, { appId: 'fixture' })
  const owner = await openAssistantTurn({ sessionId: identity.session, assistantId: identity.assistant, policy: { admission: 'personal' }, abortController: abort })
  owners.push(owner)
  return { owner, abort, authority, execution, context,
    invocation: { kind: 'execution' as const, toolProfile: 'web' as const, execution, assertCurrent: authority.assertCurrent.bind(authority) } }
}
const provider: LLMProvider = { name: 'fixture-platform', models: [], stream() { throw new Error('Unexpected provider dispatch') }, createSession() { throw new Error('Unexpected provider dispatch') } }
const services = () => ({ provider, configuredProviders: undefined, resolveWorkspaceCustomLlm: null, resolveLegacyByoKey: null, buildLegacyByoProvider: null })
const web = () => ({ kind: 'web' as const, requestedModel: 'pro', plan: 'max_5x', budgetStatus: 'ok' as const, researchMode: false, metered: null, hasImage: false })
const loop = (context: ReturnType<typeof executionToolContext>) => ({ ledger: NOOP_TURN_LEDGER, systemPrompt: 'Fictional fixture', messages: [{ role: 'user' as const, content: 'Give a concise answer.' }], tools: new Map(), maxTurns: 1, context })
/** Non-resume lanes run only what the original owner's prepareRun adopted. */
async function runPrepared(owner: AssistantTurn, context: ReturnType<typeof executionToolContext>, sink: { kind: 'sse' | 'none' }) {
  const { systemPrompt, messages, tools, ...owned } = loop(context)
  await owner.prepareRun({ systemPrompt, messages, candidateTools: tools })
  return owner.run({ loop: owned, sink })
}

it('[COMP:api/assistant-run-preparation] pins original services/request and finite availability across an admission await', async () => {
  const gate = deferred(), entered = deferred(), current = vi.fn(async () => { entered.resolve(); await gate.promise })
  const f = await fixture(current), original = vi.fn(async () => null), replacement = vi.fn(async () => null)
  const available = new MutableProviderAvailability(); available.setStaticProvider('gemini', true); available.setPreferredProvider('gemini')
  const input = { ...services(), configuredProviders: available, resolveWorkspaceCustomLlm: original }
  f.owner.bindModelPreparation(f.invocation, input)
  const request = web(), preparing = f.owner.prepareMainModel(request); await entered.promise
  request.requestedModel = 'max'; input.resolveWorkspaceCustomLlm = replacement
  available.clear(); available.setStaticProvider('dashscope', true); available.setPreferredProvider('dashscope')
  gate.resolve(); const selected = await preparing
  expect(original).toHaveBeenCalledWith(expect.objectContaining({ requestedTier: 'pro' })); expect(replacement).not.toHaveBeenCalled()
  expect([...selected.configuredProviders!]).toEqual(['gemini']); expect(selected.configuredProviders!.preferredProvider).toBe('gemini')
  const row = MODEL_REGISTRY.find(row => row.provider === 'gemini')!
  expect(selected.configuredProviders!.has(row.provider)).toBe(true)
  expect(selected.logicalTier).toBe('pro')
})

it('[COMP:api/assistant-run-preparation] preserves a real personal execution with empty workspace through main and background preparation', async () => {
  const f = await fixture(vi.fn(async () => {}), '')
  const resolver = vi.fn(async () => { throw new Error('A personal invocation has no workspace resolver') })
  f.owner.bindModelPreparation(f.invocation, { ...services(), resolveWorkspaceCustomLlm: resolver })
  const background = await f.owner.prepareBackgroundModel({ configuredDefault: true })
  const main = await f.owner.prepareMainModel(web())
  expect(background.provider).toBe(provider); expect(main.provider).toBe(provider)
  expect(background.customLlm).toBeNull(); expect(main.customLlm).toBeNull(); expect(resolver).not.toHaveBeenCalled()
  expect(f.context.executionContext).toBe(f.execution); expect(f.execution.security.access.workspaceId).toBe('')
  expect(f.invocation.kind).toBe('execution')
})

it.each(['background', 'main'] as const)('[COMP:api/assistant-run-preparation] installs %s preparation before synchronous finish reentry and drains it before release', async lane => {
  const gate = deferred(), entered = deferred(); let finishing: Promise<boolean> | undefined, first = true
  let owner!: AssistantTurn
  const f = await fixture(vi.fn(async () => { if (first) { first = false; finishing = owner.finish(); entered.resolve(); await gate.promise } }))
  owner = f.owner; const resolver = vi.fn(async () => null)
  owner.bindModelPreparation(f.invocation, { ...services(), resolveWorkspaceCustomLlm: resolver })
  const prepare = lane === 'background' ? owner.prepareBackgroundModel({ configuredDefault: true }) : owner.prepareMainModel(web()); await entered.promise
  expect(releaseTurn).not.toHaveBeenCalled(); gate.resolve(); await prepare; await finishing
  expect(resolver).toHaveBeenCalledTimes(1); expect(releaseTurn).toHaveBeenCalledExactlyOnceWith(identity.session, 'model-token', 'completed', expect.any(Function))
})

it('[COMP:api/assistant-run-preparation] refuses replacement of the original authority operation across an admission await', async () => {
  const gate = deferred(), entered = deferred(), resolver = vi.fn(async () => null)
  const f = await fixture(vi.fn(async () => { entered.resolve(); await gate.promise }))
  f.owner.bindModelPreparation(f.invocation, { ...services(), resolveWorkspaceCustomLlm: resolver })
  const preparing = f.owner.prepareMainModel(web()), outcome = expect(preparing).rejects.toMatchObject({ reason: 'authority_changed' })
  await entered.promise; f.authority.assertCurrent = vi.fn(async () => {}); gate.resolve(); await outcome
  expect(resolver).not.toHaveBeenCalled(); await f.owner.finish('failed'); expect(f.owner.released).toBe(true)
})

it('[COMP:api/assistant-run-preparation] runs durable resume on its canonical execution and permits only runtime copies that keep it', async () => {
  const f = await fixture()
  const originalProvider: LLMProvider = { name: 'fixture-resume', models: [], async *stream(request) {
    yield { type: 'message_start', model: request.model }; yield { type: 'text_delta', text: 'Fictional resumed answer.' }
    yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
  }, createSession(options) { return { send(messages) { return originalProvider.stream({ ...options, messages }) } } } }
  f.owner.bindModelPreparation({ kind: 'execution', toolProfile: 'resume', execution: f.execution, assertCurrent: f.authority.assertCurrent.bind(f.authority) }, { ...services(), provider: originalProvider })
  await f.owner.prepareMainModel({ kind: 'resume', fallbackModel: 'fixture-model', selectedTier: 'pro' })
  // Resume, like every lane, runs only its owner's prepared run.
  const { systemPrompt, messages, tools, ...owned } = loop(f.context)
  await f.owner.prepareRun({ systemPrompt, messages, candidateTools: tools })
  await expect(f.owner.run({ loop: { ...owned, context: { ...f.context, executionContext: { ...f.execution } } }, sink: { kind: 'none' } })).rejects.toMatchObject({ reason: 'authority_changed' })
  expect(releaseTurn).not.toHaveBeenCalled()
  await expect(f.owner.run({ loop: { ...owned, context: { ...f.context, appId: 'resumed-runtime-copy' } }, sink: { kind: 'none' } })).resolves.toMatchObject({ selection: { kind: 'text' } })
})

it('[COMP:api/assistant-run-preparation] refuses alternate caller models and unavailable exact durable custom selections', async () => {
  const f = await fixture(); f.owner.bindModelPreparation(f.invocation, services())
  await f.owner.prepareMainModel(web())
  await expect(f.owner.run({ model: { provider }, loop: loop(f.context), sink: { kind: 'none' } } as never)).rejects.toThrow('original owner supplies')
  const resume = await fixture()
  resume.owner.bindModelPreparation({ kind: 'execution', toolProfile: 'resume', execution: resume.execution, assertCurrent: resume.authority.assertCurrent }, services())
  await expect(resume.owner.prepareMainModel({ kind: 'resume', fallbackModel: 'fixture', selectedCustomModel: 'custom:missing' })).rejects.toThrow('no longer available')
})

it('[COMP:api/assistant-run-preparation] replays the checkpoint model through a changed tier route and refuses entitlement loss', async () => {
  vi.stubEnv('USEBRIAN_EDITION', 'oss')
  const f = await fixture()
  const availability = new MutableProviderAvailability()
  const saved = 'gpt-6.2-sol-pro'
  availability.setModelCatalog('openai-codex', new Set(['gpt-6.2-sol', 'gpt-6-luna']))
  const wire: string[] = []
  const codex: LLMProvider = {
    name: 'fixture', models: [saved],
    async *stream(request) {
      wire.push(request.model)
      yield { type: 'message_start', model: request.model }
    },
    createSession(options) { return { send: messages => this.stream({ ...options, messages }) } },
  }
  const managed = createRoutingProvider({ 'openai-codex': codex }, { availability })
  const readCurrent = vi.fn(async () => ({ tier: 'standard', modelAlias: 'gpt-6-luna' }))
  const store = { getTierRouteSystem: readCurrent } as unknown as WorkspaceCustomLlmEndpointStore
  const resolver = createWorkspaceCustomLlmResolver(store, { managedProvider: managed })
  f.owner.bindModelPreparation({ ...f.invocation, toolProfile: 'resume' }, {
    ...services(), provider: managed, configuredProviders: availability, resolveWorkspaceCustomLlm: resolver,
  })
  const selected = await f.owner.prepareMainModel({ kind: 'resume', fallbackModel: chatTierDefaults().standard,
    selectedTier: 'standard', selectedCustomModel: saved })
  expect(selected).toMatchObject({ model: saved, logicalTier: 'standard', providerKeySource: 'platform' })
  const dispatch = async () => {
    const session = selected.provider.createSession({ model: selected.model, systemPrompt: '' })
    for await (const _ of session.send([{ role: 'user', content: 'Continue.' }])) { /* drain */ }
  }
  await dispatch()
  availability.setModelCatalog('openai-codex', new Set(['gpt-6-luna']))
  await expect(dispatch()).rejects.toThrow('not available')
  expect(wire).toEqual([saved])
  expect(readCurrent).not.toHaveBeenCalled()
  // A request-supplied managed alias has no checkpoint authority.
  const regular = await resolver({ workspaceId: identity.workspace, requestedModel: saved, requestedTier: 'standard' })
  expect(regular?.selector).toBe('gpt-6-luna')
})

it.each([true, false])('[COMP:api/assistant-run-preparation] reopens only the saved custom profile on resume (available=%s)', async available => {
  const f = await fixture()
  const profile = endpoint(), saved = customLlmAlias(profile.id)
  const getRuntimeSystem = vi.fn(async () => available ? profile : null)
  const getTierRouteSystem = vi.fn(async () => ({ modelAlias: 'gpt-6.2-sol' }))
  const resolver = createWorkspaceCustomLlmResolver({ getRuntimeSystem, getTierRouteSystem } as unknown as WorkspaceCustomLlmEndpointStore)
  f.owner.bindModelPreparation({ ...f.invocation, toolProfile: 'resume' }, { ...services(), resolveWorkspaceCustomLlm: resolver })
  const selected = f.owner.prepareMainModel({ kind: 'resume', fallbackModel: chatTierDefaults().standard,
    selectedTier: 'standard', selectedCustomModel: saved })
  if (available) await expect(selected).resolves.toMatchObject({ model: saved, logicalTier: 'standard', providerKeySource: 'user' })
  else await expect(selected).rejects.toThrow('no longer available')
  expect(getRuntimeSystem).toHaveBeenCalledExactlyOnceWith({ workspaceId: identity.workspace, profileId: profile.id })
  expect(getTierRouteSystem).not.toHaveBeenCalled()
})

it('[COMP:api/assistant-run-preparation] preserves explicit image refusal and default image fallback with original legacy precedence', async () => {
  const custom = { ...services(), provider: { ...provider, name: 'fictional-custom' } }, legacyProvider = { ...provider, name: 'fictional-legacy' }
  const runtime = { provider: custom.provider, selector: 'custom:fictional', providerKeySource: 'user', supportsVision: false } as ResolvedWorkspaceCustomLlm
  for (const explicit of [true, false]) {
    const f = await fixture(), readKey = vi.fn(async () => 'fictional-key'), build = vi.fn(() => legacyProvider)
    f.owner.bindModelPreparation(f.invocation, { ...services(), resolveWorkspaceCustomLlm: async () => runtime,
      resolveLegacyByoKey: readKey, buildLegacyByoProvider: build })
    const selected = await f.owner.prepareMainModel({ ...web(), requestedModel: explicit ? 'custom:fictional' : 'pro', hasImage: true })
    expect(selected.imageRoute).toBe(explicit ? 'refuse' : 'fall_back_to_builtin')
    if (explicit) { expect(selected.customLlm?.provider).toBe(custom.provider); expect(readKey).not.toHaveBeenCalled() }
    else { expect(selected.customLlm).toBeNull(); expect(selected.provider).toBe(legacyProvider); expect(selected.usedLegacyByoKey).toBe(true); expect(readKey).toHaveBeenCalledExactlyOnceWith(identity.workspace) }
  }
})

it('[COMP:api/assistant-run-preparation] refuses exact saved legacy and metered resume routes rather than adopting a default', async () => {
  for (const metered of [false, true]) {
    const f = await fixture(), resolver = vi.fn(async () => null), readKey = vi.fn(async () => null)
    f.owner.bindModelPreparation({ kind: 'execution', toolProfile: 'resume', execution: f.execution, assertCurrent: f.authority.assertCurrent.bind(f.authority) }, { ...services(), resolveWorkspaceCustomLlm: resolver,
        resolveLegacyByoKey: readKey, buildLegacyByoProvider: () => provider })
    await expect(f.owner.prepareMainModel({ kind: 'resume', fallbackModel: 'fixture', selectedTier: 'pro',
      ...(metered ? { selectedMeteredModel: 'fictional-metered' } : { selectedLegacyByo: true }) })).rejects.toThrow(metered ? 'does not support explicit metered' : 'legacy BYO Gemini key')
    expect(resolver).not.toHaveBeenCalled(); expect(readKey).toHaveBeenCalledTimes(metered ? 0 : 1)
  }
})

function endpoint() { return { id: '00000000-0000-4000-8000-000000000031', endpointId: '00000000-0000-4000-8000-000000000031',
  workspaceId: identity.workspace, name: 'Fictional route', endpointName: 'fixture-gateway', baseUrl: 'https://model.example/v1', apiKey: null,
  modelId: 'fixture-wire-model', contextWindow: 32768, maxOutputTokens: 4096, supportsTools: true, supportsVision: true,
  fallbackToDefaultOnFailure: true, verifiedAt: new Date(), createdAt: new Date(), updatedAt: new Date() } }
function textSse() { return new Response([
  { choices: [{ delta: { content: 'Fictional BYO answer.' }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } }, '[DONE]',
].map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('')) }

it('[COMP:api/assistant-run-preparation] refuses an actual background endpoint failure without dispatching managed fallback', async () => {
  const f = await fixture(), managedDispatch = vi.fn(() => { throw new Error('Background must never substitute a managed provider') })
  const managed: LLMProvider = { name: 'fictional-platform', models: [], stream: managedDispatch, createSession: managedDispatch }
  const record = endpoint(), store = { getRuntimeSystem: vi.fn(async () => record),
    getTierRuntimeSystem: vi.fn(async () => record), getTierRouteSystem: vi.fn(async () => ({ profileId: record.id })) } as unknown as WorkspaceCustomLlmEndpointStore
  const resolver = createWorkspaceCustomLlmResolver(store, { managedProvider: managed,
    fetchFn: vi.fn(async () => new Response('Fictional endpoint failure', { status: 530 })) })
  const resolve = vi.fn(resolver)
  f.owner.bindModelPreparation(f.invocation, { ...services(), provider: managed, resolveWorkspaceCustomLlm: resolve })
  const background = await f.owner.prepareBackgroundModel({ configuredDefault: true })
  expect(background.customLlm).not.toBeNull(); expect(background.customLlm!.fallback.enabled).toBe(false)
  expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ allowDefault: true, allowAnyDefault: true }))
  const request = async () => { for await (const _ of background.provider.stream({ model: background.model!,
    systemPrompt: 'Fictional background work', messages: [{ role: 'user', content: 'Classify this fictional input.' }],
    signal: f.abort.signal })) { /* real endpoint provider dispatch */ } }
  await expect(request()).rejects.toThrow('530')
  expect(managedDispatch).not.toHaveBeenCalled(); expect(background.providerKeySource).toBe('user')
  expect(background.customLlm!.fallback.used).toBe(false)
})

it('[COMP:api/assistant-run-preparation] dispatches the exact self-hosted model and records the logical tier', async () => {
  vi.stubEnv('USEBRIAN_EDITION', 'outpost')
  const f = await fixture()
  const availability = new MutableProviderAvailability()
  availability.setModelCatalog('openai-codex', new Set(['gpt-6.2-sol', 'gpt-6-luna']))
  const dispatched: string[] = []
  const codex: LLMProvider = {
    name: 'fixture-codex', models: ['gpt-6.2-sol', 'gpt-6-luna'],
    async *stream(request) {
      dispatched.push(request.model)
      yield { type: 'message_start', model: request.model }
      yield { type: 'text_delta', text: 'Fixture answer.' }
      yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 7, outputTokens: 3 } }
    },
    createSession(options) { return { send: messages => this.stream({ ...options, messages }) } },
  }
  const managedProvider = createRoutingProvider({ 'openai-codex': codex }, { availability })
  const store = { getTierRouteSystem: async ({ tier }: { tier: string }) =>
    tier === 'standard' ? { tier, modelAlias: 'gpt-6.2-sol' } : null } as unknown as WorkspaceCustomLlmEndpointStore
  const resolver = createWorkspaceCustomLlmResolver(store, { managedProvider })
  f.owner.bindModelPreparation(f.invocation, { ...services(), configuredProviders: availability,
    provider: managedProvider, resolveWorkspaceCustomLlm: resolver })
  expect((await f.owner.prepareBackgroundModel({ configuredDefault: true })).customLlm).toBeNull()
  const selected = await f.owner.prepareMainModel({ ...web(), requestedModel: 'standard' })
  expect(selected).toMatchObject({ logicalModel: chatTierDefaults().standard, logicalTier: 'standard',
    model: 'gpt-6.2-sol', customLlm: { selector: 'gpt-6.2-sol', modelTier: 'standard', providerKeySource: 'platform' } })
  const recordUsage = vi.fn(async (_row: TurnUsageRow) => {})
  f.owner.registerUsageBilling({ metadata: { userId: identity.user, actorUserId: identity.user, assistantId: identity.assistant,
    sessionId: identity.session, modelTier: selected.logicalTier, source: 'included', triggerKey: 'main_response',
    providerKeySource: selected.providerKeySource }, costPolicy: 'calculate', recordUsage })
  await runPrepared(f.owner, f.context, { kind: 'sse' })
  await f.owner.finish()
  expect(dispatched).toEqual(['gpt-6.2-sol'])
  expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-6.2-sol', modelTier: 'standard', outputTokens: 3 }))

  availability.setModelCatalog('openai-codex', new Set(['gpt-6-luna']))
  const dispatchAfterWithdrawal = async () => {
    for await (const _ of selected.provider.stream({ model: selected.model, systemPrompt: '', messages: [] })) { /* drain */ }
  }
  await expect(dispatchAfterWithdrawal()).rejects.toThrow('not available')
  expect(dispatched).toEqual(['gpt-6.2-sol'])
  vi.stubEnv('USEBRIAN_EDITION', 'hosted')
  const hostedResolver = createWorkspaceCustomLlmResolver(store, { managedProvider })
  await expect(hostedResolver({ workspaceId: identity.workspace, requestedTier: 'standard' }))
    .rejects.toThrow("cannot serve the 'standard' tier")
})

describe('[COMP:api/assistant-run-preparation] actual endpoint fallback spend', () => {
  it.each(['byo', 'fallback', 'stopped', 'refused'] as const)('settles original %s producer once after actual provider outcome', async mode => {
    let current = true
    const f = await fixture(vi.fn(async () => { if (!current) throw Object.assign(new Error('Original authority refused'), { reason: 'authority_changed', retrySafe: false }) }))
    const originalEndpoint = endpoint(), rows: TurnUsageRow[] = [], recorder = vi.fn(async (row: TurnUsageRow) => { rows.push(row) }), replacement = vi.fn(async () => {})
    const managed: LLMProvider = { name: 'fixture-platform', models: [],
      async *stream(request: ProviderRequest) {
        yield { type: 'message_start', model: request.model }; yield { type: 'text_delta', text: 'Fictional platform answer.' }
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 7, outputTokens: 3 } }
        if (mode === 'stopped') abortLocalTurn(identity.session, 'model-token')
        if (mode === 'refused') current = false
      },
      createSession(config) { return { send(messages) { return managed.stream({ ...config, messages }) } } },
    }
    const store = { getRuntimeSystem: vi.fn(async () => originalEndpoint), getTierRuntimeSystem: vi.fn(), getTierRouteSystem: vi.fn() } as unknown as WorkspaceCustomLlmEndpointStore
    const fetchFn = vi.fn(async () => mode === 'byo' ? textSse() : new Response('fixture endpoint unavailable', { status: 530 }))
    const resolver = createWorkspaceCustomLlmResolver(store, { fetchFn, managedProvider: managed })
    let originalRuntime: ResolvedWorkspaceCustomLlm | null = null
    f.owner.bindModelPreparation(f.invocation, { ...services(), provider: managed,
      resolveWorkspaceCustomLlm: async request => { originalRuntime = await resolver(request); return originalRuntime } })
    const selected = await f.owner.prepareMainModel({ ...web(), requestedModel: customLlmAlias(originalEndpoint.id) })
    const registration: TurnUsageBilling = { metadata: { userId: 'original-payer', actorUserId: identity.user, assistantId: identity.assistant,
      sessionId: identity.session, userMessageId: 'original-message', modelTier: selected.logicalTier,
      source: 'included', triggerKey: 'main_response', providerKeySource: 'user' }, costPolicy: 'calculate', recordUsage: recorder }
    f.owner.registerUsageBilling(registration)
    registration.metadata = { ...registration.metadata, userId: 'replacement-payer' }; registration.recordUsage = replacement
    Object.defineProperty(originalRuntime!, 'providerKeySource', { configurable: true, get: () => 'user' })
    try { await runPrepared(f.owner, f.context, { kind: 'sse' }) } catch { /* original Stop/refusal remains separate from factual spend */ }
    await f.owner.finish(mode === 'byo' || mode === 'fallback' ? 'completed' : 'failed')
    expect(recorder).toHaveBeenCalledTimes(1); expect(replacement).not.toHaveBeenCalled(); expect(rows[0]).toMatchObject({ userId: 'original-payer', actorUserId: identity.user, userMessageId: 'original-message', inputTokens: 7, outputTokens: 3,
      providerKeySource: mode === 'byo' ? 'user' : 'platform' })
    if (mode === 'byo') expect(rows[0].actualCostUsd).toBe(0)
    if (mode !== 'byo') expect(rows[0].actualCostUsd).toBeGreaterThan(0)
    expect(f.owner.released).toBe(true)
  })
})


it.each(['own', 'prototype'] as const)('[COMP:api/assistant-run-preparation] pins finite %s metadata and the original private-state getter receiver', async placement => {
  const f = await fixture(), facts = new WeakMap<object, 'user' | 'platform'>(), rows: TurnUsageRow[] = []
  let runtime!: ResolvedWorkspaceCustomLlm
  const fallback = { enabled: true, used: false, reason: null, status: null, detail: null, endpointName: 'fictional-receiver' }
  const producer: LLMProvider = { name: 'fictional-original-producer', models: [], async *stream() {
    yield { type: 'message_start', model: proModel }; yield { type: 'text_delta', text: 'Fictional receiver-bound answer.' }
    yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 7, outputTokens: 3 } }
    facts.set(runtime, 'platform'); fallback.used = true
  }, createSession(options) { return { send(messages) { return producer.stream({ ...options, messages }) } } } }
  const browser = Object.create({ apiKeyEnvName: 'OPENAI_API_KEY', apiKey: 'fictional-key', model: 'fictional-wire', baseUrl: 'https://original.example/v1' })
  const fields = { provider: producer, selector: 'custom:receiver', fallback, profileId: 'original-profile', modelTier: 'pro',
    inputTokenLimit: 32768, maxTokens: 4096, routeKind: 'custom', supportsVision: true, browserUse: browser }
  const holder: object = placement === 'prototype' ? { ...fields } : {}
  runtime = Object.create(placement === 'prototype' ? holder : Object.prototype) as ResolvedWorkspaceCustomLlm
  if (placement === 'own') for (const [name, value] of Object.entries(fields)) Object.defineProperty(runtime, name, { value, writable: true, configurable: true, enumerable: false })
  const getter = function(this: object) { const value = facts.get(this); if (!value) throw new Error('The producer receiver changed'); return value }
  Object.defineProperty(placement === 'prototype' ? holder : runtime, 'providerKeySource', { configurable: true, get: getter })
  facts.set(runtime, 'user')
  f.owner.bindModelPreparation(f.invocation, { ...services(), resolveWorkspaceCustomLlm: async () => runtime })
  const selected = await f.owner.prepareMainModel({ ...web(), requestedModel: 'custom:receiver' })
  expect(selected.provider).toBe(producer); expect(selected.customLlm).toMatchObject({ selector: 'custom:receiver', profileId: 'original-profile', modelTier: 'pro', inputTokenLimit: 32768, maxTokens: 4096, routeKind: 'custom', supportsVision: true })
  expect(selected.customLlm!.fallback).toBe(fallback); expect(Object.isFrozen(selected.customLlm!.browserUse)).toBe(true)
  const replacement = vi.fn(() => 'user')
  Object.defineProperty(runtime, 'providerKeySource', { configurable: true, get: replacement })
  runtime.profileId = 'replacement-profile'; runtime.selector = 'custom:replacement'; browser.baseUrl = 'https://replacement.example/v1'
  f.owner.registerUsageBilling({ metadata: { userId: 'original-payer', assistantId: identity.assistant, sessionId: identity.session,
    modelTier: selected.logicalTier, source: 'included', providerKeySource: 'user' }, costPolicy: 'calculate', recordUsage: async row => { rows.push(row) } })
  await runPrepared(f.owner, f.context, { kind: 'none' }); await f.owner.finish()
  expect(rows).toHaveLength(1); expect(rows[0].providerKeySource).toBe('platform'); expect(rows[0].actualCostUsd).toBeGreaterThan(0)
  expect(replacement).not.toHaveBeenCalled(); expect(selected.customLlm!.profileId).toBe('original-profile')
  expect(selected.customLlm!.browserUse!.baseUrl).toBe('https://original.example/v1'); expect(selected.customLlm!.fallback.used).toBe(true)
})
