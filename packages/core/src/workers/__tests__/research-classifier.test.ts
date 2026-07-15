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

import { describe, it, expect, vi } from 'vitest'
import { classifyResearchIntent, detectOperateSiteIntent } from '../research-classifier.js'
import type { LLMProvider, StreamChunk } from '../../providers/types.js'

function makeProvider(rawText: string): LLMProvider {
  async function* stream(): AsyncIterable<StreamChunk> {
    yield { type: 'message_start', model: 'gemini-3.1-flash-lite' }
    yield { type: 'text_delta', text: rawText }
    yield {
      type: 'message_end',
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 20 },
    }
  }
  return {
    name: 'mock',
    models: ['gemini-3.1-flash-lite'],
    stream: vi.fn(() => stream()),
    createSession: vi.fn(),
  } as unknown as LLMProvider
}

describe('[COMP:workers/research-classifier] detectOperateSiteIntent', () => {
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

  it('accepts the classifier operate_site verdict for phrasings the regex misses', async () => {
    const provider = makeProvider('{"research":false,"operate_site":true}')
    const result = await classifyResearchIntent({
      provider,
      message: 'what are the events listed for hong kong this month on that luma platform',
    })
    expect(result.research).toBe(false)
    expect(result.operateSite).toBe(true)
    expect(result.reason).toBe('operate_site_classifier')
    expect(result.model).toBe('gemini-3.1-flash-lite')
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
