import { afterEach, expect, it, vi } from 'vitest'
import { summarizeProviderError } from '../provider-error-summary.js'
import { debugDocumentFlow } from '../../engine/document-flow-debug.js'
const secret = 'Bearer PRIVATE-key https://private.example/file.pdf base64SECRET'
const gemini = (status: number, message = secret, code?: string) => new Error(`Gemini API error ${status}: ${JSON.stringify({ error: { message, status: code }, payload: secret })}`)
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })
it.each([[400, 'unknown'], [401, 'auth'], [403, 'auth'], [429, 'rate_limit'], [500, 'upstream_failure'], [503, 'upstream_failure'], [599, 'upstream_failure']] as const)('classifies HTTP %s without content', (httpStatus, category) => {
  expect(summarizeProviderError(gemini(httpStatus))).toEqual({ category, httpStatus })
})
it('only recognizes specific Gemini validation patterns', () => {
  expect(summarizeProviderError(gemini(400, secret, 'INVALID_ARGUMENT')).category).toBe('invalid_argument')
  expect(summarizeProviderError(gemini(400, `Function call is missing a thought_signature. ${secret}`, 'INVALID_ARGUMENT')).category).toBe('signature_error')
  expect(summarizeProviderError(gemini(400, 'Please ensure that the number of function response parts should be equal to number of function call parts.')).category).toBe('tool_pairing_error')
  expect(summarizeProviderError(gemini(400, 'thought_signature function call field validation failed')).category).toBe('unknown')
})
it('bounds JSON parsing and validates fields without coercion', () => {
  for (const error of [undefined, null, secret, {}, { message: {} }, { status: '401' }, { status: 999 }, { status: 400.5 }, new Error('payload Gemini API error 401: {}'), { toString() { throw Error(secret) }, toJSON() { throw Error(secret) }, get message() { throw Error(secret) } }]) {
    expect(summarizeProviderError(error)).toEqual({ category: 'unknown', httpStatus: null })
  }
  for (const body of ['not JSON', '{}', '{"error":{"message":{},"status":{}}}', JSON.stringify({ error: { status: 'INVALID_ARGUMENT', message: 'x'.repeat(20000) } })]) {
    expect(summarizeProviderError(new Error(`Gemini API error 400: ${body}`))).toEqual({ category: 'unknown', httpStatus: 400 })
  }
})
it('recognizes network causes, abort and actual idle errors, not generic timeout mentions', () => {
  expect(summarizeProviderError(new Error('terminated', { cause: Object.assign(new Error(secret), { code: 'UND_ERR_SOCKET' }) })).category).toBe('network')
  expect(summarizeProviderError(new TypeError('fetch failed')).category).toBe('network')
  expect(summarizeProviderError(Object.assign(new Error(secret), { name: 'AbortError' })).category).toBe('aborted')
  expect(summarizeProviderError(new Error('Stream idle for 90000ms (first chunk)')).category).toBe('idle_timeout')
  expect(summarizeProviderError(new Error('No response body from Gemini API')).category).toBe('incomplete_stream')
  expect(summarizeProviderError(new Error('timeout setting invalid')).category).toBe('unknown')
  const cycle = { cause: undefined as unknown }; cycle.cause = cycle
  expect(summarizeProviderError(cycle).category).toBe('unknown')
})
it('debug is opt-in and emits only enums/status, never the error or body', () => {
  const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.stubEnv('BRIAN_DEBUG_DOCUMENT_FLOW', '0')
  debugDocumentFlow('stream_error', { error: true, providerError: gemini(401) })
  expect(spy).not.toHaveBeenCalled()
  vi.stubEnv('BRIAN_DEBUG_DOCUMENT_FLOW', '1')
  debugDocumentFlow('stream_error', { error: true, providerError: gemini(401) })
  debugDocumentFlow('stream_error', { error: true })
  const rows = spy.mock.calls.map(([, json]) => JSON.parse(json as string))
  expect(rows[0]).toMatchObject({ category: 'auth', httpStatus: 401 })
  expect(rows[1]).toMatchObject({ category: 'unknown', httpStatus: null })
  const output = JSON.stringify([spy.mock.calls, summarizeProviderError(gemini(401))])
  for (const text of ['Bearer', 'PRIVATE', 'https:', 'base64SECRET', 'payload', 'message']) expect(output).not.toContain(text)
})
it.each(['http', 'no-body', 'incomplete'] as const)('Gemini boundary reports %s safely', async kind => {
  const { createGeminiProvider } = await import('../gemini.js')
  vi.stubEnv('BRIAN_DEBUG_DOCUMENT_FLOW', '1')
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(async () => kind === 'http'
    ? new Response(JSON.stringify({ error: { status: 'INVALID_ARGUMENT', message: secret } }), { status: 400 })
    : kind === 'no-body' ? new Response(null) : new Response('')))
  try {
    for await (const _ of createGeminiProvider(secret).stream({ model: 'gemini-3.8-flash', systemPrompt: '', messages: [{ role: 'user', content: secret }], tools: [] })) { /* drain */ }
  } catch (error) { expect(kind).not.toBe('incomplete') }
  const rows = log.mock.calls.map(([, json]) => JSON.parse(json as string)).filter(row => row.event === 'stream_error')
  expect(rows).toContainEqual(expect.objectContaining({ category: kind === 'http' ? 'invalid_argument' : 'incomplete_stream', httpStatus: kind === 'http' ? 400 : null }))
  expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
  vi.unstubAllGlobals()
})
