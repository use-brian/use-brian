/**
 * Unit tests for the Microsoft Graph read-only client.
 * Component tag: [COMP:msgraph/client].
 *
 * The client is transport only: auth, pagination, query building, errors. It
 * returns RAW Graph JSON — projection belongs to the core tool layer
 * (`packages/core/src/tools/base/msgraph.ts`), matching notion/client.ts.
 *
 * `fetchImpl` is injected, so no test touches the network. Every fixture is a
 * hand-written literal modelled on the response shapes printed in the Graph
 * v1.0 reference pages cited by
 * docs/research/external/microsoft-teams-connector-2026.md §2 / §A.2.
 */

import { describe, it, expect } from 'vitest'
import { createMsGraphClient, MsGraphAuthError, MsGraphError } from '../client.js'
import { classifyConnectorAuthError } from '../../mcp/connector-health.js'

const TEAM_ID = '172b0cce-e65d-44ce-9a49-91d9f2e8593a'

type FetchCall = { url: string; init: RequestInit | undefined }

/** A fetchImpl that replays `pages` in order and records what it was asked. */
function fakeFetch(pages: unknown[], calls: FetchCall[]): typeof fetch {
  const queue = [...pages]
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify(queue.shift()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
}

/** A fetchImpl that always answers with one Graph error response. */
function fakeErrorFetch(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    })) as typeof fetch
}

// GET /teams/{id}/channels — verbatim shape from the channel-list reference
// example, noise fields included: they must survive the round trip untouched.
const CHANNEL_ROW = {
  '@odata.etag': 'W/"eyJvZGF0YS5ldGFnIjoiVy9cIjEwXCIifQ=="',
  id: '19:09fc54a3141a45d0bc769cf506d2e079@thread.skype',
  createdDateTime: '2020-05-27T19:22:25.692Z',
  displayName: 'Engineering',
  description: 'Where the platform team argues',
  isFavoriteByDefault: null,
  email: '',
  webUrl:
    'https://teams.microsoft.com/l/channel/19%3a09fc54a3141a45d0bc769cf506d2e079%40thread.skype/Engineering',
  membershipType: 'standard',
}

describe('[COMP:msgraph/client] Microsoft Graph client', () => {
  it('sends a bearer token and returns the raw Graph rows unchanged', async () => {
    const calls: FetchCall[] = []
    const client = createMsGraphClient({
      getAccessToken: async () => 'tok-abc',
      fetchImpl: fakeFetch(
        [
          {
            '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#channels',
            value: [CHANNEL_ROW],
          },
        ],
        calls,
      ),
    })

    const body = await client.listChannels({ teamId: TEAM_ID })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`https://graph.microsoft.com/v1.0/teams/${TEAM_ID}/channels`)
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe('Bearer tok-abc')
    // Nothing mapped, nothing dropped — including `email: ''` and the nulls.
    expect(body).toEqual({ value: [CHANNEL_ROW] })
  })

  it('follows @odata.nextLink verbatim and concatenates every page', async () => {
    // The skiptoken is opaque — a client that rebuilds the next page instead of
    // following the link it was handed cannot produce this exact request.
    const NEXT_LINK =
      'https://graph.microsoft.com/v1.0/teams/172b0cce-e65d-44ce-9a49-91d9f2e8593a/channels?$skiptoken=RFNQVENvbnRpbnVhdGlvblRva2Vu'
    const page1 = {
      '@odata.nextLink': NEXT_LINK,
      value: [{ id: '19:page-one@thread.tacv2', displayName: 'Engineering' }],
    }
    const page2 = { value: [{ id: '19:page-two@thread.tacv2', displayName: 'Design' }] }

    const calls: FetchCall[] = []
    const client = createMsGraphClient({
      getAccessToken: async () => 'tok-abc',
      fetchImpl: fakeFetch([page1, page2], calls),
    })

    const body = await client.listChannels({ teamId: TEAM_ID })

    expect(calls.map((c) => c.url)).toEqual([
      `https://graph.microsoft.com/v1.0/teams/${TEAM_ID}/channels`,
      NEXT_LINK,
    ])
    expect(body).toEqual({
      value: [
        { id: '19:page-one@thread.tacv2', displayName: 'Engineering' },
        { id: '19:page-two@thread.tacv2', displayName: 'Design' },
      ],
    })
  })

  it('throws a typed MsGraphAuthError on 401 that connector-health classifies as a dead credential', async () => {
    const client = createMsGraphClient({
      getAccessToken: async () => 'tok-expired',
      fetchImpl: fakeErrorFetch(401, {
        error: {
          code: 'InvalidAuthenticationToken',
          message: 'Access token has expired or is not yet valid.',
          innerError: { date: '2026-07-23T04:00:00', 'request-id': 'a1b2c3' },
        },
      }),
    })

    const err = await client.listChannels({ teamId: TEAM_ID }).then(
      () => null,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(MsGraphAuthError)
    expect((err as MsGraphAuthError).status).toBe(401)
    // The caller flips connector_instance to `auth_failed` off this signal, so
    // the message must also satisfy the repo-wide string classifier.
    expect(classifyConnectorAuthError(err)).toBe(true)
  })

  it('throws a generic MsGraphError carrying the status on a non-401 failure', async () => {
    const client = createMsGraphClient({
      getAccessToken: async () => 'tok-abc',
      fetchImpl: fakeErrorFetch(403, {
        error: {
          code: 'Forbidden',
          message: 'Insufficient privileges to complete the operation.',
        },
      }),
    })

    const err = await client.listChannels({ teamId: TEAM_ID }).then(
      () => null,
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(MsGraphError)
    expect(err).not.toBeInstanceOf(MsGraphAuthError)
    expect((err as MsGraphError).status).toBe(403)
    // A 403 is a per-resource refusal, not a dead credential — it must never
    // flip the whole connector to auth_failed (connector-health.ts:89-92).
    expect(classifyConnectorAuthError(err)).toBe(false)
  })

  it('lists joined teams and matches search client-side, sending no OData params', async () => {
    // "This method doesn't currently support the OData query parameters" —
    // no $filter, no $select, no $top on /me/joinedTeams (research §2.1). So
    // both `search` and `limit` have to be applied in-process.
    const page = {
      value: [
        { id: TEAM_ID, displayName: 'Contoso Platform', description: 'Platform team', isArchived: false },
        { id: '8f8f8f8f-0000-0000-0000-000000000001', displayName: 'Design', description: null, isArchived: false },
        { id: '8f8f8f8f-0000-0000-0000-000000000002', displayName: 'Sales', description: null, isArchived: true },
      ],
    }

    const calls: FetchCall[] = []
    const client = createMsGraphClient({
      getAccessToken: async () => 'tok-abc',
      fetchImpl: fakeFetch([page], calls),
    })

    const body = await client.listTeams({ search: 'PLAT' })

    expect(calls[0]!.url).toBe('https://graph.microsoft.com/v1.0/me/joinedTeams')
    expect(body).toEqual({
      value: [
        {
          id: TEAM_ID,
          displayName: 'Contoso Platform',
          description: 'Platform team',
          isArchived: false,
        },
      ],
    })
  })

  it('reads channel messages with $top clamped to the documented ceiling of 50', async () => {
    const MESSAGE_ROW = {
      '@odata.etag': 'W/"eyJvZGF0YS5ldGFnIjoiMTYxNjk5MDAzMjAzNSJ9"',
      id: '1616990032035',
      replyToId: null,
      messageType: 'message',
      createdDateTime: '2021-03-29T03:53:52.035Z',
      subject: null,
      importance: 'normal',
      webUrl: 'https://teams.microsoft.com/l/message/19%3Aeng/1616990032035',
      from: {
        application: null,
        device: null,
        user: {
          id: '8ea0e38b-efb3-4757-924a-5f94061cf8c2',
          displayName: 'Robin Kline',
          userIdentityType: 'aadUser',
        },
      },
      body: {
        contentType: 'html',
        content: '<div>Deploy is green.</div><div>Ship it, <at id="0">Bob</at>?</div>',
      },
    }

    const calls: FetchCall[] = []
    const client = createMsGraphClient({
      getAccessToken: async () => 'tok-abc',
      fetchImpl: fakeFetch([{ value: [MESSAGE_ROW] }], calls),
    })

    const body = await client.listChannelMessages({
      teamId: TEAM_ID,
      channelId: '19:09fc54a3141a45d0bc769cf506d2e079@thread.skype',
      limit: 200,
    })

    expect(calls[0]!.url).toBe(
      `https://graph.microsoft.com/v1.0/teams/${TEAM_ID}` +
        '/channels/19%3A09fc54a3141a45d0bc769cf506d2e079%40thread.skype/messages?$top=50',
    )
    // The HTML body and the null-filled `from` envelope reach the tool layer
    // intact — this client strips nothing.
    expect(body).toEqual({ value: [MESSAGE_ROW] })
  })

  it('reads thread replies from the replies sub-collection', async () => {
    // Channel-message reads return root messages only; replies are a separate
    // collection, also capped at $top 50 (research §2.1).
    const REPLY_ROW = {
      id: '1616990032045',
      replyToId: '1616990032035',
      messageType: 'message',
      createdDateTime: '2021-03-29T04:01:11.000Z',
      body: { contentType: 'text', content: 'Shipping now.' },
    }

    const calls: FetchCall[] = []
    const client = createMsGraphClient({
      getAccessToken: async () => 'tok-abc',
      fetchImpl: fakeFetch([{ value: [REPLY_ROW] }], calls),
    })

    const body = await client.listMessageReplies({
      teamId: TEAM_ID,
      channelId: '19:eng@thread.tacv2',
      messageId: '1616990032035',
      limit: 10,
    })

    expect(calls[0]!.url).toBe(
      `https://graph.microsoft.com/v1.0/teams/${TEAM_ID}` +
        '/channels/19%3Aeng%40thread.tacv2/messages/1616990032035/replies?$top=10',
    )
    expect(body).toEqual({ value: [REPLY_ROW] })
  })

  it('expands members when listing chats, since a one-on-one chat has no topic', async () => {
    const CHAT_ROW = {
      id: '19:8b081ef6-4792-4def-b2c9-c363a1bf41d5_5031bb31@unq.gbl.spaces',
      topic: null,
      createdDateTime: '2020-12-04T23:10:28.51Z',
      lastUpdatedDateTime: '2020-12-04T23:10:36.925Z',
      chatType: 'oneOnOne',
      members: [
        {
          '@odata.type': '#microsoft.graph.aadUserConversationMember',
          id: 'MCMjMSMjZGNkMjE5ZGQ',
          roles: [],
          displayName: 'Adele Vance',
          userId: 'bc3c562a-3063-4a5a-80c7-a096e344a38f',
          email: 'AdeleV@contoso.com',
        },
      ],
    }

    const calls: FetchCall[] = []
    const client = createMsGraphClient({
      getAccessToken: async () => 'tok-abc',
      fetchImpl: fakeFetch([{ value: [CHAT_ROW] }], calls),
    })

    const body = await client.listChats({ limit: 80 })

    // $top caps at 50 for chats; $expand=members is what makes a topicless
    // one-on-one chat identifiable at all.
    expect(calls[0]!.url).toBe(
      'https://graph.microsoft.com/v1.0/me/chats?$expand=members&$top=50',
    )
    expect(body).toEqual({ value: [CHAT_ROW] })
  })

  it('reads chat messages by chat id', async () => {
    const calls: FetchCall[] = []
    const client = createMsGraphClient({
      getAccessToken: async () => 'tok-abc',
      fetchImpl: fakeFetch([{ value: [] }], calls),
    })

    await client.listChatMessages({
      chatId: '19:8b081ef6-4792-4def-b2c9-c363a1bf41d5_5031bb31@unq.gbl.spaces',
      limit: 20,
    })

    expect(calls[0]!.url).toBe(
      'https://graph.microsoft.com/v1.0/chats/' +
        '19%3A8b081ef6-4792-4def-b2c9-c363a1bf41d5_5031bb31%40unq.gbl.spaces/messages?$top=20',
    )
  })

  it('routes listMembers to the team roster or one channel roster on channelId', async () => {
    const calls: FetchCall[] = []
    const client = createMsGraphClient({
      getAccessToken: async () => 'tok-abc',
      fetchImpl: fakeFetch([{ value: [] }, { value: [] }], calls),
    })

    await client.listMembers({ teamId: TEAM_ID, limit: 100 })
    await client.listMembers({ teamId: TEAM_ID, channelId: '19:eng@thread.tacv2', limit: 100 })

    expect(calls.map((c) => c.url)).toEqual([
      `https://graph.microsoft.com/v1.0/teams/${TEAM_ID}/members?$top=100`,
      `https://graph.microsoft.com/v1.0/teams/${TEAM_ID}/channels/19%3Aeng%40thread.tacv2/members?$top=100`,
    ])
  })

  it('clamps a roster $top to 999, not to the message ceiling of 50', async () => {
    // Rosters default to 100 and cap at 999 — a global 50-clamp would silently
    // truncate a large team (research §2.3).
    const calls: FetchCall[] = []
    const client = createMsGraphClient({
      getAccessToken: async () => 'tok-abc',
      fetchImpl: fakeFetch([{ value: [] }], calls),
    })

    await client.listMembers({ teamId: TEAM_ID, limit: 5000 })

    expect(calls[0]!.url.endsWith('/members?$top=999')).toBe(true)
  })

  it('posts a chatMessage /search/query and returns the hit envelope verbatim', async () => {
    // Search nests hits two levels deep and the tool layer reads
    // value[0].hitsContainers[0].{hits,moreResultsAvailable} — so this response
    // must NOT go through collection pagination, which would flatten it.
    const SEARCH_BODY = {
      value: [
        {
          searchTerms: ['pricing'],
          hitsContainers: [
            {
              hits: [
                {
                  hitId: '1615971548136',
                  rank: 1,
                  summary: 'the <c0>pricing</c0> deck is in the Q3 folder',
                  resource: {
                    '@odata.type': '#microsoft.graph.chatMessage',
                    id: '1615971548136',
                    createdDateTime: '2021-03-17T09:39:08.136Z',
                    webUrl: 'https://teams.microsoft.com/l/message/19%3Aeng/1615971548136',
                    channelIdentity: { teamId: TEAM_ID, channelId: '19:eng@thread.tacv2' },
                    chatId: null,
                    from: {
                      user: {
                        id: '8ea0e38b-efb3-4757-924a-5f94061cf8c2',
                        displayName: 'Robin Kline',
                        userIdentityType: 'aadUser',
                      },
                    },
                  },
                },
              ],
              total: 1,
              moreResultsAvailable: false,
            },
          ],
        },
      ],
    }

    const calls: FetchCall[] = []
    const client = createMsGraphClient({
      getAccessToken: async () => 'tok-abc',
      fetchImpl: fakeFetch([SEARCH_BODY], calls),
    })

    const body = await client.searchMessages({ query: 'pricing from:bob', limit: 10 })

    expect(calls[0]!.url).toBe('https://graph.microsoft.com/v1.0/search/query')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(new Headers(calls[0]!.init?.headers).get('content-type')).toBe('application/json')
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe('Bearer tok-abc')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      requests: [
        {
          entityTypes: ['chatMessage'],
          query: { queryString: 'pricing from:bob' },
          from: 0,
          size: 10,
        },
      ],
    })
    expect(body).toEqual(SEARCH_BODY)
  })

  it('scopes findPeople to a team roster and matches in-process, tolerating guests', async () => {
    // The roster $filter Graph documents is `eq` — exact match — which cannot
    // serve the "partial name" the tool advertises. So the roster is listed and
    // matched here. The anonymous row has no userId, no email and no UPN; the
    // matcher must skip it rather than throw.
    const ADELE = {
      '@odata.type': '#microsoft.graph.aadUserConversationMember',
      id: 'MCMjMSMjZGNkMjE5ZGQ',
      roles: ['owner'],
      displayName: 'Adele Vance',
      userId: 'bc3c562a-3063-4a5a-80c7-a096e344a38f',
      email: 'AdeleV@contoso.com',
    }
    const ANON = { id: 'MCMjMyMjNzYxNGNlYjE', roles: ['guest'], displayName: 'Anonymous User' }

    const calls: FetchCall[] = []
    const client = createMsGraphClient({
      getAccessToken: async () => 'tok-abc',
      fetchImpl: fakeFetch([{ value: [ADELE, ANON] }], calls),
    })

    const body = await client.findPeople({ query: 'vance', teamId: TEAM_ID })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`https://graph.microsoft.com/v1.0/teams/${TEAM_ID}/members`)
    expect(calls[0]!.url).not.toContain('$filter')
    expect(body).toEqual({ value: [ADELE] })
  })

  it('filters the tenant directory server-side and doubles quotes in the OData literal', async () => {
    // startsWith on displayName / mail / userPrincipalName is "Default+Advanced"
    // and needs no ConsistencyLevel header (research §2.3). A single quote in
    // the name must be doubled or the filter is a 400 — and an injection seam.
    const calls: FetchCall[] = []
    const client = createMsGraphClient({
      getAccessToken: async () => 'tok-abc',
      fetchImpl: fakeFetch([{ value: [] }], calls),
    })

    await client.findPeople({ query: "O'Brien", limit: 10 })

    const url = new URL(calls[0]!.url)
    expect(url.origin + url.pathname).toBe('https://graph.microsoft.com/v1.0/users')
    expect(url.searchParams.get('$filter')).toBe(
      "startsWith(displayName,'O''Brien') or startsWith(mail,'O''Brien') " +
        "or startsWith(userPrincipalName,'O''Brien')",
    )
    expect(url.searchParams.get('$top')).toBe('10')
  })

  it('stops paginating joined teams once limit is satisfied, but not while searching', async () => {
    // joinedTeams takes no $top, so pagination is the only brake. A capped
    // request must not walk page two; a search must, since a match can sit on
    // any page.
    const twoPages = () => [
      {
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/joinedTeams?$skiptoken=X',
        value: [{ id: TEAM_ID, displayName: 'Contoso Platform' }],
      },
      { value: [{ id: 'other', displayName: 'Design' }] },
    ]

    const capped: FetchCall[] = []
    await createMsGraphClient({
      getAccessToken: async () => 'tok-abc',
      fetchImpl: fakeFetch(twoPages(), capped),
    }).listTeams({ limit: 1 })

    const searched: FetchCall[] = []
    const found = await createMsGraphClient({
      getAccessToken: async () => 'tok-abc',
      fetchImpl: fakeFetch(twoPages(), searched),
    }).listTeams({ search: 'design' })

    expect(capped).toHaveLength(1)
    expect(searched).toHaveLength(2)
    expect(found).toEqual({ value: [{ id: 'other', displayName: 'Design' }] })
  })

  it('routes a GUID query to the user resource and wraps it as a collection', async () => {
    // A model holding `fromUserId` off a message row has no other way back to
    // a person: startsWith on displayName/mail/UPN never matches a GUID.
    const USER_ROW = {
      '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users/$entity',
      businessPhones: [],
      displayName: 'Robin Kline',
      jobTitle: 'Retail Manager',
      mail: 'RobinK@contoso.com',
      userPrincipalName: 'RobinK@contoso.com',
      id: '8ea0e38b-efb3-4757-924a-5f94061cf8c2',
    }

    const calls: FetchCall[] = []
    const client = createMsGraphClient({
      getAccessToken: async () => 'tok-abc',
      fetchImpl: fakeFetch([USER_ROW], calls),
    })

    const body = await client.findPeople({ query: '8ea0e38b-efb3-4757-924a-5f94061cf8c2' })

    expect(calls[0]!.url).toBe(
      'https://graph.microsoft.com/v1.0/users/8ea0e38b-efb3-4757-924a-5f94061cf8c2',
    )
    expect(calls[0]!.url).not.toContain('$filter')
    // /users/{id} answers with a bare entity; the tool layer reads `value`.
    expect(body).toEqual({ value: [USER_ROW] })
  })

  it('returns an empty collection when a GUID lookup 404s', async () => {
    // "Not found" is an ordinary answer for a find, not a tool failure.
    const client = createMsGraphClient({
      getAccessToken: async () => 'tok-abc',
      fetchImpl: fakeErrorFetch(404, {
        error: { code: 'Request_ResourceNotFound', message: 'Resource does not exist.' },
      }),
    })

    const body = await client.findPeople({
      query: '00000000-0000-0000-0000-000000000000',
    })

    expect(body).toEqual({ value: [] })
  })

  it('matches a GUID query against roster id fields under any of their spellings', async () => {
    // A roster row is where a guest's email lives, and the Entra id arrives as
    // `userId` (Graph), `objectId` (Bot Framework) or `aadObjectId` (Activity).
    const HARRY = {
      '@odata.type': '#microsoft.graph.aadUserConversationMember',
      id: 'MCMjMiMjOWY0ODIwNTU',
      displayName: 'Harry Johnson',
      objectId: '73761f06-2ac9-469c-9f10-279a8cc267f9',
      email: 'harry@contoso.com',
    }
    const ADELE = {
      id: 'MCMjMSMjZGNkMjE5ZGQ',
      displayName: 'Adele Vance',
      userId: 'bc3c562a-3063-4a5a-80c7-a096e344a38f',
    }

    const calls: FetchCall[] = []
    const client = createMsGraphClient({
      getAccessToken: async () => 'tok-abc',
      fetchImpl: fakeFetch([{ value: [ADELE, HARRY] }], calls),
    })

    const body = await client.findPeople({
      query: '73761F06-2AC9-469C-9F10-279A8CC267F9',
      teamId: TEAM_ID,
    })

    expect(calls[0]!.url).toBe(`https://graph.microsoft.com/v1.0/teams/${TEAM_ID}/members`)
    expect(body).toEqual({ value: [HARRY] })
  })

  it('surfaces Retry-After in the error message when a throttle survives retry', async () => {
    // The core tools flatten a rejection into `Microsoft Teams error: <msg>`,
    // so the wait hint has to be in the message or the model cannot repeat it.
    const client = createMsGraphClient({
      getAccessToken: async () => 'tok-abc',
      fetchImpl: fakeErrorFetch(
        429,
        { error: { code: 'TooManyRequests', message: 'Rate limit is exceeded.' } },
        { 'Retry-After': '17' },
      ),
      // Stand in for an exhausted backoff. The production default is the real
      // `fetchWithRetry`, which would honour the 17s hint and stall the suite;
      // this test is about the message the caller finally sees, not the wait.
      retry: (doFetch) => doFetch(),
    })

    const err = await client.listChannels({ teamId: TEAM_ID }).then(
      () => null,
      (e: unknown) => e,
    )

    expect((err as MsGraphError).status).toBe(429)
    expect((err as MsGraphError).message).toContain('retry after 17s')
    // A throttle is not a dead credential.
    expect(classifyConnectorAuthError(err)).toBe(false)
  })

  it('keeps working when its methods are destructured off the client', async () => {
    // The core tool layer consumes this structurally, so no method may depend
    // on being called with `this` bound to the client object.
    const calls: FetchCall[] = []
    const { listChannels } = createMsGraphClient({
      getAccessToken: async () => 'tok-abc',
      fetchImpl: fakeFetch([{ value: [CHANNEL_ROW] }], calls),
    })

    const body = await listChannels({ teamId: TEAM_ID })

    expect(body).toEqual({ value: [CHANNEL_ROW] })
  })

  it('is assignable to the MsGraphApi port that core declares', () => {
    // Verbatim copy of packages/core/src/tools/base/msgraph.ts:273. Core owns
    // the contract and does not import from this package, so the compiler check
    // lives here. The assignment below is the assertion; if a signature drifts
    // this file stops typechecking.
    type CoreMsGraphApi = {
      listTeams(params: { search?: string; limit?: number }): Promise<unknown>
      listChannels(params: { teamId: string; limit?: number }): Promise<unknown>
      listChannelMessages(params: {
        teamId: string
        channelId: string
        limit?: number
      }): Promise<unknown>
      listMessageReplies(params: {
        teamId: string
        channelId: string
        messageId: string
        limit?: number
      }): Promise<unknown>
      listChats(params: { limit?: number }): Promise<unknown>
      listChatMessages(params: { chatId: string; limit?: number }): Promise<unknown>
      searchMessages(params: { query: string; limit?: number }): Promise<unknown>
      listMembers(params: {
        teamId: string
        channelId?: string
        limit?: number
      }): Promise<unknown>
      findPeople(params: { query: string; teamId?: string; limit?: number }): Promise<unknown>
    }

    const client: CoreMsGraphApi = createMsGraphClient({
      getAccessToken: async () => 'tok-abc',
    })

    expect(Object.keys(client).sort()).toEqual([
      'findPeople',
      'listChannelMessages',
      'listChannels',
      'listChatMessages',
      'listChats',
      'listMembers',
      'listMessageReplies',
      'listTeams',
      'searchMessages',
    ])
  })
})
