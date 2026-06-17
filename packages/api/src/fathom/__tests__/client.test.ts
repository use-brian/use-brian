import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  exchangeFathomAuthorizationCode,
  refreshFathomTokens,
  createFathomTokenManager,
  packFathomTokens,
  unpackFathomTokens,
  listFathomMeetings,
  getFathomMeeting,
  getFathomTranscript,
  getFathomSummary,
  type FathomTokens,
} from '../client.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  }
}

beforeEach(() => {
  mockFetch.mockReset()
})

const ACCESS = 'fath_access_abc'
const REFRESH = 'fath_refresh_def'

describe('[COMP:fathom/client] Fathom OAuth + API client', () => {
  // ── OAuth token endpoint ─────────────────────────────────

  it('exchangeFathomAuthorizationCode posts form-urlencoded body', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      access_token: ACCESS,
      refresh_token: REFRESH,
      expires_in: 3600,
    }))

    const tokens = await exchangeFathomAuthorizationCode({
      code: 'auth_code_xyz',
      clientId: 'cid',
      clientSecret: 'csec',
      redirectUri: 'https://example.com/cb',
    })

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.fathom.ai/external/v1/oauth2/token',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    )
    const body = (mockFetch.mock.calls[0][1] as { body: URLSearchParams }).body
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('auth_code_xyz')
    expect(body.get('client_id')).toBe('cid')
    expect(body.get('client_secret')).toBe('csec')
    expect(body.get('redirect_uri')).toBe('https://example.com/cb')

    expect(tokens.accessToken).toBe(ACCESS)
    expect(tokens.refreshToken).toBe(REFRESH)
    expect(Date.parse(tokens.expiresAt)).toBeGreaterThan(Date.now())
  })

  it('refreshFathomTokens posts grant_type=refresh_token', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      access_token: 'new_access',
      refresh_token: 'new_refresh',
      expires_in: 3600,
    }))

    const tokens = await refreshFathomTokens({
      refreshToken: REFRESH,
      clientId: 'cid',
      clientSecret: 'csec',
    })

    const body = (mockFetch.mock.calls[0][1] as { body: URLSearchParams }).body
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe(REFRESH)
    expect(tokens.refreshToken).toBe('new_refresh')
  })

  it('rejects when token endpoint returns no refresh_token', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ access_token: 'a', expires_in: 3600 }))

    await expect(refreshFathomTokens({
      refreshToken: REFRESH, clientId: 'cid', clientSecret: 'csec',
    })).rejects.toThrow(/incomplete payload/)
  })

  it('throws on token endpoint error response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 400))
    await expect(refreshFathomTokens({
      refreshToken: REFRESH, clientId: 'cid', clientSecret: 'csec',
    })).rejects.toThrow(/Fathom token endpoint failed \(400\)/)
  })

  // ── Token packing ────────────────────────────────────────

  it('packFathomTokens / unpackFathomTokens roundtrip', () => {
    const tokens: FathomTokens = {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: new Date().toISOString(),
    }
    const packed = packFathomTokens(tokens)
    const unpacked = unpackFathomTokens(packed)
    expect(unpacked).toEqual(tokens)
  })

  it('unpackFathomTokens returns null for malformed input', () => {
    expect(unpackFathomTokens('not json')).toBeNull()
    expect(unpackFathomTokens('{}')).toBeNull()
    expect(unpackFathomTokens('{"accessToken":"a"}')).toBeNull()
  })

  // ── Token manager (rotate-and-persist) ───────────────────

  it('token manager returns cached access token when not expired', async () => {
    const future = new Date(Date.now() + 10 * 60_000).toISOString()
    const persisted = vi.fn().mockResolvedValue(undefined)
    const mgr = createFathomTokenManager({
      clientId: 'cid', clientSecret: 'csec',
      store: {
        async getTokens() { return { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: future } },
        persistTokens: persisted,
      },
    })

    const token = await mgr.getAccessToken()
    expect(token).toBe(ACCESS)
    expect(persisted).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('token manager refreshes and persists rotated tokens when expired', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    let stored: FathomTokens = { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: past }
    mockFetch.mockResolvedValue(jsonResponse({
      access_token: 'rotated_access',
      refresh_token: 'rotated_refresh',
      expires_in: 3600,
    }))

    const mgr = createFathomTokenManager({
      clientId: 'cid', clientSecret: 'csec',
      store: {
        async getTokens() { return stored },
        async persistTokens(t) { stored = t },
      },
    })

    const token = await mgr.getAccessToken()

    expect(token).toBe('rotated_access')
    // Critical invariant: the new refresh_token must have replaced the old one.
    // If persistence is skipped, the connection bricks on next call.
    expect(stored.refreshToken).toBe('rotated_refresh')
    expect(stored.accessToken).toBe('rotated_access')
    expect(Date.parse(stored.expiresAt)).toBeGreaterThan(Date.now())
  })

  it('token manager throws when no tokens are stored', async () => {
    const mgr = createFathomTokenManager({
      clientId: 'cid', clientSecret: 'csec',
      store: { async getTokens() { return null }, async persistTokens() {} },
    })
    await expect(mgr.getAccessToken()).rejects.toThrow(/Fathom not connected/)
  })

  // ── API surface ───────────────────────────────────────────

  it('listFathomMeetings sends bearer auth + serializes flags', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ items: [] }))

    await listFathomMeetings(ACCESS, {
      cursor: 'cur',
      limit: 50,
      includeTranscript: true,
      includeSummary: true,
      recordedAfter: '2026-01-01T00:00:00Z',
    })

    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toMatch(/^https:\/\/api\.fathom\.ai\/external\/v1\/meetings\?/)
    expect(url).toContain('cursor=cur')
    expect(url).toContain('limit=50')
    expect(url).toContain('include_transcript=true')
    expect(url).toContain('include_summary=true')
    expect(url).toContain('recorded_after=2026-01-01T00%3A00%3A00Z')
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe(`Bearer ${ACCESS}`)
  })

  it('listFathomMeetings omits unset query params', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ items: [] }))
    await listFathomMeetings(ACCESS, {})
    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toBe('https://api.fathom.ai/external/v1/meetings')
  })

  it('getFathomMeeting / getFathomTranscript / getFathomSummary hit the right paths', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}))
    await getFathomMeeting(ACCESS, 'meet_42')
    await getFathomTranscript(ACCESS, 'meet_42')
    await getFathomSummary(ACCESS, 'meet_42')

    expect(mockFetch.mock.calls[0][0]).toBe('https://api.fathom.ai/external/v1/meetings/meet_42')
    expect(mockFetch.mock.calls[1][0]).toBe('https://api.fathom.ai/external/v1/recordings/meet_42/transcript')
    expect(mockFetch.mock.calls[2][0]).toBe('https://api.fathom.ai/external/v1/recordings/meet_42/summary')
  })

  it('translates 401 into a reconnect-prompt error', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'invalid_token' }, 401))
    await expect(getFathomMeeting(ACCESS, 'm1')).rejects.toThrow(/reconnect Fathom/i)
  })

  it('encodes meeting ids that contain unsafe characters', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}))
    await getFathomMeeting(ACCESS, 'meet/with spaces')
    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://api.fathom.ai/external/v1/meetings/meet%2Fwith%20spaces',
    )
  })
})
