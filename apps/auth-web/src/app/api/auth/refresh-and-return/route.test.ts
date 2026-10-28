import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizedRetry } from './retry'
import { GET } from './route'

vi.mock('@/lib/config', () => ({
  portalConfig: () => ({
    internalApiUrl: 'http://127.0.0.1:4000',
    portalOrigin: 'https://auth.brian.example.com',
    appOrigin: 'https://app.brian.example.com',
    cookieDomain: '.brian.example.com',
    trustProxyHeaders: false,
    emailEnabled: true,
    oidcEnabled: false,
  }),
}))

const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({
    accessToken: 'synthetic-access',
    refreshToken: 'synthetic-rotated-refresh',
    user: { id: 'person-one', name: 'Example Person', email: 'person@example.com' },
  })))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals() })

function refreshRequest(next: string, retry?: string) {
  const url = new URL('https://auth.brian.example.com/api/auth/refresh-and-return')
  url.searchParams.set('next', next)
  if (retry !== undefined) url.searchParams.set('retry', retry)
  return new Request(url, { headers: { Cookie: 'refresh_token=synthetic-refresh' } })
}

describe('[COMP:app/outpost-auth] refresh retry bounds', () => {
  it('clamps negative, invalid, and oversized counters', () => {
    expect(normalizedRetry('-2147483648')).toBe(0)
    expect(normalizedRetry('invalid')).toBe(0)
    expect(normalizedRetry('999')).toBe(4)
  })
})

describe('[COMP:app/outpost-auth] refresh return origin boundary', () => {
  it.each([
    '/\\outside.example/invite',
    '/\\outside.example\\invite',
    '/\t/outside.example/invite',
    '/\n/outside.example/invite',
    '/\r/outside.example/invite',
    '//outside.example/invite',
    'https://app.brian.example.com.outside.example/invite',
    '/\\[::1/invite',
    '/\\%/invite',
  ])('falls back to the configured app after successful refresh for rejected return %j', async next => {
    const response = await GET(refreshRequest(next))
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('https://app.brian.example.com/')
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:4000/auth/refresh', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ refreshToken: 'synthetic-refresh' }),
    }))
    expect(response.cookies.get('access_token')?.value).toBe('synthetic-access')
    expect(response.cookies.get('refresh_token')?.value).toBe('synthetic-rotated-refresh')
  })

  it.each([
    ['/invite?token=abc#accept', 'https://auth.brian.example.com/invite?token=abc#accept'],
    ['https://app.brian.example.com/w/one?view=work', 'https://app.brian.example.com/w/one?view=work'],
    ['https://auth.brian.example.com/invite?token=abc', 'https://auth.brian.example.com/invite?token=abc'],
  ])('preserves an allowed destination through successful refresh: %s', async (next, destination) => {
    const response = await GET(refreshRequest(next))
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(destination)
  })

  it.each([['0', true], ['4', false], ['999', false]] as const)('preserves bounded automatic retry at counter %s', async (retry, automatic) => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 503 }))
    const response = await GET(refreshRequest('/invite?token=abc', retry))
    expect(response.status).toBe(503)
    const body = await response.text()
    expect(body.includes('http-equiv="refresh"')).toBe(automatic)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('location')).toBeNull()
  })
})
