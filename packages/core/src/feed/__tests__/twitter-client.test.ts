import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  buildAuthorizeUrl as buildTwitterAuthorizeUrl,
  SCOPES as TWITTER_SCOPES,
} from '../twitter/oauth.js'
import {
  createTweet,
  deleteTweet,
  getAuthenticatedProfile,
  exchangeCodeForToken,
  refreshAccessToken,
  listReplies as twitterListReplies,
  TwitterApiError,
} from '../twitter/client.js'

describe('[COMP:feed/twitter-client] buildAuthorizeUrl', () => {
  it('includes all PKCE and scope parameters on x.com', () => {
    const url = new URL(
      buildTwitterAuthorizeUrl({
        clientId: 'cid',
        redirectUri: 'https://example.com/cb',
        state: 'signedstate',
        codeChallenge: 'chal',
      }),
    )
    expect(url.hostname).toBe('x.com')
    expect(url.pathname).toBe('/i/oauth2/authorize')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.com/cb')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('state')).toBe('signedstate')
    expect(url.searchParams.get('code_challenge')).toBe('chal')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toBe(TWITTER_SCOPES.join(' '))
  })

  it('includes offline.access in the scope list (refresh token prerequisite)', () => {
    expect(TWITTER_SCOPES).toContain('offline.access')
  })
})

// Each describe spins up its own fetch mock — we avoid global mocks so tests
// don't leak between blocks.
function mockFetch(response: {
  ok?: boolean
  status?: number
  body: unknown
}) {
  // Narrow init to non-optional so destructures in tests don't need `!`.
  // The SUT always passes both url and init; anything else is a test bug.
  return vi.fn(async (_url: string, _init: RequestInit) => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    text: async () =>
      typeof response.body === 'string' ? response.body : JSON.stringify(response.body),
  }))
}

describe('[COMP:feed/twitter-client] OAuth token exchange', () => {
  const origFetch = global.fetch
  beforeEach(() => {
    // noop
  })
  afterEach(() => {
    global.fetch = origFetch
  })

  it('exchanges code for access+refresh tokens with basic-auth header and code_verifier', async () => {
    const fetchMock = mockFetch({
      body: {
        token_type: 'bearer',
        access_token: 'access123',
        refresh_token: 'refresh123',
        expires_in: 7200,
        scope: 'tweet.read tweet.write offline.access',
      },
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const tokens = await exchangeCodeForToken({
      clientId: 'cid',
      clientSecret: 'csecret',
      redirectUri: 'https://example.com/cb',
      code: 'auth-code',
      codeVerifier: 'verifier-xyz',
    })

    expect(tokens.access_token).toBe('access123')
    expect(tokens.refresh_token).toBe('refresh123')
    expect(tokens.expires_in).toBe(7200)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toContain('/2/oauth2/token')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toMatch(/^Basic /)
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('cid:csecret').toString('base64')}`,
    )
    const bodyStr = init.body as string
    expect(bodyStr).toContain('grant_type=authorization_code')
    expect(bodyStr).toContain('code=auth-code')
    expect(bodyStr).toContain('code_verifier=verifier-xyz')
  })

  it('refreshes tokens using grant_type=refresh_token', async () => {
    const fetchMock = mockFetch({
      body: {
        token_type: 'bearer',
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 7200,
        scope: 'tweet.read tweet.write offline.access',
      },
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const out = await refreshAccessToken({
      clientId: 'cid',
      clientSecret: 'csecret',
      refreshToken: 'old-refresh',
    })
    expect(out.access_token).toBe('new-access')
    expect(out.refresh_token).toBe('new-refresh')
    const init = fetchMock.mock.calls[0]![1]
    const body = init.body as string
    expect(body).toContain('grant_type=refresh_token')
    expect(body).toContain('refresh_token=old-refresh')
  })
})

describe('[COMP:feed/twitter-client] Tweet surface', () => {
  const origFetch = global.fetch
  afterEach(() => {
    global.fetch = origFetch
  })

  it('createTweet POSTs text and returns the created id', async () => {
    const fetchMock = mockFetch({ body: { data: { id: '42', text: 'hello' } } })
    global.fetch = fetchMock as unknown as typeof fetch
    const id = await createTweet({ accessToken: 'tok', tweet: { text: 'hello' } })
    expect(id).toBe('42')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.x.com/2/tweets')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(JSON.parse(init.body as string)).toEqual({ text: 'hello' })
  })

  it('createTweet rejects empty text before any network call', async () => {
    global.fetch = vi.fn() as unknown as typeof fetch
    await expect(
      createTweet({ accessToken: 'tok', tweet: { text: '' } }),
    ).rejects.toBeInstanceOf(TwitterApiError)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('createTweet rejects >280 chars before any network call', async () => {
    global.fetch = vi.fn() as unknown as typeof fetch
    await expect(
      createTweet({ accessToken: 'tok', tweet: { text: 'x'.repeat(281) } }),
    ).rejects.toBeInstanceOf(TwitterApiError)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('deleteTweet surfaces a failure when API returns deleted=false', async () => {
    const fetchMock = mockFetch({ body: { data: { deleted: false } } })
    global.fetch = fetchMock as unknown as typeof fetch
    await expect(
      deleteTweet({ accessToken: 'tok', tweetId: 'abc' }),
    ).rejects.toBeInstanceOf(TwitterApiError)
  })

  it('getAuthenticatedProfile parses the /users/me response', async () => {
    const fetchMock = mockFetch({
      body: { data: { id: '123', username: 'sidanclaw', name: 'sidanclaw' } },
    })
    global.fetch = fetchMock as unknown as typeof fetch
    const p = await getAuthenticatedProfile('tok')
    expect(p.id).toBe('123')
    expect(p.username).toBe('sidanclaw')
  })

  it('listReplies strips the parent conversation tweet from results', async () => {
    const fetchMock = mockFetch({
      body: {
        data: [
          { id: 'root', text: 'parent tweet' },
          { id: 'r1', text: 'reply 1' },
          { id: 'r2', text: 'reply 2' },
        ],
      },
    })
    global.fetch = fetchMock as unknown as typeof fetch
    const resp = await twitterListReplies({ accessToken: 'tok', tweetId: 'root' })
    expect(resp.data?.map((t) => t.id)).toEqual(['r1', 'r2'])
  })

  it('surfaces HTTP errors as TwitterApiError with status + message', async () => {
    const fetchMock = mockFetch({
      ok: false,
      status: 401,
      body: { title: 'Unauthorized', detail: 'token expired' },
    })
    global.fetch = fetchMock as unknown as typeof fetch
    try {
      await getAuthenticatedProfile('bad')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(TwitterApiError)
      if (err instanceof TwitterApiError) {
        expect(err.status).toBe(401)
        expect(err.isAuthError).toBe(true)
        expect(err.message).toContain('token expired')
      }
    }
  })
})
