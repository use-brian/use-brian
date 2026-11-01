/**
 * Research-intent classifier — adaptive research entry + the operate-site
 * override.
 *
 * The operate-site verdict exists because coordinator mode and the research
 * workers structurally exclude every computer-use tool: a "browse <site>"
 * ask that auto-escalates into research mode becomes un-serviceable
 * (incident 2026-07-13 — "browse luma" → 69-webSearch coordinator fan-out,
 * zero browser calls). Spec:
 * docs/architecture/engine/coordinator-pattern.md → "Adaptive entry and the
 * operate-site override".
 *
 * [COMP:workers/research-classifier]
 */

import { afterEach, describe, it, expect, vi } from 'vitest'
import { classifyResearchIntent, detectOperateSiteIntent } from '../research-classifier.js'
import type { LLMProvider, StreamChunk } from '../../providers/types.js'
import { executionFixture, fixtureDecisionProvider } from '../../decisions/__tests__/execution-fixture.js'

function makeProvider(rawText: string, responseModel = 'gemini-3.5-flash-lite'): LLMProvider {
  async function* stream(): AsyncIterable<StreamChunk> {
    yield { type: 'message_start', model: responseModel }
    yield { type: 'text_delta', text: rawText }
    yield {
      type: 'message_end',
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 20 },
    }
  }
  return {
    name: 'mock',
    models: ['gemini-3.5-flash-lite'],
    stream: vi.fn(() => stream()),
    createSession: vi.fn(),
  } as unknown as LLMProvider
}

describe('[COMP:workers/research-classifier] detectOperateSiteIntent', () => {
  it.each(['test','ping','pong'])('skips research work for the exact %s probe under current authority',async message=>{
    const provider=makeProvider('{"research":true,"effort":"focused"}'),check=vi.fn(async()=>{})
    expect(await classifyResearchIntent({provider,message,assertInputAuthority:check})).toMatchObject({research:false,usage:null,model:null})
    expect(provider.stream).not.toHaveBeenCalled()
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('hits on a strong verb with a named site (the 2026-07-13 incident message)', () => {
    expect(
      detectOperateSiteIntent('can you browse luma for me to check whats current events in hk?'),
    ).toBe(true)
  })

  it('hits on log-into / sign-into phrasings, including pronoun variants', () => {
    expect(detectOperateSiteIntent('log into stripe and download the latest invoice')).toBe(true)
    expect(detectOperateSiteIntent('log me into notion and check the roadmap page')).toBe(true)
    expect(detectOperateSiteIntent('sign in to github and check my notifications')).toBe(true)
  })

  it('hits on a weak verb combined with a URL-ish token', () => {
    expect(detectOperateSiteIntent('open lu.ma and read the hk events')).toBe(true)
    expect(detectOperateSiteIntent('go to https://example.com/pricing and tell me the tiers')).toBe(true)
    expect(detectOperateSiteIntent('check www.ycombinator.com for the latest batch companies')).toBe(true)
  })

  it('hits on non-English operate phrasing (the 2026-07-15 Cantonese price-check incident)', () => {
    // Naming the feature is the strongest possible signal, any language.
    expect(detectOperateSiteIntent('翻翻去我果三個 trip 可唔可以幫我用 computer use 去睇 exactly 要幾錢')).toBe(true)
    // CJK strong verbs need no URL (like English "browse X").
    expect(detectOperateSiteIntent('幫我瀏覽下國泰官網有無平飛')).toBe(true)
    expect(detectOperateSiteIntent('帮我浏览一下国泰官网')).toBe(true)
    // CJK weak verbs count only next to a URL-ish token.
    expect(detectOperateSiteIntent('去 cathaypacific.com 睇下班次幾錢')).toBe(true)
    expect(detectOperateSiteIntent('聽日想去日本玩')).toBe(false)
  })

  it('does not hit on "browse the web / the internet / online" (research phrasing)', () => {
    expect(detectOperateSiteIntent('browse the web for the top AI conferences in asia')).toBe(false)
    expect(detectOperateSiteIntent('browse the internet for competitor pricing analysis')).toBe(false)
    expect(detectOperateSiteIntent('browse online for the best CRM deals this quarter')).toBe(false)
  })

  it('does not hit on weak verbs without a URL-ish token', () => {
    expect(detectOperateSiteIntent('can you check whats current events in hk?')).toBe(false)
    expect(detectOperateSiteIntent('visit our top customers this quarter and summarize')).toBe(false)
  })

  it('does not hit on plain research / lookup asks', () => {
    expect(
      detectOperateSiteIntent('research the HK AI events landscape this month and write a report'),
    ).toBe(false)
    expect(detectOperateSiteIntent('compare notion vs airtable pricing tiers in depth')).toBe(false)
    expect(detectOperateSiteIntent('what time is it in tokyo')).toBe(false)
  })
})

describe('[COMP:workers/research-classifier] classifyResearchIntent', () => {
  afterEach(() => vi.useRealTimers())

  it('aborts an in-flight LLM fallback at the shorter decision deadline', async () => {
    vi.useFakeTimers()
    const aborted = vi.fn()
    const llm = makeProvider('{"research":false}')
    llm.stream = vi.fn(async function* (request) {
      await new Promise<void>((_resolve, reject) => {
        request.signal!.addEventListener('abort', () => {
          aborted()
          reject(request.signal!.reason)
        }, { once: true })
      })
    })
    const primary = fixtureDecisionProvider(async () => { throw new Error('Synthetic transport failure') })
    const classification = classifyResearchIntent({ provider: llm, message: 'Compare battery recycling methods',
      decisionRuntime: executionFixture({ llm, primary }) })

    await vi.advanceTimersByTimeAsync(100)
    await expect(classification).resolves.toMatchObject({ research: false, operateSite: false })
    expect(llm.stream).toHaveBeenCalledOnce()
    expect(aborted).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('binds current authority to a configured non-LLM decision primary', async () => {
    const llm = makeProvider('{"research":false}')
    let revoked = false
    const refusal = Object.assign(new Error('Fictional input unavailable'), { reason: 'authority_changed', retrySafe: false })
    const check = vi.fn(async () => { if (revoked) throw refusal })
    const primary = fixtureDecisionProvider(async request => {
      expect(request.assertInputAuthority).toBeTypeOf('function')
      revoked = true
      await request.assertInputAuthority!()
      throw new Error('Must not consume revoked state')
    })
    await expect(classifyResearchIntent({ provider: llm, message: 'Compare battery suppliers',
      assertInputAuthority: check, decisionRuntime: executionFixture({ llm, primary }) }))
      .rejects.toMatchObject({ reason: 'authority_changed' })
    expect(llm.stream).not.toHaveBeenCalled()
  })
  it('accepts a terminal injected decision without calling the LLM', async () => {
    const llm = makeProvider('{"research":false}')
    const decisionRuntime = executionFixture({
      llm,
      profilePolicy: { reviewBelow: 0.7 },
      primary: fixtureDecisionProvider(async (request) => ({
        providerId: 'fixture-decision',
        model: request.model,
        answers: [{
          kind: 'choice',
          questionId: 'intent',
          value: 'research',
          evidence: {
            source: 'native_distribution',
            probabilities: { ordinary: 0.04, research: 0.94, operate_site: 0.02 },
          },
        }],
      })),
    })

    const result = await classifyResearchIntent({
      provider: llm,
      message: 'do an in-depth competitive scan of the APAC events platforms market',
      decisionRuntime,
      workspaceId: 'workspace-fictional',
    })

    expect(result).toMatchObject({ research: true, operateSite: false, reason: 'research_classifier' })
    expect(llm.stream).not.toHaveBeenCalled()
  })

  it('sends uncertain primary evidence to one independent LLM review', async () => {
    const llm = makeProvider('{"research":false}')
    const decisionRuntime = executionFixture({
      llm,
      profilePolicy: { reviewBelow: 0.7 },
      primary: fixtureDecisionProvider(async (request) => ({
        providerId: 'fixture-decision',
        model: request.model,
        answers: [{
          kind: 'choice',
          questionId: 'intent',
          value: 'research',
          evidence: {
            source: 'native_distribution',
            probabilities: { ordinary: 0.4, research: 0.35, operate_site: 0.25 },
          },
        }],
      })),
    })

    const result = await classifyResearchIntent({
      provider: llm,
      message: 'do an in-depth competitive scan of the APAC events platforms market',
      decisionRuntime,
    })

    expect(result.research).toBe(false)
    expect(llm.stream).toHaveBeenCalledOnce()
  })

  it('fast-paths an operate-site message without calling the LLM', async () => {
    const provider = makeProvider('{"research":true}')
    const result = await classifyResearchIntent({
      provider,
      message: 'can you browse luma for me to check whats current events in hk?',
    })
    expect(result.research).toBe(false)
    expect(result.operateSite).toBe(true)
    expect(result.reason).toBe('operate_site_fast_path')
    expect(result.model).toBeNull()
    expect(provider.stream).not.toHaveBeenCalled()
  })

  it('fast-paths regardless of the short-message gate (site ops are length-independent)', async () => {
    const provider = makeProvider('{"research":false}')
    const result = await classifyResearchIntent({ provider, message: 'browse lu.ma events' })
    expect(result.operateSite).toBe(true)
    expect(provider.stream).not.toHaveBeenCalled()
  })

  it('short-circuits short non-operate messages without calling the LLM', async () => {
    const provider = makeProvider('{"research":true}')
    const result = await classifyResearchIntent({ provider, message: 'hello there' })
    expect(result.research).toBe(false)
    expect(result.operateSite).toBe(false)
    expect(provider.stream).not.toHaveBeenCalled()
  })

  it('CJK-weights the length gate — a compact Cantonese ask reaches the classifier (2026-07-16 incident)', async () => {
    // 26 raw chars, but 7 CJK chars carry a full current-offer question.
    // Pre-fix this short-circuited and the turn ran on the cheap path with
    // zero tool calls, shipping confabulated welcome-offer figures.
    const provider = makeProvider('{"research":false}')
    const result = await classifyResearchIntent({
      provider,
      message: 'cx sc credit card 而家個迎新係點',
    })
    expect(provider.stream).toHaveBeenCalledTimes(1)
    expect(result.model).toBe('gemini-3.5-flash-lite')
  })

  it('still short-circuits genuinely short CJK small talk', async () => {
    const provider = makeProvider('{"research":true}')
    for (const message of ['而家得閒嗎?', 'こんにちは', '早晨']) {
      const result = await classifyResearchIntent({ provider, message })
      expect(result.research).toBe(false)
    }
    expect(provider.stream).not.toHaveBeenCalled()
  })

  it('accepts the classifier operate_site verdict for phrasings the regex misses', async () => {
    const provider = makeProvider('{"research":false,"operate_site":true}')
    const result = await classifyResearchIntent({
      provider,
      message: 'what are the events listed for hong kong this month on that luma platform',
    })
    expect(result.research).toBe(false)
    expect(result.operateSite).toBe(true)
    expect(result.reason).toBe('operate_site_classifier')
    expect(result.model).toBe('gemini-3.5-flash-lite')
  })

  it('returns a research verdict with operateSite false', async () => {
    const provider = makeProvider('{"research":true,"reason":"multi-source competitive scan"}')
    const result = await classifyResearchIntent({
      provider,
      message: 'do an in-depth competitive scan of the APAC events platforms market',
    })
    expect(result.research).toBe(true)
    expect(result.operateSite).toBe(false)
    expect(result.reason).toBe('multi-source competitive scan')
  })

  it('sends recent dialogue so a Snapio strategy follow-up is not classified in isolation', async () => {
    // Production regression 2026-08-09: the prompt already said follow-ups
    // were OFF, but the classifier received only this final sentence and
    // silently promoted it to Research. The coordinator then thought-burnt
    // and the context-blind fallback asked for files already discussed.
    const provider = makeProvider('{"research":false}')
    const currentMessage = 'How can we strategize the story to add multiples for snapio?'
    const recentConversation = [
      {
        role: 'user' as const,
        text: 'What is the potential exit strategy if we aim for 50M in two years?',
      },
      {
        role: 'assistant' as const,
        text: 'Snapio should target strategic acquirers and build toward an 8x to 12x EV/EBITDA valuation story.',
      },
    ]

    await classifyResearchIntent({ provider, message: currentMessage, recentConversation })

    const call = (provider.stream as ReturnType<typeof vi.fn>).mock.calls[0][0]
    const payload = JSON.parse(call.messages[0].content)
    expect(payload).toEqual({ currentMessage, recentConversation })
    expect(call.systemPrompt).toContain('Use recentConversation to resolve whether currentMessage is a follow-up')
  })

  it('a research:true verdict wins over a stray operate_site flag', async () => {
    const provider = makeProvider('{"research":true,"operate_site":true,"reason":"x"}')
    const result = await classifyResearchIntent({
      provider,
      message: 'do an in-depth competitive scan of the APAC events platforms market',
    })
    expect(result.research).toBe(true)
    expect(result.operateSite).toBe(false)
  })

  it('degrades to all-false on non-JSON output', async () => {
    const provider = makeProvider('definitely not json')
    const result = await classifyResearchIntent({
      provider,
      message: 'summarize the current state of our enterprise pipeline for the board',
    })
    expect(result.research).toBe(false)
    expect(result.operateSite).toBe(false)
  })
})

describe('[COMP:workers/research-classifier] background-lane model injection', () => {
  const LONG = 'Please research the current state of solid-state battery manufacturing in detail.'

  it('sends the injected model on the wire, not the Gemini literal', () => {
    // A Google-free deploy passes a servable id here. If this ever regresses
    // to the module constant the routing provider throws "not configured" and
    // the whole lane dies silently in a background job.
    const provider = makeProvider('{"research":true,"reason":"deep topic"}', 'qwen3.5-flash')
    return classifyResearchIntent({ provider, message: LONG, model: 'qwen3.5-flash' }).then((r) => {
      expect(provider.stream).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'qwen3.5-flash' }),
      )
      // The result attributes usage to the model that actually served it —
      // otherwise cost lands on a model that was never called.
      expect(r.model).toBe('qwen3.5-flash')
    })
  })

  it('defaults to the historical literal when nothing is injected', () => {
    const provider = makeProvider('{"research":true,"reason":"deep topic"}')
    return classifyResearchIntent({ provider, message: LONG }).then((r) => {
      expect(provider.stream).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gemini-3.5-flash-lite' }),
      )
      expect(r.model).toBe('gemini-3.5-flash-lite')
    })
  })
})


describe('[COMP:workers/research-classifier] automatic effort assessment', () => {
  it.each(['focused', 'standard', 'deep'] as const)('assesses short research requests with %s effort', async (effort) => {
    const provider = makeProvider(JSON.stringify({ research: true, effort }))
    const result = await classifyResearchIntent({ provider, message: 'Research battery suppliers' })
    expect(result).toMatchObject({ research: true, effort, operateSite: false })
    expect(provider.stream).toHaveBeenCalledOnce()
  })

  it('keeps invalid or absent effort on the bounded standard profile', async () => {
    const provider = makeProvider('{"research":true,"effort":"unlimited"}')
    expect(await classifyResearchIntent({ provider, message: 'Compare battery suppliers' })).toMatchObject({ research: true, effort: 'standard' })
  })

  it.each(['research_focused', 'research_deep'] as const)('preserves effort from the provider-neutral %s verdict', async (value) => {
    const provider = makeProvider('{"research":false}')
    const decisionRuntime = executionFixture({
      llm: provider,
      primary: fixtureDecisionProvider(async (request) => ({
        providerId: 'fixture-decision',
        model: request.model,
        answers: [{ kind: 'choice', questionId: 'intent', value, evidence: { source: 'native_distribution', probabilities: { [value]: 1 } } }],
      })),
    })
    const result = await classifyResearchIntent({ provider, message: 'Compare battery suppliers', decisionRuntime })
    expect(result).toMatchObject({ research: true, effort: value === 'research_focused' ? 'focused' : 'deep' })
    expect(provider.stream).not.toHaveBeenCalled()
  })
})


describe('[COMP:workers/research-classifier] short semantic requests', () => {
  it('assesses short requests without requiring a research keyword', async () => {
    const provider = makeProvider('{"research":true,"effort":"focused"}')
    expect(await classifyResearchIntent({ provider, message: 'Best CRM for a nonprofit?' })).toMatchObject({ research: true, effort: 'focused' })
    expect(provider.stream).toHaveBeenCalledOnce()
  })
})


describe('[COMP:workers/research-classifier] combined preparation decision', () => {
  const candidates = [{ name: 'calendarListEvents', description: 'Read calendar events' }]
  it.each(['ordinary', 'research_focused', 'research', 'research_deep'])(
    'answers intent %s and concrete tool selection in one decision', async intent => {
      const provider = makeProvider('unexpected')
      const evaluate = vi.fn(async (request: import('../../decisions/types.js').DecisionRequest) => ({
        providerId: 'fixture-decision', model: request.model,
        answers: request.questions.map((question, index) => ({ kind: 'choice' as const, questionId: question.id,
          value: question.id === 'intent' ? intent : index === 1 ? 't0' : 'none', evidence: { source: 'unavailable' as const } })),
      }))
      const result = await classifyResearchIntent({ provider, message: 'Check my calendar now', toolCandidates: candidates,
        decisionRuntime: executionFixture({ llm: provider, primary: fixtureDecisionProvider(evaluate) }) })
      expect(evaluate).toHaveBeenCalledOnce()
      expect(evaluate.mock.calls[0][0].operation).toMatchObject({ id: 'research.intent', version: '3' })
      expect(evaluate.mock.calls[0][0].questions).toHaveLength(4)
      expect(result).toMatchObject({ research: intent !== 'ordinary', toolNames: ['calendarListEvents'] })
      expect(provider.stream).not.toHaveBeenCalled()
    })

  it('preserves a successful research verdict across slow healthy authority checks', async () => {
    vi.useFakeTimers()
    try {
      const provider = makeProvider('unexpected'), started = Date.now()
      const check = vi.fn(() => new Promise<void>(resolve => setTimeout(resolve, 1100)))
      const primary = fixtureDecisionProvider(async request => ({ providerId: 'fixture-decision', model: request.model,
        answers: request.questions.map(question => ({ kind: 'choice' as const, questionId: question.id,
          value: question.id === 'intent' ? 'research_focused' : 'none', evidence: { source: 'unavailable' as const } })) }))
      const pending = classifyResearchIntent({ provider, message: 'Compare fresh evidence on energy storage', toolCandidates: candidates,
        assertInputAuthority: check, decisionRuntime: executionFixture({ llm: provider, primary, totalTimeoutMs: 60_000, primaryTimeoutMs: 20_000 }) })
      await vi.advanceTimersByTimeAsync(45_000)
      expect(await pending).toMatchObject({ research: true, effort: 'focused', toolNames: [] })
      expect(check.mock.calls.length * 1100).toBeGreaterThan(5000)
      expect(Date.now() - started).toBeGreaterThan(5000)
      expect(provider.stream).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('uses one combined LLM fallback with the full research criteria', async () => {
    const provider = makeProvider(JSON.stringify({ answers: { intent: { value: 'research_focused' },
      group0_rank1: { value: 't0' }, group0_rank2: { value: 'none' }, group0_rank3: { value: 'none' } } }))
    const result = await classifyResearchIntent({ provider, message: 'Compare current energy storage methods', toolCandidates: candidates,
      decisionRuntime: executionFixture({ llm: provider, primary: fixtureDecisionProvider(async () => { throw new Error('offline') }) }) })
    expect(result).toMatchObject({ research: true, effort: 'focused', toolNames: ['calendarListEvents'] })
    expect(provider.stream).toHaveBeenCalledOnce()
    const request = vi.mocked(provider.stream).mock.calls[0][0]
    expect(JSON.stringify(request.messages)).toContain('MULTI-SOURCE INVESTIGATION')
    expect(request.allowProviderFallback).toBe(false)
  })

  it('still classifies research when the tool catalog exceeds the bounded vocabulary', async () => {
    const provider = makeProvider('unexpected')
    const evaluate = vi.fn(async (request: import('../../decisions/types.js').DecisionRequest) => {
      expect(request.questions).toHaveLength(1)
      return { providerId: 'fixture-decision', model: request.model,
        answers: [{ kind: 'choice' as const, questionId: 'intent', value: 'research_deep', evidence: { source: 'unavailable' as const } }] }
    })
    const result = await classifyResearchIntent({ provider, message: 'Research all competing storage technologies',
      toolCandidates: Array.from({ length: 509 }, (_, i) => ({ name: `read${i}`, description: 'Read' })),
      decisionRuntime: executionFixture({ llm: provider, primary: fixtureDecisionProvider(evaluate) }) })
    expect(result).toMatchObject({ research: true, effort: 'deep', toolNames: [] })
  })

  it('cannot admit a fabricated choice and keeps deterministic site intent', async () => {
    const provider = makeProvider('malformed')
    const evaluate = vi.fn(async (request: import('../../decisions/types.js').DecisionRequest) => ({
      providerId: 'fixture-decision', model: request.model,
      answers: request.questions.map(question => ({ kind: 'choice' as const, questionId: question.id,
        value: question.id === 'intent' ? 'ordinary' : 'ungranted', evidence: { source: 'unavailable' as const } })),
    }))
    const runtime = executionFixture({ llm: provider, primary: fixtureDecisionProvider(evaluate) })
    expect(await classifyResearchIntent({ provider, message: 'Check my calendar now', toolCandidates: candidates, decisionRuntime: runtime }))
      .toMatchObject({ research: false, toolNames: [] })
    evaluate.mockClear()
    const site = await classifyResearchIntent({ provider, message: 'Browse example.com', toolCandidates: candidates, decisionRuntime: runtime })
    expect(site).toMatchObject({ research: false, operateSite: true, reason: 'operate_site_fast_path' })
    expect(site.toolNames).toBeUndefined()
    expect(evaluate).not.toHaveBeenCalled()
  })
})
