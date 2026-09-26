import { describe, expect, it, vi } from 'vitest'
import { applyLiveOfficeSuggestion, officeSuggestionApplied, replaceLiveOfficeSnapshot } from '../live-sync.js'

const snapshot = { artifactId: 'artifact-1', family: 'spreadsheet' } as never

describe('[COMP:api/office-live-sync] Office live snapshot bridge', () => {
  it('is disabled when doc-sync is not configured outside production', async () => {
    await expect(replaceLiveOfficeSnapshot(snapshot, { syncUrl: undefined, syncSecret: undefined })).resolves.toBe('disabled')
  })

  it('posts the committed snapshot to the authenticated doc-sync endpoint', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await expect(replaceLiveOfficeSnapshot(snapshot, {
      syncUrl: 'ws://localhost:8080/',
      syncSecret: 'secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).resolves.toBe('replaced')
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://localhost:8080/internal/office/replace')
    expect((init.headers as Record<string, string>)['x-doc-sync-secret']).toBe('secret')
    expect(JSON.parse(init.body as string)).toEqual({ artifactId: 'artifact-1', snapshot })
  })

  it('retries transient failures and fails closed after the third attempt', async () => {
    const recovered = vi.fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    await expect(replaceLiveOfficeSnapshot(snapshot, { syncUrl: 'ws://localhost:8080', syncSecret: 'secret', fetchImpl: recovered as unknown as typeof fetch })).resolves.toBe('replaced')
    expect(recovered).toHaveBeenCalledTimes(2)

    const unavailable = vi.fn(async () => new Response('busy', { status: 503 }))
    await expect(replaceLiveOfficeSnapshot(snapshot, { syncUrl: 'ws://localhost:8080', syncSecret: 'secret', fetchImpl: unavailable as unknown as typeof fetch })).rejects.toThrow(/HTTP 503/)
    expect(unavailable).toHaveBeenCalledTimes(3)
  })

  it('posts suggestion application to the atomic doc-sync boundary and reports conflicts', async () => {
    const command = { artifactId: 'artifact-1', commandId: 'command-1' } as never
    const applied = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await expect(applyLiveOfficeSuggestion('artifact-1', 'suggestion-1', command, { syncUrl: 'ws://localhost:8080', syncSecret: 'secret', fetchImpl: applied as unknown as typeof fetch })).resolves.toBe('applied')
    const [url, init] = applied.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://localhost:8080/internal/office/suggestion')
    expect(JSON.parse(init.body as string)).toEqual({ artifactId: 'artifact-1', suggestionId: 'suggestion-1', command })
    await expect(applyLiveOfficeSuggestion('artifact-1', 'suggestion-1', command, { syncUrl: 'ws://localhost:8080', syncSecret: 'secret', fetchImpl: vi.fn(async () => new Response('{}', { status: 409 })) as unknown as typeof fetch })).resolves.toBe('conflict')
  })
})


describe('[COMP:api/office-live-sync] read-only suggestion receipt bridge', () => {
  const artifactId = '00000000-0000-4000-8000-000000000001'
  const suggestionId = '00000000-0000-4000-8000-000000000002'
  const options = { syncUrl: 'ws://localhost:8080', syncSecret: 'secret' }
  it('sends only UUIDs with the existing secret, timeout and redirect protection', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"applied":true}'))
    expect(await officeSuggestionApplied(artifactId, suggestionId, { ...options, fetchImpl })).toBe(true)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://localhost:8080/internal/office/suggestion-status')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'x-doc-sync-secret': 'secret' } })
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(init.body as string)).toEqual({ artifactId, suggestionId })
  })
  it.each(['{"applied":false}', '{"applied":"true"}', '{"applied":true,"extra":1}', 'null', 'invalid'])('fails closed for response %s', async (body) => {
    expect(await officeSuggestionApplied(artifactId, suggestionId, { ...options, fetchImpl: vi.fn(async () => new Response(body)) })).toBe(false)
  })
  it('fails closed on disabled transport, invalid IDs, HTTP errors, timeout or network errors', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('unavailable') })
    expect(await officeSuggestionApplied(artifactId, suggestionId, { syncUrl: '', syncSecret: '', fetchImpl })).toBe(false)
    expect(await officeSuggestionApplied('bad', suggestionId, { ...options, fetchImpl })).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(await officeSuggestionApplied(artifactId, suggestionId, { ...options, fetchImpl })).toBe(false)
    expect(await officeSuggestionApplied(artifactId, suggestionId, { ...options, fetchImpl: vi.fn(async () => new Response('{}', { status: 500 })) })).toBe(false)
    const aborting = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))))
    expect(await officeSuggestionApplied(artifactId, suggestionId, { ...options, timeoutMs: 1, fetchImpl: aborting })).toBe(false)
  })
})
