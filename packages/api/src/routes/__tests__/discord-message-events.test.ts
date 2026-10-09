import { expectMentionMatches } from './incoming-event-assertions.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'
vi.mock('../../message-events.js', () => ({ dispatchIncomingMessageEvent: vi.fn(async () => {}) }))
vi.mock('../../db/channels-store.js', () => ({
  getChannelForWebhook: vi.fn(async () => ({ workspaceId: 'ws', status: 'active', enabledCapabilities: [] })),
  resolveRoutingForSurface: vi.fn(),
}))
import { dispatchIncomingMessageEvent } from '../../message-events.js'
import { getChannelForWebhook, resolveRoutingForSurface } from '../../db/channels-store.js'
import { discordRoutes } from '../discord.js'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getChannelForWebhook).mockResolvedValue({ workspaceId: 'ws', status: 'active', enabledCapabilities: ['chat'] } as never)
})
describe.each([{ capabilities: [] }, { capabilities: ['chat'] }])('Discord incoming workflow events ($capabilities)', ({ capabilities }) => {
  beforeEach(() => {
    vi.mocked(getChannelForWebhook).mockResolvedValue({ workspaceId: 'ws', status: 'active', enabledCapabilities: capabilities } as never)
  })
  it.each([
    ['passive', { text: 'hello', isMentioned: false }, {}, 'secret', 1],
    ['media-only', { text: '', files: [{ url: 'https://example.com/file', name: 'f', mimeType: 'audio/mpeg' }] }, {}, 'secret', 1],
    ['self', { userId: 'bot' }, {}, 'secret', 0],
    ['bot', { raw: { author: { bot: true } } }, {}, 'secret', 0],
    ['blocked', {}, { userAccessMode: 'blocklist', blockedUserIds: ['user'] }, 'secret', 0],
    ['not allowed', {}, { userAccessMode: 'allowlist', allowedUserIds: ['other'] }, 'secret', 0],
    ['unauthenticated', {}, {}, 'wrong', 0],
    ['invalid', { userId: '' }, {}, 'secret', 0],
  ])('%s before chat gating', async (_name, fields, config, secret, count) => {
    const app = createTestApp('/discord', discordRoutes({
      connectorSecret: 'secret', integrationStore: { getByChannelForWebhook: vi.fn(async () => ({
        id: 'integration', botUserId: 'bot', config, credentials: { bot_token: 'token' },
      })) }, tools: new Map(),
    } as never))
    await request(app).post('/discord/inbound').set('X-Connector-Secret', secret).send({
      channelId: 'channel', message: { userId: 'user', channelId: 'room', text: 'hello', messageId: 'msg', timestamp: 1700000000000, isGroupChat: true, ...fields },
    })
    await new Promise(r => setImmediate(r))
    expect(dispatchIncomingMessageEvent).toHaveBeenCalledTimes(count)
    // With chat on, an un-mentioned group message resolves its assistant so a
    // bound group can keep it as a room post (unified-sessions D4); it still
    // runs no turn. Rejected messages never reach routing.
    if (count === 0 || !capabilities.includes('chat')) expect(resolveRoutingForSurface).not.toHaveBeenCalled()
    if (count) expect(dispatchIncomingMessageEvent).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws', integrationId: 'integration', incoming: expect.objectContaining({ channelType: 'discord', messageId: 'msg', timestamp: 1700000000 }),
    }))
  })
})


it('matches Discord user and role mention IDs from the original Gateway message', async () => {
  const app = createTestApp('/discord', discordRoutes({
    connectorSecret: 'secret', integrationStore: { getByChannelForWebhook: vi.fn(async () => ({
      id: 'integration', botUserId: 'bot', config: {}, credentials: { bot_token: 'token' },
    })) }, tools: new Map(),
  } as never))
  await request(app).post('/discord/inbound').set('X-Connector-Secret', 'secret').send({
    channelId: 'channel', message: { userId: 'user', channelId: 'room', text: 'Hi', messageId: 'msg', timestamp: 1700000000000,
      isGroupChat: true, isMentioned: false,
      raw: { mentions: [{ id: 'member-1' }, { id: 'member-1' }, { id: 'member-2' }], mention_roles: ['role-1'] },
    },
  })
  await new Promise(r => setImmediate(r))
  expect(dispatchIncomingMessageEvent).toHaveBeenCalledOnce()
  await expectMentionMatches(vi.mocked(dispatchIncomingMessageEvent).mock.calls[0][0], ['member-1', 'member-2', 'role-1'])
})

it('dispatches a real mention-only normalization without starting an empty chat turn', async () => {
  const { createDiscordAdapter } = await import('@use-brian/channels')
  const raw = { id: 'mention-only', channel_id: 'room', guild_id: 'guild',
    author: { id: 'user', username: 'User' }, content: '<@bot>', mentions: [{ id: 'bot', username: 'Bot' }],
    timestamp: '2026-01-01T00:00:00Z',
  }
  // Same normalization config as the Gateway connector; the chat default stays null.
  expect(createDiscordAdapter({ token: 'token', botUserId: 'bot' }).parseIncoming(raw)).toBeNull()
  const incoming = createDiscordAdapter({ token: 'token', botUserId: 'bot',
    config: { requireMention: false, preserveMentionOnly: true },
  }).parseIncoming(raw)
  expect(incoming).toMatchObject({ text: '', isMentioned: true })
  const app = createTestApp('/discord', discordRoutes({
    connectorSecret: 'secret', integrationStore: { getByChannelForWebhook: vi.fn(async () => ({
      id: 'integration', botUserId: 'bot', config: {}, credentials: { bot_token: 'token' },
    })) }, tools: new Map(),
  } as never))
  await request(app).post('/discord/inbound').set('X-Connector-Secret', 'secret').send({ channelId: 'channel', message: incoming })
  await new Promise(r => setImmediate(r))
  expect(dispatchIncomingMessageEvent).toHaveBeenCalledOnce()
  await expectMentionMatches(vi.mocked(dispatchIncomingMessageEvent).mock.calls[0][0], ['bot'])
  expect(resolveRoutingForSurface).not.toHaveBeenCalled()
})
