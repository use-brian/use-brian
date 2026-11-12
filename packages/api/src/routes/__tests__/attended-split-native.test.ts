import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindScopeSources, boundScopeSources, ContextScopeAccumulator, createGeminiProvider, registerDecisionMetadataSink,
  type SessionContextAuthority } from '@use-brian/core'
import { createDecisionAttemptUsageRecorder, createDecisionRuntime, type DecisionRuntimeAttempt } from '../../decision-runtime.js'
import { createWorkspaceDecisionRouteResolver } from '../../workspace-decision-routing.js'
import type { Session, SessionMessage } from '../../db/sessions.js'
import { captureAttendedSessionClassification, forkAttendedSessionClassification, prepareAttendedSplitMessage } from '../attended-session-context.js'

// Keep the real splitter, runtime, workspace resolver, and physical adapters.
// Only persistence and the host's source proof are synthetic.
const spies = vi.hoisted(() => ({ query: vi.fn(), proof: vi.fn() }))
vi.mock('../../db/session-query-reader.js', () => ({ readAdmittedSessionQuery: spies.query, captureSessionTopics: vi.fn(), sessionQueryRootMetadata: vi.fn() }))
vi.mock('../../application-platform/model-source-authority.js', () => ({ assertSourceModelInputAuthority: spies.proof, ownsNativeAttendedAssembly: vi.fn() }))

const body = 'Compare fictional Acorn and Birch markets and separately research their independent regulatory risks.'
const workspaceId = 'fictional-workspace'
const JEV = 'typesafe-jev-1.13', OPENAI = 'openai-decisions-gpt-6-luna'
beforeEach(() => { vi.clearAllMocks(); spies.proof.mockResolvedValue(undefined) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function fixture(selected: string, answer = false, mode: 'llm_only' | 'shadow' | 'classifier_first' = 'classifier_first') {
  const controller = new AbortController()
  const authority = { execution: { identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: 'fictional-user' } },
    ownership: { kind: 'workspace', workspaceId }, surface: {}, security: { authority: { assertCurrent: vi.fn().mockResolvedValue(undefined) }, access: { workspaceId }, writeDefaults: { compartments: [], projectIds: [] } },
    lifecycle: { abortSignal: controller.signal } }, accumulator: new ContextScopeAccumulator() } as unknown as SessionContextAuthority
  const session = { id: 'fictional-session' } as Session
  const message = { id: 'fictional-author-message', sessionId: session.id, role: 'user', sequenceNum: 1, content: [{ type: 'text', text: body }] } as SessionMessage
  const source = { workspaceId, userId: 'fictional-user', assistantId: null, sensitivity: 'public' as const, compartments: [], projectIds: [], resourceKind: 'session_message', resourceId: message.id, version: '1' }
  spies.query.mockResolvedValue(bindScopeSources({ history: [message] }, [source]))
  const capture = await captureAttendedSessionClassification({ authority, session, message })
  const branch = forkAttendedSessionClassification({ authority, session, message, capture })
  const provider = createGeminiProvider({ kind: 'ai-studio', endpoint: () => 'https://fictional.example/split', headers: async () => ({}) })
  const llmCalls: unknown[] = [], nativeCalls: unknown[] = [], attempts: DecisionRuntimeAttempt[] = []
  const metered = vi.fn(async () => {})
  const meter = createDecisionAttemptUsageRecorder({ recordUsage: metered } as never)
  const getSystem = vi.fn(async () => ({ workspaceId, mode, modelAlias: mode === 'llm_only' ? null : selected, updatedAt: 'now' }))
  const runtime = createDecisionRuntime({ llmProvider: provider, defaultLlmModel: 'fictional-boot-model',
    typesafeApiKey: 'fictional-jev-key', openaiDecisionsApiKey: 'fictional-openai-key',
    resolveRoute: createWorkspaceDecisionRouteResolver({ store: { getSystem }, configuredAdapterIds: () => ['typesafe', 'openai-decisions'] }),
    onAttempt: registerDecisionMetadataSink(async (attempt: DecisionRuntimeAttempt) => { attempts.push(attempt); await meter(attempt) }),
  })
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body))
    if (String(url) === 'https://fictional.example/split') {
      llmCalls.push(request)
      expect(request.contents[0].parts[0].text).toBe(body)
      const packet = { candidates: [{ content: { parts: [{ text: JSON.stringify({ split: true, tasks: ['Research Acorn.', 'Research Birch.'] }) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8 } }
      return new Response('data: ' + JSON.stringify(packet) + '\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }
    nativeCalls.push(request)
    expect(String(url)).toBe(selected === JEV ? 'https://api.typesafe.ai/v1/systemone' : 'https://api.openai.com/v1/decisions')
    expect(selected === JEV ? request.state : JSON.parse(request.input)).toEqual({ message: body })
    return new Response(JSON.stringify(selected === JEV
      ? { model: 'jev-1.13.0', answers: { split: { type: 'noul', noul: answer ? 1 : 0 } }, usage: { input_tokens: 9, output_tokens: 0 } }
      : { model: 'gpt-6-luna', answers: [{ type: 'predicate', name: 'split', probability: answer ? 1 : 0 }], usage: { input_tokens: 9, output_tokens: 0 } }), { headers: { 'content-type': 'application/json' } })
  }))
  const input = { authority: branch.authority, session, message, capture: branch.capture, provider, rawMessage: body, signal: controller.signal, decisionRuntime: runtime }
  return { input, controller, source, llmCalls, nativeCalls, attempts, metered, getSystem }
}

describe('admitted Standard split native routing', () => {
  it.each([JEV, OPENAI])('%s false completes without LLM and meters the workspace native alias', async selected => {
    const f = await fixture(selected)
    const prepared = await prepareAttendedSplitMessage(f.input)
    expect(f.nativeCalls).toHaveLength(1)
    expect(f.llmCalls).toHaveLength(0)
    expect(f.getSystem).toHaveBeenCalledWith(workspaceId)
    expect(f.attempts[0]).toMatchObject({ workspaceId, operationId: 'research.split', runId: 'research-split-fictional-author-message', stage: 'primary_decision', modelCatalogId: selected })
    const usageModel = selected === JEV ? 'jev-1.13.0' : selected
    expect(prepared).toMatchObject({ model: usageModel, usage: { inputTokens: 9, outputTokens: 0 } })
    expect(f.metered).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workspaceId, model: usageModel, source: 'overhead:splitter', inputTokens: 9 }))
    const before = spies.proof.mock.calls.length
    const result = await prepared!.read()
    expect(result.tasks).toBeNull()
    expect(boundScopeSources(result)).toEqual([f.source])
    expect(spies.proof.mock.calls.length).toBe(before + 1)
    await expect(prepared!.read()).rejects.toMatchObject({ reason: 'authority_changed' })
  })
  it.each([JEV, OPENAI])('%s true still generates tasks through the historical LLM model', async selected => {
    const f = await fixture(selected, true)
    const prepared = await prepareAttendedSplitMessage(f.input)
    expect(f.nativeCalls).toHaveLength(1)
    expect(f.llmCalls).toHaveLength(1)
    expect(f.attempts.find(attempt => attempt.stage !== 'primary_decision')).toMatchObject({ modelCatalogId: 'gemini-3.5-flash-lite' })
    expect((await prepared!.read()).tasks).toEqual(['Research Acorn.', 'Research Birch.'])
    expect(prepared!.usage).toEqual({ inputTokens: 20, outputTokens: 8 })
  })
  it.each(['llm_only', 'shadow'] as const)('workspace %s opts out of native execution authority', async mode => {
    const f = await fixture(JEV, false, mode)
    const prepared = await prepareAttendedSplitMessage(f.input)
    expect(f.llmCalls).toHaveLength(1)
    expect((await prepared!.read()).tasks).toEqual(['Research Acorn.', 'Research Birch.'])
    if (mode === 'llm_only') expect(f.nativeCalls).toHaveLength(0)
  })
  it('does not turn native no-split bytes into a reusable source permission', async () => {
    const f = await fixture(JEV)
    const prepared = await prepareAttendedSplitMessage(f.input)
    spies.proof.mockRejectedValueOnce(new Error('Fictional revocation'))
    await expect(prepared!.read()).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(f.llmCalls).toHaveLength(0)
  })
  it('preserves cancellation after native completion', async () => {
    const f = await fixture(OPENAI)
    const prepared = await prepareAttendedSplitMessage(f.input)
    const reason = new Error('Fictional stopped turn')
    f.controller.abort(reason)
    await expect(prepared!.read()).rejects.toBe(reason)
  })
})
