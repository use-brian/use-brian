import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyResearchIntent, createGeminiProvider, registerDecisionMetadataSink } from '@use-brian/core'
import { createDecisionAttemptUsageRecorder, createDecisionRuntime, type DecisionRuntimeAttempt } from '../decision-runtime.js'
import { createWorkspaceDecisionRouteResolver } from '../workspace-decision-routing.js'
import { recordOverheadUsage } from '../routes/_overhead-usage.js'

const workspaceId = 'fictional-workspace'
const tools = Array.from({ length: 357 }, (_, i) => ({ name: `fictional_tool_${i}`, description: `Complete fictional capability ${i}` }))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function unpack(payload: any) {
  for (const table of payload.rowTables ?? []) {
    let parent = payload
    for (const key of table.path.slice(0, -1)) parent = parent[key]
    const key = table.path.at(-1)
    parent[key] = parent[key].map((row: unknown[]) => Object.fromEntries(table.columns.map((column: string, i: number) => [column, row[i]])))
  }
  for (const q of payload.questions) {
    if (q.options?.$ref) q.options = payload.choiceOptions[q.options.$ref.split('/')[2]]
  }
  return payload
}

function fixture(intent = 'ordinary', afterFetch?: () => void) {
  const attempts: DecisionRuntimeAttempt[] = []
  const recordUsage = vi.fn(async () => {})
  const meter = createDecisionAttemptUsageRecorder({ recordUsage } as never)
  const check = vi.fn(async () => {})
  const provider = createGeminiProvider({ kind: 'ai-studio', endpoint: () => 'https://fictional.example/llm-only', headers: async () => ({}) })
  const getSystem = vi.fn(async () => ({ workspaceId, mode: 'llm_only' as const, modelAlias: null, updatedAt: 'now' }))
  const runtime = createDecisionRuntime({ llmProvider: provider, defaultLlmModel: 'gemini-3.5-flash-lite',
    typesafeApiKey: 'fictional-jev-key', openaiDecisionsApiKey: 'fictional-openai-key',
    resolveRoute: createWorkspaceDecisionRouteResolver({ store: { getSystem }, configuredAdapterIds: () => ['typesafe', 'openai-decisions'] }),
    onAttempt: registerDecisionMetadataSink(async (attempt: DecisionRuntimeAttempt) => { attempts.push(attempt); await meter(attempt) }),
  })
  const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    expect(String(url)).toBe('https://fictional.example/llm-only')
    const body = JSON.parse(String(init?.body))
    expect(body.generationConfig.maxOutputTokens).toBe(1024)
    const payload = unpack(JSON.parse(body.contents[0].parts[0].text))
    expect(payload.state.tools).toEqual(tools.map((tool, i) => ({ id: `t${i}`, ...tool })))
    expect(payload.state.tools.at(-1)).toMatchObject({ id: 't356', description: 'Complete fictional capability 356' })
    expect(payload.questions).toHaveLength(7)
    const schema = body.generationConfig.responseJsonSchema
    expect(schema.properties.answers.required).toEqual(payload.questions.map((q: any) => q.id))
    const answers = Object.fromEntries(payload.questions.map((q: any) => {
      const field = schema.properties.answers.properties[q.id]
      const domain = field.$ref ? schema.$defs[field.$ref.split('/')[2]] : field
      expect(domain).toEqual({ type: 'string', enum: q.options.map((o: any) => o.value) })
      return [q.id, q.id === 'intent' ? intent : q.id === 'group1_rank1' ? 't356' : 'none']
    }))
    afterFetch?.()
    const packet = { candidates: [{ content: { parts: [{ text: JSON.stringify({ answers }) }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 50 } }
    return new Response('data: ' + JSON.stringify(packet) + '\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  vi.stubGlobal('fetch', fetch)
  const input = { provider, model: 'gemini-3.5-flash-lite', workspaceId, runId: 'fictional-preparation',
    decisionRuntime: runtime, assertInputAuthority: check, message: 'Please assess the fictional Acorn proposal with the complete available tool catalog.', toolCandidates: tools }
  return { input, check, fetch, attempts, recordUsage, getSystem }
}

describe('workspace LLM-only compact preparation', () => {
  it.each(['ordinary', 'research_focused'])('keeps all decisions and tools for %s, using one LLM call and one caller charge', async intent => {
    const f = fixture(intent)
    const result = await classifyResearchIntent(f.input)
    expect(result).toMatchObject({ research: intent !== 'ordinary', toolNames: ['fictional_tool_356'],
      usage: { inputTokens: 1000, outputTokens: 50 }, model: 'gemini-3.5-flash-lite' })
    expect(f.fetch).toHaveBeenCalledOnce()
    expect(f.check).toHaveBeenCalledTimes(2)
    expect(f.attempts).toHaveLength(1)
    expect(f.attempts[0]).toMatchObject({ stage: 'llm_only', outcome: 'success', operationId: 'research.intent' })
    expect(f.getSystem).toHaveBeenCalledWith(workspaceId)
    // The native central recorder must not duplicate ordinary LLM caller usage.
    expect(f.recordUsage).not.toHaveBeenCalled()
    await recordOverheadUsage({ usageStore: { recordUsage: f.recordUsage } as never, userId: 'fictional-user', assistantId: 'fictional-assistant',
      sessionId: 'fictional-session', model: result.model, usage: result.usage, source: 'overhead:classifier' })
    expect(f.recordUsage).toHaveBeenCalledOnce()
  })

  it('withholds compact results on fresh final source revocation without another provider call', async () => {
    const f = fixture()
    const refusal = Object.assign(new Error('Fictional source revoked'), { reason: 'authority_changed', retrySafe: false })
    let checks = 0
    f.check.mockImplementation(async () => { if (++checks === 2) throw refusal })
    await expect(classifyResearchIntent(f.input)).rejects.toBe(refusal)
    expect(f.fetch).toHaveBeenCalledOnce()
  })

  it('preserves cancellation without publishing or dispatching a native fallback', async () => {
    const controller = new AbortController()
    const reason = new Error('Fictional canceled preparation')
    const f = fixture('ordinary', () => controller.abort(reason))
    await expect(classifyResearchIntent({ ...f.input, signal: controller.signal })).rejects.toBeDefined()
    expect(f.fetch).toHaveBeenCalledOnce()
  })
})
