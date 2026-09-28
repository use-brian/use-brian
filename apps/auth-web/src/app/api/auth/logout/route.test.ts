import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET, POST } from './route'

const fetchMock = vi.fn()
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 200 }))
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

function logoutRequest(form = false) {
  const body = form ? new URLSearchParams({ next: 'http://localhost:3003/w/one' }) : undefined
  return new Request('http://localhost:3005/api/auth/logout', {
    method: 'POST', body,
    headers: { Cookie: 'access_token=expired; refresh_token=retained-refresh', Origin: 'http://localhost:3005' },
  })
}

describe('[COMP:app/outpost-auth] logout intent', () => {
  it('GET asks for confirmation without clearing cookies', () => {
    const response = GET(new Request('http://localhost:3005/api/auth/logout?next=http%3A%2F%2Flocalhost%3A3003%2Fw%2Fone'))
    expect(new URL(response.headers.get('location')!).pathname).toBe('/logout')
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('POST clears cookies and returns to the allowlisted app', async () => {
    const form = new FormData()
    form.set('next', 'http://localhost:3003/w/one')
    const response = await POST(new Request('http://localhost:3005/api/auth/logout', { method: 'POST', body: form }))
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('http://localhost:3003/w/one')
    expect(response.headers.get('set-cookie')).toContain('access_token=')
  })

  it('revokes using the HttpOnly refresh token before deleting cookies, without needing live access', async () => {
    let finish!: (response: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve }))
    let completed = false
    const pending = POST(logoutRequest()).then(response => { completed = true; return response })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    expect(completed).toBe(false)
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4000/auth/logout', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ refreshToken: 'retained-refresh' }), cache: 'no-store',
    }))
    finish(new Response('{}'))
    const response = await pending
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    for (const name of ['access_token', 'refresh_token', 'user']) {
      expect(response.headers.getSetCookie()).toContain(`${name}=; Path=/; Max-Age=0`)
    }
  })

  it('expires all host-only and shared-domain auth cookies in separate headers', async () => {
    vi.stubEnv('AUTH_PORTAL_URL', 'https://auth.customer.example')
    vi.stubEnv('AUTHED_APP_URL', 'https://app.customer.example')
    vi.stubEnv('COOKIE_DOMAIN', '.customer.example')
    const response = await POST(new Request('https://auth.customer.example/api/auth/logout', { method: 'POST' }))
    expect(response.headers.getSetCookie()).toHaveLength(6)
    for (const name of ['access_token', 'refresh_token', 'user']) {
      expect(response.headers.getSetCookie()).toContain(`${name}=; Path=/; Max-Age=0`)
      expect(response.headers.getSetCookie()).toContain(`${name}=; Path=/; Max-Age=0; Domain=.customer.example`)
    }
  })

  it('clears malformed percent-encoded refresh cookies without throwing', async () => {
    const response = await POST(new Request('http://localhost:3005/api/auth/logout', {
      method: 'POST', headers: { Cookie: 'refresh_token=%' },
    }))
    expect(response.status).toBe(200)
    expect(response.headers.getSetCookie()).toContain('refresh_token=; Path=/; Max-Age=0')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('clears an invalid or expired refresh token instead of trapping the user', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }))
    expect((await POST(logoutRequest())).status).toBe(200)
  })

  it.each([404, 429, 500, 503])('does not claim logout succeeded when revocation returns %s', async status => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status }))
    const response = await POST(logoutRequest())
    expect(response.status).toBe(503)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('location')).toBeNull()
  })

  it('offers a form retry on network failure without navigating back into automatic refresh', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    const response = await POST(logoutRequest(true))
    const target = new URL(response.headers.get('location')!)
    expect(target.pathname).toBe('/logout')
    expect(target.searchParams.get('error')).toBe('unavailable')
    expect(target.searchParams.get('next')).toBe('http://localhost:3003/w/one')
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('rejects cross-site logout POSTs', async () => {
    const response = await POST(new Request('http://localhost:3005/api/auth/logout', {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
    }))
    expect(response.status).toBe(403)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
