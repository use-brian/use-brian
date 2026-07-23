/**
 * Unit tests for the Microsoft Graph read-only tool factory.
 * Component tag: [COMP:tools/msgraph-read].
 *
 * The factory is injected with a fake api object — `packages/core` is
 * network-free, so every Graph call arrives through the injected port.
 * See docs/plans/msteams-connector.md §5 P2.
 */

import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createMsGraphTools, type MsGraphApi } from '../msgraph.js'
import type { Tool, ToolContext } from '../../types.js'

const ctx: ToolContext = {
  userId: 'u-1',
  assistantId: 'a-1',
  sessionId: 's-1',
  appId: 'Use Brian',
  channelType: 'web',
  channelId: 'c-1',
  abortSignal: new AbortController().signal,
}

function byName(tools: Tool[], name: string): Tool {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool ${name} not found`)
  return t
}

/**
 * A verbatim-shaped `GET /teams/{id}/channels/{id}/messages` body: one real
 * message and one system event, carrying the Graph noise the projection must
 * drop (`@odata.*`, `eventDetail`, HTML `body.content`, null-filled fields).
 */
const CHANNEL_MESSAGES = {
  '@odata.context':
    "https://graph.microsoft.com/v1.0/$metadata#teams('team-1')/channels('chan-1')/messages",
  '@odata.count': 2,
  value: [
    {
      '@odata.etag': '1616990032035',
      id: '1616990032035',
      replyToId: null,
      etag: '1616990032035',
      messageType: 'message',
      createdDateTime: '2026-03-29T03:53:52.035Z',
      lastModifiedDateTime: '2026-03-29T03:53:52.035Z',
      lastEditedDateTime: null,
      deletedDateTime: null,
      subject: 'Q3 pricing',
      summary: null,
      chatId: null,
      importance: 'normal',
      locale: 'en-us',
      webUrl: 'https://teams.microsoft.com/l/message/chan-1/1616990032035',
      policyViolation: null,
      eventDetail: null,
      from: {
        application: null,
        device: null,
        user: {
          id: '8ea0e38b-efb3-4757-924a-5f94061cf8c2',
          displayName: 'Robin Kline',
          userIdentityType: 'aadUser',
        },
      },
      body: { contentType: 'html', content: '<div><div>We land at <b>$49</b>&nbsp;flat.</div></div>' },
      channelIdentity: { teamId: 'team-1', channelId: 'chan-1' },
      attachments: [],
      mentions: [],
      reactions: [],
    },
    {
      '@odata.etag': '1616990100000',
      id: '1616990100000',
      messageType: 'systemEventMessage',
      createdDateTime: '2026-03-29T03:55:00.000Z',
      subject: null,
      webUrl: 'https://teams.microsoft.com/l/message/chan-1/1616990100000',
      from: null,
      body: { contentType: 'html', content: '<systemEventMessage/>' },
      eventDetail: {
        '@odata.type': '#microsoft.graph.membersAddedEventMessageDetail',
        visibleHistoryStartDateTime: '2026-03-29T03:55:00.000Z',
        members: [{ id: '2f19f2a5-0000-0000-0000-000000000000', displayName: 'Ada Lovelace' }],
        initiator: { user: { id: '8ea0e38b-efb3-4757-924a-5f94061cf8c2' } },
      },
      attachments: [{ id: 'att-1', contentType: 'reference', name: 'roadmap.pptx' }],
    },
  ],
}

/** The v1 tool set, hand-written. Adding a tool must update this literal. */
const TOOL_NAMES = [
  'msTeamsListTeams',
  'msTeamsListChannels',
  'msTeamsReadChannelMessages',
  'msTeamsReadThreadReplies',
  'msTeamsListChats',
  'msTeamsReadChatMessages',
  'msTeamsSearchMessages',
  'msTeamsListMembers',
  'msTeamsFindPerson',
]

/** One valid input per tool, so a sweep can drive the whole surface. */
const VALID_INPUT: Record<string, Record<string, unknown>> = {
  msTeamsListTeams: {},
  msTeamsListChannels: { teamId: 'team-1' },
  msTeamsReadChannelMessages: { teamId: 'team-1', channelId: '19:chan1@thread.tacv2' },
  msTeamsReadThreadReplies: {
    teamId: 'team-1',
    channelId: '19:chan1@thread.tacv2',
    messageId: '1616990032035',
  },
  msTeamsListChats: {},
  msTeamsReadChatMessages: { chatId: '19:group1@thread.v2' },
  msTeamsSearchMessages: { query: 'pricing' },
  msTeamsListMembers: { teamId: 'team-1' },
  msTeamsFindPerson: { query: 'ada' },
}

/** `GET /teams` — settings blobs and internal ids are the noise here. */
const TEAMS = {
  '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#teams',
  '@odata.count': 1,
  value: [
    {
      id: 'team-1',
      createdDateTime: null,
      displayName: 'Platform',
      description: 'Platform engineering',
      internalId: '19:abc123@thread.tacv2',
      classification: null,
      specialization: 'none',
      visibility: 'private',
      webUrl: 'https://teams.microsoft.com/l/team/19%3aabc123%40thread.tacv2',
      isArchived: false,
      isMembershipLimitedToOwners: false,
      memberSettings: { allowCreateUpdateChannels: true, allowDeleteChannels: true },
      guestSettings: { allowCreateUpdateChannels: false },
      messagingSettings: { allowUserEditMessages: true },
      funSettings: { allowGiphy: true, giphyContentRating: 'moderate' },
      discoverySettings: { showInTeamsSearchAndSuggestions: true },
      summary: null,
      tenantId: '11111111-2222-3333-4444-555555555555',
    },
  ],
}

/** `GET /teams/{id}/channels`. */
const CHANNELS = {
  '@odata.context':
    "https://graph.microsoft.com/v1.0/$metadata#teams('team-1')/channels",
  value: [
    {
      id: '19:chan1@thread.tacv2',
      createdDateTime: '2026-01-05T12:00:00Z',
      displayName: 'General',
      description: 'Team-wide announcements',
      isFavoriteByDefault: null,
      email: '',
      tenantId: '11111111-2222-3333-4444-555555555555',
      webUrl: 'https://teams.microsoft.com/l/channel/19%3achan1%40thread.tacv2/General',
      membershipType: 'standard',
    },
  ],
}

/**
 * `GET /teams/{id}/channels` for a team whose ids are spelled as thread ids.
 * Microsoft returns `displayName: null` for the General channel so that
 * clients can localize the name themselves, and General's channel id is the
 * team's own id.
 */
const CHANNELS_WITH_GENERAL = {
  '@odata.context': "https://graph.microsoft.com/v1.0/$metadata#teams('19:abc123')/channels",
  value: [
    {
      id: '19:abc123@thread.tacv2',
      createdDateTime: '2026-01-05T12:00:00Z',
      displayName: null,
      description: 'Team-wide announcements',
      isFavoriteByDefault: null,
      email: '',
      webUrl: 'https://teams.microsoft.com/l/channel/19%3aabc123%40thread.tacv2/General',
      membershipType: 'standard',
    },
    {
      id: '19:chan2@thread.tacv2',
      createdDateTime: '2026-02-11T08:30:00Z',
      displayName: 'Engineering',
      description: null,
      email: '',
      webUrl: 'https://teams.microsoft.com/l/channel/19%3achan2%40thread.tacv2/Engineering',
      membershipType: 'private',
    },
  ],
}

/** `GET .../messages/{id}/replies`. */
const REPLIES = {
  '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#replies',
  value: [
    {
      '@odata.etag': '1616990500000',
      id: '1616990500000',
      replyToId: '1616990032035',
      messageType: 'message',
      createdDateTime: '2026-03-29T04:01:40.000Z',
      subject: null,
      webUrl: 'https://teams.microsoft.com/l/message/chan-1/1616990500000',
      from: {
        application: null,
        device: null,
        user: {
          id: '2f19f2a5-0000-0000-0000-000000000000',
          displayName: 'Ada Lovelace',
          userIdentityType: 'aadUser',
        },
      },
      body: { contentType: 'html', content: '<p>Agreed. Ship it &amp; tell sales.</p>' },
      attachments: [],
    },
  ],
}

/**
 * `GET /me/chats?$expand=members` — a titled group chat plus a one-on-one
 * whose `topic` is null, which is only identifiable by its member names.
 */
const CHATS = {
  '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#chats',
  '@odata.count': 2,
  value: [
    {
      id: '19:group1@thread.v2',
      topic: 'Pricing sync',
      createdDateTime: '2026-02-01T09:00:00Z',
      lastUpdatedDateTime: '2026-03-29T04:10:00Z',
      chatType: 'group',
      webUrl: 'https://teams.microsoft.com/l/chat/19%3agroup1%40thread.v2',
      tenantId: '11111111-2222-3333-4444-555555555555',
      isHiddenForAllMembers: false,
      onlineMeetingInfo: null,
      viewpoint: { isHidden: false, lastMessageReadDateTime: '2026-03-29T04:11:00Z' },
      members: [
        {
          '@odata.type': '#microsoft.graph.aadUserConversationMember',
          id: 'MCMjMiMjOTBmOWNhMg',
          roles: [],
          displayName: 'Robin Kline',
          visibleHistoryStartDateTime: '2026-02-01T09:00:00Z',
          userId: '8ea0e38b-efb3-4757-924a-5f94061cf8c2',
          email: 'robin@contoso.com',
          tenantId: '11111111-2222-3333-4444-555555555555',
        },
      ],
    },
    {
      id: '19:dm1@unq.gbl.spaces',
      topic: null,
      createdDateTime: '2026-03-02T09:00:00Z',
      lastUpdatedDateTime: '2026-03-28T18:00:00Z',
      chatType: 'oneOnOne',
      webUrl: 'https://teams.microsoft.com/l/chat/19%3adm1%40unq.gbl.spaces',
      members: [
        {
          '@odata.type': '#microsoft.graph.aadUserConversationMember',
          id: 'MCMjMSMj',
          displayName: 'Ada Lovelace',
          userId: '2f19f2a5-0000-0000-0000-000000000000',
          email: 'ada@contoso.com',
        },
      ],
    },
  ],
}

/**
 * `POST /search/query` with `entityTypes: ["chatMessage"]`. Search never
 * returns a message body — only a `summary` snippet carrying `<c0>` hit
 * highlight markers, which are Graph's, not content.
 */
const SEARCH_HITS = {
  '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#search',
  value: [
    {
      searchTerms: ['pricing'],
      hitsContainers: [
        {
          total: 2,
          moreResultsAvailable: true,
          hits: [
            {
              hitId: '1616990032035',
              rank: 1,
              summary: 'We land at <c0>$49</c0> flat.<ddd/>',
              resource: {
                '@odata.type': '#microsoft.graph.chatMessage',
                id: '1616990032035',
                etag: '1616990032035',
                createdDateTime: '2026-03-29T03:53:52.035Z',
                lastModifiedDateTime: '2026-03-29T03:53:52.035Z',
                importance: 'normal',
                subject: 'Q3 pricing',
                webUrl: 'https://teams.microsoft.com/l/message/chan-1/1616990032035',
                chatId: null,
                channelIdentity: { teamId: 'team-1', channelId: '19:chan1@thread.tacv2' },
                from: {
                  user: {
                    id: '8ea0e38b-efb3-4757-924a-5f94061cf8c2',
                    displayName: 'Robin Kline',
                    userIdentityType: 'aadUser',
                  },
                },
              },
            },
            {
              hitId: '1616991111111',
              rank: 2,
              summary: 'the <c0>pricing</c0> deck is in the DM',
              resource: {
                '@odata.type': '#microsoft.graph.chatMessage',
                id: '1616991111111',
                createdDateTime: '2026-03-28T11:00:00Z',
                subject: null,
                webUrl: 'https://teams.microsoft.com/l/message/19%3adm1/1616991111111',
                chatId: '19:dm1@unq.gbl.spaces',
                channelIdentity: null,
                from: {
                  user: {
                    id: '2f19f2a5-0000-0000-0000-000000000000',
                    displayName: 'Ada Lovelace',
                    userIdentityType: 'aadUser',
                  },
                },
              },
            },
          ],
        },
      ],
    },
  ],
}

/**
 * `GET /teams/{id}/members`. The row `id` is the OPAQUE membership id, not a
 * user id, so it must never be projected as one; `userId` is the Entra object
 * id. Graph returns `roles: []` for a plain member.
 */
const MEMBERS = {
  '@odata.context': "https://graph.microsoft.com/v1.0/$metadata#teams('team-1')/members",
  '@odata.count': 2,
  value: [
    {
      '@odata.type': '#microsoft.graph.aadUserConversationMember',
      id: 'MCMjMiMjOTBmOWNhMg',
      roles: ['owner'],
      displayName: 'Robin Kline',
      visibleHistoryStartDateTime: '0001-01-01T00:00:00Z',
      userId: '8ea0e38b-efb3-4757-924a-5f94061cf8c2',
      email: 'robin@contoso.com',
      tenantId: '11111111-2222-3333-4444-555555555555',
    },
    {
      '@odata.type': '#microsoft.graph.aadUserConversationMember',
      id: 'MCMjMSMj',
      roles: [],
      displayName: 'Ada Lovelace',
      userId: '2f19f2a5-0000-0000-0000-000000000000',
      email: 'ada@contoso.com',
      tenantId: '11111111-2222-3333-4444-555555555555',
    },
  ],
}

/**
 * Person lookup across both shapes it can hit: a directory `/users` row, a
 * B2B guest (`mail` null, `#EXT#` UPN), and an anonymous guest membership row
 * which has no Entra object id, no mail and no UPN at all.
 */
const PEOPLE = {
  '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users',
  value: [
    {
      id: '8ea0e38b-efb3-4757-924a-5f94061cf8c2',
      displayName: 'Robin Kline',
      givenName: 'Robin',
      surname: 'Kline',
      mail: 'robin@contoso.com',
      userPrincipalName: 'robin@contoso.com',
      jobTitle: 'Principal Engineer',
      department: 'Platform',
      mobilePhone: null,
      businessPhones: [],
      officeLocation: null,
      preferredLanguage: null,
      userType: 'Member',
    },
    {
      id: '9c1b0000-0000-0000-0000-000000000000',
      displayName: 'Ada Lovelace',
      mail: null,
      userPrincipalName: 'ada_adatum.com#EXT#@contoso.com',
      jobTitle: null,
      department: null,
      businessPhones: [],
      userType: 'Guest',
    },
    {
      '@odata.type': '#microsoft.graph.anonymousGuestConversationMember',
      id: 'MSMjMCMjZm',
      roles: ['guest'],
      displayName: 'Anonymous',
      anonymousGuestId: 'e5f2a3b4-1111-2222-3333-444455556666',
      visibleHistoryStartDateTime: null,
    },
  ],
}

/**
 * The same Entra object id under both spellings it travels by: `objectId` on
 * a Graph membership row, `aadObjectId` on the Bot Framework Activity the
 * shipped Teams channel already parses. A join across the two surfaces misses
 * silently unless one side normalizes, so this side does.
 */
const MEMBERS_ALT_SPELLINGS = {
  '@odata.context': "https://graph.microsoft.com/v1.0/$metadata#teams('team-1')/members",
  value: [
    {
      '@odata.type': '#microsoft.graph.aadUserConversationMember',
      id: 'MCMjQUFB',
      roles: ['owner'],
      displayName: 'Grace Hopper',
      objectId: '3a3a3a3a-1111-1111-1111-111111111111',
      email: 'grace@contoso.com',
      tenantId: '11111111-2222-3333-4444-555555555555',
    },
    {
      '@odata.type': '#microsoft.graph.aadUserConversationMember',
      id: 'MCMjQkJC',
      roles: [],
      displayName: 'Alan Turing',
      aadObjectId: '4b4b4b4b-2222-2222-2222-222222222222',
      email: 'alan@contoso.com',
      tenantId: '11111111-2222-3333-4444-555555555555',
    },
  ],
}

/**
 * A roster carrying an anonymous guest: no object id under any spelling, no
 * email, no UPN. All three are absent keys, not empty strings.
 */
const MEMBERS_WITH_GUEST = {
  '@odata.context': "https://graph.microsoft.com/v1.0/$metadata#teams('team-1')/members",
  '@odata.count': 2,
  value: [
    {
      '@odata.type': '#microsoft.graph.aadUserConversationMember',
      id: 'MCMjQ0ND',
      roles: [],
      displayName: 'Robin Kline',
      objectId: '8ea0e38b-efb3-4757-924a-5f94061cf8c2',
      email: 'robin@contoso.com',
    },
    {
      '@odata.type': '#microsoft.graph.anonymousGuestConversationMember',
      id: 'MSMjRERE',
      roles: ['guest'],
      displayName: 'Anonymous',
      anonymousGuestId: 'e5f2a3b4-1111-2222-3333-444455556666',
      visibleHistoryStartDateTime: null,
    },
  ],
}

function stubApi(overrides: Partial<MsGraphApi> = {}): MsGraphApi {
  return {
    listTeams: vi.fn(async () => ({ value: [] })),
    listChannels: vi.fn(async () => ({ value: [] })),
    listChannelMessages: vi.fn(async () => ({ value: [] })),
    listMessageReplies: vi.fn(async () => ({ value: [] })),
    listChats: vi.fn(async () => ({ value: [] })),
    listChatMessages: vi.fn(async () => ({ value: [] })),
    searchMessages: vi.fn(async () => ({ value: [] })),
    listMembers: vi.fn(async () => ({ value: [] })),
    findPeople: vi.fn(async () => ({ value: [] })),
    ...overrides,
  }
}

describe('[COMP:tools/msgraph-read] Microsoft Graph read tools', () => {
  it('exposes the v1 tool set, and every tool is read-only', () => {
    const tools = createMsGraphTools(stubApi())

    expect([...tools.map((t) => t.name)].sort()).toEqual([...TOOL_NAMES].sort())

    // D1 — read-only, permanently. A write tool added through this factory
    // drops out of this list and fails loudly.
    expect([...tools.filter((t) => t.isReadOnly).map((t) => t.name)].sort()).toEqual(
      [...TOOL_NAMES].sort(),
    )
    expect(tools.filter((t) => t.requiresConfirmation).map((t) => t.name)).toEqual([])
  })

  it('the discovery tools forward their args and project teams and channels', async () => {
    const listTeams = vi.fn(async () => TEAMS)
    const listChannels = vi.fn(async () => CHANNELS)
    const tools = createMsGraphTools(stubApi({ listTeams, listChannels }))

    const teams = await byName(tools, 'msTeamsListTeams').execute({ search: 'Plat' }, ctx)
    expect(listTeams).toHaveBeenCalledWith({ search: 'Plat', limit: undefined })
    expect(teams.data).toEqual({
      matched: 1,
      returned: 1,
      truncated: false,
      items: [
        {
          id: 'team-1',
          displayName: 'Platform',
          description: 'Platform engineering',
          visibility: 'private',
          isArchived: false,
          webUrl: 'https://teams.microsoft.com/l/team/19%3aabc123%40thread.tacv2',
        },
      ],
    })

    const channels = await byName(tools, 'msTeamsListChannels').execute(
      { teamId: 'team-1', limit: 10 },
      ctx,
    )
    expect(listChannels).toHaveBeenCalledWith({ teamId: 'team-1', limit: 10 })
    expect(channels.data).toEqual({
      matched: 1,
      returned: 1,
      truncated: false,
      items: [
        {
          id: '19:chan1@thread.tacv2',
          displayName: 'General',
          description: 'Team-wide announcements',
          membershipType: 'standard',
          createdDateTime: '2026-01-05T12:00:00Z',
          webUrl: 'https://teams.microsoft.com/l/channel/19%3achan1%40thread.tacv2/General',
        },
      ],
    })
  })

  it('the thread and chat reads forward their args and project their rows', async () => {
    const listMessageReplies = vi.fn(async () => REPLIES)
    const listChats = vi.fn(async () => CHATS)
    const listChatMessages = vi.fn(async () => CHANNEL_MESSAGES)
    const tools = createMsGraphTools(
      stubApi({ listMessageReplies, listChats, listChatMessages }),
    )

    const replies = await byName(tools, 'msTeamsReadThreadReplies').execute(
      { teamId: 'team-1', channelId: 'chan-1', messageId: '1616990032035' },
      ctx,
    )
    expect(listMessageReplies).toHaveBeenCalledWith({
      teamId: 'team-1',
      channelId: 'chan-1',
      messageId: '1616990032035',
      limit: undefined,
    })
    expect(replies.data).toEqual({
      matched: 1,
      returned: 1,
      truncated: false,
      items: [
        {
          id: '1616990500000',
          createdDateTime: '2026-03-29T04:01:40.000Z',
          messageType: 'message',
          subject: undefined,
          from: 'Ada Lovelace',
          fromUserId: '2f19f2a5-0000-0000-0000-000000000000',
          fromIdentityType: 'aadUser',
          text: 'Agreed. Ship it & tell sales.',
          hasAttachments: false,
          webUrl: 'https://teams.microsoft.com/l/message/chan-1/1616990500000',
        },
      ],
    })

    const chats = await byName(tools, 'msTeamsListChats').execute({ limit: 5 }, ctx)
    expect(listChats).toHaveBeenCalledWith({ limit: 5 })
    expect(chats.data).toEqual({
      matched: 2,
      returned: 2,
      truncated: false,
      items: [
        {
          id: '19:group1@thread.v2',
          topic: 'Pricing sync',
          chatType: 'group',
          lastUpdatedDateTime: '2026-03-29T04:10:00Z',
          members: ['Robin Kline'],
          webUrl: 'https://teams.microsoft.com/l/chat/19%3agroup1%40thread.v2',
        },
        {
          id: '19:dm1@unq.gbl.spaces',
          topic: undefined,
          chatType: 'oneOnOne',
          lastUpdatedDateTime: '2026-03-28T18:00:00Z',
          members: ['Ada Lovelace'],
          webUrl: 'https://teams.microsoft.com/l/chat/19%3adm1%40unq.gbl.spaces',
        },
      ],
    })

    const chatMessages = await byName(tools, 'msTeamsReadChatMessages').execute(
      { chatId: '19:group1@thread.v2', limit: 1 },
      ctx,
    )
    expect(listChatMessages).toHaveBeenCalledWith({ chatId: '19:group1@thread.v2', limit: 1 })
    expect(chatMessages.data).toMatchObject({
      matched: 2,
      returned: 1,
      truncated: true,
      items: [{ id: '1616990032035', from: 'Robin Kline', text: 'We land at $49 flat.' }],
    })
  })

  it('msTeamsListMembers projects the Entra user id, never the opaque membership id', async () => {
    const listMembers = vi.fn(async () => MEMBERS)
    const tools = createMsGraphTools(stubApi({ listMembers }))

    const res = await byName(tools, 'msTeamsListMembers').execute(
      { teamId: 'team-1', channelId: '19:chan1@thread.tacv2' },
      ctx,
    )

    expect(listMembers).toHaveBeenCalledWith({
      teamId: 'team-1',
      channelId: '19:chan1@thread.tacv2',
      limit: undefined,
    })
    expect(res.data).toEqual({
      matched: 2,
      returned: 2,
      truncated: false,
      items: [
        {
          userId: '8ea0e38b-efb3-4757-924a-5f94061cf8c2',
          displayName: 'Robin Kline',
          email: 'robin@contoso.com',
          identityKind: 'aadUser',
          roles: ['owner'],
        },
        {
          userId: '2f19f2a5-0000-0000-0000-000000000000',
          displayName: 'Ada Lovelace',
          email: 'ada@contoso.com',
          identityKind: 'aadUser',
        },
      ],
    })
    // The opaque membership id must not travel as if it were a user id.
    expect(JSON.stringify(res.data)).not.toContain('MCMjMiMjOTBmOWNhMg')
  })

  it('never leaks raw Graph JSON out of any tool', async () => {
    const tools = createMsGraphTools(
      stubApi({
        listTeams: async () => TEAMS,
        listChannels: async () => CHANNELS,
        listChannelMessages: async () => CHANNEL_MESSAGES,
        listMessageReplies: async () => REPLIES,
        listChats: async () => CHATS,
        listChatMessages: async () => CHANNEL_MESSAGES,
        searchMessages: async () => SEARCH_HITS,
        listMembers: async () => MEMBERS,
        findPeople: async () => PEOPLE,
      }),
    )

    /** Graph plumbing that must never reach the model. */
    const NOISE = [
      '@odata',
      '#microsoft.graph.',
      'eventDetail',
      'membersAddedEventMessageDetail',
      'hitsContainers',
      'internalId',
      'funSettings',
      'giphyContentRating',
      'messagingSettings',
      'discoverySettings',
      'visibleHistoryStartDateTime',
      'anonymousGuestId',
      'businessPhones',
      'viewpoint',
      'tenantId',
      'MCMjMiMjOTBmOWNhMg',
      '<div',
      '<b>',
      '<p>',
      '<c0>',
      '&nbsp;',
      '&amp;',
    ]

    /** One substantive value per tool, so the sweep cannot pass on an empty result. */
    const SUBSTANCE: Record<string, string> = {
      msTeamsListTeams: 'Platform engineering',
      msTeamsListChannels: 'Team-wide announcements',
      msTeamsReadChannelMessages: 'We land at $49 flat.',
      msTeamsReadThreadReplies: 'Ship it & tell sales.',
      msTeamsListChats: 'Pricing sync',
      msTeamsReadChatMessages: 'We land at $49 flat.',
      msTeamsSearchMessages: 'We land at $49 flat.',
      msTeamsListMembers: 'robin@contoso.com',
      msTeamsFindPerson: 'Principal Engineer',
    }

    for (const name of TOOL_NAMES) {
      const res = await byName(tools, name).execute(VALID_INPUT[name], ctx)
      const serialized = JSON.stringify(res.data)
      expect(serialized, name).toContain(SUBSTANCE[name])
      for (const token of NOISE) expect(serialized, `${name} leaked ${token}`).not.toContain(token)
    }
  })

  it('carries a self-contained description on every tool', () => {
    for (const tool of createMsGraphTools(stubApi())) {
      // Tool-specific instructions live here and nowhere else: the system
      // prompt must never name a tool that may not be injected.
      expect(tool.description, tool.name).toBeTruthy()
      expect(tool.description.length, tool.name).toBeGreaterThanOrEqual(80)
      expect(tool.description, tool.name).toContain('Microsoft Teams')
      expect(tool.description, tool.name).not.toContain('—')
    }
  })

  it('states the matching and sampling limits the api actually has', () => {
    const tools = createMsGraphTools(stubApi())

    // Directory matching is server-side startsWith, so a middle-of-string term
    // finds nobody. A model told only "partial name" would read an empty
    // result as "this person does not exist" and stop. The remedy is naming
    // the escape hatch, so the description has to point at teamId.
    const findPerson = byName(tools, 'msTeamsFindPerson')
    const findPersonText = [
      findPerson.description,
      ...Object.values((findPerson.inputSchema as z.ZodObject<z.ZodRawShape>).shape).map(
        (f) => f.description ?? '',
      ),
    ].join(' ')
    expect(findPersonText).toMatch(/starts with/i)
    expect(findPersonText).toContain('teamId')

    // $expand=members caps at 25 member items per chat whatever $top says, so
    // the projected member names are a sample on a big group chat.
    expect(byName(tools, 'msTeamsListChats').description).toContain('25')
  })

  it('tells the model msTeamsFindPerson accepts a directory id, not just a name', () => {
    // Every message and member row this connector projects carries a
    // fromUserId / userId. Resolving one back to a person is a direct id
    // lookup in the api layer, but the model will never attempt it unless
    // the schema says an id is an accepted query.
    const findPerson = byName(createMsGraphTools(stubApi()), 'msTeamsFindPerson')
    const text = [
      findPerson.description,
      ...Object.values((findPerson.inputSchema as z.ZodObject<z.ZodRawShape>).shape).map(
        (f) => f.description ?? '',
      ),
    ].join(' ')
    expect(text).toMatch(/Entra/i)
    expect(text).toContain('fromUserId')
  })

  it('rejects missing, blank and wrong-typed args at the schema boundary', () => {
    const tools = createMsGraphTools(stubApi())

    // Every tool that names a resource requires its id.
    for (const name of TOOL_NAMES) {
      const required = Object.keys(VALID_INPUT[name])
      const tool = byName(tools, name)
      expect(tool.inputSchema.safeParse(VALID_INPUT[name]).success, name).toBe(true)
      if (required.length === 0) continue
      expect(tool.inputSchema.safeParse({}).success, name).toBe(false)
      // A blank id is a missing id wearing a costume.
      const blanked = Object.fromEntries(required.map((k) => [k, '']))
      expect(tool.inputSchema.safeParse(blanked).success, name).toBe(false)
    }

    const readChannel = byName(tools, 'msTeamsReadChannelMessages')
    const accepts = (v: unknown) => readChannel.inputSchema.safeParse(v).success
    expect(accepts({ teamId: 1, channelId: 'c' })).toBe(false)
    expect(accepts({ teamId: 't', channelId: 'c', limit: 'ten' })).toBe(false)
    expect(accepts({ teamId: 't', channelId: 'c', limit: 0 })).toBe(false)
    // Graph caps channel-message $top at 50.
    expect(accepts({ teamId: 't', channelId: 'c', limit: 51 })).toBe(false)
    expect(accepts({ teamId: 't', channelId: 'c', limit: 50 })).toBe(true)
  })

  it('describes every input field, so the model is not guessing at arg shapes', () => {
    for (const tool of createMsGraphTools(stubApi())) {
      const shape = (tool.inputSchema as z.ZodObject<z.ZodRawShape>).shape
      for (const [field, schema] of Object.entries(shape)) {
        expect(schema.description, `${tool.name}.${field}`).toBeTruthy()
      }
    }
  })

  it('surfaces an api failure as an error result on every tool, never as a throw', async () => {
    const boom = async () => {
      throw new Error('429 Too Many Requests, Retry-After 12')
    }
    const failing: MsGraphApi = {
      listTeams: boom,
      listChannels: boom,
      listChannelMessages: boom,
      listMessageReplies: boom,
      listChats: boom,
      listChatMessages: boom,
      searchMessages: boom,
      listMembers: boom,
      findPeople: boom,
    }
    const tools = createMsGraphTools(failing)

    for (const name of TOOL_NAMES) {
      const res = await byName(tools, name).execute(VALID_INPUT[name], ctx)
      expect(res.isError, name).toBe(true)
      expect(res.data, name).toBe(
        'Microsoft Teams error: 429 Too Many Requests, Retry-After 12',
      )
    }
  })

  it('renders a non-Error rejection without stringifying it as [object Object]', async () => {
    const tools = createMsGraphTools(
      stubApi({
        listTeams: async () => {
          throw 'token expired'
        },
      }),
    )
    const res = await byName(tools, 'msTeamsListTeams').execute({}, ctx)
    expect(res).toEqual({ data: 'Microsoft Teams error: token expired', isError: true })
  })

  it('msTeamsFindPerson drops the fields a guest has none of instead of blanking them', async () => {
    const findPeople = vi.fn(async () => PEOPLE)
    const tools = createMsGraphTools(stubApi({ findPeople }))

    const res = await byName(tools, 'msTeamsFindPerson').execute(
      { query: 'ada', teamId: 'team-1' },
      ctx,
    )

    expect(findPeople).toHaveBeenCalledWith({ query: 'ada', teamId: 'team-1', limit: undefined })

    const items = (res.data as { items: Record<string, unknown>[] }).items
    expect(items[0]).toEqual({
      userId: '8ea0e38b-efb3-4757-924a-5f94061cf8c2',
      displayName: 'Robin Kline',
      email: 'robin@contoso.com',
      userPrincipalName: 'robin@contoso.com',
      jobTitle: 'Principal Engineer',
      department: 'Platform',
      identityKind: 'aadUser',
    })

    // A B2B guest has no mailbox: the `mail` key is absent, not `null` or ''.
    expect(items[1]).toEqual({
      userId: '9c1b0000-0000-0000-0000-000000000000',
      displayName: 'Ada Lovelace',
      userPrincipalName: 'ada_adatum.com#EXT#@contoso.com',
      identityKind: 'aadUser',
    })
    expect(Object.keys(items[1]).sort()).toEqual([
      'displayName',
      'identityKind',
      'userId',
      'userPrincipalName',
    ])

    // An anonymous guest has no id, no mail and no UPN. The row still names
    // the person, hands over the one handle it does have, and says plainly
    // why nothing else is there.
    expect(items[2]).toEqual({
      displayName: 'Anonymous',
      identityKind: 'anonymousGuest',
      roles: ['guest'],
      membershipId: 'MSMjMCMjZm',
      note: 'Anonymous or external guest. No directory identity, so this person cannot be looked up by id or email. membershipId identifies this membership row only and is not a user id.',
    })
    expect(Object.keys(items[2]).sort()).toEqual([
      'displayName',
      'identityKind',
      'membershipId',
      'note',
      'roles',
    ])
  })

  it('keeps a guest member usable instead of emitting a row of nulls', async () => {
    const listMembers = vi.fn(async () => MEMBERS_WITH_GUEST)
    const tools = createMsGraphTools(stubApi({ listMembers }))

    const res = await byName(tools, 'msTeamsListMembers').execute({ teamId: 'team-1' }, ctx)
    const items = (res.data as { items: Record<string, unknown>[] }).items

    expect(items[0]).toEqual({
      userId: '8ea0e38b-efb3-4757-924a-5f94061cf8c2',
      displayName: 'Robin Kline',
      email: 'robin@contoso.com',
      identityKind: 'aadUser',
    })

    // No object id under any spelling, no email, no UPN. What is left is a
    // name and the membership row's own id, and that is what survives.
    expect(items[1]).toEqual({
      displayName: 'Anonymous',
      identityKind: 'anonymousGuest',
      roles: ['guest'],
      membershipId: 'MSMjRERE',
      note: 'Anonymous or external guest. No directory identity, so this person cannot be looked up by id or email. membershipId identifies this membership row only and is not a user id.',
    })
    expect(Object.keys(items[1]).sort()).toEqual([
      'displayName',
      'identityKind',
      'membershipId',
      'note',
      'roles',
    ])

    // A member who does have a directory identity still never carries the
    // opaque membership id, so it can never be mistaken for a user id.
    expect('membershipId' in items[0]).toBe(false)
  })

  it('normalizes objectId and aadObjectId to one field name', async () => {
    const listMembers = vi.fn(async () => MEMBERS_ALT_SPELLINGS)
    const tools = createMsGraphTools(stubApi({ listMembers }))

    const res = await byName(tools, 'msTeamsListMembers').execute({ teamId: 'team-1' }, ctx)

    expect(res.data).toEqual({
      matched: 2,
      returned: 2,
      truncated: false,
      items: [
        {
          userId: '3a3a3a3a-1111-1111-1111-111111111111',
          displayName: 'Grace Hopper',
          email: 'grace@contoso.com',
          identityKind: 'aadUser',
          roles: ['owner'],
        },
        {
          userId: '4b4b4b4b-2222-2222-2222-222222222222',
          displayName: 'Alan Turing',
          email: 'alan@contoso.com',
          identityKind: 'aadUser',
        },
      ],
    })

    // One spelling leaves this projection, whichever arrived.
    const serialized = JSON.stringify(res.data)
    expect(serialized).not.toContain('objectId')
    expect(serialized).not.toContain('aadObjectId')
  })

  it('msTeamsSearchMessages passes the query through and projects who, when, where, snippet', async () => {
    const searchMessages = vi.fn(async () => SEARCH_HITS)
    const tools = createMsGraphTools(stubApi({ searchMessages }))

    const res = await byName(tools, 'msTeamsSearchMessages').execute(
      { query: 'pricing from:robin sent>2026-03-01' },
      ctx,
    )

    expect(searchMessages).toHaveBeenCalledWith({
      query: 'pricing from:robin sent>2026-03-01',
      limit: undefined,
    })
    expect(res.data).toEqual({
      matched: 2,
      returned: 2,
      truncated: false,
      // Graph's `total` counts this page only, so paging is signalled by
      // moreResultsAvailable rather than by comparing counts.
      moreResultsAvailable: true,
      items: [
        {
          id: '1616990032035',
          createdDateTime: '2026-03-29T03:53:52.035Z',
          subject: 'Q3 pricing',
          from: 'Robin Kline',
          fromUserId: '8ea0e38b-efb3-4757-924a-5f94061cf8c2',
          fromIdentityType: 'aadUser',
          teamId: 'team-1',
          channelId: '19:chan1@thread.tacv2',
          chatId: undefined,
          snippet: 'We land at $49 flat.',
          webUrl: 'https://teams.microsoft.com/l/message/chan-1/1616990032035',
        },
        {
          id: '1616991111111',
          createdDateTime: '2026-03-28T11:00:00Z',
          subject: undefined,
          from: 'Ada Lovelace',
          fromUserId: '2f19f2a5-0000-0000-0000-000000000000',
          fromIdentityType: 'aadUser',
          teamId: undefined,
          channelId: undefined,
          chatId: '19:dm1@unq.gbl.spaces',
          snippet: 'the pricing deck is in the DM',
          webUrl: 'https://teams.microsoft.com/l/message/19%3adm1/1616991111111',
        },
      ],
    })
  })

  it('names the General channel, which Microsoft returns with a null displayName', async () => {
    const listChannels = vi.fn(async () => CHANNELS_WITH_GENERAL)
    const tools = createMsGraphTools(stubApi({ listChannels }))

    const res = await byName(tools, 'msTeamsListChannels').execute(
      { teamId: '19:abc123@thread.tacv2' },
      ctx,
    )

    expect(res.data).toEqual({
      matched: 2,
      returned: 2,
      truncated: false,
      items: [
        {
          id: '19:abc123@thread.tacv2',
          displayName: 'General',
          description: 'Team-wide announcements',
          membershipType: 'standard',
          createdDateTime: '2026-01-05T12:00:00Z',
          webUrl: 'https://teams.microsoft.com/l/channel/19%3aabc123%40thread.tacv2/General',
          isGeneral: true,
        },
        {
          id: '19:chan2@thread.tacv2',
          displayName: 'Engineering',
          description: undefined,
          membershipType: 'private',
          createdDateTime: '2026-02-11T08:30:00Z',
          webUrl: 'https://teams.microsoft.com/l/channel/19%3achan2%40thread.tacv2/Engineering',
        },
      ],
    })
    // isGeneral is a flag, not a column: it is absent on ordinary channels.
    const items = (res.data as { items: Record<string, unknown>[] }).items
    expect('isGeneral' in items[1]).toBe(false)
  })

  it('msTeamsReadChannelMessages forwards its args and projects the result', async () => {
    const listChannelMessages = vi.fn(async () => CHANNEL_MESSAGES)
    const tools = createMsGraphTools(stubApi({ listChannelMessages }))

    const res = await byName(tools, 'msTeamsReadChannelMessages').execute(
      { teamId: 'team-1', channelId: 'chan-1', limit: 20 },
      ctx,
    )

    expect(listChannelMessages).toHaveBeenCalledWith({
      teamId: 'team-1',
      channelId: 'chan-1',
      limit: 20,
    })
    expect(res.data).toEqual({
      matched: 2,
      returned: 2,
      truncated: false,
      items: [
        {
          id: '1616990032035',
          createdDateTime: '2026-03-29T03:53:52.035Z',
          messageType: 'message',
          subject: 'Q3 pricing',
          from: 'Robin Kline',
          fromUserId: '8ea0e38b-efb3-4757-924a-5f94061cf8c2',
          fromIdentityType: 'aadUser',
          text: 'We land at $49 flat.',
          hasAttachments: false,
          webUrl: 'https://teams.microsoft.com/l/message/chan-1/1616990032035',
        },
        {
          id: '1616990100000',
          createdDateTime: '2026-03-29T03:55:00.000Z',
          messageType: 'systemEventMessage',
          subject: undefined,
          from: undefined,
          fromUserId: undefined,
          fromIdentityType: undefined,
          text: '',
          hasAttachments: true,
          webUrl: 'https://teams.microsoft.com/l/message/chan-1/1616990100000',
        },
      ],
    })
  })
})
