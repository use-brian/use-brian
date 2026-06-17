import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPost, listOwnPosts, listProfilePosts } from '../threads/client.js'

describe('[COMP:feed/threads-client] URL-paste reply listings', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch').mockReset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('listOwnPosts hits /v1.0/{userId}/threads with shortcode field + since/until window', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: '17841440000000099', shortcode: 'DX4FjS5Gl5x' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    const result = await listOwnPosts({
      accessToken: 'tok',
      userId: 'user-123',
      since: 1_700_000_000,
      until: 1_700_086_400,
      limit: 100,
    })
    expect(result.data).toHaveLength(1)
    const callUrl = (fetchSpy.mock.calls[0][0] as string | URL).toString()
    expect(callUrl).toContain('/v1.0/user-123/threads')
    expect(callUrl).toContain('fields=')
    // The fields query string must include shortcode + permalink so the resolver
    // can match against the URL it was given.
    const url = new URL(callUrl)
    const fields = url.searchParams.get('fields') ?? ''
    expect(fields.split(',')).toEqual(
      expect.arrayContaining(['id', 'shortcode', 'permalink']),
    )
    expect(url.searchParams.get('since')).toBe('1700000000')
    expect(url.searchParams.get('until')).toBe('1700086400')
    expect(url.searchParams.get('limit')).toBe('100')
  })

  it('listProfilePosts hits /v1.0/profile_posts with `username` query param', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await listProfilePosts({
      accessToken: 'tok',
      username: 'someone',
      since: 100,
      until: 200,
      limit: 50,
    })
    const callUrl = (fetchSpy.mock.calls[0][0] as string | URL).toString()
    expect(callUrl).toContain('/v1.0/profile_posts')
    const url = new URL(callUrl)
    expect(url.searchParams.get('username')).toBe('someone')
    expect(url.searchParams.get('since')).toBe('100')
    expect(url.searchParams.get('until')).toBe('200')
    expect(url.searchParams.get('limit')).toBe('50')
  })

  it('listOwnPosts omits since/until when not provided', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await listOwnPosts({ accessToken: 'tok', userId: 'u' })
    const callUrl = (fetchSpy.mock.calls[0][0] as string | URL).toString()
    const url = new URL(callUrl)
    expect(url.searchParams.has('since')).toBe(false)
    expect(url.searchParams.has('until')).toBe(false)
    expect(url.searchParams.has('limit')).toBe(false)
  })

  it('listProfilePosts surfaces ThreadsApiError on non-2xx responses', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: 'Application does not have permission for this action',
            code: 10,
          },
        }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      ),
    )
    await expect(
      listProfilePosts({ accessToken: 'tok', username: 'someone' }),
    ).rejects.toThrow(/Application does not have permission/)
  })
})

describe('[COMP:feed/threads-client] createPost spoilers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(global, 'fetch').mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  it('forwards is_spoiler_media and text_entities on IMAGE container creation', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'container-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'published-99' }))

    const promise = createPost({
      userId: 'u',
      accessToken: 'tok',
      post: {
        mediaType: 'IMAGE',
        text: 'sneak peek behind a spoiler',
        imageUrl: 'https://img/1.jpg',
        isSpoilerMedia: true,
        textSpoilers: [
          { offset: 0, length: 10 },
          { offset: 12, length: 6 },
        ],
      },
    })
    // The 2s post-container sleep for media posts must not block the test.
    await vi.runAllTimersAsync()
    const publishedId = await promise
    expect(publishedId).toBe('published-99')

    const containerBody = (fetchSpy.mock.calls[0][1] as RequestInit).body as string
    const params = new URLSearchParams(containerBody)
    expect(params.get('media_type')).toBe('IMAGE')
    expect(params.get('is_spoiler_media')).toBe('true')
    const entities = JSON.parse(params.get('text_entities') ?? '[]')
    expect(entities).toEqual([
      { entity_type: 'SPOILER', offset: 0, length: 10 },
      { entity_type: 'SPOILER', offset: 12, length: 6 },
    ])
  })

  it('omits spoiler params when not provided', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'container-2' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'published-100' }))

    const promise = createPost({
      userId: 'u',
      accessToken: 'tok',
      post: { mediaType: 'TEXT', text: 'plain post' },
    })
    await vi.runAllTimersAsync()
    await promise

    const containerBody = (fetchSpy.mock.calls[0][1] as RequestInit).body as string
    const params = new URLSearchParams(containerBody)
    expect(params.has('is_spoiler_media')).toBe(false)
    expect(params.has('text_entities')).toBe(false)
  })

  it('sets is_spoiler_media on the parent CAROUSEL container only — children inherit', async () => {
    // Two child containers + one parent container + one publish call = 4 fetches.
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'child-a' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'child-b' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'parent-1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'published-200' }))

    const promise = createPost({
      userId: 'u',
      accessToken: 'tok',
      post: {
        mediaType: 'CAROUSEL',
        text: 'photo dump',
        children: [
          { mediaType: 'IMAGE', imageUrl: 'https://img/1.jpg' },
          { mediaType: 'IMAGE', imageUrl: 'https://img/2.jpg' },
        ],
        isSpoilerMedia: true,
      },
    })
    await vi.runAllTimersAsync()
    await promise

    // Children are the first two requests; neither should opt in individually.
    for (const i of [0, 1]) {
      const childBody = (fetchSpy.mock.calls[i][1] as RequestInit).body as string
      const childParams = new URLSearchParams(childBody)
      expect(childParams.get('is_carousel_item')).toBe('true')
      expect(childParams.has('is_spoiler_media')).toBe(false)
    }
    // The third request is the parent — it carries the spoiler flag.
    const parentBody = (fetchSpy.mock.calls[2][1] as RequestInit).body as string
    const parentParams = new URLSearchParams(parentBody)
    expect(parentParams.get('media_type')).toBe('CAROUSEL')
    expect(parentParams.get('is_spoiler_media')).toBe('true')
  })
})

describe('[COMP:feed/threads-client] createPost topic_tag', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(global, 'fetch').mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  it('forwards topic_tag on TEXT container creation', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'container-tt' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'published-tt' }))

    const promise = createPost({
      userId: 'u',
      accessToken: 'tok',
      post: { mediaType: 'TEXT', text: 'on housing', topicTag: 'HousingHK' },
    })
    await vi.runAllTimersAsync()
    await promise

    const body = (fetchSpy.mock.calls[0][1] as RequestInit).body as string
    const params = new URLSearchParams(body)
    expect(params.get('topic_tag')).toBe('HousingHK')
  })

  it('omits topic_tag when not provided', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'c-no-tag' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'p-no-tag' }))
    const promise = createPost({
      userId: 'u',
      accessToken: 'tok',
      post: { mediaType: 'TEXT', text: 'plain' },
    })
    await vi.runAllTimersAsync()
    await promise
    const body = (fetchSpy.mock.calls[0][1] as RequestInit).body as string
    expect(new URLSearchParams(body).has('topic_tag')).toBe(false)
  })

  it('treats whitespace-only topicTag as omitted (no API rejection for empty tag)', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ id: 'c-ws' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'p-ws' }))
    const promise = createPost({
      userId: 'u',
      accessToken: 'tok',
      post: { mediaType: 'TEXT', text: 'plain', topicTag: '   ' },
    })
    await vi.runAllTimersAsync()
    await promise
    const body = (fetchSpy.mock.calls[0][1] as RequestInit).body as string
    expect(new URLSearchParams(body).has('topic_tag')).toBe(false)
  })

  it('rejects topic_tag containing `.` or `&` before the API call (Meta docs forbid these)', async () => {
    // Should throw before any network call goes out.
    const fetchSpy = vi.spyOn(global, 'fetch')
    await expect(
      createPost({
        userId: 'u',
        accessToken: 'tok',
        post: { mediaType: 'TEXT', text: 'x', topicTag: 'a.b' },
      }),
    ).rejects.toThrow(/`\.` or `&`/)
    await expect(
      createPost({
        userId: 'u',
        accessToken: 'tok',
        post: { mediaType: 'TEXT', text: 'x', topicTag: 'a&b' },
      }),
    ).rejects.toThrow(/`\.` or `&`/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects topic_tag longer than 50 chars before the API call', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    const tooLong = 'a'.repeat(51)
    await expect(
      createPost({
        userId: 'u',
        accessToken: 'tok',
        post: { mediaType: 'TEXT', text: 'x', topicTag: tooLong },
      }),
    ).rejects.toThrow(/50 characters or less/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
