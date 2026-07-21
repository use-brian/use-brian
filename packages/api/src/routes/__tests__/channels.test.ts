import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

vi.mock('../../db/channels-store.js', () => ({
  listChannelsForWorkspace: vi.fn(),
  getChannelForUser: vi.fn(),
  updateChannel: vi.fn(),
  deleteChannel: vi.fn(),
  listChannelAssistants: vi.fn(),
  attachAssistant: vi.fn(),
  detachAssistant: vi.fn(),
  // Pulled in transitively: channels.js → integrations.js (for the shared
  // `channelConfigSchema`) → channels-store.js. Not exercised by these tests.
  findOrCreateChannelForConnect: vi.fn(),
  findOrCreateChannelForWorkspaceConnect: vi.fn(),
}))

// Only `queryWithRLS` is stubbed (the channel-destinations read) — the rest
// of the module stays real because other modules in the import graph pull
// their own named exports from it at load time.
vi.mock('../../db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/client.js')>()),
  queryWithRLS: vi.fn(),
}))

vi.mock('@use-brian/channels', () => ({
  validateSlackCredentials: vi.fn(),
  validateTelegramCredentials: vi.fn(),
  validateDiscordCredentials: vi.fn(),
  validateMsTeamsCredentials: vi.fn(),
  createTelegramApi: vi.fn(),
  createSlackApi: vi.fn(),
  // The workspace channels route doesn't construct an adapter, but the
  // channels package re-exports some types/values the rest of the import
  // graph might touch. Default to undefined.
  createSlackAdapter: vi.fn(),
  createTelegramAdapter: vi.fn(),
  verifySlackSignature: vi.fn(),
  parseTopicChannelId: vi.fn(),
  chunkText: vi.fn(),
  markdownToTelegramHTML: vi.fn(),
  stripMarkdown: vi.fn(),
}))

import {
  listChannelsForWorkspace,
  getChannelForUser,
  updateChannel,
  deleteChannel,
  listChannelAssistants,
  attachAssistant,
  detachAssistant,
  findOrCreateChannelForWorkspaceConnect,
  type Channel,
} from '../../db/channels-store.js'
import {
  validateSlackCredentials,
  validateTelegramCredentials,
  validateDiscordCredentials,
  validateMsTeamsCredentials,
  createTelegramApi,
  createSlackApi,
} from '@use-brian/channels'
import { channelsRoutes } from '../channels.js'
import { queryWithRLS } from '../../db/client.js'
import type { WorkspaceStore } from '../../db/workspace-store.js'
import type { ChannelIntegrationStore } from '../../db/channel-integrations.js'
import type { DiscordConnectorClient } from '../../discord/connector-client.js'

function makeChannel(over: Partial<Channel> = {}): Channel {
  return {
    id: 'chan-1',
    workspaceId: 'ws-1',
    channelType: 'slack',
    clearance: 'internal',
    enabledCapabilities: ['chat', 'broadcast', 'ingest'],
    status: 'active',
    displayName: 'Acme Slack',
    createdAt: new Date('2026-05-18T00:00:00Z'),
    updatedAt: new Date('2026-05-18T00:00:00Z'),
    ...over,
  }
}

function buildApp(
  opts: {
    role?: string | null
    userId?: string | null
    integrationStore?: ChannelIntegrationStore
    apiUrl?: string
    discordConnector?: DiscordConnectorClient
    telegramBotToken?: string
  } = {},
) {
  const role = opts.role === undefined ? 'admin' : opts.role
  const workspaceStore = { getRole: vi.fn().mockResolvedValue(role) } as unknown as WorkspaceStore
  const userId = opts.userId === undefined ? 'user-1' : opts.userId
  return createTestApp(
    '/api',
    channelsRoutes({
      workspaceStore,
      integrationStore: opts.integrationStore,
      apiUrl: opts.apiUrl,
      discordConnector: opts.discordConnector,
      telegramBotToken: opts.telegramBotToken,
    }),
    userId ? { userId } : undefined,
  )
}

/** A `channel_integrations` row as `listForWorkspace` / `updateConfig` return it. */
function makeIntegration(over: Record<string, unknown> = {}) {
  return {
    id: 'int-1',
    channelId: 'chan-1',
    channelType: 'slack',
    teamId: null,
    teamName: null,
    botUserId: null,
    botUsername: null,
    config: {},
    status: 'active',
    createdAt: new Date('2026-05-18T00:00:00Z'),
    updatedAt: new Date('2026-05-18T00:00:00Z'),
    lastEventAt: null,
    ...over,
  }
}

const ASSISTANT_UUID = '00000000-0000-0000-0000-000000000001'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:api/channels-route] GET channels', () => {
  it('lists a workspace\'s channels for a member', async () => {
    vi.mocked(listChannelsForWorkspace).mockResolvedValue([makeChannel()])
    const res = await request(buildApp()).get('/api/workspaces/ws-1/channels')
    expect(res.status).toBe(200)
    expect(res.body.channels).toHaveLength(1)
    expect(res.body.channels[0].id).toBe('chan-1')
    expect(res.body.channels[0].createdAt).toBe('2026-05-18T00:00:00.000Z')
  })

  it('rejects a non-member with 403', async () => {
    const res = await request(buildApp({ role: null })).get('/api/workspaces/ws-1/channels')
    expect(res.status).toBe(403)
  })

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(buildApp({ userId: null })).get('/api/workspaces/ws-1/channels')
    expect(res.status).toBe(401)
  })

  it('404s a channel that belongs to a different workspace', async () => {
    vi.mocked(getChannelForUser).mockResolvedValue(makeChannel({ workspaceId: 'ws-OTHER' }))
    const res = await request(buildApp()).get('/api/workspaces/ws-1/channels/chan-1')
    expect(res.status).toBe(404)
  })
})

describe('[COMP:api/channels-route] PATCH channel', () => {
  it('rejects an invalid clearance value with 400', async () => {
    const res = await request(buildApp())
      .patch('/api/workspaces/ws-1/channels/chan-1')
      .send({ clearance: 'bogus' })
    expect(res.status).toBe(400)
  })

  it('updates a channel and returns the new row', async () => {
    vi.mocked(getChannelForUser).mockResolvedValue(makeChannel())
    vi.mocked(updateChannel).mockResolvedValue(makeChannel({ displayName: 'Renamed' }))
    const res = await request(buildApp())
      .patch('/api/workspaces/ws-1/channels/chan-1')
      .send({ displayName: 'Renamed' })
    expect(res.status).toBe(200)
    expect(res.body.channel.displayName).toBe('Renamed')
  })

  it('403s when RLS rejects the write (clearance raised above the user\'s)', async () => {
    vi.mocked(getChannelForUser).mockResolvedValue(makeChannel())
    vi.mocked(updateChannel).mockResolvedValue(null)
    const res = await request(buildApp())
      .patch('/api/workspaces/ws-1/channels/chan-1')
      .send({ clearance: 'confidential' })
    expect(res.status).toBe(403)
  })
})

describe('[COMP:api/channels-route] channel assistants', () => {
  it('attaches an assistant', async () => {
    vi.mocked(getChannelForUser).mockResolvedValue(makeChannel())
    vi.mocked(attachAssistant).mockResolvedValue({
      id: 'ca-1',
      channelId: 'chan-1',
      assistantId: ASSISTANT_UUID,
      externalSurfaceId: null,
      modelAlias: 'standard',
      createdAt: new Date('2026-05-18T00:00:00Z'),
    })
    const res = await request(buildApp())
      .post('/api/workspaces/ws-1/channels/chan-1/assistants')
      .send({ assistantId: ASSISTANT_UUID })
    expect(res.status).toBe(200)
    expect(res.body.assistant.assistantId).toBe(ASSISTANT_UUID)
  })

  it('409s when attach hits a unique/trigger conflict', async () => {
    vi.mocked(getChannelForUser).mockResolvedValue(makeChannel())
    vi.mocked(attachAssistant).mockRejectedValue(new Error('duplicate key'))
    const res = await request(buildApp())
      .post('/api/workspaces/ws-1/channels/chan-1/assistants')
      .send({ assistantId: ASSISTANT_UUID })
    expect(res.status).toBe(409)
  })

  it('404s detach when the routing row is not on this channel', async () => {
    vi.mocked(getChannelForUser).mockResolvedValue(makeChannel())
    vi.mocked(listChannelAssistants).mockResolvedValue([])
    const res = await request(buildApp())
      .delete('/api/workspaces/ws-1/channels/chan-1/assistants/ca-999')
    expect(res.status).toBe(404)
    expect(detachAssistant).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/channels-route] DELETE channel', () => {
  it('deletes a channel', async () => {
    vi.mocked(getChannelForUser).mockResolvedValue(makeChannel())
    vi.mocked(deleteChannel).mockResolvedValue(true)
    const res = await request(buildApp()).delete('/api/workspaces/ws-1/channels/chan-1')
    expect(res.status).toBe(204)
    expect(deleteChannel).toHaveBeenCalledWith('user-1', 'chan-1')
  })

  it('tears down the Gateway socket when deleting a discord channel', async () => {
    vi.mocked(getChannelForUser).mockResolvedValue(
      makeChannel({ id: 'chan-dc', channelType: 'discord' }),
    )
    vi.mocked(deleteChannel).mockResolvedValue(true)
    const disconnect = vi.fn().mockResolvedValue(undefined)
    const discordConnector = { disconnect } as unknown as DiscordConnectorClient
    const res = await request(buildApp({ discordConnector })).delete(
      '/api/workspaces/ws-1/channels/chan-dc',
    )
    expect(res.status).toBe(204)
    expect(disconnect).toHaveBeenCalledWith('chan-dc')
  })

  it('does NOT call the connector when deleting a non-discord channel', async () => {
    vi.mocked(getChannelForUser).mockResolvedValue(makeChannel({ channelType: 'slack' }))
    vi.mocked(deleteChannel).mockResolvedValue(true)
    const disconnect = vi.fn()
    const discordConnector = { disconnect } as unknown as DiscordConnectorClient
    const res = await request(buildApp({ discordConnector })).delete(
      '/api/workspaces/ws-1/channels/chan-1',
    )
    expect(res.status).toBe(204)
    expect(disconnect).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/channels-route] channel config', () => {
  it('GET enriches each channel with its integration config + integrationId', async () => {
    vi.mocked(listChannelsForWorkspace).mockResolvedValue([makeChannel()])
    const integrationStore = {
      listForWorkspace: vi
        .fn()
        .mockResolvedValue([makeIntegration({ config: { requireMention: false } })]),
      updateConfig: vi.fn(),
    } as unknown as ChannelIntegrationStore
    const res = await request(buildApp({ integrationStore })).get(
      '/api/workspaces/ws-1/channels',
    )
    expect(res.status).toBe(200)
    expect(res.body.channels[0].integrationId).toBe('int-1')
    expect(res.body.channels[0].config).toEqual({ requireMention: false })
  })

  it('GET returns null config when no integration store is configured', async () => {
    vi.mocked(listChannelsForWorkspace).mockResolvedValue([makeChannel()])
    const res = await request(buildApp()).get('/api/workspaces/ws-1/channels')
    expect(res.status).toBe(200)
    expect(res.body.channels[0].config).toBeNull()
    expect(res.body.channels[0].integrationId).toBeNull()
  })

  it('PATCH config 503s when no integration store is configured', async () => {
    const res = await request(buildApp())
      .patch('/api/workspaces/ws-1/channels/chan-1/config')
      .send({ requireMention: false })
    expect(res.status).toBe(503)
  })

  it('PATCH config rejects an unknown field with 400', async () => {
    const integrationStore = {
      listForWorkspace: vi.fn(),
      updateConfig: vi.fn(),
    } as unknown as ChannelIntegrationStore
    const res = await request(buildApp({ integrationStore }))
      .patch('/api/workspaces/ws-1/channels/chan-1/config')
      .send({ bogusField: true })
    expect(res.status).toBe(400)
  })

  it('PATCH config 404s when the channel has no integration', async () => {
    vi.mocked(getChannelForUser).mockResolvedValue(makeChannel())
    const integrationStore = {
      listForWorkspace: vi.fn().mockResolvedValue([]),
      updateConfig: vi.fn(),
    } as unknown as ChannelIntegrationStore
    const res = await request(buildApp({ integrationStore }))
      .patch('/api/workspaces/ws-1/channels/chan-1/config')
      .send({ requireMention: false })
    expect(res.status).toBe(404)
  })

  it('PATCH config merges the patch into the stored config', async () => {
    vi.mocked(getChannelForUser).mockResolvedValue(makeChannel())
    const updateConfig = vi
      .fn()
      .mockResolvedValue(
        makeIntegration({ config: { ackReaction: 'eyes', requireMention: false } }),
      )
    const integrationStore = {
      listForWorkspace: vi
        .fn()
        .mockResolvedValue([makeIntegration({ config: { ackReaction: 'eyes' } })]),
      updateConfig,
    } as unknown as ChannelIntegrationStore
    const res = await request(buildApp({ integrationStore }))
      .patch('/api/workspaces/ws-1/channels/chan-1/config')
      .send({ requireMention: false })
    expect(res.status).toBe(200)
    // Existing `ackReaction` survives; the patch's `requireMention` is added.
    expect(updateConfig).toHaveBeenCalledWith({
      actingUserId: 'user-1',
      id: 'int-1',
      config: { ackReaction: 'eyes', requireMention: false },
    })
    expect(res.body.channel.config).toEqual({
      ackReaction: 'eyes',
      requireMention: false,
    })
  })

  it('PATCH config rejects a non-member with 403', async () => {
    const res = await request(buildApp({ role: null }))
      .patch('/api/workspaces/ws-1/channels/chan-1/config')
      .send({ requireMention: false })
    expect(res.status).toBe(403)
  })
})

describe('[COMP:api/channels-route] workspace-driven connect', () => {
  it('POST /slack rejects invalid body with 400', async () => {
    const integrationStore = {
      upsert: vi.fn(),
      listForWorkspace: vi.fn().mockResolvedValue([]),
    } as unknown as ChannelIntegrationStore
    const res = await request(buildApp({ integrationStore }))
      .post('/api/workspaces/ws-1/channels/slack')
      .send({ botToken: 'not-xoxb', signingSecret: 'short' })
    expect(res.status).toBe(400)
  })

  it('POST /slack 503s when no integration store is configured', async () => {
    const res = await request(buildApp())
      .post('/api/workspaces/ws-1/channels/slack')
      .send({ botToken: 'xoxb-abc', signingSecret: 'longenough-secret-1234' })
    expect(res.status).toBe(503)
  })

  it('POST /msteams 201s, stores encrypted creds, and returns the webhook path', async () => {
    vi.mocked(validateMsTeamsCredentials).mockResolvedValue({ appId: 'app-1', tenantId: 'tid-1', botId: '28:app-1' })
    vi.mocked(findOrCreateChannelForWorkspaceConnect).mockResolvedValue({ channelId: 'chan-mt', reused: false })
    vi.mocked(getChannelForUser).mockResolvedValue(
      makeChannel({ id: 'chan-mt', channelType: 'msteams', displayName: 'Microsoft Teams' }),
    )
    const upsert = vi.fn()
    const integrationStore = {
      upsert,
      listForWorkspace: vi.fn().mockResolvedValue([
        makeIntegration({ id: 'int-mt', channelId: 'chan-mt', channelType: 'msteams' }),
      ]),
    } as unknown as ChannelIntegrationStore
    const res = await request(buildApp({ integrationStore }))
      .post('/api/workspaces/ws-1/channels/msteams')
      .send({ appId: 'app-1', appPassword: 'secret', tenantId: 'tid-1' })
    expect(res.status).toBe(201)
    expect(res.body.channel.id).toBe('chan-mt')
    expect(res.body.webhookPath).toBe('/webhook/msteams/chan-mt')
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: 'msteams',
        credentials: { app_id: 'app-1', app_password: 'secret', tenant_id: 'tid-1' },
      }),
    )
  })

  it('POST /msteams 400s when Azure rejects the credentials', async () => {
    vi.mocked(validateMsTeamsCredentials).mockRejectedValue(new Error('AADSTS7000215: bad secret'))
    const integrationStore = {
      upsert: vi.fn(),
      listForWorkspace: vi.fn().mockResolvedValue([]),
    } as unknown as ChannelIntegrationStore
    const res = await request(buildApp({ integrationStore }))
      .post('/api/workspaces/ws-1/channels/msteams')
      .send({ appId: 'app-1', appPassword: 'bad', tenantId: 'tid-1' })
    expect(res.status).toBe(400)
    expect(res.body.detail).toContain('AADSTS7000215')
  })

  it('POST /slack 400s when Slack rejects the credentials', async () => {
    vi.mocked(validateSlackCredentials).mockRejectedValue(new Error('invalid_auth'))
    const integrationStore = {
      upsert: vi.fn(),
      listForWorkspace: vi.fn().mockResolvedValue([]),
    } as unknown as ChannelIntegrationStore
    const res = await request(buildApp({ integrationStore }))
      .post('/api/workspaces/ws-1/channels/slack')
      .send({ botToken: 'xoxb-abc', signingSecret: 'longenough-secret-1234' })
    expect(res.status).toBe(400)
    expect(res.body.detail).toContain('invalid_auth')
  })

  it('POST /slack 201s with the new channel + webhookPath on success', async () => {
    vi.mocked(validateSlackCredentials).mockResolvedValue({
      teamId: 'T123',
      teamName: 'Acme',
      botUserId: 'U999',
    })
    vi.mocked(findOrCreateChannelForWorkspaceConnect).mockResolvedValue({
      channelId: 'chan-new',
      reused: false,
    })
    vi.mocked(getChannelForUser).mockResolvedValue(
      makeChannel({ id: 'chan-new', displayName: 'Acme' }),
    )
    const upsert = vi.fn()
    const integrationStore = {
      upsert,
      listForWorkspace: vi
        .fn()
        .mockResolvedValue([
          makeIntegration({ id: 'int-new', channelId: 'chan-new', teamId: 'T123' }),
        ]),
    } as unknown as ChannelIntegrationStore
    const res = await request(buildApp({ integrationStore }))
      .post('/api/workspaces/ws-1/channels/slack')
      .send({
        botToken: 'xoxb-abc',
        signingSecret: 'longenough-secret-1234',
        defaultAssistantId: ASSISTANT_UUID,
      })
    expect(res.status).toBe(201)
    expect(res.body.channel.id).toBe('chan-new')
    expect(res.body.webhookPath).toBe('/webhook/slack/chan-new')
    expect(res.body.webhookUrl).toBeNull()
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'chan-new',
        channelType: 'slack',
        teamId: 'T123',
        botUserId: 'U999',
      }),
    )
  })

  it('POST /telegram 503s when apiUrl is not configured', async () => {
    const integrationStore = {
      upsert: vi.fn(),
      listForWorkspace: vi.fn().mockResolvedValue([]),
    } as unknown as ChannelIntegrationStore
    const res = await request(buildApp({ integrationStore }))
      .post('/api/workspaces/ws-1/channels/telegram')
      .send({ botToken: '12345:ABC' })
    expect(res.status).toBe(503)
  })

  it('POST /telegram 201s and auto-registers the webhook against the new channel id', async () => {
    vi.mocked(validateTelegramCredentials).mockResolvedValue({
      botId: 12345,
      botUsername: 'mybot',
      firstName: 'My Bot',
    })
    vi.mocked(findOrCreateChannelForWorkspaceConnect).mockResolvedValue({
      channelId: 'chan-tg',
      reused: false,
    })
    const setWebhook = vi.fn().mockResolvedValue(undefined)
    vi.mocked(createTelegramApi).mockReturnValue({ setWebhook } as never)
    vi.mocked(getChannelForUser).mockResolvedValue(
      makeChannel({
        id: 'chan-tg',
        channelType: 'telegram',
        displayName: 'My Bot',
      }),
    )
    const integrationStore = {
      upsert: vi.fn(),
      listForWorkspace: vi.fn().mockResolvedValue([
        makeIntegration({
          id: 'int-tg',
          channelId: 'chan-tg',
          channelType: 'telegram',
          botUserId: '12345',
        }),
      ]),
    } as unknown as ChannelIntegrationStore
    const res = await request(
      buildApp({ integrationStore, apiUrl: 'https://api.example.com' }),
    )
      .post('/api/workspaces/ws-1/channels/telegram')
      .send({ botToken: '12345:ABC-token' })
    expect(res.status).toBe(201)
    expect(res.body.channel.id).toBe('chan-tg')
    expect(res.body.botUsername).toBe('mybot')
    expect(setWebhook).toHaveBeenCalledWith(
      'https://api.example.com/webhook/telegram/chan-tg',
      expect.any(String),
    )
  })

  it('POST /discord 503s when the connector is not configured', async () => {
    const integrationStore = {
      upsert: vi.fn(),
      listForWorkspace: vi.fn().mockResolvedValue([]),
    } as unknown as ChannelIntegrationStore
    const res = await request(buildApp({ integrationStore }))
      .post('/api/workspaces/ws-1/channels/discord')
      .send({ botToken: 'discord-bot-token' })
    expect(res.status).toBe(503)
  })

  it('POST /discord 201s, stores the integration, and opens the Gateway socket', async () => {
    vi.mocked(validateDiscordCredentials).mockResolvedValue({
      botId: '987654321',
      botUsername: 'sidanbot',
    })
    vi.mocked(findOrCreateChannelForWorkspaceConnect).mockResolvedValue({
      channelId: 'chan-dc',
      reused: false,
    })
    vi.mocked(getChannelForUser).mockResolvedValue(
      makeChannel({ id: 'chan-dc', channelType: 'discord', displayName: 'sidanbot' }),
    )
    const upsert = vi.fn()
    const integrationStore = {
      upsert,
      listForWorkspace: vi.fn().mockResolvedValue([
        makeIntegration({ id: 'int-dc', channelId: 'chan-dc', channelType: 'discord', botUserId: '987654321' }),
      ]),
    } as unknown as ChannelIntegrationStore
    const connect = vi.fn().mockResolvedValue({ channelId: 'chan-dc', status: 'connecting' })
    const discordConnector = { connect } as unknown as DiscordConnectorClient

    const res = await request(buildApp({ integrationStore, discordConnector }))
      .post('/api/workspaces/ws-1/channels/discord')
      .send({ botToken: 'discord-bot-token', defaultAssistantId: ASSISTANT_UUID })

    expect(res.status).toBe(201)
    expect(res.body.channel.id).toBe('chan-dc')
    expect(res.body.botUsername).toBe('sidanbot')
    expect(res.body.connectorError).toBeNull()
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'chan-dc',
        channelType: 'discord',
        botUserId: '987654321',
        credentials: { bot_token: 'discord-bot-token' },
      }),
    )
    expect(connect).toHaveBeenCalledWith('chan-dc', {
      botToken: 'discord-bot-token',
      botUserId: '987654321',
    })
  })

  it('POST /discord still 201s but reports connectorError when the socket open fails', async () => {
    vi.mocked(validateDiscordCredentials).mockResolvedValue({ botId: '1', botUsername: 'b' })
    vi.mocked(findOrCreateChannelForWorkspaceConnect).mockResolvedValue({ channelId: 'chan-dc', reused: false })
    vi.mocked(getChannelForUser).mockResolvedValue(makeChannel({ id: 'chan-dc', channelType: 'discord' }))
    const integrationStore = {
      upsert: vi.fn(),
      listForWorkspace: vi.fn().mockResolvedValue([]),
    } as unknown as ChannelIntegrationStore
    const discordConnector = {
      connect: vi.fn().mockRejectedValue(new Error('connector unreachable')),
    } as unknown as DiscordConnectorClient

    const res = await request(buildApp({ integrationStore, discordConnector }))
      .post('/api/workspaces/ws-1/channels/discord')
      .send({ botToken: 'discord-bot-token' })

    expect(res.status).toBe(201)
    expect(res.body.connectorError).toContain('connector unreachable')
  })
})

describe('[COMP:api/slack-channels-route] GET slack-channels', () => {
  function slackIntegrationStore(
    over: { list?: unknown[]; creds?: unknown } = {},
  ): ChannelIntegrationStore {
    return {
      listForWorkspace: vi
        .fn()
        .mockResolvedValue(
          over.list ?? [makeIntegration({ id: 'int-slack', channelType: 'slack' })],
        ),
      getForUserWithCredentials: vi
        .fn()
        .mockResolvedValue(over.creds ?? { credentials: { bot_token: 'xoxb-1' } }),
    } as unknown as ChannelIntegrationStore
  }

  function mockConversationsList(
    channels: Array<{
      id: string
      name: string
      isMember: boolean
      isArchived: boolean
      isPrivate: boolean
    }>,
  ) {
    vi.mocked(createSlackApi).mockReturnValue({
      conversationsList: vi.fn().mockResolvedValue({ channels }),
    } as unknown as ReturnType<typeof createSlackApi>)
  }

  it('returns the workspace Slack channels by name, archived dropped, member-first', async () => {
    mockConversationsList([
      { id: 'C2', name: 'random', isMember: false, isArchived: false, isPrivate: false },
      { id: 'C1', name: 'dev-work', isMember: true, isArchived: false, isPrivate: false },
      { id: 'C3', name: 'old', isMember: true, isArchived: true, isPrivate: false },
    ])
    const res = await request(
      buildApp({ integrationStore: slackIntegrationStore() }),
    ).get('/api/workspaces/ws-1/slack-channels')
    expect(res.status).toBe(200)
    // archived 'old' dropped; members first (C1), then by name (C2).
    expect(res.body.channels).toEqual([
      { id: 'C1', name: 'dev-work', isMember: true },
      { id: 'C2', name: 'random', isMember: false },
    ])
  })

  it('returns empty when the workspace has no Slack integration', async () => {
    const res = await request(
      buildApp({
        integrationStore: slackIntegrationStore({
          list: [makeIntegration({ channelType: 'telegram' })],
        }),
      }),
    ).get('/api/workspaces/ws-1/slack-channels')
    expect(res.status).toBe(200)
    expect(res.body.channels).toEqual([])
  })

  it('returns empty (not 500) when Slack enumeration fails', async () => {
    vi.mocked(createSlackApi).mockReturnValue({
      conversationsList: vi
        .fn()
        .mockRejectedValue(new Error('Slack API conversations.list: missing_scope')),
    } as unknown as ReturnType<typeof createSlackApi>)
    const res = await request(
      buildApp({ integrationStore: slackIntegrationStore() }),
    ).get('/api/workspaces/ws-1/slack-channels')
    expect(res.status).toBe(200)
    expect(res.body.channels).toEqual([])
  })

  it('rejects a non-member with 403', async () => {
    const res = await request(buildApp({ role: null })).get(
      '/api/workspaces/ws-1/slack-channels',
    )
    expect(res.status).toBe(403)
  })

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(buildApp({ userId: null })).get(
      '/api/workspaces/ws-1/slack-channels',
    )
    expect(res.status).toBe(401)
  })
})

describe('[COMP:api/channel-destinations-route] GET channel-destinations', () => {
  type DestRow = { channelType: string; channelId: string; title: string | null; lastActiveAt: Date }
  function destRow(over: Partial<DestRow> = {}): DestRow {
    return {
      channelType: 'telegram',
      channelId: '880211324',
      title: null,
      lastActiveAt: new Date('2026-06-29T09:45:15Z'),
      ...over,
    }
  }
  function mockRows(rows: DestRow[]) {
    vi.mocked(queryWithRLS).mockResolvedValue({ rows } as never)
  }
  function telegramIntegrationStore(): ChannelIntegrationStore {
    return {
      listForWorkspace: vi
        .fn()
        .mockResolvedValue([makeIntegration({ id: 'int-tg', channelType: 'telegram' })]),
      getForUserWithCredentials: vi
        .fn()
        .mockResolvedValue({ credentials: { bot_token: 'byo-token' } }),
    } as unknown as ChannelIntegrationStore
  }
  function telegramApi(getChat: ReturnType<typeof vi.fn>) {
    return { getChat } as unknown as ReturnType<typeof createTelegramApi>
  }

  it('drops rows whose id cannot be valid for their channel type', async () => {
    mockRows([
      // The two mistyped legacy shapes from the cross-wire delivery bug:
      destRow({ channelType: 'slack', channelId: '3fa7eadc-5316-4677-a75c-90bdd16f739c' }),
      destRow({ channelType: 'slack', channelId: '880211324' }),
      destRow({ channelType: 'slack', channelId: 'C0BB4AK5BHB' }),
      destRow({ channelType: 'telegram', channelId: 'not-a-chat-id' }),
      destRow({ channelType: 'telegram', channelId: '-100555' }),
      // WhatsApp JIDs pass through unfiltered.
      destRow({ channelType: 'whatsapp', channelId: '1203630@g.us' }),
    ])
    const res = await request(buildApp()).get('/api/workspaces/ws-1/channel-destinations')
    expect(res.status).toBe(200)
    expect(res.body.destinations.map((d: { channelId: string }) => d.channelId)).toEqual([
      'C0BB4AK5BHB',
      '-100555',
      '1203630@g.us',
    ])
  })

  it('resolves a telegram group title via the BYO bot without consulting the default bot', async () => {
    mockRows([destRow({ channelId: '-100555' })])
    const getChat = vi.fn().mockResolvedValue({ id: -100555, type: 'supergroup', title: 'Dev Work' })
    vi.mocked(createTelegramApi).mockReturnValue(telegramApi(getChat))
    const res = await request(
      buildApp({ integrationStore: telegramIntegrationStore(), telegramBotToken: 'default-token' }),
    ).get('/api/workspaces/ws-1/channel-destinations')
    expect(res.status).toBe(200)
    expect(res.body.destinations[0]).toMatchObject({ channelId: '-100555', title: 'Dev Work' })
    // BYO token is tried first; the hit short-circuits the default bot.
    expect(vi.mocked(createTelegramApi).mock.calls[0][0]).toEqual({ token: 'byo-token' })
    expect(getChat).toHaveBeenCalledTimes(1)
  })

  it('falls back to the hosted default bot when the BYO bot cannot see the chat', async () => {
    mockRows([destRow({ channelId: '880211324' })])
    const byoGetChat = vi.fn().mockRejectedValue(new Error('Telegram API getChat: chat not found'))
    const defaultGetChat = vi
      .fn()
      .mockResolvedValue({ id: 880211324, type: 'private', first_name: 'Hinson', last_name: 'Wong' })
    vi.mocked(createTelegramApi)
      .mockReturnValueOnce(telegramApi(byoGetChat))
      .mockReturnValueOnce(telegramApi(defaultGetChat))
    const res = await request(
      buildApp({ integrationStore: telegramIntegrationStore(), telegramBotToken: 'default-token' }),
    ).get('/api/workspaces/ws-1/channel-destinations')
    expect(res.body.destinations[0].title).toBe('Hinson Wong')
    expect(vi.mocked(createTelegramApi).mock.calls.map((c) => c[0])).toEqual([
      { token: 'byo-token' },
      { token: 'default-token' },
    ])
  })

  it('falls back to @username for a private chat with no name', async () => {
    mockRows([destRow({ channelId: '424242' })])
    const getChat = vi.fn().mockResolvedValue({ id: 424242, type: 'private', username: 'hinson' })
    vi.mocked(createTelegramApi).mockReturnValue(telegramApi(getChat))
    const res = await request(
      buildApp({ telegramBotToken: 'default-token' }),
    ).get('/api/workspaces/ws-1/channel-destinations')
    expect(res.body.destinations[0].title).toBe('@hinson')
  })

  it('keeps the row with a null title when no bot can resolve the chat', async () => {
    mockRows([destRow({ channelId: '880211324' })])
    const getChat = vi.fn().mockRejectedValue(new Error('Telegram API getChat: chat not found'))
    vi.mocked(createTelegramApi).mockReturnValue(telegramApi(getChat))
    const res = await request(
      buildApp({ integrationStore: telegramIntegrationStore(), telegramBotToken: 'default-token' }),
    ).get('/api/workspaces/ws-1/channel-destinations')
    expect(res.status).toBe(200)
    expect(res.body.destinations[0]).toMatchObject({ channelId: '880211324', title: null })
  })

  it('skips resolution entirely when no bot token is configured', async () => {
    mockRows([destRow({ channelId: '880211324' })])
    const res = await request(buildApp()).get('/api/workspaces/ws-1/channel-destinations')
    expect(res.status).toBe(200)
    expect(res.body.destinations[0].title).toBeNull()
    expect(vi.mocked(createTelegramApi)).not.toHaveBeenCalled()
  })

  it('never overwrites a session title with a resolved name', async () => {
    mockRows([destRow({ channelId: '880211324', title: 'Standup thread' })])
    const getChat = vi.fn()
    vi.mocked(createTelegramApi).mockReturnValue(telegramApi(getChat))
    const res = await request(
      buildApp({ telegramBotToken: 'default-token' }),
    ).get('/api/workspaces/ws-1/channel-destinations')
    expect(res.body.destinations[0].title).toBe('Standup thread')
    expect(getChat).not.toHaveBeenCalled()
  })

  it('rejects a non-member with 403', async () => {
    const res = await request(buildApp({ role: null })).get(
      '/api/workspaces/ws-1/channel-destinations',
    )
    expect(res.status).toBe(403)
  })

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(buildApp({ userId: null })).get(
      '/api/workspaces/ws-1/channel-destinations',
    )
    expect(res.status).toBe(401)
  })
})
