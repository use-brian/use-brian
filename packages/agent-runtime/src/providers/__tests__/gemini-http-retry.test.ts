import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createGeminiHttpRetry } from '../gemini-http-retry.js'
import { wrapProvider } from '../wrappers.js'
import { createGeminiProvider } from '../gemini.js'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); vi.spyOn(Math, 'random').mockReturnValue(1) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })
const limited = (body = '{}', headers = {}) => new Response(body, { status: 429, headers })
const ok = () => new Response('ok')

it('exhausts after three retries', async () => {
  const start = Date.now()
  const send = vi.fn(async () => limited())
  const result = expect(createGeminiHttpRetry()(send)).rejects.toThrow('429')
  await vi.runAllTimersAsync()
  await result
  expect(send).toHaveBeenCalledTimes(4)
  expect(Date.now() - start).toBe(41_000)
})
it.each([
  ['delta', { 'Retry-After': '5' }, '{}', 5000],
  ['date', { 'Retry-After': 'Thu, 01 Jan 2026 00:00:06 GMT' }, '{}', 6000],
  ['RetryInfo', {}, JSON.stringify({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '2.500s' }] } }), 2500],
  ['malformed', { 'Retry-After': '-5' }, '{broken', 7000],
  ['invalid RetryInfo', {}, JSON.stringify({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '-2s' }] } }), 7000],
] as const)('honors %s', async (_name, headers, body, delay) => {
  const send = vi.fn().mockResolvedValueOnce(limited(body, headers)).mockResolvedValueOnce(ok())
  const result = createGeminiHttpRetry()(send)
  await vi.advanceTimersByTimeAsync(delay - 1)
  expect(send).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect((await result).status).toBe(200)
  expect(send).toHaveBeenCalledTimes(2)
})
it.each([400, 401, 403, 500, 503, 200])('does not retry HTTP %s', async status => {
  const response = new Response('', { status })
  const send = vi.fn(async () => response)
  expect(await createGeminiHttpRetry()(send)).toBe(response)
  expect(send).toHaveBeenCalledTimes(1)
})
it('does not retry network failures', async () => {
  const send = vi.fn(async () => { throw new Error('network') })
  await expect(createGeminiHttpRetry()(send)).rejects.toThrow('network')
  expect(send).toHaveBeenCalledTimes(1)
})
it('cancels sleep and never fetches after cancellation', async () => {
  const controller = new AbortController()
  const send = vi.fn(async () => limited())
  const result = expect(createGeminiHttpRetry(controller.signal)(send)).rejects.toThrow('cancel')
  await vi.advanceTimersByTimeAsync(100)
  controller.abort(new Error('cancel'))
  await vi.runAllTimersAsync()
  await result
  expect(send).toHaveBeenCalledTimes(1)
  await expect(createGeminiHttpRetry(controller.signal)(send)).rejects.toThrow('cancel')
  expect(send).toHaveBeenCalledTimes(1)
})
it.each(['daily quota exceeded', 'Quota exceeded, limit: 0', 'billing disabled'])('does not retry definitive hard quota: %s', async message => {
  const send = vi.fn(async () => limited(JSON.stringify({ error: { message } })))
  await expect(createGeminiHttpRetry()(send)).rejects.toThrow('429')
  expect(send).toHaveBeenCalledTimes(1)
})
it('does not shorten a server delay to fit the budget', async () => {
  const send = vi.fn(async () => limited('{}', { 'Retry-After': '61' }))
  await expect(createGeminiHttpRetry()(send)).rejects.toThrow('429')
  expect(send).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})
it('counts retry request time in the budget', async () => {
  const send = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 58_000)); return limited() })
    .mockResolvedValueOnce(limited())
  const result = expect(createGeminiHttpRetry()(send)).rejects.toThrow('429')
  await vi.runAllTimersAsync()
  await result
  expect(send).toHaveBeenCalledTimes(2)
})
it('does not impose a rate-limit deadline on a slow first successful request', async () => {
  const send = vi.fn((signal: AbortSignal) => new Promise<Response>((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason))
    setTimeout(() => resolve(ok()), 75_000)
  }))
  const result = createGeminiHttpRetry()(send)
  await vi.advanceTimersByTimeAsync(75_000)
  expect((await result).status).toBe(200)
  expect(send).toHaveBeenCalledTimes(1)
})
it('aborts a pending retry request at the deadline after a 429', async () => {
  const send = vi.fn((signal: AbortSignal) => new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))))
    .mockResolvedValueOnce(limited())
  const result = expect(createGeminiHttpRetry()(send)).rejects.toThrow('429')
  await vi.advanceTimersByTimeAsync(60_000)
  await result
  expect(send).toHaveBeenCalledTimes(2)
})
it('bounds and cancels stalled rejected bodies', async () => {
  const cancel = vi.fn()
  const send = vi.fn().mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 429 })).mockResolvedValueOnce(ok())
  const result = createGeminiHttpRetry()(send)
  await vi.runAllTimersAsync()
  expect((await result).status).toBe(200)
  expect(cancel).toHaveBeenCalledOnce()
})
it.each([false, true])('retries identical adapter body, delivers tools once (stateful=%s)', async stateful => {
  const tool = { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'readFile', args: { path: 'a' }, id: 'call1' }, thoughtSignature: 'signature' }] }, finishReason: 'STOP' }] }
  const fetch = vi.fn().mockResolvedValueOnce(limited()).mockResolvedValueOnce(new Response(`data: ${JSON.stringify(tool)}\n\n`))
  vi.stubGlobal('fetch', fetch)
  const provider = wrapProvider(createGeminiProvider('key'))
  const options = { systemPrompt: '', model: 'gemini-3-flash', tools: [{ name: 'readFile', description: 'read', parameters: { type: 'object' as const, properties: {} } }] }
  const messages = [{ role: 'user' as const, content: 'read a' }]
  const stream = stateful ? provider.createSession!(options).send(messages) : provider.stream({ ...options, messages })
  const result = (async () => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks })()
  await vi.runAllTimersAsync()
  const chunks = await result
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(fetch.mock.calls[0]![1].body).toBe(fetch.mock.calls[1]![1].body)
  expect(chunks.filter(c => c.type === 'tool_use_start')).toHaveLength(1)
  expect(chunks.filter(c => c.type === 'tool_use_end')).toHaveLength(1)
})
it('bounds oversized error bodies and retries generic RESOURCE_EXHAUSTED', async () => {
  const send = vi.fn().mockResolvedValueOnce(limited('x'.repeat(40_000)))
    .mockResolvedValueOnce(limited(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } })))
    .mockResolvedValueOnce(ok())
  const result = createGeminiHttpRetry()(send)
  await vi.runAllTimersAsync()
  expect((await result).status).toBe(200)
  expect(send).toHaveBeenCalledTimes(3)
})
it('does not retry a failure after successful stream bytes', async () => {
  let reads = 0
  const body = new ReadableStream({ pull(controller) {
    if (reads++ === 0) controller.enqueue(new TextEncoder().encode('data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hello"}]}}]}\n\n'))
    else controller.error(new Error('stream failed 429'))
  } })
  const fetch = vi.fn(async () => new Response(body))
  vi.stubGlobal('fetch', fetch)
  const run = async () => {
    for await (const _ of createGeminiProvider('key').stream({ model: 'gemini-3-flash', systemPrompt: '', messages: [{ role: 'user', content: 'hello' }] })) { /* drain */ }
  }
  await expect(run()).rejects.toThrow('stream failed 429')
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('shares retry count across schema fallback sends', async () => {
  const retry = createGeminiHttpRetry()
  const send = vi.fn().mockResolvedValueOnce(limited()).mockResolvedValueOnce(new Response('', { status: 400 }))
  const first = retry(send)
  await vi.runAllTimersAsync()
  expect((await first).status).toBe(400)
  const fallback = vi.fn(async () => limited())
  const second = expect(retry(fallback)).rejects.toThrow('429')
  await vi.runAllTimersAsync()
  await second
  expect(fallback).toHaveBeenCalledTimes(3)
})

it('recovers from sustained 429 beyond the old seven-second window', async () => {
  const start = Date.now()
  const send = vi.fn(async () => Date.now() - start < 15_000 ? limited() : ok())
  const result = createGeminiHttpRetry()(send)
  await vi.runAllTimersAsync()
  expect((await result).status).toBe(200)
  expect(send).toHaveBeenCalledTimes(3)
  expect(Date.now() - start).toBe(19_000)
})
it.each([false, true])('bounds late 429 by wrapper deadline without idle replay (session=%s)', async session => {
  const fetch = vi.fn(async () => {
    await new Promise(resolve => setTimeout(resolve, 85_000))
    return limited()
  })
  vi.stubGlobal('fetch', fetch)
  const provider = wrapProvider(createGeminiProvider('key'))
  const opts = { model: 'gemini-3-flash', systemPrompt: '' }
  const messages = [{ role: 'user' as const, content: 'hello' }]
  const run = async () => {
    const stream = session ? provider.createSession(opts).send(messages) : provider.stream({ ...opts, messages })
    for await (const _ of stream) { /* drain */ }
  }
  const result = expect(run()).rejects.toThrow('429')
  await vi.runAllTimersAsync()
  await result
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})
it('logs only allowlisted metadata, including terminal quota reason', async () => {
  vi.stubEnv('BRIAN_DEBUG_GEMINI_HTTP_RETRY', '1')
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  const send = vi.fn(async () => limited(JSON.stringify({ error: { message: 'billing disabled SECRET https://private/quota' } })))
  await expect(createGeminiHttpRetry(undefined, { transport: 'vertex', model: 'SECRET' })(send)).rejects.toThrow('429')
  const metadata = JSON.parse(log.mock.calls[0]![1])
  expect(metadata).toMatchObject({ transport: 'vertex', model: 'other', quota: 'billing', terminalReason: 'hard_quota', attempt: 0 })
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/SECRET|https|private/)
})
it('uses the longer server hint without shortening it by jitter', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0)
  const body = JSON.stringify({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' }] } })
  const send = vi.fn().mockResolvedValueOnce(limited(body, { 'Retry-After': '10' })).mockResolvedValueOnce(ok())
  const result = createGeminiHttpRetry()(send)
  await vi.advanceTimersByTimeAsync(11_999)
  expect(send).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect((await result).status).toBe(200)
})

it.each([false, true])('aborts a pending late retry at the wrapper deadline (session=%s)', async session => {
  let retrySignal: AbortSignal | undefined
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    retrySignal = init.signal as AbortSignal
    return new Promise<Response>((_resolve, reject) => retrySignal!.addEventListener('abort', () => reject(retrySignal!.reason), { once: true }))
  }).mockImplementationOnce(async () => {
    await new Promise(resolve => setTimeout(resolve, 85_000))
    return limited('{}', { 'Retry-After': '1' })
  })
  vi.stubGlobal('fetch', fetch)
  const provider = wrapProvider(createGeminiProvider('key'))
  const opts = { model: 'gemini-3-flash', systemPrompt: '' }
  const messages = [{ role: 'user' as const, content: 'hello' }]
  const run = async () => {
    const stream = session ? provider.createSession(opts).send(messages) : provider.stream({ ...opts, messages })
    for await (const _ of stream) { /* drain */ }
  }
  const result = expect(run()).rejects.toThrow('429')
  await vi.advanceTimersByTimeAsync(90_000)
  await result
  expect(retrySignal?.aborted).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})

it.each([
  { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'BILLING_DISABLED' },
  { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'requests_per_day' }] },
  { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaValue: '0' }] },
])('rejects structured hard quota without retry', async detail => {
  const send = vi.fn(async () => limited(JSON.stringify({ error: { details: [detail] } })))
  await expect(createGeminiHttpRetry()(send)).rejects.toThrow('429')
  expect(send).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})
