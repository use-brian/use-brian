import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { normalizeGeminiContents, resolveGeminiThinkingLevel, resolveStopReason, stripNonInputParts } from '../gemini.js'

type GeminiContent = Parameters<typeof normalizeGeminiContents>[0][number]

const userText = (text: string): GeminiContent => ({
  role: 'user',
  parts: [{ text }],
})

const userToolResult = (name: string): GeminiContent => ({
  role: 'user',
  parts: [{ functionResponse: { name, response: { result: 'ok' } } }],
})

const modelText = (text: string): GeminiContent => ({
  role: 'model',
  parts: [{ text }],
})

const modelToolCall = (name: string): GeminiContent => ({
  role: 'model',
  parts: [{ functionCall: { name, args: {} } }],
})

describe('[COMP:providers/gemini-normalize] normalizeGeminiContents', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('returns empty array unchanged', () => {
    expect(normalizeGeminiContents([])).toEqual([])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('leaves a well-formed history (user first) untouched', () => {
    const contents = [userText('hi'), modelText('hello'), userText('how are you')]
    expect(normalizeGeminiContents(contents)).toEqual(contents)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('drops a leading model tool_use (the Hinson bug signature)', () => {
    const contents = [
      modelToolCall('weather'),
      userToolResult('weather'),
      modelText('It is 28°C'),
      userText('thanks'),
    ]
    const result = normalizeGeminiContents(contents)
    expect(result).toEqual([userText('thanks')])
    expect(warnSpy).toHaveBeenCalledOnce()
  })

  it('drops a leading model text turn', () => {
    const contents = [modelText('assistant speaking first'), userText('user reply')]
    expect(normalizeGeminiContents(contents)).toEqual([userText('user reply')])
    expect(warnSpy).toHaveBeenCalledOnce()
  })

  it('drops a leading orphan tool_result (user role with only functionResponse)', () => {
    const contents = [userToolResult('weather'), userText('next question')]
    expect(normalizeGeminiContents(contents)).toEqual([userText('next question')])
    expect(warnSpy).toHaveBeenCalledOnce()
  })

  it('keeps a user turn that mixes text and tool_result', () => {
    const mixed: GeminiContent = {
      role: 'user',
      parts: [
        { functionResponse: { name: 'weather', response: { result: 'ok' } } },
        { text: 'and another question' },
      ],
    }
    expect(normalizeGeminiContents([mixed])).toEqual([mixed])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('drops multiple leading invalid contents until it finds a user text turn', () => {
    const contents = [
      modelToolCall('weather'),
      userToolResult('weather'),
      modelText('reply'),
      userText('real user message'),
      modelText('assistant reply'),
    ]
    const result = normalizeGeminiContents(contents)
    expect(result).toEqual([userText('real user message'), modelText('assistant reply')])
    expect(warnSpy).toHaveBeenCalledOnce()
  })

  it('returns empty array when nothing is salvageable', () => {
    const contents = [modelToolCall('weather'), userToolResult('weather'), modelText('reply')]
    expect(normalizeGeminiContents(contents)).toEqual([])
    expect(warnSpy).toHaveBeenCalledOnce()
  })

  it('keeps a user turn with inlineData (image) as a valid head', () => {
    const image: GeminiContent = {
      role: 'user',
      parts: [{ inlineData: { mimeType: 'image/png', data: 'base64==' } }],
    }
    expect(normalizeGeminiContents([image])).toEqual([image])
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe('[COMP:providers/gemini-stop-reason] resolveStopReason', () => {
  it('promotes end_turn to tool_use when tool calls are present', () => {
    expect(resolveStopReason('end_turn', true)).toBe('tool_use')
  })

  it('promotes max_tokens to tool_use when tool calls are present (the 09:00 cron incident)', () => {
    // Gemini can return MAX_TOKENS alongside complete tool calls when the
    // thinking budget consumes most of the output budget. Before the fix,
    // the query loop exited here without executing the tools.
    expect(resolveStopReason('max_tokens', true)).toBe('tool_use')
  })

  it('promotes safety to tool_use when tool calls are present', () => {
    expect(resolveStopReason('safety', true)).toBe('tool_use')
  })

  it('leaves end_turn alone when no tool calls', () => {
    expect(resolveStopReason('end_turn', false)).toBe('end_turn')
  })

  it('leaves max_tokens alone when no tool calls (web channel relies on this to auto-continue)', () => {
    expect(resolveStopReason('max_tokens', false)).toBe('max_tokens')
  })

  it('leaves safety alone when no tool calls', () => {
    expect(resolveStopReason('safety', false)).toBe('safety')
  })
})

describe('[COMP:providers/gemini-thinking] resolveGeminiThinkingLevel', () => {
  it('maps low / high to LOW / HIGH for Gemini 3 Pro', () => {
    expect(resolveGeminiThinkingLevel('gemini-3.1-pro-preview', 'low')).toBe('LOW')
    expect(resolveGeminiThinkingLevel('gemini-3.1-pro-preview', 'high')).toBe('HIGH')
  })

  it('maps low / high for Gemini 3 Flash too', () => {
    expect(resolveGeminiThinkingLevel('gemini-3-flash-preview', 'low')).toBe('LOW')
    expect(resolveGeminiThinkingLevel('gemini-3-flash-preview', 'high')).toBe('HIGH')
  })

  it('returns undefined when level is unset (omits thinkingConfig)', () => {
    expect(resolveGeminiThinkingLevel('gemini-3.1-pro-preview', undefined)).toBeUndefined()
  })

  it('returns undefined for models that do not support thinkingConfig', () => {
    // Gemini 2.5 Flash has its own (incompatible) thinking config — we omit.
    expect(resolveGeminiThinkingLevel('gemini-2.5-flash', 'low')).toBeUndefined()
    expect(resolveGeminiThinkingLevel('gemini-pro-1.5', 'high')).toBeUndefined()
  })
})

/**
 * The request-boundary guard. This is the class-level fix for the production
 * 400 "Unsupported input part type: go/debugproto \nthought: true": it asserts
 * the Gemini INPUT-part contract directly, with NO mocked `fetch` — which is
 * the exact gap that let the original bug ship (the session-stream test only
 * checked the payload we built, never that the API would accept it).
 */
describe('[COMP:providers/gemini-input-parts] stripNonInputParts', () => {
  // The guard `console.warn`s whatever it strips; silence it so the drop
  // cases don't spam test output (it fires by design here).
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { vi.restoreAllMocks() })

  it('drops a bare { thought: true } part — the production 400 shape', () => {
    const out = stripNonInputParts([
      { role: 'model', parts: [{ thought: true }, { text: 'hello' }] },
    ])
    expect(out).toEqual([{ role: 'model', parts: [{ text: 'hello' }] }])
  })

  it('drops a thought part even when it carries a signature or body', () => {
    const out = stripNonInputParts([
      {
        role: 'model',
        parts: [
          { thought: true, thoughtSignature: 'sig', text: 'reasoning' },
          { text: 'visible' },
        ],
      },
    ])
    // Reasoning is never re-sent, signature or not. Visible text survives.
    expect(out[0].parts).toEqual([{ text: 'visible' }])
  })

  it('keeps a functionCall part WITH its thoughtSignature (Gemini 3.x needs it)', () => {
    const parts = [{ functionCall: { name: 'patchPage', args: {} }, thoughtSignature: 'sig-abc' }]
    const out = stripNonInputParts([{ role: 'model', parts }])
    expect(out[0].parts).toEqual(parts)
  })

  it('drops content-less parts and removes a turn left empty', () => {
    const out = stripNonInputParts([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ thought: true }] }, // pure reasoning → empty → dropped
      { role: 'model', parts: [{}] },                 // malformed → empty → dropped
    ])
    expect(out).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }])
  })

  it('passes a clean history through untouched (no spurious drops)', () => {
    const clean = [
      { role: 'user' as const, parts: [{ text: 'q' }] },
      { role: 'model' as const, parts: [{ text: 'a' }] },
    ]
    expect(stripNonInputParts(clean)).toEqual(clean)
  })
})
