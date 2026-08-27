import { describe, expect, it } from 'vitest'
import { GET, POST } from './route'

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

  it('rejects cross-site logout POSTs', async () => {
    const response = await POST(new Request('http://localhost:3005/api/auth/logout', {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
    }))
    expect(response.status).toBe(403)
    expect(response.headers.get('set-cookie')).toBeNull()
  })
})
