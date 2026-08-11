import { EventEmitter } from 'node:events'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type { RequestOptions } from 'node:https'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  createPublicCustomLlmFetch,
  isPublicCustomLlmAddress,
  resolvePublicCustomLlmTarget,
} from '../custom-llm-public-fetch.js'

describe('[COMP:api/custom-llm-endpoints] hosted public endpoint transport', () => {
  it('rejects private, reserved, documentation, and non-global addresses', () => {
    for (const address of [
      '0.0.0.1',
      '10.0.0.1',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.1.1',
      '192.0.2.1',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '::1',
      'fc00::1',
      'fe80::1',
      '2001:db8::1',
      '::ffff:127.0.0.1',
    ]) expect(isPublicCustomLlmAddress(address), address).toBe(false)

    expect(isPublicCustomLlmAddress('8.8.8.8')).toBe(true)
    expect(isPublicCustomLlmAddress('2606:4700:4700::1111')).toBe(true)
  })

  it('fails closed when even one DNS answer is private', async () => {
    await expect(resolvePublicCustomLlmTarget(
      new URL('https://models.example.com/v1/chat/completions'),
      vi.fn().mockResolvedValue([
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
    )).rejects.toMatchObject({ code: 'endpoint_public_address_required' })
  })

  it('rejects local hostnames before DNS and requires HTTPS', async () => {
    const lookup = vi.fn()
    await expect(resolvePublicCustomLlmTarget(new URL('https://model.internal/v1'), lookup))
      .rejects.toThrow('local or private')
    await expect(resolvePublicCustomLlmTarget(new URL('http://models.example.com/v1'), lookup))
      .rejects.toThrow('public HTTPS')
    expect(lookup).not.toHaveBeenCalled()
  })

  it('pins the vetted IP while preserving the original TLS hostname and does not follow redirects', async () => {
    let pinned: { address?: string; family?: number } = {}
    let pinnedAll: Array<{ address: string; family: number }> = []
    const request = vi.fn((
      _url: URL,
      options: RequestOptions,
      callback: (response: IncomingMessage) => void,
    ) => {
      options.lookup?.('models.example.com', {}, (error, address, family) => {
        if (error) throw error
        pinned = { address: address as string, family: family as number }
      })
      options.lookup?.('models.example.com', { all: true }, (error, addresses) => {
        if (error) throw error
        pinnedAll = addresses as Array<{ address: string; family: number }>
      })
      const response = Readable.from([Buffer.from('redirect')]) as IncomingMessage
      response.statusCode = 302
      response.statusMessage = 'Found'
      response.headers = { location: 'https://127.0.0.1/private' }
      queueMicrotask(() => callback(response))

      const outgoing = new EventEmitter() as ClientRequest
      outgoing.write = vi.fn() as unknown as ClientRequest['write']
      outgoing.end = vi.fn() as unknown as ClientRequest['end']
      return outgoing
    })
    const fetchFn = createPublicCustomLlmFetch({
      lookup: vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]),
      request: request as unknown as typeof import('node:https').request,
    })

    const response = await fetchFn('https://models.example.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: '{}',
    })

    expect(response.status).toBe(302)
    expect(await response.text()).toBe('redirect')
    expect(request).toHaveBeenCalledTimes(1)
    const [url, options] = request.mock.calls[0] as unknown as [URL, RequestOptions]
    expect(url.hostname).toBe('models.example.com')
    expect(options.servername).toBe('models.example.com')
    expect(pinned).toEqual({ address: '8.8.8.8', family: 4 })
    expect(pinnedAll).toEqual([{ address: '8.8.8.8', family: 4 }])
  })
})
