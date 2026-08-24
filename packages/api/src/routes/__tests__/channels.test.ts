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
  resolveRoutingForSurface: vi.fn(),
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
  validateWhatsAppCloudCredentials: vi.fn(),
  subscribeWhatsAppCloudApp: vi.fn(),
  DEFAULT_WHATSAPP_GRAPH_API_VERSION: 'v26.0',
  TELEGRAM_BOT_COMMANDS: [{ command: 'ask', description: 'Ask Brian anything' }],
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

vi.mock('../../feishu/client.js', () => ({
  validateFeishuCredentials: vi.fn(),
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
  resolveRoutingForSurface,
  type Channel,
} from '../../db/channels-store.js'
import {
  validateSlackCredentials,
  validateTelegramCredentials,
  validateDiscordCredentials,
  validateMsTeamsCredentials,
  validateWhatsAppCloudCredentials,
  subscribeWhatsAppCloudApp,
  createTelegramApi,
  createSlackApi,
} from '@use-brian/channels'
import { channelsRoutes, normalizeWhatsAppPhoneNumber } from '../channels.js'
import { queryWithRLS } from '../../db/client.js'
import type { WorkspaceStore } from '../../db/workspace-store.js'
import type { ChannelIntegrationStore } from '../../db/channel-integrations.js'
import type { DiscordConnectorClient } from '../../discord/connector-client.js'
import type { FeishuConnectorClient } from '../../feishu/connector-client.js'
import { validateFeishuCredentials } from '../../feishu/client.js'
import type { LinkCodeStore } from '../../db/link-codes.js'
import type { CustomChannelStore } from '../../db/custom-channel-store.js'
import { hashBridgeToken } from '../../db/custom-channel-token.js'

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
    feishuConnector?: FeishuConnectorClient
    telegramBotToken?: string
    ownerPairing?: {
      enabled: boolean
      requiredOnConnect?: boolean
      linkCodeStore: LinkCodeStore
    }
    customChannelStore?: CustomChannelStore
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
      feishuConnector: opts.feishuConnector,
      telegramBotToken: opts.telegramBotToken,
      ownerPairing: opts.ownerPairing,
      customChannelStore: opts.customChannelStore,
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

  it('403s a plain member renaming the channel', async () => {
    vi.mocked(getChannelForUser).mockResolvedValue(makeChannel())
    const res = await request(buildApp({ role: 'member' }))
      .patch('/api/workspaces/ws-1/channels/chan-1')
      .send({ displayName: 'Renamed' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('rename_requires_admin')
    expect(updateChannel).not.toHaveBeenCalled()
  })

  it('lets a plain member still edit clearance and capabilities', async () => {
    vi.mocked(getChannelForUser).mockResolvedValue(makeChannel())
    vi.mocked(updateChannel).mockResolvedValue(makeChannel({ clearance: 'public' }))
    const res = await request(buildApp({ role: 'member' }))
      .patch('/api/workspaces/ws-1/channels/chan-1')
      .send({ clearance: 'public' })
    expect(res.status).toBe(200)
  })

  it('lets the workspace owner rename the channel', async () => {
    vi.mocked(getChannelForUser).mockResolvedValue(makeChannel())
    vi.mocked(updateChannel).mockResolvedValue(makeChannel({ displayName: 'Renamed' }))
    const res = await request(buildApp({ role: 'owner' }))
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

  it('tears down the Feishu long connection after deleting the channel', async () => {
    vi.mocked(getChannelForUser).mockResolvedValue(
      makeChannel({ id: 'chan-feishu', channelType: 'feishu' }),
    )
    vi.mocked(deleteChannel).mockResolvedValue(true)
    const disconnect = vi.fn().mockResolvedValue(undefined)
    const feishuConnector = { disconnect } as unknown as FeishuConnectorClient
    const res = await request(buildApp({ feishuConnector })).delete(
      '/api/workspaces/ws-1/channels/chan-feishu',
    )
    expect(res.status).toBe(204)
    expect(disconnect).toHaveBeenCalledWith('chan-feishu')
  })
})

describe('[COMP:api/channels-route] channel config', () => {
  it('normalizes common WhatsApp phone formatting without guessing a country code', () => {
    expect(normalizeWhatsAppPhoneNumber('+1 (555) 123-4567')).toBe('15551234567')
    expect(normalizeWhatsAppPhoneNumber('44 20 7946 0958')).toBe('442079460958')
    expect(normalizeWhatsAppPhoneNumber('0044 20 7946 0958')).toBe('442079460958')
    expect(normalizeWhatsAppPhoneNumber('09123 45678')).toBeNull()
    expect(normalizeWhatsAppPhoneNumber('555-1234')).toBeNull()
    expect(normalizeWhatsAppPhoneNumber('call-me')).toBeNull()
  })

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
    expect(res.body.channels[0].integrationStatus).toBe('active')
    expect(res.body.channels[0].config).toEqual({ requireMention: false })
  })

  it('GET projects the public WhatsApp number from legacy Cloud credentials', async () => {
    vi.mocked(listChannelsForWorkspace).mockResolvedValue([
      makeChannel({ channelType: 'whatsapp' }),
    ])
    const integration = makeIntegration({
      channelType: 'whatsapp',
      teamId: 'waba-1',
      botUserId: 'phone-1',
      config: {},
    })
    const integrationStore = {
      listForWorkspace: vi.fn().mockResolvedValue([integration]),
      getForUserWithCredentials: vi.fn().mockResolvedValue({
        ...integration,
        credentials: {
          provider: 'cloud_api',
          display_phone_number: '+1 555 123 4567',
        },
      }),
    } as unknown as ChannelIntegrationStore

    const res = await request(buildApp({ integrationStore })).get(
      '/api/workspaces/ws-1/channels',
    )

    expect(res.status).toBe(200)
    expect(res.body.channels[0].config.whatsappDisplayPhoneNumber).toBe('+1 555 123 4567')
  })

  it('GET returns null config when no integration store is configured', async () => {
    vi.mocked(listChannelsForWorkspace).mockResolvedValue([makeChannel()])
    const res = await request(buildApp()).get('/api/workspaces/ws-1/channels')
    expect(res.status).toBe(200)
    expect(res.body.channels[0].config).toBeNull()
    expect(res.body.channels[0].integrationId).toBeNull()
    expect(res.body.channels[0].integrationStatus).toBeNull()
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
      .send({ requireMention: false, allowGuestConnectorTools: true })
    expect(res.status).toBe(200)
    // Existing config survives; both Telegram guest fields are accepted.
    expect(updateConfig).toHaveBeenCalledWith({
      actingUserId: 'user-1',
      id: 'int-1',
      config: {
        ackReaction: 'eyes',
        requireMention: false,
        allowGuestConnectorTools: true,
      },
    })
    expect(res.body.channel.config).toEqual({
      ackReaction: 'eyes',
      requireMention: false,
    })
  })

  it('PATCH config normalizes WhatsApp Cloud allowlist phone numbers', async () => {
    vi.mocked(getChannelForUser).mockResolvedValue(makeChannel({ channelType: 'whatsapp' }))
    const integration = makeIntegration({
      channelType: 'whatsapp',
      teamId: 'waba-1',
      botUserId: 'phone-1',
      config: { whatsappDisplayPhoneNumber: '+1 555 000 0000' },
    })
    const updateConfig = vi.fn().mockImplementation(async ({ config }) => ({ ...integration, config }))
    const integrationStore = {
      listForWorkspace: vi.fn().mockResolvedValue([integration]),
      updateConfig,
    } as unknown as ChannelIntegrationStore

    const res = await request(buildApp({ integrationStore }))
      .patch('/api/workspaces/ws-1/channels/chan-1/config')
      .send({ allowedUserIds: ['+1 (555) 123-4567', '15551234567'] })

    expect(res.status).toBe(200)
    expect(updateConfig).toHaveBeenCalledWith({
      actingUserId: 'user-1',
      id: 'int-1',
      config: {
        whatsappDisplayPhoneNumber: '+1 555 000 0000',
        allowedUserIds: ['15551234567'],
      },
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

  it('POST /whatsapp-cloud provisions official Meta credentials and callback', async () => {
    vi.mocked(validateWhatsAppCloudCredentials).mockResolvedValue({
      id: '123456789', displayPhoneNumber: '+1 555 123 4567', verifiedName: 'Acme Support',
    })
    vi.mocked(subscribeWhatsAppCloudApp).mockResolvedValue(undefined)
    vi.mocked(findOrCreateChannelForWorkspaceConnect).mockResolvedValue({ channelId: 'chan-wa', reused: false })
    vi.mocked(getChannelForUser).mockResolvedValue(
      makeChannel({ id: 'chan-wa', channelType: 'whatsapp', displayName: 'Acme Support' }),
    )
    const integration = makeIntegration({ id: 'int-wa', channelId: 'chan-wa', channelType: 'whatsapp', botUserId: '123456789' })
    const upsert = vi.fn().mockResolvedValue(integration)
    const updateConfig = vi.fn().mockResolvedValue({
      ...integration,
      config: {
        userAccessMode: 'allowlist',
        allowedUserIds: [],
        whatsappDisplayPhoneNumber: '+1 555 123 4567',
      },
    })
    const integrationStore = {
      upsert,
      updateConfig,
      listForWorkspace: vi.fn().mockResolvedValue([
        integration,
      ]),
    } as unknown as ChannelIntegrationStore
    const res = await request(buildApp({ integrationStore, apiUrl: 'https://api.example.com' }))
      .post('/api/workspaces/ws-1/channels/whatsapp-cloud')
      .send({
        accessToken: 'permanent-token', appSecret: 'app-secret-value', verifyToken: 'verify-me-123',
        phoneNumberId: '123456789', wabaId: '987654321',
      })
    expect(res.status).toBe(201)
    expect(res.body.webhookUrl).toBe('https://api.example.com/webhook/whatsapp/chan-wa')
    expect(res.body.verifyToken).toBe('verify-me-123')
    expect(subscribeWhatsAppCloudApp).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumberId: '123456789' }),
      '987654321',
    )
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      channelType: 'whatsapp',
      botUserId: '123456789',
      credentials: expect.objectContaining({
        provider: 'cloud_api', phone_number_id: '123456789', waba_id: '987654321',
      }),
    }))
    expect(updateConfig).toHaveBeenCalledWith({
      actingUserId: 'user-1', id: 'int-wa',
      config: {
        userAccessMode: 'allowlist',
        allowedUserIds: [],
        whatsappDisplayPhoneNumber: '+1 555 123 4567',
      },
    })
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
    const upsertMyCommands = vi.fn().mockResolvedValue(undefined)
    vi.mocked(createTelegramApi).mockReturnValue({ setWebhook, upsertMyCommands } as never)
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
    expect(upsertMyCommands).toHaveBeenCalledWith([
      { command: 'ask', description: 'Ask Brian anything' },
    ])
    expect(res.body.pairingCode).toBeNull()
  })

  it('POST /telegram creates an OSS owner pairing code for the default assistant', async () => {
    vi.mocked(validateTelegramCredentials).mockResolvedValue({
      botId: 12345,
      botUsername: 'mybot',
      firstName: 'My Bot',
    })
    vi.mocked(findOrCreateChannelForWorkspaceConnect).mockResolvedValue({
      channelId: 'chan-tg',
      reused: false,
    })
    vi.mocked(resolveRoutingForSurface).mockResolvedValue({
      id: 'route-1',
      channelId: 'chan-tg',
      assistantId: ASSISTANT_UUID,
      externalSurfaceId: null,
      modelAlias: 'standard',
      createdAt: new Date(),
    })
    vi.mocked(createTelegramApi).mockReturnValue({
      setWebhook: vi.fn().mockResolvedValue(undefined),
      upsertMyCommands: vi.fn().mockResolvedValue(undefined),
    } as never)
    vi.mocked(getChannelForUser).mockResolvedValue(
      makeChannel({ id: 'chan-tg', channelType: 'telegram' }),
    )
    const integrationStore = {
      upsert: vi.fn(),
      listForWorkspace: vi.fn().mockResolvedValue([]),
    } as unknown as ChannelIntegrationStore
    const create = vi.fn().mockResolvedValue({
      code: 'ABC234',
      expiresAt: new Date('2026-07-25T12:15:00Z'),
    })

    const res = await request(buildApp({
      integrationStore,
      apiUrl: 'https://api.example.com',
      ownerPairing: { enabled: true, linkCodeStore: { create } as never },
    }))
      .post('/api/workspaces/ws-1/channels/telegram')
      .send({ botToken: '12345:ABC-token', defaultAssistantId: ASSISTANT_UUID })

    expect(res.status).toBe(201)
    expect(create).toHaveBeenCalledWith({ userId: 'user-1', assistantId: ASSISTANT_UUID })
    expect(res.body).toMatchObject({
      pairingCode: 'ABC234',
      pairingCodeExpiresAt: '2026-07-25T12:15:00.000Z',
    })
  })

  it('POST /telegram keeps hosted pairing optional without a default assistant', async () => {
    vi.mocked(validateTelegramCredentials).mockResolvedValue({
      botId: 12345,
      botUsername: 'mybot',
      firstName: 'My Bot',
    })
    vi.mocked(findOrCreateChannelForWorkspaceConnect).mockResolvedValue({
      channelId: 'chan-tg',
      reused: false,
    })
    vi.mocked(resolveRoutingForSurface).mockResolvedValue(null)
    vi.mocked(createTelegramApi).mockReturnValue({
      setWebhook: vi.fn().mockResolvedValue(undefined),
      upsertMyCommands: vi.fn().mockResolvedValue(undefined),
    } as never)
    vi.mocked(getChannelForUser).mockResolvedValue(
      makeChannel({ id: 'chan-tg', channelType: 'telegram' }),
    )
    const integrationStore = {
      upsert: vi.fn(),
      listForWorkspace: vi.fn().mockResolvedValue([]),
    } as unknown as ChannelIntegrationStore
    const create = vi.fn()

    const res = await request(buildApp({
      integrationStore,
      apiUrl: 'https://api.example.com',
      ownerPairing: { enabled: true, linkCodeStore: { create } as never },
    }))
      .post('/api/workspaces/ws-1/channels/telegram')
      .send({ botToken: '12345:ABC-token' })

    expect(res.status).toBe(201)
    expect(create).not.toHaveBeenCalled()
    expect(res.body.pairingCode).toBeNull()
  })

  it('POST /telegram requires a default assistant for OSS owner pairing', async () => {
    const res = await request(buildApp({
      integrationStore: {} as ChannelIntegrationStore,
      apiUrl: 'https://api.example.com',
      ownerPairing: {
        enabled: true,
        requiredOnConnect: true,
        linkCodeStore: {} as LinkCodeStore,
      },
    }))
      .post('/api/workspaces/ws-1/channels/telegram')
      .send({ botToken: '12345:ABC-token' })

    expect(res.status).toBe(400)
    expect(validateTelegramCredentials).not.toHaveBeenCalled()
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

  it('POST /feishu 201s, encrypts the brand-bound app credentials, and opens the bridge', async () => {
    vi.mocked(validateFeishuCredentials).mockResolvedValue({
      botOpenId: 'ou_bot',
      botName: 'Brian for Lark',
    })
    vi.mocked(findOrCreateChannelForWorkspaceConnect).mockResolvedValue({
      channelId: 'chan-feishu',
      reused: false,
    })
    vi.mocked(getChannelForUser).mockResolvedValue(
      makeChannel({ id: 'chan-feishu', channelType: 'feishu', displayName: 'Brian for Lark' }),
    )
    const upsert = vi.fn()
    const integrationStore = {
      upsert,
      listForWorkspace: vi.fn().mockResolvedValue([
        makeIntegration({ id: 'int-feishu', channelId: 'chan-feishu', channelType: 'feishu', botUserId: 'ou_bot' }),
      ]),
    } as unknown as ChannelIntegrationStore
    const connect = vi.fn().mockResolvedValue({ channelId: 'chan-feishu', status: 'connected' })
    const feishuConnector = { connect } as unknown as FeishuConnectorClient

    const res = await request(buildApp({ integrationStore, feishuConnector }))
      .post('/api/workspaces/ws-1/channels/feishu')
      .send({
        appId: 'cli_lark_app',
        appSecret: 'lark-secret',
        brand: 'lark',
        defaultAssistantId: ASSISTANT_UUID,
      })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      botOpenId: 'ou_bot',
      botName: 'Brian for Lark',
      brand: 'lark',
      connectorError: null,
    })
    expect(validateFeishuCredentials).toHaveBeenCalledWith({
      appId: 'cli_lark_app',
      appSecret: 'lark-secret',
      brand: 'lark',
    })
    expect(findOrCreateChannelForWorkspaceConnect).toHaveBeenCalledWith(expect.objectContaining({
      channelType: 'feishu',
      externalIdentity: { teamId: 'cli_lark_app', botUserId: 'ou_bot' },
    }))
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'chan-feishu',
      channelType: 'feishu',
      teamId: 'cli_lark_app',
      botUserId: 'ou_bot',
      credentials: { app_id: 'cli_lark_app', app_secret: 'lark-secret', brand: 'lark' },
    }))
    expect(connect).toHaveBeenCalledWith('chan-feishu', {
      appId: 'cli_lark_app',
      appSecret: 'lark-secret',
      brand: 'lark',
    })
  })

  it('POST /feishu reports a non-fatal connectorError after credentials are saved', async () => {
    vi.mocked(validateFeishuCredentials).mockResolvedValue({ botOpenId: 'ou_bot', botName: 'Brian' })
    vi.mocked(findOrCreateChannelForWorkspaceConnect).mockResolvedValue({ channelId: 'chan-feishu', reused: false })
    vi.mocked(getChannelForUser).mockResolvedValue(makeChannel({ id: 'chan-feishu', channelType: 'feishu' }))
    const integrationStore = {
      upsert: vi.fn(),
      listForWorkspace: vi.fn().mockResolvedValue([]),
    } as unknown as ChannelIntegrationStore
    const feishuConnector = {
      connect: vi.fn().mockRejectedValue(new Error('websocket handshake failed')),
    } as unknown as FeishuConnectorClient

    const res = await request(buildApp({ integrationStore, feishuConnector }))
      .post('/api/workspaces/ws-1/channels/feishu')
      .send({ appId: 'cli_app', appSecret: 'secret', brand: 'feishu' })

    expect(res.status).toBe(201)
    expect(res.body.connectorError).toContain('websocket handshake failed')
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
      destRow({ channelType: 'telegram', channelId: '-100555:topic:42' }),
      destRow({ channelType: 'telegram', channelId: '-100555:topic:invalid' }),
      destRow({ channelType: 'feishu', channelId: 'not-a-feishu-chat' }),
      destRow({ channelType: 'feishu', channelId: 'oc_project123' }),
      // WhatsApp JIDs pass through unfiltered.
      destRow({ channelType: 'whatsapp', channelId: '1203630@g.us' }),
    ])
    const res = await request(buildApp()).get('/api/workspaces/ws-1/channel-destinations')
    expect(res.status).toBe(200)
    expect(res.body.destinations.map((d: { channelId: string }) => d.channelId)).toEqual([
      'C0BB4AK5BHB',
      '-100555',
      '-100555:topic:42',
      'oc_project123',
      '1203630@g.us',
    ])
  })

  it('normalizes Slack thread sessions to one base-channel destination', async () => {
    mockRows([
      destRow({
        channelType: 'slack',
        channelId: 'C123:thread:100.001',
        title: 'Older thread',
        lastActiveAt: new Date('2026-08-20T01:00:00Z'),
      }),
      destRow({
        channelType: 'slack',
        channelId: 'C123:thread:100.002',
        title: 'Newer thread',
        lastActiveAt: new Date('2026-08-20T02:00:00Z'),
      }),
      destRow({ channelType: 'slack', channelId: 'C456:thread:200.001' }),
    ])

    const res = await request(buildApp()).get('/api/workspaces/ws-1/channel-destinations')

    expect(res.status).toBe(200)
    expect(res.body.destinations).toEqual([
      expect.objectContaining({ channelType: 'slack', channelId: 'C123', title: 'Newer thread' }),
      expect.objectContaining({ channelType: 'slack', channelId: 'C456' }),
    ])
  })

  it('labels a Telegram forum topic from the seen-chat inventory', async () => {
    mockRows([destRow({ channelId: '-100555:topic:42' })])
    const integrationStore = {
      listForWorkspace: vi.fn().mockResolvedValue([
        makeIntegration({
          channelType: 'telegram',
          botUsername: 'project_bot',
          config: {
            seenChats: [{
              chatId: '-100555',
              chatTitle: 'Project Forum',
              isForum: true,
              topics: [{ topicId: 42, name: 'Standups', lastSeenAt: '2026-06-29T09:45:15Z' }],
              lastSeenAt: '2026-06-29T09:45:15Z',
            }],
          },
        }),
      ]),
    } as unknown as ChannelIntegrationStore

    const res = await request(buildApp({ integrationStore }))
      .get('/api/workspaces/ws-1/channel-destinations')

    expect(res.status).toBe(200)
    expect(res.body.destinations[0]).toMatchObject({
      channelId: '-100555:topic:42',
      title: 'Project Forum › Standups',
      channelIntegrationId: 'int-1',
      integrationLabel: '@project_bot',
    })
    expect(vi.mocked(createTelegramApi)).not.toHaveBeenCalled()
  })

  it('preserves a topic name when a newer bot has only seen the base group', async () => {
    mockRows([destRow({ channelId: '-100555:topic:42' })])
    const integrationStore = {
      listForWorkspace: vi.fn().mockResolvedValue([
        makeIntegration({
          id: 'int-project',
          channelType: 'telegram',
          botUsername: 'project_bot',
          config: {
            seenChats: [{
              chatId: '-100555',
              chatTitle: 'Project Forum',
              isForum: true,
              topics: [{ topicId: 42, name: 'Standups', lastSeenAt: '2026-06-29T09:45:15Z' }],
              lastSeenAt: '2026-06-29T09:45:15Z',
            }],
          },
        }),
        makeIntegration({
          id: 'int-new',
          channelType: 'telegram',
          botUsername: 'new_bot',
          config: {
            seenChats: [{
              chatId: '-100555',
              chatTitle: 'Project Forum',
              isForum: true,
              topics: [],
              lastSeenAt: '2026-08-16T09:45:15Z',
            }],
          },
        }),
      ]),
    } as unknown as ChannelIntegrationStore

    const res = await request(buildApp({ integrationStore }))
      .get('/api/workspaces/ws-1/channel-destinations')

    expect(res.status).toBe(200)
    expect(res.body.destinations).toHaveLength(2)
    expect(res.body.destinations.map((d: { title: string }) => d.title)).toEqual([
      'Project Forum › Standups',
      'Project Forum › Standups',
    ])
  })

  it('returns one destination per Telegram channel that can reach the chat', async () => {
    mockRows([destRow({ channelId: '-100555' })])
    const seenChat = {
      chatId: '-100555',
      chatTitle: 'Project Forum',
      isForum: false,
      topics: [],
      lastSeenAt: '2026-06-29T09:45:15Z',
    }
    const integrationStore = {
      listForWorkspace: vi.fn().mockResolvedValue([
        makeIntegration({
          id: 'int-project',
          channelType: 'telegram',
          botUsername: 'project_bot',
          config: { seenChats: [seenChat] },
        }),
        makeIntegration({
          id: 'int-ops',
          channelType: 'telegram',
          botUsername: 'ops_bot',
          config: { seenChats: [seenChat] },
        }),
      ]),
    } as unknown as ChannelIntegrationStore

    const res = await request(buildApp({ integrationStore }))
      .get('/api/workspaces/ws-1/channel-destinations')

    expect(res.status).toBe(200)
    expect(res.body.destinations).toEqual([
      expect.objectContaining({
        channelId: '-100555',
        channelIntegrationId: 'int-project',
        integrationLabel: '@project_bot',
      }),
      expect.objectContaining({
        channelId: '-100555',
        channelIntegrationId: 'int-ops',
        integrationLabel: '@ops_bot',
      }),
    ])
  })

  it('returns one destination per Feishu app that observed the chat', async () => {
    mockRows([destRow({ channelType: 'feishu', channelId: 'oc_project123' })])
    const seenChat = {
      chatId: 'oc_project123',
      chatTitle: null,
      isForum: false,
      topics: [],
      lastSeenAt: '2026-08-24T09:45:15Z',
    }
    const integrationStore = {
      listForWorkspace: vi.fn().mockResolvedValue([
        makeIntegration({
          id: 'int-feishu',
          channelType: 'feishu',
          teamName: 'Mainland app',
          config: { seenChats: [seenChat] },
        }),
        makeIntegration({
          id: 'int-lark',
          channelType: 'feishu',
          teamName: 'Global app',
          config: { seenChats: [seenChat] },
        }),
      ]),
    } as unknown as ChannelIntegrationStore

    const res = await request(buildApp({ integrationStore }))
      .get('/api/workspaces/ws-1/channel-destinations')

    expect(res.status).toBe(200)
    expect(res.body.destinations).toEqual([
      expect.objectContaining({
        channelId: 'oc_project123',
        channelIntegrationId: 'int-feishu',
        integrationLabel: 'Mainland app',
      }),
      expect.objectContaining({
        channelId: 'oc_project123',
        channelIntegrationId: 'int-lark',
        integrationLabel: 'Global app',
      }),
    ])
  })

  it('resolves a topic group by its base chat id and falls back to the topic number', async () => {
    mockRows([destRow({ channelId: '-100555:topic:42' })])
    const getChat = vi.fn().mockResolvedValue({ id: -100555, type: 'supergroup', title: 'Project Forum' })
    vi.mocked(createTelegramApi).mockReturnValue(telegramApi(getChat))

    const res = await request(buildApp({ telegramBotToken: 'default-token' }))
      .get('/api/workspaces/ws-1/channel-destinations')

    expect(res.status).toBe(200)
    expect(getChat).toHaveBeenCalledWith('-100555')
    expect(res.body.destinations[0].title).toBe('Project Forum › #42')
  })

  it('resolves a telegram group title while probing configured bots concurrently', async () => {
    mockRows([destRow({ channelId: '-100555' })])
    const getChat = vi.fn().mockResolvedValue({ id: -100555, type: 'supergroup', title: 'Dev Work' })
    vi.mocked(createTelegramApi).mockReturnValue(telegramApi(getChat))
    const res = await request(
      buildApp({ integrationStore: telegramIntegrationStore(), telegramBotToken: 'default-token' }),
    ).get('/api/workspaces/ws-1/channel-destinations')
    expect(res.status).toBe(200)
    expect(res.body.destinations[0]).toMatchObject({ channelId: '-100555', title: 'Dev Work' })
    // Both candidates start together so lookup stays within one timeout window.
    expect(vi.mocked(createTelegramApi).mock.calls[0][0]).toEqual({ token: 'byo-token' })
    expect(getChat).toHaveBeenCalledTimes(2)
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

  it('keeps a private DM available when it cannot be attributed through seenChats', async () => {
    mockRows([destRow({ channelId: '880211324' })])
    const getChat = vi.fn().mockResolvedValue({
      id: 880211324,
      type: 'private',
      first_name: 'Hinson',
      last_name: 'Wong',
    })
    vi.mocked(createTelegramApi).mockReturnValue(telegramApi(getChat))

    const res = await request(
      buildApp({ integrationStore: telegramIntegrationStore() }),
    ).get('/api/workspaces/ws-1/channel-destinations')

    expect(res.body.destinations).toEqual([
      expect.objectContaining({
        channelId: '880211324',
        title: 'Hinson Wong',
        channelIntegrationId: null,
      }),
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

// ── Custom (bridge-driven) channels ──────────────────────────────
// docs/architecture/channels/custom-channel.md → "Workspace-facing routes".

function makeCustomStore(): CustomChannelStore {
  return {
    putState: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockResolvedValue(null),
    touchSeen: vi.fn().mockResolvedValue(undefined),
    enqueue: vi.fn().mockResolvedValue('item-1'),
    claim: vi.fn().mockResolvedValue([]),
    ack: vi.fn().mockResolvedValue(0),
    expireStale: vi.fn().mockResolvedValue([]),
  }
}

describe('[COMP:api/channels-route] custom channels', () => {
  it('POST /custom 201s, returns a ubc_ token ONCE, and stores only its hash', async () => {
    vi.mocked(findOrCreateChannelForWorkspaceConnect).mockResolvedValue({ channelId: 'chan-cu', reused: false })
    vi.mocked(getChannelForUser).mockResolvedValue(
      makeChannel({ id: 'chan-cu', channelType: 'custom', displayName: 'My WeChat desktop', enabledCapabilities: ['chat'] }),
    )
    const upsert = vi.fn()
    const integrationStore = { upsert, listForWorkspace: vi.fn().mockResolvedValue([]) } as unknown as ChannelIntegrationStore
    const customChannelStore = makeCustomStore()
    const res = await request(buildApp({ integrationStore, customChannelStore }))
      .post('/api/workspaces/ws-1/channels/custom')
      .send({ displayName: 'My WeChat desktop', kind: 'wechat-desktop', defaultAssistantId: ASSISTANT_UUID })
    expect(res.status).toBe(201)
    expect(res.body.channel.id).toBe('chan-cu')
    expect(res.body.bridgeToken).toMatch(/^ubc_[A-Za-z0-9_-]{43}$/)
    expect(res.body.kind).toBe('wechat-desktop')

    expect(findOrCreateChannelForWorkspaceConnect).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1',
      channelType: 'custom',
      displayName: 'My WeChat desktop',
      defaultAssistantId: ASSISTANT_UUID,
      externalIdentity: { botUserId: expect.stringMatching(/^custom:[0-9a-f-]{36}$/) },
    }))
    expect(upsert).toHaveBeenCalledTimes(1)
    const creds = upsert.mock.calls[0][0].credentials as { bridge_token_hash: string; kind?: string }
    expect(creds.kind).toBe('wechat-desktop')
    expect(creds.bridge_token_hash).toBe(hashBridgeToken(res.body.bridgeToken))
    expect(JSON.stringify(upsert.mock.calls[0][0])).not.toContain(res.body.bridgeToken)
    // Seeds the state row so Studio has something to render before the bridge calls in.
    expect(customChannelStore.putState).toHaveBeenCalledWith('chan-cu', expect.objectContaining({ status: 'connecting' }))
  })

  it('POST /custom accepts kind: null / "" from an empty form field as "no kind"', async () => {
    vi.mocked(findOrCreateChannelForWorkspaceConnect).mockResolvedValue({ channelId: 'chan-cu2', reused: false })
    vi.mocked(getChannelForUser).mockResolvedValue(
      makeChannel({ id: 'chan-cu2', channelType: 'custom', displayName: 'Wechat', enabledCapabilities: ['chat'] }),
    )
    const upsert = vi.fn()
    const integrationStore = { upsert, listForWorkspace: vi.fn().mockResolvedValue([]) } as unknown as ChannelIntegrationStore
    for (const kind of [null, '', '  ']) {
      upsert.mockClear()
      const res = await request(buildApp({ integrationStore, customChannelStore: makeCustomStore() }))
        .post('/api/workspaces/ws-1/channels/custom')
        .send({ displayName: 'Wechat', kind, defaultAssistantId: ASSISTANT_UUID })
      expect(res.status).toBe(201)
      expect(res.body.kind).toBe(null)
      const creds = upsert.mock.calls[0][0].credentials as { kind?: string }
      expect(creds.kind).toBeUndefined()
    }
  })

  it('POST /custom 400s on a missing displayName and 503s without the store', async () => {
    const integrationStore = { upsert: vi.fn() } as unknown as ChannelIntegrationStore
    const bad = await request(buildApp({ integrationStore, customChannelStore: makeCustomStore() }))
      .post('/api/workspaces/ws-1/channels/custom')
      .send({})
    expect(bad.status).toBe(400)
    const noStore = await request(buildApp({ integrationStore }))
      .post('/api/workspaces/ws-1/channels/custom')
      .send({ displayName: 'x' })
    expect(noStore.status).toBe(503)
  })

  it('POST /:id/custom/rotate-token mints a new token; the old hash is replaced', async () => {
    vi.mocked(getChannelForUser).mockResolvedValue(makeChannel({ id: 'chan-cu', channelType: 'custom' }))
    const oldHash = hashBridgeToken('ubc_old')
    const upsert = vi.fn()
    const integrationStore = {
      upsert,
      listForWorkspace: vi.fn().mockResolvedValue([
        makeIntegration({ id: 'int-cu', channelId: 'chan-cu', channelType: 'custom', teamName: 'wechat-desktop', botUserId: 'custom:abc' }),
      ]),
      getForUserWithCredentials: vi.fn().mockResolvedValue({
        id: 'int-cu', credentials: { bridge_token_hash: oldHash, kind: 'wechat-desktop' },
      }),
    } as unknown as ChannelIntegrationStore
    const res = await request(buildApp({ integrationStore, customChannelStore: makeCustomStore() }))
      .post('/api/workspaces/ws-1/channels/chan-cu/custom/rotate-token')
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.bridgeToken).toMatch(/^ubc_/)
    const creds = upsert.mock.calls[0][0].credentials as { bridge_token_hash: string; kind?: string }
    expect(creds.bridge_token_hash).toBe(hashBridgeToken(res.body.bridgeToken))
    expect(creds.bridge_token_hash).not.toBe(oldHash)
    expect(creds.kind).toBe('wechat-desktop')
    expect(upsert.mock.calls[0][0]).toMatchObject({ channelId: 'chan-cu', channelType: 'custom', botUserId: 'custom:abc' })
  })

  it('rotate-token 400s for a non-custom channel', async () => {
    vi.mocked(getChannelForUser).mockResolvedValue(makeChannel({ id: 'chan-1', channelType: 'slack' }))
    const integrationStore = { upsert: vi.fn(), listForWorkspace: vi.fn().mockResolvedValue([]) } as unknown as ChannelIntegrationStore
    const res = await request(buildApp({ integrationStore, customChannelStore: makeCustomStore() }))
      .post('/api/workspaces/ws-1/channels/chan-1/custom/rotate-token')
      .send({})
    expect(res.status).toBe(400)
  })

  it('GET /:id/custom/state returns the published state, or a connecting placeholder', async () => {
    vi.mocked(getChannelForUser).mockResolvedValue(makeChannel({ id: 'chan-cu', channelType: 'custom' }))
    const customChannelStore = makeCustomStore()
    vi.mocked(customChannelStore.getState).mockResolvedValueOnce({
      channelId: 'chan-cu', status: 'needs_action', action: { kind: 'qr', text: 'hello' },
      lastSeenAt: '2026-08-19T10:00:00.000Z', updatedAt: '2026-08-19T10:00:00.000Z', online: true, outboxDepth: 2,
    })
    const app = buildApp({ customChannelStore })
    const res = await request(app).get('/api/workspaces/ws-1/channels/chan-cu/custom/state')
    expect(res.status).toBe(200)
    expect(res.body.state).toMatchObject({ status: 'needs_action', action: { kind: 'qr', text: 'hello' }, online: true, outboxDepth: 2 })
    const empty = await request(app).get('/api/workspaces/ws-1/channels/chan-cu/custom/state')
    expect(empty.body.state).toMatchObject({ channelId: 'chan-cu', status: 'connecting', online: false, outboxDepth: 0 })
  })

  it('POST /:id/custom/input enqueues an input item carrying the requestId', async () => {
    vi.mocked(getChannelForUser).mockResolvedValue(makeChannel({ id: 'chan-cu', channelType: 'custom' }))
    const customChannelStore = makeCustomStore()
    const res = await request(buildApp({ customChannelStore }))
      .post('/api/workspaces/ws-1/channels/chan-cu/custom/input')
      .send({ requestId: 'req-7', value: '123456' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, itemId: 'item-1' })
    expect(customChannelStore.enqueue).toHaveBeenCalledWith('chan-cu', {
      type: 'input', peerId: null, payload: { requestId: 'req-7', value: '123456' },
    })
  })

  it('POST /:id/custom/disconnect enqueues a disconnect item and marks the state disconnected', async () => {
    vi.mocked(getChannelForUser).mockResolvedValue(makeChannel({ id: 'chan-cu', channelType: 'custom' }))
    const customChannelStore = makeCustomStore()
    const res = await request(buildApp({ customChannelStore }))
      .post('/api/workspaces/ws-1/channels/chan-cu/custom/disconnect')
      .send({})
    expect(res.status).toBe(200)
    expect(customChannelStore.enqueue).toHaveBeenCalledWith('chan-cu', { type: 'disconnect', peerId: null, payload: {} })
    expect(customChannelStore.putState).toHaveBeenCalledWith('chan-cu', expect.objectContaining({ status: 'disconnected' }))
  })

  it('DELETE a custom channel enqueues disconnect before the cascade', async () => {
    vi.mocked(getChannelForUser).mockResolvedValue(makeChannel({ id: 'chan-cu', channelType: 'custom' }))
    vi.mocked(deleteChannel).mockResolvedValue(true)
    const customChannelStore = makeCustomStore()
    const res = await request(buildApp({ customChannelStore }))
      .delete('/api/workspaces/ws-1/channels/chan-cu')
    expect(res.status).toBe(204)
    expect(customChannelStore.enqueue).toHaveBeenCalledWith('chan-cu', { type: 'disconnect', peerId: null, payload: {} })
    expect(deleteChannel).toHaveBeenCalledWith('user-1', 'chan-cu')
  })
})
