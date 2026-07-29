import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMsGraphTokenManager,
  exchangeMsGraphAuthorizationCode,
  packMsGraphTokens,
  unpackMsGraphTokens,
  MsGraphTokenError,
  type MsGraphTokens,
  type MsGraphTokenStore,
} from '../token.js'
import { classifyConnectorAuthError } from '../../mcp/connector-health.js'

// ── Fixtures ─────────────────────────────────────────────────

const CLOCK = Date.parse('2026-07-23T12:00:00.000Z')

/** An access token that is comfortably alive under the 60s leeway. */
function liveTokens(overrides: Partial<MsGraphTokens> = {}): MsGraphTokens {
  return {
    accessToken: 'access_live',
    refreshToken: 'refresh_v1',
    expiresAt: new Date(CLOCK + 30 * 60_000).toISOString(),
    ...overrides,
  }
}

/** An access token inside the refresh leeway (expires in 10s). */
function staleTokens(overrides: Partial<MsGraphTokens> = {}): MsGraphTokens {
  return liveTokens({ expiresAt: new Date(CLOCK + 10_000).toISOString(), ...overrides })
}

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response
}

/** An in-memory store that records every persisted tuple. */
function memoryStore(initial: MsGraphTokens | null): MsGraphTokenStore & {
  current: MsGraphTokens | null
  persisted: MsGraphTokens[]
} {
  const state = {
    current: initial,
    persisted: [] as MsGraphTokens[],
    async getTokens() {
      return state.current
    },
    async persistTokens(tokens: MsGraphTokens) {
      state.persisted.push(tokens)
      state.current = tokens
    },
  }
  return state
}

function managerFor(
  store: MsGraphTokenStore,
  fetchImpl: typeof fetch,
  extra: { tenantId?: string; scope?: string } = {},
) {
  return createMsGraphTokenManager({
    store,
    clientId: 'cid',
    clientSecret: 'csec',
    fetchImpl,
    now: () => CLOCK,
    ...extra,
  })
}

function formOf(call: unknown[]): URLSearchParams {
  return (call[1] as { body: URLSearchParams }).body
}

const ROTATED = {
  access_token: 'access_v2',
  refresh_token: 'refresh_v2',
  expires_in: 3599,
  token_type: 'Bearer',
}

let mockFetch: ReturnType<typeof vi.fn>

beforeEach(() => {
  mockFetch = vi.fn()
})

describe('[COMP:msgraph/token] Microsoft Graph OAuth token manager', () => {
  // ── Cache hit ──────────────────────────────────────────────

  it('returns the stored access token without a network call when it is not near expiry', async () => {
    const store = memoryStore(liveTokens())
    const tm = managerFor(store, mockFetch as unknown as typeof fetch)

    expect(await tm.getAccessToken()).toBe('access_live')
    expect(mockFetch).not.toHaveBeenCalled()
    expect(store.persisted).toHaveLength(0)
  })

  it('refreshes inside the 60s leeway, before the access token has actually expired', async () => {
    const store = memoryStore(staleTokens())
    mockFetch.mockResolvedValue(jsonResponse(ROTATED))
    const tm = managerFor(store, mockFetch as unknown as typeof fetch)

    expect(await tm.getAccessToken()).toBe('access_v2')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('refreshes when the stored expiry is unparseable', async () => {
    const store = memoryStore(liveTokens({ expiresAt: 'not-a-date' }))
    mockFetch.mockResolvedValue(jsonResponse(ROTATED))
    const tm = managerFor(store, mockFetch as unknown as typeof fetch)

    expect(await tm.getAccessToken()).toBe('access_v2')
  })

  it('uses the injected clock, not the wall clock', async () => {
    // Expired relative to the real "now", alive relative to the injected clock.
    const store = memoryStore(liveTokens({ expiresAt: new Date(CLOCK + 60 * 60_000).toISOString() }))
    const tm = createMsGraphTokenManager({
      store,
      clientId: 'cid',
      clientSecret: 'csec',
      fetchImpl: mockFetch as unknown as typeof fetch,
      now: () => CLOCK + 61 * 60_000,
    })
    mockFetch.mockResolvedValue(jsonResponse(ROTATED))

    expect(await tm.getAccessToken()).toBe('access_v2')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  // ── Refresh request shape ──────────────────────────────────

  it('posts a form-encoded refresh_token grant to the work/school tenant', async () => {
    const store = memoryStore(staleTokens())
    mockFetch.mockResolvedValue(jsonResponse(ROTATED))
    await managerFor(store, mockFetch as unknown as typeof fetch).getAccessToken()

    // `organizations`, never `common`: `common` admits personal Microsoft
    // accounts, for which every Teams delegated permission is documented "Not
    // supported" — consent succeeds and then all nine tools fail at runtime.
    expect(mockFetch).toHaveBeenCalledWith(
      'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    )
    const body = formOf(mockFetch.mock.calls[0])
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('refresh_v1')
    expect(body.get('client_id')).toBe('cid')
    expect(body.get('client_secret')).toBe('csec')
    expect(body.get('scope')).toBeNull()
  })

  it('honours a tenant override and an explicit scope', async () => {
    const store = memoryStore(staleTokens())
    mockFetch.mockResolvedValue(jsonResponse(ROTATED))
    await managerFor(store, mockFetch as unknown as typeof fetch, {
      tenantId: 'contoso.onmicrosoft.com',
      scope: 'offline_access Chat.Read',
    }).getAccessToken()

    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token',
    )
    expect(formOf(mockFetch.mock.calls[0]).get('scope')).toBe('offline_access Chat.Read')
  })

  // ── Rotation + persistence (the invariant) ─────────────────

  it('persists the rotated refresh token, not just the access token', async () => {
    const store = memoryStore(staleTokens())
    mockFetch.mockResolvedValue(jsonResponse(ROTATED))

    expect(await managerFor(store, mockFetch as unknown as typeof fetch).getAccessToken())
      .toBe('access_v2')

    expect(store.persisted).toHaveLength(1)
    expect(store.persisted[0].refreshToken).toBe('refresh_v2')
    expect(store.persisted[0].accessToken).toBe('access_v2')
    // And the next refresh must use the ROTATED token — Graph invalidates the
    // old one on use, so reusing `refresh_v1` here would brick the connection.
    expect(store.current?.refreshToken).toBe('refresh_v2')
  })

  it('persists BEFORE returning the access token', async () => {
    const order: string[] = []
    const store = memoryStore(staleTokens())
    const wrapped: MsGraphTokenStore = {
      getTokens: store.getTokens,
      async persistTokens(tokens) {
        await new Promise((r) => setTimeout(r, 5))
        order.push('persist')
        await store.persistTokens(tokens)
      },
    }
    mockFetch.mockResolvedValue(jsonResponse(ROTATED))

    await managerFor(wrapped, mockFetch as unknown as typeof fetch).getAccessToken()
    order.push('return')

    expect(order).toEqual(['persist', 'return'])
  })

  it('fails the call when persistence fails — a lost rotation must not look like success', async () => {
    const store: MsGraphTokenStore = {
      getTokens: async () => staleTokens(),
      persistTokens: async () => {
        throw new Error('db down')
      },
    }
    mockFetch.mockResolvedValue(jsonResponse(ROTATED))

    await expect(
      managerFor(store, mockFetch as unknown as typeof fetch).getAccessToken(),
    ).rejects.toThrow('db down')
  })

  it('derives the expiry from the response expires_in, not an assumed lifetime', async () => {
    const store = memoryStore(staleTokens())
    mockFetch.mockResolvedValue(jsonResponse({ ...ROTATED, expires_in: 120 }))

    await managerFor(store, mockFetch as unknown as typeof fetch).getAccessToken()

    expect(store.persisted[0].expiresAt).toBe(new Date(CLOCK + 120_000).toISOString())
  })

  it('keeps the current refresh token when the response omits one', async () => {
    const store = memoryStore(staleTokens())
    mockFetch.mockResolvedValue(jsonResponse({ access_token: 'access_v2', expires_in: 3599 }))

    await managerFor(store, mockFetch as unknown as typeof fetch).getAccessToken()

    expect(store.persisted[0].refreshToken).toBe('refresh_v1')
  })

  it('rejects a response with no access token', async () => {
    const store = memoryStore(staleTokens())
    mockFetch.mockResolvedValue(jsonResponse({ refresh_token: 'refresh_v2', expires_in: 3599 }))

    await expect(
      managerFor(store, mockFetch as unknown as typeof fetch).getAccessToken(),
    ).rejects.toThrow(MsGraphTokenError)
    expect(store.persisted).toHaveLength(0)
  })

  // ── Concurrency ────────────────────────────────────────────

  it('coalesces concurrent refreshes into one token request', async () => {
    // Graph refresh tokens are single-use. Two parallel refreshes would send
    // the SAME refresh_token twice and the loser comes back invalid_grant, so
    // the manager must share one in-flight refresh.
    const store = memoryStore(staleTokens())
    mockFetch.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(jsonResponse(ROTATED)), 5)),
    )
    const tm = managerFor(store, mockFetch as unknown as typeof fetch)

    const results = await Promise.all([tm.getAccessToken(), tm.getAccessToken(), tm.getAccessToken()])

    expect(results).toEqual(['access_v2', 'access_v2', 'access_v2'])
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(store.persisted).toHaveLength(1)
  })

  it('does not cache a failed refresh — a later call retries', async () => {
    const store = memoryStore(staleTokens())
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ error: 'temporarily_unavailable' }, 503))
      .mockResolvedValueOnce(jsonResponse(ROTATED))
    const tm = managerFor(store, mockFetch as unknown as typeof fetch)

    await expect(tm.getAccessToken()).rejects.toThrow(MsGraphTokenError)
    expect(await tm.getAccessToken()).toBe('access_v2')
  })

  // ── Failure classification ─────────────────────────────────

  it('surfaces invalid_grant distinguishably so the caller can mark auth_failed', async () => {
    const store = memoryStore(staleTokens())
    mockFetch.mockResolvedValue(
      jsonResponse(
        {
          error: 'invalid_grant',
          error_description: 'AADSTS700082: The refresh token has expired due to inactivity.',
        },
        400,
      ),
    )

    const err = await managerFor(store, mockFetch as unknown as typeof fetch)
      .getAccessToken()
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(MsGraphTokenError)
    expect((err as MsGraphTokenError).isInvalidGrant).toBe(true)
    // The repo-wide classifier reads the flattened MESSAGE, so the code has to
    // survive into it (mcp/connector-health.ts CREDENTIAL_DEAD_SIGNALS).
    expect(classifyConnectorAuthError(err)).toBe(true)
  })

  it('does not mark a transient token-endpoint failure as invalid_grant', async () => {
    const store = memoryStore(staleTokens())
    mockFetch.mockResolvedValue(jsonResponse({ error: 'temporarily_unavailable' }, 503))

    const err = await managerFor(store, mockFetch as unknown as typeof fetch)
      .getAccessToken()
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(MsGraphTokenError)
    expect((err as MsGraphTokenError).isInvalidGrant).toBe(false)
    expect(classifyConnectorAuthError(err)).toBe(false)
  })

  it('throws a not-connected error when the store holds no tokens', async () => {
    const tm = managerFor(memoryStore(null), mockFetch as unknown as typeof fetch)
    await expect(tm.getAccessToken()).rejects.toThrow(/not connected/i)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  // ── Authorization-code exchange ────────────────────────────

  it('exchangeMsGraphAuthorizationCode posts the authorization_code grant', async () => {
    mockFetch.mockResolvedValue(jsonResponse(ROTATED))

    const tokens = await exchangeMsGraphAuthorizationCode({
      code: 'auth_code_xyz',
      clientId: 'cid',
      clientSecret: 'csec',
      redirectUri: 'https://example.com/cb',
      scope: 'offline_access Chat.Read',
      fetchImpl: mockFetch as unknown as typeof fetch,
      now: () => CLOCK,
    })

    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
    )
    const body = formOf(mockFetch.mock.calls[0])
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('auth_code_xyz')
    expect(body.get('redirect_uri')).toBe('https://example.com/cb')
    expect(body.get('scope')).toBe('offline_access Chat.Read')
    expect(tokens).toEqual({
      accessToken: 'access_v2',
      refreshToken: 'refresh_v2',
      expiresAt: new Date(CLOCK + 3599_000).toISOString(),
    })
  })

  it('exchangeMsGraphAuthorizationCode rejects a grant with no refresh token', async () => {
    // No refresh token means `offline_access` was not consented — the
    // connection would die at the first access-token expiry, so fail loudly at
    // connect time instead.
    mockFetch.mockResolvedValue(jsonResponse({ access_token: 'a', expires_in: 3599 }))

    await expect(
      exchangeMsGraphAuthorizationCode({
        code: 'c',
        clientId: 'cid',
        clientSecret: 'csec',
        redirectUri: 'https://example.com/cb',
        fetchImpl: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/refresh token/i)
  })

  // ── Envelope contract with the OAuth callback ──────────────
  //
  // `/api/auth/callback/msgraph` writes THIS envelope via `store-credentials`,
  // including a `tenantId` decoded from the id_token `tid` claim. A field the
  // callback writes and this module does not handle is DESTROYED on the first
  // refresh, not merely ignored.

  it('preserves the callback-written tenantId across a rotation', async () => {
    const store = memoryStore(staleTokens({ tenantId: 'contoso-tid' }))
    mockFetch.mockResolvedValue(jsonResponse(ROTATED))

    await managerFor(store, mockFetch as unknown as typeof fetch).getAccessToken()

    // The refresh response never echoes tenantId, so persisting the response
    // alone would silently erase it — leaving it present for freshly connected
    // users and absent for everyone else, the worst shape a missing field has.
    expect(store.persisted[0].tenantId).toBe('contoso-tid')
    expect(store.current?.tenantId).toBe('contoso-tid')
  })

  it('survives a rotation through the real pack/unpack envelope', async () => {
    // Round-trips the way production does: unpack → refresh → pack.
    let blob = packMsGraphTokens(staleTokens({ tenantId: 'contoso-tid' }))
    const store: MsGraphTokenStore = {
      getTokens: async () => unpackMsGraphTokens(blob),
      persistTokens: async (t) => {
        blob = packMsGraphTokens(t)
      },
    }
    mockFetch.mockResolvedValue(jsonResponse(ROTATED))

    await managerFor(store, mockFetch as unknown as typeof fetch).getAccessToken()

    expect(JSON.parse(blob)).toMatchObject({
      accessToken: 'access_v2',
      refreshToken: 'refresh_v2',
      tenantId: 'contoso-tid',
    })
  })

  it('omits tenantId when the tenant did not grant openid', () => {
    expect('tenantId' in JSON.parse(packMsGraphTokens(liveTokens()))).toBe(false)
    expect(unpackMsGraphTokens(packMsGraphTokens(liveTokens()))?.tenantId).toBeUndefined()
  })

  // ── Envelope helpers ───────────────────────────────────────

  it('packs and unpacks the credentials envelope round-trip', () => {
    const tokens = liveTokens({ tenantId: 'contoso-tid' })
    expect(unpackMsGraphTokens(packMsGraphTokens(tokens))).toEqual(tokens)
  })

  it('unpacks a malformed or partial envelope as null', () => {
    expect(unpackMsGraphTokens('not json')).toBeNull()
    expect(unpackMsGraphTokens(JSON.stringify({ accessToken: 'a' }))).toBeNull()
    expect(unpackMsGraphTokens(JSON.stringify({ accessToken: 'a', refreshToken: 'b' }))).toBeNull()
  })
})
