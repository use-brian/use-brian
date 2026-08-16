/**
 * Unit tests for workflow channel delivery — the thread-reply pass-through.
 * Component tag: [COMP:workflow/channel-delivery].
 *
 * Mocks the DB session persistence and the channel adapters. Verifies that
 * `threadRef` reaches the adapter as `opts.threadTs` (Slack thread /
 * Telegram reply) and that the adapter-returned message id lands on the
 * `delivered` outcome as `messageId` — the two halves that let a later
 * `deliver.thread.fromStep` step reply under an earlier step's message.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/sessions.js', () => ({
  findOrCreateSession: vi.fn(async () => ({ id: 'sess-1' })),
  addSessionMessage: vi.fn(async () => ({})),
}))
vi.mock('../../db/client.js', () => ({
  query: vi.fn(async () => ({ rows: [] })),
}))

const { sendMessage, createTelegramAdapter } = vi.hoisted(() => {
  const send = vi.fn()
  return { sendMessage: send, createTelegramAdapter: vi.fn(() => ({ sendMessage: send })) }
})
vi.mock('@use-brian/channels', () => ({
  createSlackAdapter: vi.fn(() => ({ sendMessage })),
  createTelegramAdapter,
  createWhatsAppAdapter: vi.fn(() => ({ sendMessage })),
}))

import { createWorkflowChannelDelivery } from '../channel-delivery.js'
import { createTelegramAdapter as mockedCreateTelegramAdapter } from '@use-brian/channels'
import type { ChannelIntegrationStore } from '../../db/channel-integrations.js'

const integrationStore = {
  getCredentialsForAssistantSystem: vi.fn(async () => ({
    credentials: { bot_token: 'xoxb-test' },
    botUserId: 'B1',
  })),
  getCredentialsForAssistantIntegrationSystem: vi.fn(async () => ({
    credentials: { bot_token: 'selected-token' },
    botUserId: 'B2',
  })),
} as unknown as ChannelIntegrationStore

function baseParams() {
  return {
    workspaceId: 'ws-1',
    assistantId: 'asst-1',
    userId: 'u-1',
    channelId: 'C123',
    text: 'per-person update',
  }
}

beforeEach(() => {
  sendMessage.mockReset()
  sendMessage.mockResolvedValue('1751970000.111111')
  vi.mocked(mockedCreateTelegramAdapter).mockClear()
  vi.mocked(integrationStore.getCredentialsForAssistantSystem).mockClear()
  vi.mocked(integrationStore.getCredentialsForAssistantIntegrationSystem).mockClear()
})

describe('[COMP:workflow/channel-delivery] thread-reply pass-through', () => {
  it('slack: passes threadRef as opts.threadTs and returns the posted ts as messageId', async () => {
    const deliver = createWorkflowChannelDelivery({ integrationStore })
    const outcome = await deliver({
      ...baseParams(),
      channelType: 'slack',
      threadRef: '1751960000.000100',
    })
    expect(sendMessage).toHaveBeenCalledWith(
      'C123',
      expect.objectContaining({ text: 'per-person update' }),
      { threadTs: '1751960000.000100' },
    )
    expect(outcome).toMatchObject({
      status: 'delivered',
      channelType: 'slack',
      channelId: 'C123',
      messageId: '1751970000.111111',
    })
  })

  it('slack: posts top-level (no opts) when threadRef is absent, still reporting messageId', async () => {
    const deliver = createWorkflowChannelDelivery({ integrationStore })
    const outcome = await deliver({ ...baseParams(), channelType: 'slack' })
    expect(sendMessage).toHaveBeenCalledWith(
      'C123',
      expect.objectContaining({ text: 'per-person update' }),
      undefined,
    )
    expect(outcome).toMatchObject({ status: 'delivered', messageId: '1751970000.111111' })
  })

  it('telegram: passes threadRef through as the reply anchor', async () => {
    const deliver = createWorkflowChannelDelivery({
      integrationStore,
      defaultTelegramBotToken: 'tg-token',
    })
    const outcome = await deliver({
      ...baseParams(),
      channelType: 'telegram',
      channelId: '42',
      threadRef: '778899',
    })
    expect(sendMessage).toHaveBeenCalledWith(
      '42',
      expect.objectContaining({ text: 'per-person update' }),
      { threadTs: '778899' },
    )
    expect(outcome).toMatchObject({ status: 'delivered', messageId: '1751970000.111111' })
  })

  it('telegram: retries the shared bot when the assistant BYO bot cannot see the chat', async () => {
    sendMessage
      .mockRejectedValueOnce(new Error('Telegram API sendMessage: Bad Request: chat not found'))
      .mockResolvedValueOnce('778900')
    const deliver = createWorkflowChannelDelivery({
      integrationStore,
      defaultTelegramBotToken: 'shared-token',
    })

    const outcome = await deliver({
      ...baseParams(),
      channelType: 'telegram',
      channelId: '-100555:topic:42',
    })

    expect(vi.mocked(mockedCreateTelegramAdapter).mock.calls.map(([options]) => options.token)).toEqual([
      'xoxb-test',
      'shared-token',
    ])
    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(outcome).toMatchObject({ status: 'delivered', messageId: '778900' })
  })

  it('telegram: sends only through the explicitly selected integration', async () => {
    const deliver = createWorkflowChannelDelivery({
      integrationStore,
      defaultTelegramBotToken: 'shared-token',
    })

    const outcome = await deliver({
      ...baseParams(),
      channelType: 'telegram',
      channelId: '-100555:topic:42',
      channelIntegrationId: '00000000-0000-4000-8000-000000000001',
    })

    expect(vi.mocked(mockedCreateTelegramAdapter).mock.calls.map(([options]) => options.token)).toEqual([
      'selected-token',
    ])
    expect(integrationStore.getCredentialsForAssistantIntegrationSystem).toHaveBeenCalledWith(
      'asst-1',
      '00000000-0000-4000-8000-000000000001',
      'telegram',
      '-100555:topic:42',
    )
    expect(outcome).toMatchObject({ status: 'delivered' })
  })
})
