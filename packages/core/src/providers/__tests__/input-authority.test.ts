import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGeminiProvider } from '../gemini.js'
import { createOpenAICompatProvider } from '../openai-compat.js'
import { createAnthropicProvider } from '../anthropic.js'
import { wrapProvider } from '../wrappers.js'
import { wrapFallback } from '../wrap-fallback.js'
import { wrapEndpointFallback } from '../wrap-endpoint-fallback.js'
import { isInputAuthorityError } from '../input-authority.js'
import type { LLMProvider, ProviderRequest, StreamChunk } from '../types.js'

const request: ProviderRequest = { model: 'gemini-3-flash',systemPrompt: 'Fictional input',messages: [{ role: 'user',content: 'Fictional record' }] }
const denied = () => Object.assign(new Error('Input unavailable'), { reason: 'authority_changed',retrySafe: false })
async function drain(stream: AsyncIterable<StreamChunk>) { for await (const _ of stream) { /* consume local fixture only */ } }
function fixtureProvider(send: () => AsyncIterable<StreamChunk>): LLMProvider {
  return { name: 'fixture',models: ['fixture-model'],stream: send,createSession: () => ({ send }) }
}
function dispatch(provider: LLMProvider, stateless: boolean, input = request) {
  return stateless ? provider.stream(input) : provider.createSession({ ...input }).send(input.messages)
}

// Transport/recovery mechanics. The API integration suite supplies independent source ACL proof.
describe('[COMP:engine/model-input-authority] provider attempts', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('recognizes nested SDK refusals and terminates cyclic error causes', () => {
    expect(isInputAuthorityError(new Error('SDK wrapper', { cause: denied() }))).toBe(true)
    const cycle = new Error('Cycle'); cycle.cause = cycle
    expect(isInputAuthorityError(cycle)).toBe(false)
  })
  it.each([false,true])('checks each context-budget retry (%s)', async stateless => {
    let attempts = 0
    const base = fixtureProvider(() => (async function* () { attempts++; throw new Error('context_length_exceeded') })())
    const check = vi.fn(async () => { if (attempts) throw denied() })
    await expect(drain(dispatch(wrapProvider(base),stateless,{ ...request,assertInputAuthority: check }))).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(attempts).toBe(1); expect(check).toHaveBeenCalledTimes(2)
  })
  it('checks the text-loop retry before a second base attempt', async () => {
    let attempts = 0, revoked = false
    const base = fixtureProvider(() => (async function* () {
      attempts++
      yield { type: 'message_start' as const,model: 'fixture' }
      yield { type: 'text_delta' as const,text: '\u200B'.repeat(100) }
      revoked = true
      yield { type: 'message_end' as const,stopReason: 'end_turn' as const,usage: { inputTokens: 1,outputTokens: 1 } }
    })())
    await expect(drain(wrapProvider(base).stream({ ...request,assertInputAuthority: async () => { if (revoked) throw denied() } })))
      .rejects.toMatchObject({ reason: 'authority_changed' })
    expect(attempts).toBe(1)
  })
  it.each([false,true])('does not start a fallback after an intervening refusal (%s)', async stateless => {
    let primaryCalls = 0, fallbackCalls = 0
    const primary = fixtureProvider(() => (async function* () { primaryCalls++; throw Object.assign(new Error('Provider outage'), { status: 503 }) })())
    const fallback = fixtureProvider(() => (async function* () { fallbackCalls++ })())
    const check = vi.fn(async () => { if (primaryCalls) throw denied() })
    await expect(drain(dispatch(wrapFallback(primary,fallback),stateless,{ ...request,assertInputAuthority: check })))
      .rejects.toMatchObject({ reason: 'authority_changed' })
    expect(primaryCalls).toBe(1); expect(fallbackCalls).toBe(0)
  })
  it.each([false,true])('preserves a fallback authority error instead of the original outage (%s)', async stateless => {
    const refusal = denied()
    const primary = fixtureProvider(() => (async function* () { throw Object.assign(new Error('Provider outage'), { status: 503 }) })())
    const fallback = fixtureProvider(() => (async function* () { throw refusal })())
    await expect(drain(dispatch(wrapFallback(primary,fallback),stateless))).rejects.toBe(refusal)
  })
  it.each([false,true])('holds endpoint fallback on nested authority errors (%s)', async stateless => {
    const refusal = new Error('SDK wrapper', { cause: denied() }); let fallbackCalls = 0
    const primary = fixtureProvider(() => (async function* () { throw refusal })())
    const fallback = fixtureProvider(() => (async function* () { fallbackCalls++ })())
    await expect(drain(dispatch(wrapEndpointFallback(primary,fallback),stateless))).rejects.toBe(refusal)
    expect(fallbackCalls).toBe(0)
  })
  it('preserves endpoint fallback authority errors after primary network failure', async () => {
    const refusal = denied()
    const primary = fixtureProvider(() => (async function* () { throw new Error('Connection refused') })())
    const fallback = fixtureProvider(() => (async function* () { throw refusal })())
    await expect(drain(wrapEndpointFallback(primary,fallback).stream(request))).rejects.toBe(refusal)
  })
  it.each([false,true])('rechecks Gemini HTTP rate-limit retries (%s)', async stateless => {
    let requests = 0
    vi.stubGlobal('fetch', vi.fn(async () => { requests++; return new Response('{"error":{"message":"Capacity unavailable"}}', { status: 429,headers: { 'retry-after': '0' } }) }))
    const check = vi.fn(async () => { if (requests) throw denied() })
    await expect(drain(dispatch(createGeminiProvider('fictional-test-key'),stateless,{ ...request,assertInputAuthority: check })))
      .rejects.toMatchObject({ reason: 'authority_changed' })
    expect(requests).toBe(1); expect(check).toHaveBeenCalledTimes(2)
  })
  it('rechecks Gemini schema retries without serializing the callback', async () => {
    const bodies: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { bodies.push(init.body); return new Response('Unsupported schema', { status: 400 }) }))
    await expect(drain(createGeminiProvider('fictional-test-key').stream({ ...request,responseFormat: 'json',responseSchema: { type: 'object' },
      assertInputAuthority: async () => { if (bodies.length) throw denied() } }))).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(bodies).toHaveLength(1); expect(bodies[0]).not.toContain('assertInputAuthority')
  })
  it.each([false,true])('rechecks compatible-endpoint system-message retries (%s)', async stateless => {
    let requests = 0
    const provider = createOpenAICompatProvider({ label: 'fixture',baseURL: 'https://model.example/v1',apiKey: 'fictional-test-key',
      fetchFn: vi.fn(async () => { requests++; return new Response('Only one system message is supported', { status: 400 }) }) })
    await expect(drain(dispatch(provider,stateless,{ ...request,runtimeSystemContext: 'Fictional private context',
      assertInputAuthority: async () => { if (requests) throw denied() } }))).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(requests).toBe(1)
  })
  it('checks the Anthropic SDK fetch and preserves refusal without SDK retry', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const check = vi.fn(async () => { throw denied() })
    await expect(drain(createAnthropicProvider({ apiKey: 'fictional-test-key' }).stream({ ...request,model: 'claude-haiku-4-5',assertInputAuthority: check })))
      .rejects.toMatchObject({ reason: 'authority_changed',retrySafe: false })
    expect(fetch).not.toHaveBeenCalled(); expect(check).toHaveBeenCalledTimes(1)
  })
})
