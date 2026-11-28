/** [COMP:api/assistant-run-preparation] The original owner's private final run
 * preparation. Actual provider input, capture before admission/Brief awaits,
 * user-visible placement, source bindings, original authority, Stop,
 * uncertainty and cleanup. Only lease SQL and source-proof I/O are fake. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { NOOP_TURN_LEDGER } from '@use-brian/agent-runtime/engine/turn-ledger.js'
import { createConfirmationResolver } from '@use-brian/agent-runtime/mcp/types.js'
import { createGeminiProvider } from '@use-brian/agent-runtime/providers/gemini.js'
import type { ContentBlock, LLMProvider, Message, StreamChunk } from '@use-brian/agent-runtime/providers/types.js'
import { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import type { ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'
import {
  createExecutionContext,
  executionToolContext
} from '@use-brian/agent-runtime/security/execution-context.js'
import {
  bindScopeSources,
  boundScopeSources
} from '@use-brian/agent-runtime/security/source-evidence.js'
import {
  buildTool,
  type CurrentAuthorityBoundary,
  type Tool,
  type ToolContext
} from '@use-brian/agent-runtime/tools/types.js'
vi.mock('../lease.js', async importOriginal => ({ ...await importOriginal<typeof import('../lease.js')>(),
  takeTurnLease: vi.fn(async () => ({ taken: true, token: 'run-token', turnId: 'b'.repeat(64) })),
  startLeaseHeartbeat: () => () => {}, releaseTurn: vi.fn(async () => true),
}))
// The unattended Brief basis store (resume's system execution freezes its
// approval job's basis); the resolver itself is the test's.
const workBasis = vi.hoisted(() => ({ get: vi.fn(async (): Promise<unknown> => null), put: vi.fn(async () => {}) }))
vi.mock('../../db/brief-store.js', async importOriginal => ({ ...await importOriginal<typeof import('../../db/brief-store.js')>(),
  getWorkBasisSystem: workBasis.get, putWorkBasisSystem: workBasis.put }))
vi.mock('../../application-platform/model-source-authority.js', () => ({
  admitModelSourceEvidence: async (context: { authority?: CurrentAuthorityBoundary }) => { await context.authority?.assertCurrent() },
}))
const mailbox = vi.hoisted(() => ({ dispatcher: vi.fn() }))
const knowledge = vi.hoisted(() => ({ dispatcher: vi.fn() }))
const selectRecentText = vi.hoisted(() => vi.fn())
vi.mock('../../mcp/surface.js', async importOriginal => ({ ...await importOriginal<typeof import('../../mcp/surface.js')>(),
  prepareMailboxReadDispatcher: mailbox.dispatcher, prepareKnowledgeReadDispatcher: knowledge.dispatcher }))
vi.mock('../../db/verified-channel-record.js', async importOriginal => ({ ...await importOriginal<typeof import('../../db/verified-channel-record.js')>(),
  selectVerifiedChannelRecentText: selectRecentText }))
import { openAssistantTurn, type AssistantTurn } from '../kernel.js'
import type { InitialMailboxCapabilities } from '../capabilities.js'
import type { SurfaceCapabilityOptions } from '../../mcp/surface.js'
import { abortLocalTurn, releaseTurn } from '../lease.js'
import { configureBriefTurnContext, type BriefTurn, type BriefTurnResolver } from '../../briefs/context.js'
import { createWorkspaceCustomLlmResolver, type ResolvedWorkspaceCustomLlm, type WorkspaceCustomLlmResolver } from '../../custom-llm-runtime.js'
import type { WorkspaceCustomLlmEndpointStore } from '../../db/workspace-custom-llm-endpoints.js'
import { createWorkerManager } from '@use-brian/core/workers/worker.js'

const identity = { workspace: '00000000-0000-4000-8000-000000000040', assistant: 'fixture-assistant', user: 'fixture-user', session: 'fixture-run-session' }
const owners: AssistantTurn[] = [], pending: (() => void)[] = []
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); pending.push(resolve); return { promise, resolve } }
afterEach(async () => { pending.splice(0).forEach(resolve => resolve()); for (const owner of owners.splice(0)) await owner.finish('failed'); configureBriefTurnContext(null) })
beforeEach(() => vi.clearAllMocks())

type Captured = { config: Record<string, unknown>; sends: Message[][] }
/** Real provider boundary: records exactly what a session is constructed and sent with. */
function capturingProvider(script: 'text' | 'tool' | readonly string[] = 'text', toolName = 'readThing',
  toolStopReason: 'tool_use' | 'end_turn' = 'tool_use', toolInputs: readonly string[] = []) {
  const captured: Captured[] = []
  let calls = 0
  const provider: LLMProvider = { name: 'fixture-run-provider', models: [], stream() { throw new Error('Unexpected stateless dispatch') },
    createSession(config) {
      const entry: Captured = { config: config as unknown as Record<string, unknown>, sends: [] }; captured.push(entry)
      return { send(messages) {
        entry.sends.push(messages); const call = calls++
        return (async function* () {
          yield { type: 'message_start' as const, model: config.model }
          const name = Array.isArray(script) ? script[call] : script === 'tool' && call === 0 ? toolName : undefined
          if (name) {
            const id = call ? `fixture-call-${call}` : 'fixture-call'
            yield { type: 'tool_use_start' as const, id, name }
            yield { type: 'tool_use_delta' as const, id, input: toolInputs[call] ?? (name === 'searchKnowledge' ? '{"query":"observatory handbook"}' : '{}') }
            yield { type: 'tool_use_end' as const, id }
            yield { type: 'message_end' as const, stopReason: toolStopReason, usage: { inputTokens: 1, outputTokens: 1 } }
          } else {
            yield { type: 'text_delta' as const, text: 'Fictional prepared answer.' }
            yield { type: 'message_end' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } }
          }
        })()
      } }
    } }
  return { provider, captured }
}

async function fixture(options: { assertCurrent?: () => Promise<void>; lane?: 'web' | 'channel' | 'resume'; provider?: LLMProvider; custom?: boolean; resolver?: WorkspaceCustomLlmResolver; scopeAccumulator?: ContextScopeAccumulator } = {}) {
  const abort = new AbortController(), assertCurrent = vi.fn(options.assertCurrent ?? (async () => {}))
  const authority: CurrentAuthorityBoundary = { assertCurrent, async execute(operation) { return operation() } }
  const lane = options.lane ?? 'web'
  // Durable resume binds its canonical system execution, keyed by its approval.
  const execution = createExecutionContext({ identity: lane === 'resume' ? { kind: 'system', purpose: 'session_resume', jobId: 'fixture-approval' }
    : { kind: 'attended', principal: { kind: 'workspace_member', userId: identity.user, authenticationKind: lane === 'channel' ? 'verified_channel' : 'native_session' } },
    ownership: { kind: 'workspace', workspaceId: identity.workspace },
    access: { workspaceId: identity.workspace, userId: identity.user, assistantId: identity.assistant, assistantKind: 'standard', clearance: 'internal',
      compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: [identity.assistant] },
    writeDefaults: { compartments: [], projectIds: [] }, authority,
    lifecycle: { sessionId: identity.session, channelType: 'web', channelId: 'fixture', abortSignal: abort.signal } })
  const context = executionToolContext(execution, { appId: 'fixture' })
  const owner = await openAssistantTurn({ sessionId: identity.session, assistantId: identity.assistant, policy: { admission: 'personal' }, abortController: abort })
  owners.push(owner)
  const { provider, captured } = options.provider ? { provider: options.provider, captured: [] as Captured[] } : capturingProvider()
  const runtime = options.custom ? { provider, selector: 'custom:fixture', profileId: 'fixture-profile', modelTier: 'pro', inputTokenLimit: 16_000, maxTokens: 2_048,
    routeKind: 'custom', supportsVision: true, providerKeySource: 'user',
    fallback: { enabled: false, used: false, reason: null, status: null, detail: null, endpointName: 'fixture' } } as unknown as ResolvedWorkspaceCustomLlm : null
  const services = { provider, configuredProviders: undefined, resolveWorkspaceCustomLlm: options.resolver ?? (runtime ? async () => runtime : null),
    resolveLegacyByoKey: null, buildLegacyByoProvider: null }
  let main
  if (lane === 'resume') {
    owner.bindModelPreparation({ kind: 'execution', toolProfile: 'resume', execution, assertCurrent: authority.assertCurrent.bind(authority) }, services)
    main = await owner.prepareMainModel({ kind: 'resume', fallbackModel: 'fixture-model', selectedTier: 'pro' })
  } else {
    owner.bindModelPreparation({ kind: 'execution', toolProfile: lane, execution, scopeAccumulator: options.scopeAccumulator,
      assertCurrent: () => authority.assertCurrent() }, services)
    main = await owner.prepareMainModel(lane === 'web'
      ? { kind: 'web', requestedModel: options.custom ? 'custom:fixture' : 'pro', plan: 'max_5x', budgetStatus: 'ok', researchMode: false, metered: null, hasImage: false }
      : { kind: 'channel', plan: 'max_5x', budgetStatus: 'ok' })
  }
  return { owner, abort, authority, assertCurrent, execution, context, captured, main }
}
const readCalls: string[] = []
function readTool(name = 'readThing', label = 'original') {
  return buildTool({ name, description: `Fictional ${label} read`, inputSchema: z.object({}).passthrough(), isReadOnly: true,
    async execute() { readCalls.push(label); return { data: { from: label } } } })
}
function writeTool() {
  return buildTool({ name: 'writeThing', description: 'Fictional write', inputSchema: z.object({}).passthrough(), isReadOnly: false,
    async execute() { readCalls.push('write'); return { data: { written: true } } } })
}
const owned = (context: ToolContext) => ({ ledger: NOOP_TURN_LEDGER, maxTurns: 3, context })
function briefResolver(content = '<brief>Fictional accepted rules</brief>', incomplete = false): BriefTurnResolver {
  return vi.fn(async () => ({ workspaceId: identity.workspace, projectId: 'fixture-project', projectBindingId: 'fixture-binding',
    basis: {} as BriefTurn['basis'], fingerprint: 'fixture', incomplete, content }) as BriefTurn)
}
const source = (id: string): ScopeSource => ({ workspaceId: identity.workspace, userId: null, assistantId: identity.assistant, sensitivity: 'internal',
  compartments: [], projectIds: [], resourceKind: 'session_message', resourceId: id, version: '1' })
const toolNames = (entry: Captured) => ((entry.config.tools as Array<{ name: string }> | undefined) ?? []).map(tool => tool.name)
const sent = (entry: Captured) => entry.sends[0]!

function initialMailbox(f: Awaited<ReturnType<typeof fixture>>, overrides?: Partial<SurfaceCapabilityOptions>) {
  return vi.fn<InitialMailboxCapabilities>(async () => ({ profile: 'channel', composition: { kind: 'surface-options', params: {
    assistantId: identity.assistant, assistantTeamId: identity.workspace, executionContext: f.execution,
    actorIdentity: { channel: 'telegram', id: 'fixture-account', email: null, userId: identity.user },
    ...overrides,
  } as SurfaceCapabilityOptions } }))
}

describe('[COMP:api/assistant-run-preparation] owner prepareRun', () => {
  it('delivers the owner-assembled prompt, messages, tools and model limits to the actual provider', async () => {
    const f = await fixture({ custom: true })
    const view = await f.owner.prepareRun({ systemPrompt: 'Fictional stable prompt', messages: [{ role: 'user', content: 'Give a concise answer.' }],
      candidateTools: new Map([['readThing', readTool()]]),
      trustedContributions: [{ name: 'runtime', content: 'Trusted runtime facts' }, { name: 'blank', content: '  ' }, { name: 'page', content: 'Supplementary page facts' }],
      userVisibleContributions: [{ name: 'turn', content: 'Visible attachment facts' }] })
    expect(view.grounding).toEqual({ runtimeContext: 'Trusted runtime facts', userVisibleContext: 'Visible attachment facts' })
    expect(Object.isFrozen(view)).toBe(true); expect('tools' in view).toBe(false)
    await expect(f.owner.run({ loop: { ...owned(f.context), systemPrompt: 'Forged prompt' } as never, sink: { kind: 'none' } })).rejects.toThrow('original owner supplies the prepared run')
    await expect(f.owner.run({ loop: { ...owned(f.context), tools: new Map() } as never, sink: { kind: 'none' } })).rejects.toThrow('original owner supplies the prepared run')
    await expect(f.owner.run({ loop: { ...owned(f.context), maxTokens: 1 } as never, sink: { kind: 'none' } })).rejects.toThrow('original owner supplies the prepared run')
    await expect(f.owner.run({ loop: owned(f.context), sink: { kind: 'none' } })).resolves.toMatchObject({ selection: { kind: 'text' } })
    const [session] = f.captured
    expect(session.config).toMatchObject({ systemPrompt: 'Fictional stable prompt', runtimeSystemContext: 'Trusted runtime facts\n\nSupplementary page facts',
      maxTokens: 2_048, inputTokenLimit: 16_000 })
    expect(toolNames(session)).toEqual(['readThing'])
    const last = sent(session).at(-1)!
    expect(last.role).toBe('user')
    expect(last.content).toEqual([{ type: 'text', text: expect.stringContaining('<user_visible_context>') }, { type: 'text', text: 'Give a concise answer.' }])
    expect(JSON.stringify([session.config, session.sends]).split('<user_visible_context>').length - 1).toBe(1)
  })

  it.each(['web', 'channel'] as const)('answers a self-contained %s turn on the initial main-model dispatch', async lane => {
    const f = await fixture({ lane })
    const brief = briefResolver()
    configureBriefTurnContext(brief)
    const discover = vi.fn(async () => { throw new Error('Unexpected discovery') })
    const messages: Message[] = [{ role: 'user', content: 'What is two plus two?' }]
    await f.owner.prepareRun({ systemPrompt: 'Initial', messages, candidateTools: new Map(), contextDiscovery: discover })
    const result = await f.owner.run({ loop: owned(f.context), sink: { kind: 'adapter' } })
    expect(result.finalText).toBe('Fictional prepared answer.')
    expect(f.captured).toHaveLength(1)
    expect(sent(f.captured[0])).toEqual(messages)
    expect(toolNames(f.captured[0])).toEqual(['readChatHistory'])
    expect(discover).not.toHaveBeenCalled()
    expect(brief).not.toHaveBeenCalled()
  })

  it.each(['web', 'channel'] as const)('uses admitted current-turn tools on %s before history is needed', async lane => {
    const scripted = capturingProvider(['webSearch', 'urlReader', 'calculate'], undefined, 'end_turn')
    const f = await fixture({ lane, provider: scripted.provider })
    const message: Message = { role: 'user', content: 'Use current public figures to calculate the difference.' }
    const discover = vi.fn(async () => { throw new Error('Unexpected history load') })
    const candidates = [readTool('webSearch', 'public search'), readTool('urlReader', 'public page'),
      readTool('calculate', 'calculation'), readTool('privateWorkspaceRead'), writeTool()]
    await f.owner.prepareRun({ systemPrompt: 'Initial', messages: [message],
      candidateTools: new Map(candidates.map(tool => [tool.name, tool])), contextDiscovery: discover })
    await expect(f.owner.run({ loop: { ...owned(f.context), maxTurns: 4 }, sink: { kind: 'adapter' } }))
      .resolves.toMatchObject({ finalText: 'Fictional prepared answer.' })
    expect(discover).not.toHaveBeenCalled()
    expect(scripted.captured).toHaveLength(1)
    const [session] = scripted.captured
    expect(toolNames(session)).toEqual(['readChatHistory', 'webSearch', 'urlReader', 'calculate'])
    expect(session.sends[0]).toEqual([message])
    expect(session.sends.slice(1)).toMatchObject(['webSearch', 'urlReader', 'calculate'].map((name, index) => [
      { role: 'user', content: [{ type: 'tool_result', name,
        toolUseId: index ? `fixture-call-${index}` : 'fixture-call' }] },
    ]))
  })

  it('steers interactive pages to discovery without exposing browser actions on the initial frame', async () => {
    const f = await fixture()
    const discover = vi.fn(async () => { throw new Error('Unexpected history load') })
    await f.owner.prepareRun({ systemPrompt: 'Initial', messages: [{ role: 'user', content: 'Check the room search form at the supplied URL.' }],
      candidateTools: new Map([
        ['urlReader', readTool('urlReader')],
        ['browserNavigate', { ...writeTool(), name: 'browserNavigate', requiresCapability: 'computer' }],
      ]), contextDiscovery: discover })
    await f.owner.run({ loop: owned(f.context), sink: { kind: 'adapter' } })
    const [session] = f.captured
    expect(toolNames(session)).toEqual(['readChatHistory', 'urlReader'])
    expect(session.config.runtimeSystemContext).toContain('call readChatHistory first to check for permitted browser tools')
    expect(session.config.runtimeSystemContext).toContain('A static URL read cannot do those actions')
    expect(discover).not.toHaveBeenCalled()
  })

  it('exposes only visible current-turn reads without additional grants or approval', async () => {
    const f = await fixture()
    const discover = vi.fn(async () => { throw new Error('Unexpected history load') })
    await f.owner.prepareRun({ systemPrompt: 'Initial', messages: [{ role: 'user', content: 'Answer from this request.' }],
      candidateTools: new Map([
        ['webSearch', { ...readTool('webSearch'), requiresCapability: 'fixture-grant' }],
        ['urlReader', { ...readTool('urlReader'), hiddenFromModel: true }],
        ['calculate', { ...readTool('calculate'), resolveConfirmation: async () => true }],
      ]), contextDiscovery: discover })
    await f.owner.run({ loop: owned(f.context), sink: { kind: 'adapter' } })
    expect(toolNames(f.captured[0])).toEqual(['readChatHistory'])
    expect(discover).not.toHaveBeenCalled()
  })

  it.each(['tool_use', 'end_turn'] as const)('continues a completed discovery call with its receipt, model settings and scoped history after %s', async stopReason => {
    const scripted = capturingProvider('tool', 'readChatHistory', stopReason)
    const f = await fixture({ provider: scripted.provider, custom: true })
    const initial: Message = { role: 'user', content: 'Continue that work.' }
    const previous = bindScopeSources<Message>({ role: 'user', content: 'Earlier fixture work' }, [source('earlier')])
    const brief = briefResolver()
    configureBriefTurnContext(brief)
    const discover = vi.fn(async () => {
      expect(scripted.captured).toHaveLength(1)
      expect(sent(scripted.captured[0])).toEqual([initial])
      expect(brief).not.toHaveBeenCalled()
      const tools = f.owner.prepareTools(new Map([['readThing', readTool()]]))
      return { systemPrompt: 'Expanded', messages: [previous, initial], candidateTools: tools,
        trustedContributions: [{ name: 'facts', content: 'Private permitted context' }] }
    })
    const view = await f.owner.prepareRun({ systemPrompt: 'Initial', messages: [initial], candidateTools: new Map(), contextDiscovery: discover })
    const result = await f.owner.run({ loop: owned(f.context), sink: { kind: 'adapter' } })
    expect(result.finalText).toBe('Fictional prepared answer.')
    expect(discover).toHaveBeenCalledOnce()
    expect(scripted.captured).toHaveLength(2)
    const continuation = scripted.captured[1]
    expect(toolNames(continuation)).toEqual(['readThing'])
    expect(continuation.config).toMatchObject({ model: scripted.captured[0].config.model, maxTokens: 2_048, inputTokenLimit: 16_000, runtimeSystemContext: expect.stringContaining('Private permitted context') })
    expect(sent(continuation)).toMatchObject([previous, initial,
      { role: 'assistant', content: [{ type: 'tool_use', name: 'readChatHistory', id: 'fixture-call' }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'fixture-call', name: 'readChatHistory' }] }])
    expect(boundScopeSources(sent(continuation)[0])).toEqual([source('earlier')])
    expect(view.grounding.runtimeContext).toContain('Private permitted context')
    expect(f.owner.usage?.totalUsage).toMatchObject({ inputTokens: 2, outputTokens: 2 })
  })

  it.each(['tool_use', 'end_turn'] as const)('lets the web model correct rejected discovery arguments after %s', async stopReason => {
    const tool = 'readChatHistory'
    const scripted = capturingProvider([tool, tool], undefined, stopReason, ['{"request":"Use earlier notes."}', '{}'])
    const f = await fixture({ provider: scripted.provider })
    const initial: Message = { role: 'user', content: 'Continue the earlier discussion.' }
    const earlier = bindScopeSources<Message>({ role: 'user', content: 'Fictional retained notes.' }, [source('earlier')])
    const sendsAtDiscovery: number[] = []
    const discover = vi.fn(async () => {
      sendsAtDiscovery.push(scripted.captured[0].sends.length)
      return { systemPrompt: 'Expanded', messages: [earlier, initial], candidateTools: new Map([['readThing', readTool()]]) }
    })
    await f.owner.prepareRun({ systemPrompt: 'Initial', messages: [initial], candidateTools: new Map(), contextDiscovery: discover })

    const result = await f.owner.run({ loop: owned(f.context), sink: { kind: 'adapter' } })

    expect(result.finalText).toBe('Fictional prepared answer.')
    expect(discover).toHaveBeenCalledOnce()
    expect(sendsAtDiscovery).toEqual([2])
    expect(scripted.captured).toHaveLength(2)
    const [limited, expanded] = scripted.captured
    expect(limited.config.systemPrompt).toBe('Initial')
    expect(toolNames(limited)).toEqual([tool])
    expect(limited.sends).toHaveLength(2)
    expect(limited.sends[0]).toEqual([initial])
    expect(limited.sends[1]).toMatchObject([{ role: 'user', content: [{
      type: 'tool_result', name: tool, toolUseId: 'fixture-call', isError: true, content: expect.any(String),
    }] }])
    expect(JSON.stringify(limited.sends)).not.toContain(earlier.content)
    expect(toolNames(expanded)).toEqual(['readThing'])
    expect(sent(expanded)).toMatchObject([earlier, initial,
      { role: 'assistant', content: [{ type: 'tool_use', name: tool, id: 'fixture-call' }] },
      { role: 'user', content: [{ type: 'tool_result', name: tool, toolUseId: 'fixture-call', isError: true }] },
      { role: 'assistant', content: [{ type: 'tool_use', name: tool, id: 'fixture-call-1', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', name: tool, toolUseId: 'fixture-call-1',
        content: 'The permitted conversation context and available tools are ready.' }] },
    ])
  })

  it('terminates discovery when a valid web call fails in the discovery frame', async () => {
    const scripted = capturingProvider('tool', 'readChatHistory')
    const f = await fixture({ provider: scripted.provider })
    const failure = new Error('Fictional discovery failed while reading history.')
    const discover = vi.fn(async () => { throw failure })
    await f.owner.prepareRun({ systemPrompt: 'Initial', messages: [{ role: 'user', content: 'Continue the earlier discussion.' }],
      candidateTools: new Map(), contextDiscovery: discover })

    await expect(f.owner.run({ loop: owned(f.context), sink: { kind: 'adapter' } })).rejects.toBe(failure)
    expect(discover).toHaveBeenCalledOnce()
    expect(scripted.captured).toHaveLength(1)
    expect(scripted.captured[0].sends).toHaveLength(1)
  })

  it('terminates discovery when a rejected call precedes a recent text read failure in the same batch', async () => {
    const tool = 'readChatHistory'
    const send = vi.fn(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'message_start', model: 'fixture-model' }
      if (send.mock.calls.length > 1) {
        yield { type: 'text_delta', text: 'Unexpected continuation after a failed read.' }
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
        return
      }
      for (const [id, input] of [['rejected-call', '{"mode":"fictional-mode"}'], ['recent-text-call', '{"mode":"recent_text"}']]) {
        yield { type: 'tool_use_start', id, name: tool }
        yield { type: 'tool_use_delta', id, input }
        yield { type: 'tool_use_end', id }
      }
      yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } }
    })
    const provider: LLMProvider = { name: 'fixture-run-provider', models: [],
      stream() { throw new Error('Unexpected stateless dispatch') }, createSession: () => ({ send }) }
    const scopeAccumulator = new ContextScopeAccumulator()
    const f = await fixture({ lane: 'channel', provider, scopeAccumulator })
    const readFailure = 'Fictional recent text read failed.'
    selectRecentText.mockRejectedValueOnce(new Error(readFailure))
    const bindSelection = vi.fn(), discover = vi.fn()
    await f.owner.prepareRun({ systemPrompt: 'Initial', messages: [{ role: 'user', content: 'Continue our discussion.' }],
      candidateTools: new Map(), contextDiscovery: discover,
      telegramHistory: { source:{kind:'native',authority:{execution:f.execution,accumulator:scopeAccumulator},verifyGroupContinuation:false},
        window:{beforeSequence:3},bindSelection } })

    const receipts: Extract<ContentBlock, { type: 'tool_result' }>[] = []
    const run = f.owner.run({ loop: owned({ ...f.context, scopeAccumulator }), sink: { kind: 'adapter', onEvent(event) {
      if (event.type === 'tool_result') receipts.push(...event.results.filter(block => block.type === 'tool_result'))
    } } })
    const result = await run.then(value => ({ value }), error => ({ error }))

    expect(receipts).toMatchObject([
      { type: 'tool_result', name: tool, toolUseId: 'rejected-call', isError: true, content: expect.stringContaining('Validation failed') },
      { type: 'tool_result', name: tool, toolUseId: 'recent-text-call', isError: true, content: expect.stringContaining(readFailure) },
    ])
    expect(selectRecentText).toHaveBeenCalledExactlyOnceWith(f.execution, {beforeSequence:3}, undefined)
    expect(bindSelection).not.toHaveBeenCalled()
    expect(discover).not.toHaveBeenCalled()
    expect(result).toEqual({ error: new Error('Conversation context discovery failed.') })
    expect(send).toHaveBeenCalledOnce()
  })

  it.each([false, true])('reads mail in the initial frame and retains the pair when context is requested later (%s)', async useHistory => {
    const scripted = capturingProvider(useHistory ? ['imapSearchMessages', 'readChatHistory'] : ['imapSearchMessages'], undefined, 'end_turn')
    const f = await fixture({ lane: 'channel', provider: scripted.provider })
    const initial: Message = { role: 'user', content: 'Find the newest email.' }
    const earlier: Message = { role: 'user', content: 'Earlier fictional conversation.' }
    const capabilities = initialMailbox(f)
    const execute = vi.fn(async () => ({ data: 'Fictional mailbox receipt' }))
    mailbox.dispatcher.mockResolvedValue({ execute })
    const discover = vi.fn(async () => ({ systemPrompt: 'Expanded', messages: [earlier, initial], candidateTools: new Map() }))
    await f.owner.prepareRun({ systemPrompt: 'Initial', messages: [initial], candidateTools: new Map(),
      initialMailboxCapabilities: capabilities, contextDiscovery: discover })
    expect(capabilities).not.toHaveBeenCalled()
    expect(mailbox.dispatcher).not.toHaveBeenCalled()
    await expect(f.owner.run({ loop: owned(f.context), sink: { kind: 'adapter' } })).resolves.toMatchObject({ finalText: 'Fictional prepared answer.' })
    expect(toolNames(scripted.captured[0])).toEqual(['readChatHistory', 'imapSearchMessages', 'imapGetMessage'])
    expect(scripted.captured[0].sends[0]).toEqual([initial])
    expect(scripted.captured[0].sends[1]).toMatchObject([{ role: 'user', content: [{ type: 'tool_result', name: 'imapSearchMessages', toolUseId: 'fixture-call', content: 'Fictional mailbox receipt' }] }])
    expect(capabilities).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledExactlyOnceWith({ server: 'imap', tool: 'imapSearchMessages', args: {} }, expect.objectContaining({ executionContext: f.execution }))
    if (useHistory) {
      expect(discover).toHaveBeenCalledOnce()
      expect(sent(scripted.captured[1])).toMatchObject([earlier, initial,
        { role: 'assistant', content: [{ type: 'tool_use', name: 'imapSearchMessages', id: 'fixture-call' }] },
        { role: 'user', content: [{ type: 'tool_result', name: 'imapSearchMessages', toolUseId: 'fixture-call', content: 'Fictional mailbox receipt' }] },
        { role: 'assistant', content: [{ type: 'tool_use', name: 'readChatHistory', id: 'fixture-call-1' }] },
        { role: 'user', content: [{ type: 'tool_result', name: 'readChatHistory', toolUseId: 'fixture-call-1' }] }])
    } else {
      expect(discover).not.toHaveBeenCalled()
      expect(scripted.captured).toHaveLength(1)
    }
  })

  it('dispatches the ordinary Knowledge search lazily and completes without earlier conversation', async () => {
    const scripted = capturingProvider(['searchKnowledge'], undefined, 'end_turn')
    const f = await fixture({ lane: 'channel', provider: scripted.provider })
    const initial: Message = { role: 'user', content: 'Search Knowledge for the current observatory handbook.' }
    const capabilities = initialMailbox(f)
    const execute = vi.fn(async () => ({ data: 'Fictional observatory handbook receipt' }))
    knowledge.dispatcher.mockResolvedValue({ execute })
    const discover = vi.fn(async () => { throw new Error('Unexpected history load') })
    await f.owner.prepareRun({ systemPrompt: 'Initial', messages: [initial], candidateTools: new Map(),
      initialKnowledgeCapabilities: capabilities, contextDiscovery: discover })
    expect(capabilities).not.toHaveBeenCalled()
    expect(knowledge.dispatcher).not.toHaveBeenCalled()

    await expect(f.owner.run({ loop: owned(f.context), sink: { kind: 'adapter' } })).resolves.toMatchObject({ finalText: 'Fictional prepared answer.' })
    expect(toolNames(scripted.captured[0])).toEqual(['readChatHistory', 'searchKnowledge'])
    expect(scripted.captured[0].sends[0]).toEqual([initial])
    expect(scripted.captured[0].sends[1]).toMatchObject([{ role: 'user', content: [{ type: 'tool_result', name: 'searchKnowledge',
      toolUseId: 'fixture-call', content: 'Fictional observatory handbook receipt' }] }])
    expect(execute).toHaveBeenCalledExactlyOnceWith({ server: 'knowledge', tool: 'searchKnowledge', args: { query: 'observatory handbook' } },
      expect.objectContaining({ executionContext: f.execution }))
    expect(discover).not.toHaveBeenCalled()
  })

  it('refuses a substituted Knowledge actor before catalog activation', async () => {
    const scripted = capturingProvider('tool', 'searchKnowledge')
    const f = await fixture({ lane: 'channel', provider: scripted.provider })
    const messages: Message[] = [{ role: 'user', content: 'Search Knowledge.' }]
    const capabilities = initialMailbox(f, { actorIdentity: { channel: 'telegram', id: 'other-account', email: null, userId: 'other-user' } })
    await f.owner.prepareRun({ systemPrompt: 'Initial', messages, candidateTools: new Map(), initialKnowledgeCapabilities: capabilities,
      contextDiscovery: async () => ({ systemPrompt: 'Expanded', messages, candidateTools: new Map() }) })
    await expect(f.owner.run({ loop: owned(f.context), sink: { kind: 'adapter' } })).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(knowledge.dispatcher).not.toHaveBeenCalled()
  })

  it.each(['actor', 'assistant', 'profile'] as const)('refuses a substituted mailbox %s before connector lookup', async field => {
    const scripted = capturingProvider('tool', 'imapSearchMessages')
    const f = await fixture({ lane: 'channel', provider: scripted.provider })
    const messages: Message[] = [{ role: 'user', content: 'Read email.' }]
    const capabilities = field === 'profile'
      ? async () => ({ profile: 'web', composition: { kind: 'route-params', params: {} } } as never)
      : initialMailbox(f, field === 'assistant' ? { assistantId: 'other-assistant' }
        : { actorIdentity: { channel: 'telegram', id: 'other-account', email: null, userId: 'other-user' } })
    await f.owner.prepareRun({ systemPrompt: 'Initial', messages, candidateTools: new Map(), initialMailboxCapabilities: capabilities,
      contextDiscovery: async () => ({ systemPrompt: 'Expanded', messages, candidateTools: new Map() }) })
    await expect(f.owner.run({ loop: owned(f.context), sink: { kind: 'adapter' } })).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(mailbox.dispatcher).not.toHaveBeenCalled()
    expect(scripted.captured[0].sends).toHaveLength(1)
  })

  it('sends admitted discovery evidence to Gemini after an unsigned call on another provider', async () => {
    const first = capturingProvider('tool', 'readChatHistory')
    const getTierRouteSystem: WorkspaceCustomLlmEndpointStore['getTierRouteSystem'] = async ({ workspaceId, tier }) =>
      tier === 'pro' ? { workspaceId, tier, modelAlias: 'gpt-6.1-terra', profileId: null, updatedAt: new Date() } : null
    const resolver = createWorkspaceCustomLlmResolver({ getTierRouteSystem } as WorkspaceCustomLlmEndpointStore, { managedProvider: first.provider })
    const f = await fixture({ provider: createGeminiProvider('fixture-key'), resolver })
    const current: Message = { role: 'user', content: 'Which colour was chosen?' }
    const earlier = bindScopeSources<Message>({ role: 'user', content: 'The chosen colour was violet.' }, [source('colour')])
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Violet."}]},"finishReason":"STOP"}]}\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    ))
    try {
      await f.owner.prepareRun({ systemPrompt: 'Initial', messages: [current], candidateTools: new Map(), contextDiscovery: async () => ({
        systemPrompt: 'Expanded', messages: [earlier, current], candidateTools: new Map(),
        trustedContributions: [{ name: 'instructions', content: 'Use the permitted conversation history.' }],
        mainModel: { kind: 'web', plan: 'max_5x', budgetStatus: 'ok', researchMode: true, metered: null, hasImage: false },
      }) })
      const result = await f.owner.run({ loop: owned(f.context), sink: { kind: 'adapter' } })
      expect(first.captured).toHaveLength(1)
      expect(sent(first.captured[0])).toEqual([current])
      expect(fetch).toHaveBeenCalledOnce()
      const wire = JSON.parse(String(fetch.mock.calls[0][1]?.body))
      expect(wire.contents.flatMap((message: { parts: unknown[] }) => message.parts)).toEqual([
        { text: 'The chosen colour was violet.' }, { text: 'Which colour was chosen?' },
      ])
      expect(JSON.stringify(wire.systemInstruction)).toContain('Use the permitted conversation history.')
      expect(result.finalText).toBe('Violet.')
    } finally { fetch.mockRestore() }
  })

  it('keeps worker readers available for delegation while the coordinator sees only its narrowed tools', async () => {
    const scripted = capturingProvider(['readChatHistory', 'delegateRead'])
    const f = await fixture({ provider: scripted.provider })
    const workerReader = readTool('workerRead')
    const seen = vi.fn()
    const delegate = buildTool({ name: 'delegateRead', description: 'Inspect the worker roster', inputSchema: z.object({}), isReadOnly: true,
      async execute(_input, context) {
        seen([...context.requestTools!.keys()])
        return { data: 'Read delegated' }
      } })
    const messages: Message[] = [{ role: 'user', content: 'Research this.' }]
    await f.owner.prepareRun({ systemPrompt: 'Initial', messages, candidateTools: new Map(), contextDiscovery: async () => ({
      systemPrompt: 'Coordinate', messages, candidateTools: new Map([[delegate.name, delegate]]),
      context: { requestTools: new Map([[workerReader.name, workerReader], ['writeThing', writeTool()]]) },
    }) })
    await f.owner.run({ loop: owned(f.context), sink: { kind: 'adapter' } })
    expect(toolNames(scripted.captured[1])).toEqual(['delegateRead'])
    expect(seen).toHaveBeenCalledExactlyOnceWith(['workerRead'])
  })

  it('preserves the previous error receipt if the model requests context on a later round', async () => {
    const scripted = capturingProvider(['missingFixtureTool', 'readChatHistory'])
    const f = await fixture({ provider: scripted.provider })
    const messages: Message[] = [{ role: 'user', content: 'Continue earlier work.' }]
    await f.owner.prepareRun({ systemPrompt: 'Initial', messages, candidateTools: new Map(), contextDiscovery: async () => ({
      systemPrompt: 'Expanded', messages, candidateTools: new Map(),
    }) })
    await f.owner.run({ loop: owned(f.context), sink: { kind: 'adapter' } })
    expect(scripted.captured).toHaveLength(2)
    const continued = sent(scripted.captured[1])
    expect(continued).toMatchObject([messages[0],
      { role: 'assistant', content: [{ type: 'tool_use', id: 'fixture-call' }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'fixture-call', isError: true }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'fixture-call-1' }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'fixture-call-1' }] }])
  })

  it('defers non-native PDF bytes until discovery and keeps the attachment source at both provider boundaries', async () => {
    const scripted = capturingProvider('tool', 'readChatHistory')
    const f = await fixture({ provider: scripted.provider, custom: true })
    const file = bindScopeSources({ type: 'image' as const, mimeType: 'application/pdf', data: 'ZmFrZSBwZGY=' }, [source('file')])
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'Read this PDF.' }, file] }]
    await f.owner.prepareRun({ systemPrompt: 'Initial', messages, candidateTools: new Map(), contextDiscovery: async () => ({
      systemPrompt: 'Expanded', messages, candidateTools: new Map(),
    }) })
    await f.owner.run({ loop: owned(f.context), sink: { kind: 'adapter' } })
    const first = sent(scripted.captured[0])[0].content
    const second = sent(scripted.captured[1])[0].content
    expect(first).toMatchObject([{ type: 'text', text: 'Read this PDF.' }, { type: 'text', text: expect.stringContaining('PDF attachment') }])
    expect(JSON.stringify(first)).not.toContain(file.data)
    expect(second).toMatchObject([{ type: 'text' }, file])
    for (const blocks of [first, second]) {
      expect(Array.isArray(blocks) && boundScopeSources(blocks[1])).toEqual([source('file')])
    }
  })

  it.each([
    ['web', 'gpt-6-luna'],
    ['channel', 'gpt-6.2-sol'],
  ] as const)('uses the workspace route for promoted %s requests and spawned workers, charging each logical tier', async (lane, researchModel) => {
    vi.stubEnv('USEBRIAN_EDITION', 'outpost')
    try {
      const proModel = 'gpt-6.2-sol'
      const routes = { standard: proModel, pro: proModel, max: proModel, research: researchModel }
      const scripted = capturingProvider(['readChatHistory', 'inspectWithWorker'])
      scripted.provider.stream = async function* (request) {
        scripted.captured.push({ config: { model: request.model, allowProviderFallback: request.allowProviderFallback }, sends: [request.messages] })
        yield { type: 'message_start', model: request.model }
        yield { type: 'text_delta', text: 'Fictional worker finding.' }
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 4, outputTokens: 2 } }
      }
      const getTierRouteSystem: WorkspaceCustomLlmEndpointStore['getTierRouteSystem'] = async ({ workspaceId, tier }) =>
        ({ workspaceId, tier, modelAlias: routes[tier], profileId: null, updatedAt: new Date() })
      const resolver = createWorkspaceCustomLlmResolver({ getTierRouteSystem } as WorkspaceCustomLlmEndpointStore, { managedProvider: scripted.provider })
      const f = await fixture({ lane, provider: scripted.provider, resolver })
      const initialWorkspaceRoute = f.main.customLlm!
      const inheritedWorker = { provider: initialWorkspaceRoute.provider, model: initialWorkspaceRoute.selector,
        modelTier: initialWorkspaceRoute.modelTier, providerKeySource: initialWorkspaceRoute.providerKeySource }
      const workerUsage = vi.fn(async () => {})
      const manager = createWorkerManager({ provider: capturingProvider().provider, model: 'independent-worker-model', tools: new Map(), onUsage: workerUsage })
      const inspect = buildTool({ name: 'inspectWithWorker', description: 'Delegate the fictional inspection.', inputSchema: z.object({}), isReadOnly: true,
        async execute(_input, context) {
          const spawned = manager.spawn('Inspect the fictional material.', context)
          if (!spawned) throw new Error('Worker was not admitted')
          await manager.waitForNext(context.sessionId)
          const [finished] = manager.drainNotifications(context.sessionId)
          return { data: finished?.status }
        } })
      const messages: Message[] = [{ role: 'user', content: 'Examine the earlier results in detail.' }]
      const mainModel = lane === 'channel'
        ? { kind: 'channel' as const, requestedAlias: 'research', plan: 'max_5x', budgetStatus: 'ok' as const }
        : { kind: 'web' as const, plan: 'max_5x', budgetStatus: 'ok' as const, researchMode: true, metered: null, hasImage: false }
      await f.owner.prepareRun({ systemPrompt: 'Initial', messages, candidateTools: new Map(), contextDiscovery: async () => ({
        systemPrompt: 'Expanded', messages, candidateTools: new Map([[inspect.name, inspect]]), mainModel,
      }) })
      const recordUsage = vi.fn(async () => {}), afterSettlement = vi.fn(async () => {})
      f.owner.registerUsageBilling({ metadata: { userId: identity.user, assistantId: identity.assistant, sessionId: identity.session,
        modelTier: 'pro', source: 'included', providerKeySource: 'platform' }, costPolicy: 'calculate', recordUsage, afterSettlement })
      await f.owner.run({ loop: owned({ ...f.context, workerRuntime: inheritedWorker }), sink: { kind: 'adapter' } })
      await f.owner.settleUsage()
      expect(scripted.captured.map(c => [c.config.model, c.config.allowProviderFallback])).toEqual([
        [proModel, false], [researchModel, false], [researchModel, false],
      ])
      expect(workerUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ model: researchModel, modelTier: 'research', providerKeySource: 'platform' }))
      expect(recordUsage).toHaveBeenCalledTimes(2)
      expect(recordUsage).toHaveBeenNthCalledWith(1, expect.objectContaining({ model: proModel, inputTokens: 1, outputTokens: 1, modelTier: 'pro' }))
      expect(recordUsage).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: researchModel, inputTokens: 2, outputTokens: 2, modelTier: 'research' }))
      expect(afterSettlement).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ inputTokens: 3, outputTokens: 3 }))
    } finally { vi.unstubAllEnvs() }
  })

  it.each(['gpt-6.2-sol', 'gpt-6-luna'])('checkpoints the active Research tier and exact model %s when an approval parks', async researchModel => {
    vi.stubEnv('USEBRIAN_EDITION', 'outpost')
    try {
      const scripted = capturingProvider(['readChatHistory', 'writeThing'])
      const getTierRouteSystem: WorkspaceCustomLlmEndpointStore['getTierRouteSystem'] = async ({ workspaceId, tier }) =>
        ({ workspaceId, tier, modelAlias: tier === 'research' ? researchModel : 'gpt-6.2-sol', profileId: null, updatedAt: new Date() })
      const resolver = createWorkspaceCustomLlmResolver({ getTierRouteSystem } as WorkspaceCustomLlmEndpointStore, { managedProvider: scripted.provider })
      const f = await fixture({ provider: scripted.provider, resolver })
      const confirmations = createConfirmationResolver()
      const checkpoint = vi.fn()
      const write = { ...writeTool(), requiresConfirmation: true }
      const messages: Message[] = [{ role: 'user', content: 'Continue the earlier research.' }]
      await f.owner.prepareRun({ systemPrompt: 'Initial', messages, candidateTools: new Map(), contextDiscovery: async () => ({
        systemPrompt: 'Research', messages, candidateTools: new Map([[write.name, write]]),
        mainModel: { kind: 'web', plan: 'max_5x', budgetStatus: 'ok', researchMode: true, metered: null, hasImage: false },
      }) })
      await f.owner.run({ loop: { ...owned({ ...f.context, createToolInvocationApproval: async () => 'fixture-approval' }),
        confirmationResolver: confirmations }, sink: { kind: 'adapter', onEvent(event) {
          if (event.type === 'awaiting_approval') checkpoint(event.approvalId, f.owner.checkpointModelSelection())
          if (event.type === 'tool_confirmation_required') confirmations.resolve(event.request.toolCallId, 'allow')
        } } })
      expect(checkpoint).toHaveBeenCalledExactlyOnceWith('fixture-approval', {
        selectedCustomModel: researchModel, selectedTier: 'research', selectedLegacyByo: false,
      })
    } finally { vi.unstubAllEnvs() }
  })

  it.each(['inherited', 'independent'] as const)('handles the %s worker lane on promotion to an automatic Research route', async lane => {
    const scripted = capturingProvider(['readChatHistory', 'inspectWorkerLane'])
    const getTierRouteSystem: WorkspaceCustomLlmEndpointStore['getTierRouteSystem'] = async ({ workspaceId, tier }) => tier === 'pro'
      ? { workspaceId, tier, modelAlias: 'gpt-6.1-terra', profileId: null, updatedAt: new Date() } : null
    const resolver = createWorkspaceCustomLlmResolver({ getTierRouteSystem } as WorkspaceCustomLlmEndpointStore, { managedProvider: scripted.provider })
    const f = await fixture({ provider: scripted.provider, resolver })
    const initialRoute = f.main.customLlm!
    const workerRuntime = lane === 'independent'
      ? { provider: capturingProvider().provider, model: 'independent-worker-model' }
      : { provider: initialRoute.provider, model: initialRoute.selector }
    const observe = vi.fn()
    const inspect = buildTool({ name: 'inspectWorkerLane', description: 'Observe the worker route.', inputSchema: z.object({}), isReadOnly: true,
      async execute(_input, context) { observe(context.workerRuntime); return { data: 'observed' } } })
    const messages: Message[] = [{ role: 'user', content: 'Research the fictional material.' }]
    await f.owner.prepareRun({ systemPrompt: 'Initial', messages, candidateTools: new Map(), contextDiscovery: async () => ({
      systemPrompt: 'Expanded', messages, candidateTools: new Map([[inspect.name, inspect]]),
      mainModel: { kind: 'web', plan: 'max_5x', budgetStatus: 'ok', researchMode: true, metered: null, hasImage: false },
    }) })
    await f.owner.run({ loop: owned({ ...f.context, workerRuntime }), sink: { kind: 'adapter' } })
    expect(observe).toHaveBeenCalledExactlyOnceWith(lane === 'inherited' ? undefined : workerRuntime)
  })

  it('withholds discovered material when authority is withdrawn before the next physical dispatch', async () => {
    const scripted = capturingProvider('tool', 'readChatHistory')
    let revoked = false
    const f = await fixture({ provider: scripted.provider, assertCurrent: async () => {
      if (revoked) throw Object.assign(new Error('Revoked'), { reason: 'authority_changed', retrySafe: false })
    } })
    const messages: Message[] = [{ role: 'user', content: 'Continue.' }]
    await f.owner.prepareRun({ systemPrompt: 'Initial', messages, candidateTools: new Map(),
      contextDiscovery: async () => {
        revoked = true
        return { systemPrompt: 'Private discovered material', messages, candidateTools: new Map() }
      } })
    await expect(f.owner.run({ loop: owned(f.context), sink: { kind: 'adapter' } })).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(scripted.captured).toHaveLength(1)
    expect(JSON.stringify(scripted.captured)).not.toContain('Private discovered material')
  })

  it('honors Stop during requested discovery before any enriched provider dispatch', async () => {
    const scripted = capturingProvider('tool', 'readChatHistory')
    const f = await fixture({ provider: scripted.provider })
    const entered = deferred(), gate = deferred()
    await f.owner.prepareRun({ systemPrompt: 'Initial', messages: [{ role: 'user', content: 'Continue.' }], candidateTools: new Map(),
      contextDiscovery: async signal => {
        entered.resolve()
        await gate.promise
        signal.throwIfAborted()
        return { systemPrompt: 'Expanded', messages: [], candidateTools: new Map() }
      } })
    const outcome = f.owner.run({ loop: owned(f.context), sink: { kind: 'adapter' } }).catch(error => error)
    await entered.promise
    abortLocalTurn(identity.session, 'run-token')
    gate.resolve()
    await outcome
    expect(f.owner.abortKind).toBe('stop')
    expect(scripted.captured).toHaveLength(1)
  })

  it('captures every supplied value and implementation before admission and Brief awaits', async () => {
    readCalls.length = 0
    const gate = deferred(), entered = deferred()
    let first = false
    const tools = capturingProvider('tool')
    const f = await fixture({ provider: tools.provider, assertCurrent: async () => { if (first) { first = false; entered.resolve(); await gate.promise } } })
    const original = briefResolver(), replacement = briefResolver('<brief>Replacement rules</brief>')
    configureBriefTurnContext(original)
    const tool = readTool(), candidates = new Map<string, Tool>([['readThing', tool]])
    const input = { systemPrompt: 'Original stable prompt', messages: [{ role: 'user' as const, content: 'Original question.' }] as Message[],
      candidateTools: candidates, trustedContributions: [{ name: 'runtime', content: 'Original runtime' }],
      userVisibleContributions: [{ name: 'turn', content: 'Original visible' }] }
    first = true
    const preparing = f.owner.prepareRun(input); await entered.promise
    input.systemPrompt = 'Forged prompt'; (input.messages[0] as { content: string }).content = 'Forged question.'
    input.messages.push({ role: 'user', content: 'Forged appended turn.' })
    input.trustedContributions[0].content = 'Forged runtime'; input.userVisibleContributions[0].content = 'Forged visible'
    candidates.set('forgedTool', readTool('forgedTool', 'forged')); candidates.delete('readThing')
    tool.execute = async () => { readCalls.push('replaced'); return { data: { from: 'replaced' } } }
    tool.description = 'Forged description'
    configureBriefTurnContext(replacement)
    gate.resolve(); await preparing
    await f.owner.run({ loop: owned(f.context), sink: { kind: 'none' } })
    expect(original).toHaveBeenCalledOnce(); expect(replacement).not.toHaveBeenCalled()
    const [session] = tools.captured
    expect(session.config.systemPrompt).toBe('Original stable prompt')
    expect(session.config.runtimeSystemContext).toBe('Original runtime\n\n<brief>Fictional accepted rules</brief>')
    expect(toolNames(session)).toEqual(['readThing'])
    expect((session.config.tools as Array<{ description: string }>)[0].description).toBe('Fictional original read')
    expect(JSON.stringify(sent(session))).toContain('Original question.'); expect(JSON.stringify(sent(session))).toContain('Original visible')
    expect(JSON.stringify(session.sends)).not.toMatch(/Forged/)
    expect(readCalls).toEqual(['original'])
  })

  it.each([
    ['plain user text', [{ role: 'user', content: 'Plain question.' }], false],
    ['user content blocks', [{ role: 'user', content: [{ type: 'text', text: 'Block question.' }] }], false],
    ['assistant-final resume shape', [{ role: 'user', content: 'Earlier.' }, { role: 'assistant', content: 'Final.' }], true],
    ['tool-result carrier', [{ role: 'user', content: [{ type: 'tool_result', toolUseId: 't', name: 'readThing', content: 'r' }] }], true],
    ['empty history', [], true],
  ] as const)('places user-visible context exactly once for %s', async (_label, messages, fallback) => {
    for (const lane of ['web', 'channel'] as const) {
      const f = await fixture({ lane })
      configureBriefTurnContext(briefResolver())
      const view = await f.owner.prepareRun({ systemPrompt: 'Stable', messages: structuredClone(messages) as unknown as Message[], candidateTools: new Map(),
        trustedContributions: [{ name: 'runtime', content: 'Runtime facts' }, { name: 'page', content: 'Page facts' }],
        userVisibleContributions: [{ name: 'turn', content: 'Visible facts' }] })
      await f.owner.run({ loop: owned(f.context), sink: { kind: 'none' } })
      const [session] = f.captured, runtime = String(session.config.runtimeSystemContext)
      expect(JSON.stringify([session.config, session.sends[0]]).split('<user_visible_context>').length - 1).toBe(1)
      if (fallback) {
        // Directly after the runtime contribution, before supplementary contributions and the Brief.
        expect(runtime).toMatch(/^Runtime facts\n\n<user_visible_context>[\s\S]*Visible facts[\s\S]*<\/user_visible_context>\n\nPage facts\n\n<brief>/)
        expect(view.grounding.runtimeContext).toBe(lane === 'channel' ? 'Runtime facts' : runtime.slice(0, runtime.indexOf('\n\nPage facts')))
      } else {
        expect(runtime).toBe('Runtime facts\n\nPage facts\n\n<brief>Fictional accepted rules</brief>')
        expect(view.grounding.runtimeContext).toBe('Runtime facts')
      }
      expect(view.grounding.userVisibleContext).toBe('Visible facts')
      await f.owner.finish()
    }
  })

  it('retains canonical source bindings on copied messages, nested blocks and the placement carrier', async () => {
    const f = await fixture()
    const block = bindScopeSources({ type: 'text' as const, text: 'Bound block.' }, [source('00000000-0000-4000-8000-000000000041')])
    const earlier = bindScopeSources<Message>({ role: 'user', content: [block] }, [source('00000000-0000-4000-8000-000000000042')])
    const answer: Message = { role: 'assistant', content: 'Earlier answer.' }
    const latest = bindScopeSources<Message>({ role: 'user', content: 'Latest question.' }, [source('00000000-0000-4000-8000-000000000043')])
    const messages = bindScopeSources([earlier, answer, latest], [source('00000000-0000-4000-8000-000000000044')])
    const view = await f.owner.prepareRun({ systemPrompt: 'Stable', messages, candidateTools: new Map(), userVisibleContributions: [{ name: 'turn', content: 'Visible' }] })
    messages.splice(0); (block as { text: string }).text = 'Mutated after capture.'
    await f.owner.run({ loop: owned(f.context), sink: { kind: 'none' } })
    const received = sent(f.captured[0])
    expect(received).toHaveLength(3); expect(received[0]).not.toBe(earlier)
    expect(boundScopeSources(received[0]).map(value => value.resourceId)).toEqual(['00000000-0000-4000-8000-000000000042'])
    expect(boundScopeSources((received[0].content as object[])[0]).map(value => value.resourceId)).toEqual(['00000000-0000-4000-8000-000000000041'])
    expect(JSON.stringify(received[0])).toContain('Bound block.')
    expect(boundScopeSources(received[2]).map(value => value.resourceId)).toEqual(['00000000-0000-4000-8000-000000000043'])
    expect(boundScopeSources(view.messageSnapshot()[2])).toEqual([])
  })

  it('answers calendar identity queries without exposing or accepting a substituted adopted map', async () => {
    const f = await fixture()
    configureBriefTurnContext(briefResolver())
    const bound = f.owner.prepareTools(new Map<string, Tool>([['readThing', readTool()], ['writeThing', writeTool()]]))
    const view = await f.owner.prepareRun({ systemPrompt: 'Stable', messages: [{ role: 'user', content: 'Hi.' }], candidateTools: bound })
    expect(view.adoptsTool('readThing', bound.get('readThing')!)).toBe(true)
    // Brief-wrapped mutating tools and foreign objects are not the adopted original.
    expect(view.adoptsTool('writeThing', bound.get('writeThing')!)).toBe(false)
    expect(view.adoptsTool('readThing', readTool())).toBe(false)
    const routine = (calendarTools: Map<string, Tool>) => ({ ...owned(f.context), routineCalendarRead: { runtime: {} as never,
      llm: {} as never, calendarTools } })
    await expect(f.owner.run({ loop: routine(new Map([['readThing', readTool()]])), sink: { kind: 'none' } })).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(f.captured).toHaveLength(0)
  })

  it('prepares a durable resume on its canonical system execution with the accepted Brief, as on every lane', async () => {
    const f = await fixture({ lane: 'resume' }), brief = briefResolver()
    configureBriefTurnContext(brief)
    await expect(f.owner.prepareRun({ systemPrompt: 'Resume prompt', messages: [{ role: 'user', content: 'Outcome note.' }],
      candidateTools: new Map([['readThing', readTool()]]), trustedContributions: [{ name: 'runtime', content: 'Resume runtime' }] }))
      .resolves.toMatchObject({ grounding: { runtimeContext: 'Resume runtime', userVisibleContext: '' } })
    // Full captured admission first, then the original lease, then the Brief on the actual execution.
    expect(f.assertCurrent).toHaveBeenCalled()
    expect(brief).toHaveBeenCalledOnce()
    expect(vi.mocked(brief).mock.calls[0]![0]).toBe(f.execution)
    // An unattended run freezes its approval job's Brief basis before provider work.
    expect(workBasis.put).toHaveBeenCalledWith(expect.objectContaining({ kind: 'job', workId: 'fixture-approval', workspaceId: identity.workspace }))
    await expect(f.owner.run({ loop: owned(f.context), sink: { kind: 'none' } })).resolves.toMatchObject({ selection: { kind: 'text' } })
    expect(f.captured[0].config).toMatchObject({ systemPrompt: 'Resume prompt',
      runtimeSystemContext: 'Resume runtime\n\n<brief>Fictional accepted rules</brief>' })
  })

  it('refuses a durable resume whose loop context is not its canonical execution', async () => {
    const f = await fixture({ lane: 'resume' })
    await f.owner.prepareRun({ systemPrompt: 'Resume prompt', messages: [{ role: 'user', content: 'Outcome note.' }], candidateTools: new Map() })
    await expect(f.owner.run({ loop: owned({ ...f.context, executionContext: undefined } as never), sink: { kind: 'none' } }))
      .rejects.toMatchObject({ reason: 'authority_changed' })
    expect(f.captured).toHaveLength(0)
  })

  it('refuses an unprepared run on every lane, durable resume included, and a run while preparation is pending', async () => {
    const f = await fixture()
    await expect(f.owner.run({ loop: { ...owned(f.context), systemPrompt: 'x', messages: [], tools: new Map() } as never, sink: { kind: 'none' } })).rejects.toThrow('has not been prepared')
    const r = await fixture({ lane: 'resume' })
    await expect(r.owner.run({ loop: { ...owned(r.context), systemPrompt: 'x', messages: [], tools: new Map() } as never, sink: { kind: 'none' } })).rejects.toThrow('has not been prepared')
    await expect(r.owner.run({ loop: owned(r.context), sink: { kind: 'none' } })).rejects.toThrow('has not been prepared')
    const gate = deferred(); let hold = false
    const g = await fixture({ assertCurrent: async () => { if (hold) await gate.promise } })
    hold = true
    const preparing = g.owner.prepareRun({ systemPrompt: 'Stable', messages: [{ role: 'user', content: 'Hi.' }], candidateTools: new Map() })
    await expect(g.owner.run({ loop: owned(g.context), sink: { kind: 'none' } })).rejects.toThrow('preparation has not finished')
    expect(() => g.owner.prepareRun({ systemPrompt: 'Again', messages: [], candidateTools: new Map() })).toThrow('already started')
    gate.resolve(); await preparing
  })

  it('refuses original authority replacement during the admission await before invoking the Brief', async () => {
    const gate = deferred(), entered = deferred(); let first = false
    const f = await fixture({ assertCurrent: async () => { if (first) { first = false; entered.resolve(); await gate.promise } } })
    const brief = briefResolver(); configureBriefTurnContext(brief)
    first = true
    const preparing = f.owner.prepareRun({ systemPrompt: 'Stable', messages: [{ role: 'user', content: 'Hi.' }], candidateTools: new Map() })
    const outcome = expect(preparing).rejects.toMatchObject({ reason: 'authority_changed' })
    await entered.promise; f.authority.assertCurrent = vi.fn(async () => {}); gate.resolve(); await outcome
    expect(brief).not.toHaveBeenCalled()
    await expect(f.owner.run({ loop: owned(f.context), sink: { kind: 'none' } })).rejects.toThrow('preparation has not finished')
    await f.owner.finish('failed'); expect(releaseTurn).toHaveBeenCalledOnce(); expect(f.owner.released).toBe(true)
  })

  it('honors Stop during a pending preparation and drains it before exact-token release', async () => {
    const gate = deferred(), entered = deferred(); let first = false
    const f = await fixture({ assertCurrent: async () => { if (first) { first = false; entered.resolve(); await gate.promise } } })
    const brief = briefResolver(); configureBriefTurnContext(brief)
    first = true
    const preparing = f.owner.prepareRun({ systemPrompt: 'Stable', messages: [{ role: 'user', content: 'Hi.' }], candidateTools: new Map() })
    const outcome = expect(preparing).rejects.toBeDefined()
    await entered.promise
    abortLocalTurn(identity.session, 'run-token')
    const finishing = f.owner.finish()
    await Promise.resolve(); expect(releaseTurn).not.toHaveBeenCalled()
    gate.resolve(); await outcome; await finishing
    expect(brief).not.toHaveBeenCalled(); expect(f.owner.abortKind).toBe('stop')
    expect(releaseTurn).toHaveBeenCalledExactlyOnceWith(identity.session, 'run-token', 'stopped_by_user', expect.any(Function))
  })

  it('reports an uncertain adopted effect when authority changes while it runs and never replays it', async () => {
    readCalls.length = 0
    const effectGate = deferred(), started = deferred()
    const scripted = capturingProvider('tool', 'slowWrite')
    const f = await fixture({ provider: scripted.provider })
    const slow = buildTool({ name: 'slowWrite', description: 'Fictional slow effect', inputSchema: z.object({}).passthrough(), isReadOnly: false,
      async execute() { readCalls.push('slow'); started.resolve(); await effectGate.promise; return { data: { sent: true } } } })
    await f.owner.prepareRun({ systemPrompt: 'Stable', messages: [{ role: 'user', content: 'Send it.' }], candidateTools: new Map([['slowWrite', slow]]) })
    const running = f.owner.run({ loop: owned(f.context), sink: { kind: 'none' } })
    const settled = running.then(value => ({ value }), error => ({ error }))
    await started.promise
    f.authority.execute = async operation => operation()
    effectGate.resolve()
    const result = await settled
    expect(readCalls).toEqual(['slow'])
    const serialized = JSON.stringify(scripted.captured.flatMap(entry => entry.sends))
    // The started effect is reported as possibly executed; nothing re-enters the model or replays it.
    expect('error' in result && result.error).toMatchObject({ reason: 'authority_changed', operationMayHaveExecuted: true })
    expect(serialized).not.toContain('"sent":true')
    await f.owner.finish('failed'); expect(releaseTurn).toHaveBeenCalledOnce()
  })
})
