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

const { sendMessage, createTelegramAdapter, createWhatsAppCloudAdapter, createFeishuAdapter } = vi.hoisted(() => {
  const send = vi.fn()
  return {
    sendMessage: send,
    createTelegramAdapter: vi.fn(() => ({ sendMessage: send })),
    createWhatsAppCloudAdapter: vi.fn(() => ({ sendMessage: send })),
    createFeishuAdapter: vi.fn(() => ({ sendMessage: send })),
  }
})
// Adapters are mocked; `describeSlackError` / `SlackApiError` are NOT — the
// Slack failure copy under test is the real translator's output.
vi.mock('@use-brian/channels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@use-brian/channels')>()),
  createSlackAdapter: vi.fn(() => ({ sendMessage })),
  createTelegramAdapter,
  createWhatsAppAdapter: vi.fn(() => ({ sendMessage })),
  createWhatsAppCloudAdapter,
  createFeishuAdapter,
}))

vi.mock('../../feishu/client.js', () => ({ createFeishuApi: vi.fn(() => ({})) }))

import { createWorkflowChannelDelivery } from '../channel-delivery.js'
import {
  createTelegramAdapter as mockedCreateTelegramAdapter,
  createWhatsAppCloudAdapter as mockedCreateWhatsAppCloudAdapter,
  SlackApiError,
} from '@use-brian/channels'
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

function whatsappCloudIntegration(allowedUserIds = ['15551234567']) {
  return {
    id: 'int-wa',
    channelId: 'channel-wa',
    channelType: 'whatsapp' as const,
    teamId: 'waba-1',
    teamName: 'Support',
    botUserId: 'phone-1',
    botUsername: null,
    config: { userAccessMode: 'allowlist' as const, allowedUserIds },
    status: 'active' as const,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastEventAt: null,
    connectorInstanceId: null,
    credentials: {
      provider: 'cloud_api' as const,
      access_token: 'cloud-token',
      app_secret: 'app-secret',
      verify_token: 'verify-token',
      phone_number_id: 'phone-1',
      waba_id: 'waba-1',
      display_phone_number: '+15550000000',
      graph_api_version: 'v26.0',
    },
  }
}

beforeEach(() => {
  sendMessage.mockReset()
  sendMessage.mockResolvedValue('1751970000.111111')
  vi.mocked(mockedCreateTelegramAdapter).mockClear()
  vi.mocked(mockedCreateWhatsAppCloudAdapter).mockClear()
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

  it('slack: a push failure returns a typed failure whose text says the delivery did NOT happen', async () => {
    // Raw throw is `Slack API chat.postMessage: channel_not_found` — a bare
    // code the executor copies verbatim into `__delivery.error`, which is the
    // model's only account of the delivery.
    sendMessage.mockRejectedValueOnce(new SlackApiError({
      method: 'chat.postMessage',
      code: 'channel_not_found',
      target: { channel: 'C123' },
    }))
    const deliver = createWorkflowChannelDelivery({ integrationStore })

    const outcome = await deliver({ ...baseParams(), channelType: 'slack' })

    expect(outcome.status).toBe('failed')
    const error = (outcome as { error: string }).error
    expect(error).toContain('Slack delivery FAILED')
    expect(error).toContain('NOT posted to Slack channel `C123`')
    // describeSlackError's diagnosis + discovery pointer + invite remedy.
    expect(error).toMatch(/no conversation .* that this bot can see/)
    expect(error).toContain('`listSlackChannels`')
    expect(error).toMatch(/do not tell the user it was sent/)
  })

  it('slack: a thread reply failure names the thread it was replying under', async () => {
    sendMessage.mockRejectedValueOnce(new SlackApiError({
      method: 'chat.postMessage',
      code: 'thread_not_found',
      target: { channel: 'C123', ts: '1751960000.000100' },
    }))
    const deliver = createWorkflowChannelDelivery({ integrationStore })

    const outcome = await deliver({
      ...baseParams(),
      channelType: 'slack',
      threadRef: '1751960000.000100',
    })

    const error = (outcome as { error: string }).error
    expect(error).toContain('as a reply in thread `1751960000.000100`')
    expect(error).toMatch(/PARENT message/)
  })

  it('slack: a non-Slack throw supplies its own retry verdict', async () => {
    sendMessage.mockRejectedValueOnce(new Error('fetch failed'))
    const deliver = createWorkflowChannelDelivery({ integrationStore })

    const outcome = await deliver({ ...baseParams(), channelType: 'slack' })

    const error = (outcome as { error: string }).error
    expect(error).toContain('fetch failed')
    expect(error).toMatch(/Slack never answered this call/)
    expect(error).toMatch(/retry once/)
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

  it('feishu: resolves encrypted app credentials and passes the thread reply anchor', async () => {
    vi.mocked(integrationStore.getCredentialsForAssistantSystem).mockResolvedValueOnce({
      credentials: { app_id: 'cli_app', app_secret: 'secret', brand: 'lark' },
      botUserId: 'ou_bot',
      config: { replyInThread: true },
    } as never)
    const deliver = createWorkflowChannelDelivery({ integrationStore })
    const outcome = await deliver({
      ...baseParams(),
      channelType: 'feishu',
      channelId: 'oc_chat',
      threadRef: 'om_root',
    })
    expect(createFeishuAdapter).toHaveBeenCalledWith(expect.objectContaining({
      botOpenId: 'ou_bot',
      config: { replyInThread: true },
    }))
    expect(sendMessage).toHaveBeenCalledWith(
      'oc_chat',
      expect.objectContaining({ text: 'per-person update', format: 'markdown' }),
      { threadTs: 'om_root' },
    )
    expect(outcome).toMatchObject({
      status: 'delivered',
      channelType: 'feishu',
      channelId: 'oc_chat',
      messageId: '1751970000.111111',
    })
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
      'ws-1',
      'asst-1',
      '00000000-0000-4000-8000-000000000001',
      'telegram',
      '-100555:topic:42',
    )
    expect(outcome).toMatchObject({ status: 'delivered' })
  })

  it('whatsapp cloud: replies through the exact triggering integration', async () => {
    vi.mocked(integrationStore.getCredentialsForAssistantIntegrationSystem).mockResolvedValueOnce(whatsappCloudIntegration())
    const deliver = createWorkflowChannelDelivery({
      integrationStore,
      now: () => Date.parse('2026-08-17T12:00:00.000Z'),
    })

    const outcome = await deliver({
      ...baseParams(),
      channelType: 'whatsapp',
      channelId: '15551234567',
      channelIntegrationId: 'int-wa',
      replyToTrigger: {
        actorId: '15551234567',
        recipientType: 'individual',
        providerAccountId: 'phone-1',
        occurredAt: '2026-08-17T11:00:00.000Z',
      },
    })

    expect(mockedCreateWhatsAppCloudAdapter).toHaveBeenCalledWith({
      accessToken: 'cloud-token',
      phoneNumberId: 'phone-1',
      graphApiVersion: 'v26.0',
      recipientType: 'individual',
    })
    expect(sendMessage).toHaveBeenCalledWith(
      '15551234567',
      { text: 'per-person update', format: 'markdown' },
    )
    expect(outcome).toMatchObject({
      status: 'delivered',
      channelType: 'whatsapp',
      channelId: '15551234567',
      messageId: '1751970000.111111',
    })
  })

  it('whatsapp cloud: checks the participant allowlist and replies to the triggering group', async () => {
    vi.mocked(integrationStore.getCredentialsForAssistantIntegrationSystem).mockResolvedValueOnce(whatsappCloudIntegration())
    const deliver = createWorkflowChannelDelivery({
      integrationStore,
      now: () => Date.parse('2026-08-17T12:00:00.000Z'),
    })

    const outcome = await deliver({
      ...baseParams(),
      channelType: 'whatsapp',
      channelId: 'group-1',
      channelIntegrationId: 'int-wa',
      replyToTrigger: {
        actorId: '15551234567',
        recipientType: 'group',
        providerAccountId: 'phone-1',
        occurredAt: '2026-08-17T11:00:00.000Z',
      },
    })

    expect(mockedCreateWhatsAppCloudAdapter).toHaveBeenCalledWith({
      accessToken: 'cloud-token',
      phoneNumberId: 'phone-1',
      graphApiVersion: 'v26.0',
      recipientType: 'group',
    })
    expect(sendMessage).toHaveBeenCalledWith(
      'group-1',
      { text: 'per-person update', format: 'markdown' },
    )
    expect(outcome).toMatchObject({ status: 'delivered', channelId: 'group-1' })
  })

  it('whatsapp cloud: refuses a delayed group reply when the triggering participant is no longer allowed', async () => {
    vi.mocked(integrationStore.getCredentialsForAssistantIntegrationSystem).mockResolvedValueOnce(whatsappCloudIntegration([]))
    const deliver = createWorkflowChannelDelivery({
      integrationStore,
      now: () => Date.parse('2026-08-17T12:00:00.000Z'),
    })

    const outcome = await deliver({
      ...baseParams(),
      channelType: 'whatsapp',
      channelId: 'group-1',
      channelIntegrationId: 'int-wa',
      replyToTrigger: {
        actorId: '15551234567',
        recipientType: 'group',
        providerAccountId: 'phone-1',
        occurredAt: '2026-08-17T11:00:00.000Z',
      },
    })

    expect(outcome).toEqual({ status: 'skipped', channelType: 'whatsapp', reason: 'access_denied' })
    expect(mockedCreateWhatsAppCloudAdapter).not.toHaveBeenCalled()
  })

  it('whatsapp cloud: refuses replies after the customer-service window', async () => {
    const deliver = createWorkflowChannelDelivery({
      integrationStore,
      now: () => Date.parse('2026-08-18T12:00:00.000Z'),
    })
    const outcome = await deliver({
      ...baseParams(),
      channelType: 'whatsapp',
      channelId: '15551234567',
      channelIntegrationId: 'int-wa',
      replyToTrigger: {
        actorId: '15551234567',
        recipientType: 'individual',
        providerAccountId: 'phone-1',
        occurredAt: '2026-08-17T11:59:59.000Z',
      },
    })

    expect(outcome).toEqual({
      status: 'skipped',
      channelType: 'whatsapp',
      reason: 'customer_service_window_expired',
    })
    expect(mockedCreateWhatsAppCloudAdapter).not.toHaveBeenCalled()
  })
})
