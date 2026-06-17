import { describe, it, expect } from 'vitest'
import { createDeliveryTargetResolver } from '../delivery-target.js'
import type { ChannelIntegrationStore } from '../../db/channel-integrations.js'

/**
 * Minimal fake exposing only `getCredentialsForAssistantSystem` — the single
 * method the resolver touches. Cast through `unknown` so we don't have to stub
 * the full store surface.
 */
function fakeStore(
  impl: ChannelIntegrationStore['getCredentialsForAssistantSystem'],
): ChannelIntegrationStore {
  return { getCredentialsForAssistantSystem: impl } as unknown as ChannelIntegrationStore
}

const seenChatsIntegration = {
  config: {
    seenChats: [
      {
        chatId: '-100123',
        chatTitle: 'GM Bro',
        isForum: true,
        topics: [{ topicId: 42, name: 'Research', lastSeenAt: '2026-05-31T00:00:00Z' }],
        lastSeenAt: '2026-05-31T00:00:00Z',
      },
    ],
  },
  // The resolver never reads credentials — a placeholder keeps the cast honest.
  credentials: { bot_token: 'x' },
} as unknown as Awaited<ReturnType<ChannelIntegrationStore['getCredentialsForAssistantSystem']>>

describe('[COMP:scheduling/delivery-target] createDeliveryTargetResolver', () => {
  it('resolves a Telegram topic to group + topic name with topicId', async () => {
    const resolve = createDeliveryTargetResolver(fakeStore(async () => seenChatsIntegration))
    const r = await resolve({ assistantId: 'a1', channelType: 'telegram', channelId: '-100123:topic:42' })
    expect(r).toEqual({ label: 'Telegram · group "GM Bro" · topic "Research"', topicId: 42 })
  })

  it('resolves a bare Telegram chat (no topic) to the group with no topicId', async () => {
    const resolve = createDeliveryTargetResolver(fakeStore(async () => seenChatsIntegration))
    const r = await resolve({ assistantId: 'a1', channelType: 'telegram', channelId: '-100123' })
    expect(r).toEqual({ label: 'Telegram · group "GM Bro"' })
  })

  it('degrades a topic the bot has not seen by name to "topic #<id>"', async () => {
    const resolve = createDeliveryTargetResolver(fakeStore(async () => seenChatsIntegration))
    const r = await resolve({ assistantId: 'a1', channelType: 'telegram', channelId: '-100123:topic:99' })
    expect(r).toEqual({ label: 'Telegram · group "GM Bro" · topic #99', topicId: 99 })
  })

  it('falls back to chat-id + topic-id labels when no integration store is wired', async () => {
    const resolve = createDeliveryTargetResolver(undefined)
    const r = await resolve({ assistantId: 'a1', channelType: 'telegram', channelId: '-100123:topic:42' })
    expect(r).toEqual({ label: 'Telegram · chat -100123 · topic #42', topicId: 42 })
  })

  it('degrades gracefully (id-only) when the store lookup throws', async () => {
    const resolve = createDeliveryTargetResolver(
      fakeStore(async () => {
        throw new Error('decrypt failed')
      }),
    )
    const r = await resolve({ assistantId: 'a1', channelType: 'telegram', channelId: '-100123:topic:42' })
    expect(r).toEqual({ label: 'Telegram · chat -100123 · topic #42', topicId: 42 })
  })

  it('labels web, slack, and whatsapp targets', async () => {
    const resolve = createDeliveryTargetResolver(fakeStore(async () => null))
    expect(await resolve({ assistantId: 'a1', channelType: 'web', channelId: 'web_sess' })).toEqual({ label: 'Web chat' })
    expect(await resolve({ assistantId: 'a1', channelType: 'slack', channelId: 'C123' })).toEqual({ label: 'Slack · channel C123' })
    expect(await resolve({ assistantId: 'a1', channelType: 'whatsapp', channelId: '15551234567@c.us' })).toEqual({ label: 'WhatsApp' })
  })
})
