/**
 * Unit tests for the X (Twitter) API v2 client.
 * Component tags: [COMP:feed/voice-import-tool], [COMP:feed/inspiration-tools].
 *
 * Mocks global `fetch`. Verifies twitterFetch error mapping +
 * TwitterApiError.isAuthError, the OAuth token exchange/refresh form +
 * Basic auth, createTweet's pre-flight validation, listReplies'
 * parent-strip, listOwnTweets' pagination + clamp + over-fetch trim,
 * and the inspiration reads (home timeline / list / recent search).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  TwitterApiError,
  exchangeCodeForToken,
  refreshAccessToken,
  getAuthenticatedProfile,
  createTweet,
  deleteTweet,
  listReplies,
  listMentions,
  listOwnTweets,
  listHomeTimeline,
  listFromList,
  searchRecent,
  getTweetWithAuthor,
  listQuotes,
} from '../client.js'

const mockFetch = vi.fn()

function ok(data: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(data) }
}
function fail(status: number, body: unknown) {
  return {
    ok: false,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}
function tweets(n: number, prefix = 't') {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }))
}

const TOKEN = {
  token_type: 'bearer',
  access_token: 'AT',
  refresh_token: 'RT',
  expires_in: 7200,
  scope: 'tweet.read offline.access',
}

beforeEach(() => {
  mockFetch.mockReset()
  vi.stubGlobal('fetch', mockFetch)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('[COMP:feed/inspiration-tools] twitterFetch error mapping + OAuth', () => {
  it('maps a non-OK response to a TwitterApiError carrying the status', async () => {
    mockFetch.mockResolvedValueOnce(fail(401, { title: 'Unauthorized' }))
    await expect(getAuthenticatedProfile('AT')).rejects.toMatchObject({
      name: 'TwitterApiError',
      status: 401,
    })
  })

  it('TwitterApiError.isAuthError is true for 401/403 and false otherwise', () => {
    expect(new TwitterApiError(401, 'x', null).isAuthError).toBe(true)
    expect(new TwitterApiError(403, 'x', null).isAuthError).toBe(true)
    expect(new TwitterApiError(500, 'x', null).isAuthError).toBe(false)
  })

  it('prefers error_description over other error fields in the message', async () => {
    mockFetch.mockResolvedValueOnce(fail(400, { error_description: 'bad grant', detail: 'ignored' }))
    await expect(getAuthenticatedProfile('AT')).rejects.toThrow(/bad grant/)
  })

  it('exchangeCodeForToken posts the auth-code form with Basic client auth', async () => {
    mockFetch.mockResolvedValueOnce(ok(TOKEN))
    const out = await exchangeCodeForToken({
      clientId: 'cid',
      clientSecret: 'csecret',
      redirectUri: 'https://app/cb',
      code: 'CODE',
      codeVerifier: 'VERIFIER',
    })
    expect(out.access_token).toBe('AT')
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.x.com/2/oauth2/token')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toMatch(/^Basic /)
    expect(init.body).toContain('grant_type=authorization_code')
    expect(init.body).toContain('code_verifier=VERIFIER')
  })

  it('refreshAccessToken posts a refresh_token grant', async () => {
    mockFetch.mockResolvedValueOnce(ok(TOKEN))
    await refreshAccessToken({ clientId: 'cid', clientSecret: 'csecret', refreshToken: 'RT' })
    expect(mockFetch.mock.calls[0][1].body).toContain('grant_type=refresh_token')
  })
})

describe('[COMP:feed/inspiration-tools] tweet endpoints', () => {
  it('createTweet rejects empty and over-length text before any network call', async () => {
    await expect(createTweet({ accessToken: 'AT', tweet: { text: '' } })).rejects.toThrow(
      /text is required/,
    )
    await expect(
      createTweet({ accessToken: 'AT', tweet: { text: 'x'.repeat(281) } }),
    ).rejects.toThrow(/exceeds 280/)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('createTweet rejects more than four media attachments', async () => {
    await expect(
      createTweet({ accessToken: 'AT', tweet: { text: 'hi', mediaIds: ['1', '2', '3', '4', '5'] } }),
    ).rejects.toThrow(/at most 4 media/)
  })

  it('createTweet returns the new tweet id on success', async () => {
    mockFetch.mockResolvedValueOnce(ok({ data: { id: 't-new' } }))
    expect(await createTweet({ accessToken: 'AT', tweet: { text: 'hello' } })).toBe('t-new')
  })

  it('deleteTweet throws when the API reports deleted=false', async () => {
    mockFetch.mockResolvedValueOnce(ok({ data: { deleted: false } }))
    await expect(deleteTweet({ accessToken: 'AT', tweetId: 't-1' })).rejects.toThrow(/deleted=false/)
  })

  it('listReplies strips the parent tweet and requests author expansion', async () => {
    mockFetch.mockResolvedValueOnce(
      ok({ data: [{ id: 'parent' }, { id: 'r1' }, { id: 'r2' }] }),
    )
    const out = await listReplies({ accessToken: 'AT', tweetId: 'parent' })
    expect(out.data?.map((t) => t.id)).toEqual(['r1', 'r2'])
    const url = new URL(mockFetch.mock.calls[0][0] as string)
    expect(url.searchParams.get('expansions')).toBe('author_id')
    expect(url.searchParams.get('user.fields')).toContain('username')
  })

  it('listMentions requests author expansion and parses includes.users into the handle map', async () => {
    mockFetch.mockResolvedValueOnce(
      ok({
        data: [{ id: '500', text: '@acct hi', author_id: '900' }],
        includes: { users: [{ id: '900', username: 'alice', name: 'Alice' }] },
      }),
    )
    const out = await listMentions({ accessToken: 'AT', userId: 'u-1' })
    const url = new URL(mockFetch.mock.calls[0][0] as string)
    expect(url.pathname).toBe('/2/users/u-1/mentions')
    expect(url.searchParams.get('expansions')).toBe('author_id')
    expect(url.searchParams.get('user.fields')).toContain('username')
    expect(out.includes?.users?.[0]?.username).toBe('alice')
  })
})

describe('[COMP:feed/voice-import-tool] listOwnTweets', () => {
  it('paginates across next_token and trims the over-fetch to the target', async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ data: tweets(100, 'a'), meta: { next_token: 'p2' } }))
      .mockResolvedValueOnce(ok({ data: tweets(60, 'b') })) // no next_token → stop
    const out = await listOwnTweets({ accessToken: 'AT', userId: 'u-1', limit: 150 })
    expect(out.data).toHaveLength(150)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch.mock.calls[1][0]).toContain('pagination_token=p2')
  })

  it('clamps the limit up to the floor of 10', async () => {
    mockFetch.mockResolvedValueOnce(ok({ data: tweets(10) }))
    await listOwnTweets({ accessToken: 'AT', userId: 'u-1', limit: 3 })
    expect(mockFetch.mock.calls[0][0]).toContain('max_results=10')
  })

  it('stops after one page when the API returns no next_token', async () => {
    mockFetch.mockResolvedValueOnce(ok({ data: tweets(40) }))
    const out = await listOwnTweets({ accessToken: 'AT', userId: 'u-1', limit: 200 })
    expect(out.data).toHaveLength(40)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

describe('[COMP:feed/inspiration-tools] inspiration reads', () => {
  it('listHomeTimeline hits the reverse_chronological endpoint with a clamped max', async () => {
    mockFetch.mockResolvedValueOnce(ok({ data: tweets(5) }))
    await listHomeTimeline({ accessToken: 'AT', userId: 'u-1', max: 999 })
    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('/timelines/reverse_chronological')
    expect(url).toContain('max_results=100')
  })

  it('listFromList reads the list-tweets endpoint for the given list id', async () => {
    mockFetch.mockResolvedValueOnce(ok({ data: [] }))
    await listFromList({ accessToken: 'AT', listId: 'L-9', max: 30 })
    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('/2/lists/L-9/tweets')
    expect(url).toContain('max_results=30')
  })

  it('searchRecent passes the operator query through to recent search', async () => {
    mockFetch.mockResolvedValueOnce(ok({ data: [] }))
    await searchRecent({ accessToken: 'AT', query: 'lang:en -is:retweet ai' })
    const url = new URL(mockFetch.mock.calls[0][0] as string)
    expect(url.pathname).toBe('/2/tweets/search/recent')
    expect(url.searchParams.get('query')).toBe('lang:en -is:retweet ai')
  })

  it('listQuotes hits the quote_tweets endpoint with author expansion and parses data', async () => {
    mockFetch.mockResolvedValueOnce(
      ok({
        data: [{ id: 'q1', text: 'quoting you', author_id: '42', created_at: '2026-05-28T00:00:00Z' }],
        meta: { result_count: 1 },
      }),
    )
    const out = await listQuotes({ accessToken: 'AT', tweetId: '999', max: 25 })
    const url = new URL(mockFetch.mock.calls[0][0] as string)
    expect(url.pathname).toBe('/2/tweets/999/quote_tweets')
    expect(url.searchParams.get('expansions')).toBe('author_id')
    expect(url.searchParams.get('max_results')).toBe('25')
    expect(out.data?.[0]?.id).toBe('q1')
  })
})

describe('[COMP:feed/inspiration-tools] getTweetWithAuthor', () => {
  it('requests author_id expansion + user.fields and returns tweet + author', async () => {
    mockFetch.mockResolvedValueOnce(
      ok({
        data: {
          id: '123',
          text: 'hello world',
          author_id: 'u1',
          created_at: '2026-05-20T10:00:00.000Z',
          public_metrics: { like_count: 5, reply_count: 2, retweet_count: 1, quote_count: 0 },
        },
        includes: {
          users: [
            { id: 'u1', username: 'elonmusk', name: 'Elon', profile_image_url: 'https://pbs/x.jpg' },
          ],
        },
      }),
    )

    const result = await getTweetWithAuthor({ accessToken: 'AT', tweetId: '123' })

    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('/2/tweets/123')
    expect(url).toContain('expansions=author_id')
    expect(url).toContain('user.fields=')
    expect(result.tweet.text).toBe('hello world')
    expect(result.author?.username).toBe('elonmusk')
    expect(result.author?.profile_image_url).toBe('https://pbs/x.jpg')
  })

  it('returns author=null when includes is absent', async () => {
    mockFetch.mockResolvedValueOnce(ok({ data: { id: '123', text: 'no author block' } }))
    const result = await getTweetWithAuthor({ accessToken: 'AT', tweetId: '123' })
    expect(result.author).toBeNull()
    expect(result.tweet.id).toBe('123')
  })

  it('propagates a TwitterApiError on a non-OK response', async () => {
    mockFetch.mockResolvedValueOnce(fail(404, { title: 'Not Found Error', detail: 'gone' }))
    await expect(getTweetWithAuthor({ accessToken: 'AT', tweetId: '123' })).rejects.toBeInstanceOf(
      TwitterApiError,
    )
  })
})
