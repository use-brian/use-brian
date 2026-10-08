import { createBrowserAuthorityClient } from '../auth.js'
import { describe, expect, it, vi } from 'vitest'
import { parseEnv } from '../env.js'

const required = {
  BROWSER_RELAY_SECRET: 'relay-secret',
  JWT_SECRET: 'jwt-secret',
}

describe('[COMP:ext/relay] browser relay environment', () => {
  it('keeps the container-compatible default bind address and port', () => {
    const env = parseEnv(required)

    expect(env.HOST).toBe('0.0.0.0')
    expect(env.PORT).toBe(8080)
  })

  it('accepts a loopback bind for single-machine self-hosting', () => {
    const env = parseEnv({ ...required, HOST: '127.0.0.1', PORT: '8092' })

    expect(env.HOST).toBe('127.0.0.1')
    expect(env.PORT).toBe(8092)
  })
})


describe('[COMP:ext/relay] authority HTTP client', () => {
  it('fails closed without configuration, on insecure destinations, and on failed lookups', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
    for (const url of [undefined, 'http://api.example', 'https://user:password@api.example']) {
      expect(await createBrowserAuthorityClient(url, fetcher)('credential')).toBe(false)
    }
    expect(fetcher).not.toHaveBeenCalled()
    const check = createBrowserAuthorityClient('http://127.0.0.1:4100', fetcher)
    expect(await check('credential')).toBe(true)
    expect(fetcher).toHaveBeenCalledWith(new URL('http://127.0.0.1:4100/api/browser-extension/authority'),
      expect.objectContaining({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer credential' } }))
    fetcher.mockResolvedValueOnce(new Response(null, { status: 403 }))
    expect(await check('credential')).toBe(false)
    fetcher.mockRejectedValueOnce(new Error('network failure'))
    expect(await check('credential')).toBe(false)
  })
})
