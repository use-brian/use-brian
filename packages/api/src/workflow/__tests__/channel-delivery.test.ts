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

const sendMessage = vi.fn(
  async (_channelId: string, _msg: unknown, _opts?: { threadTs?: string }) => '1751970000.111111',
)
vi.mock('@sidanclaw/channels', () => ({
  createSlackAdapter: vi.fn(() => ({ sendMessage })),
  createTelegramAdapter: vi.fn(() => ({ sendMessage })),
  createWhatsAppAdapter: vi.fn(() => ({ sendMessage })),
}))

import { createWorkflowChannelDelivery } from '../channel-delivery.js'
import type { ChannelIntegrationStore } from '../../db/channel-integrations.js'

const integrationStore = {
  getCredentialsForAssistantSystem: vi.fn(async () => ({
    credentials: { bot_token: 'xoxb-test' },
    botUserId: 'B1',
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
  sendMessage.mockClear()
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
})
