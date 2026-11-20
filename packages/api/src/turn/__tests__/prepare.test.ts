/** [COMP:api/assistant-run-preparation] The original owner's private final run
 * preparation. Actual provider input, capture before admission/Brief awaits,
 * user-visible placement, source bindings, original authority, Stop,
 * uncertainty and cleanup. Only lease SQL and source-proof I/O are fake. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { NOOP_TURN_LEDGER } from '@use-brian/agent-runtime/engine/turn-ledger.js'
import type { LLMProvider, Message } from '@use-brian/agent-runtime/providers/types.js'
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
  type Tool
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
import { openAssistantTurn, type AssistantTurn } from '../kernel.js'
import { abortLocalTurn, releaseTurn } from '../lease.js'
import { configureBriefTurnContext, type BriefTurn, type BriefTurnResolver } from '../../briefs/context.js'
import type { ResolvedWorkspaceCustomLlm } from '../../custom-llm-runtime.js'

const identity = { workspace: '00000000-0000-4000-8000-000000000040', assistant: 'fixture-assistant', user: 'fixture-user', session: 'fixture-run-session' }
const owners: AssistantTurn[] = [], pending: (() => void)[] = []
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); pending.push(resolve); return { promise, resolve } }
afterEach(async () => { pending.splice(0).forEach(resolve => resolve()); for (const owner of owners.splice(0)) await owner.finish('failed'); configureBriefTurnContext(null) })
beforeEach(() => vi.clearAllMocks())

type Captured = { config: Record<string, unknown>; sends: Message[][] }
/** Real provider boundary: records exactly what a session is constructed and sent with. */
function capturingProvider(script: 'text' | 'tool' = 'text', toolName = 'readThing') {
  const captured: Captured[] = []
  const provider: LLMProvider = { name: 'fixture-run-provider', models: [], stream() { throw new Error('Unexpected stateless dispatch') },
    createSession(config) {
      const entry: Captured = { config: config as unknown as Record<string, unknown>, sends: [] }; captured.push(entry)
      let calls = 0
      return { send(messages) {
        entry.sends.push(messages); const call = calls++
        return (async function* () {
          yield { type: 'message_start' as const, model: 'fixture' }
          if (script === 'tool' && call === 0) {
            yield { type: 'tool_use_start' as const, id: 'fixture-call', name: toolName }
            yield { type: 'tool_use_delta' as const, id: 'fixture-call', input: '{}' }
            yield { type: 'tool_use_end' as const, id: 'fixture-call' }
            yield { type: 'message_end' as const, stopReason: 'tool_use' as const, usage: { inputTokens: 1, outputTokens: 1 } }
          } else {
            yield { type: 'text_delta' as const, text: 'Fictional prepared answer.' }
            yield { type: 'message_end' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } }
          }
        })()
      } }
    } }
  return { provider, captured }
}

async function fixture(options: { assertCurrent?: () => Promise<void>; lane?: 'web' | 'channel' | 'resume'; provider?: LLMProvider; custom?: boolean } = {}) {
  const abort = new AbortController(), assertCurrent = vi.fn(options.assertCurrent ?? (async () => {}))
  const authority: CurrentAuthorityBoundary = { assertCurrent, async execute(operation) { return operation() } }
  const lane = options.lane ?? 'web'
  // Durable resume binds its canonical system execution, keyed by its approval.
  const execution = createExecutionContext({ identity: lane === 'resume' ? { kind: 'system', purpose: 'session_resume', jobId: 'fixture-approval' }
    : { kind: 'attended', principal: { kind: 'workspace_member', userId: identity.user, authenticationKind: 'native_session' } },
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
  const services = { provider, configuredProviders: undefined, resolveWorkspaceCustomLlm: runtime ? async () => runtime : null,
    resolveLegacyByoKey: null, buildLegacyByoProvider: null }
  if (lane === 'resume') {
    owner.bindModelPreparation({ kind: 'execution', toolProfile: 'resume', execution, assertCurrent: authority.assertCurrent.bind(authority) }, services)
    await owner.prepareMainModel({ kind: 'resume', fallbackModel: 'fixture-model', selectedTier: 'pro' })
  } else {
    owner.bindModelPreparation({ kind: 'execution', toolProfile: lane, execution, assertCurrent: () => authority.assertCurrent() }, services)
    await owner.prepareMainModel(lane === 'web'
      ? { kind: 'web', requestedModel: options.custom ? 'custom:fixture' : 'pro', plan: 'max_5x', budgetStatus: 'ok', researchMode: false, metered: null, hasImage: false }
      : { kind: 'channel', plan: 'max_5x', budgetStatus: 'ok' })
  }
  return { owner, abort, authority, assertCurrent, execution, context, captured }
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
const owned = (context: ReturnType<typeof executionToolContext>) => ({ ledger: NOOP_TURN_LEDGER, maxTurns: 3, context })
function briefResolver(content = '<brief>Fictional accepted rules</brief>', incomplete = false): BriefTurnResolver {
  return vi.fn(async () => ({ workspaceId: identity.workspace, projectId: 'fixture-project', projectBindingId: 'fixture-binding',
    basis: {} as BriefTurn['basis'], fingerprint: 'fixture', incomplete, content }) as BriefTurn)
}
const source = (id: string): ScopeSource => ({ workspaceId: identity.workspace, userId: null, assistantId: identity.assistant, sensitivity: 'internal',
  compartments: [], projectIds: [], resourceKind: 'session_message', resourceId: id, version: '1' })
const toolNames = (entry: Captured) => ((entry.config.tools as Array<{ name: string }> | undefined) ?? []).map(tool => tool.name)
const sent = (entry: Captured) => entry.sends[0]!

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
