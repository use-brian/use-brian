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
  createMsTeamsAdapter: vi.fn(() => ({ sendMessage })),
  createCustomAdapter: vi.fn(() => ({ sendMessage })),
}))

vi.mock('../../feishu/client.js', () => ({ createFeishuApi: vi.fn(() => ({})) }))

import { createWorkflowChannelDelivery } from '../channel-delivery.js'
import { createWorkflowPublicationDispatcher, type AuthorizeWorkflowPublication, type PublicationConsentStore } from '../publication-consent.js'
import type { WorkflowRunRecord } from '@use-brian/core'
import {
  createTelegramAdapter as mockedCreateTelegramAdapter,
  createWhatsAppCloudAdapter as mockedCreateWhatsAppCloudAdapter,
  SlackApiError,
} from '@use-brian/channels'
import type { ChannelIntegrationStore } from '../../db/channel-integrations.js'
import { addSessionMessage, findOrCreateSession } from '../../db/sessions.js'

const integrationStore = {
  getCredentialsForAssistantSystem: vi.fn(async () => ({
    id: 'integration',
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

function whatsappCloudIntegration(
  allowedUserIds = ['15551234567'],
  whatsappCloudAllowAllGroupMembers = false,
) {
  return {
    id: 'int-wa',
    channelId: 'channel-wa',
    channelType: 'whatsapp' as const,
    teamId: 'waba-1',
    teamName: 'Support',
    botUserId: 'phone-1',
    botUsername: null,
    config: {
      userAccessMode: 'allowlist' as const,
      allowedUserIds,
      whatsappCloudAllowAllGroupMembers,
    },
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
  vi.mocked(addSessionMessage).mockClear()
  vi.mocked(findOrCreateSession).mockClear()
  sendMessage.mockReset()
  sendMessage.mockResolvedValue('1751970000.111111')
  vi.mocked(mockedCreateTelegramAdapter).mockClear()
  vi.mocked(mockedCreateWhatsAppCloudAdapter).mockClear()
  vi.mocked(integrationStore.getCredentialsForAssistantSystem).mockClear()
  vi.mocked(integrationStore.getCredentialsForAssistantIntegrationSystem).mockClear()
})

describe('[COMP:workflow/channel-delivery] thread-reply pass-through', () => {
  // A07 acceptance evidence selects the stable "refuses an unverified audience" title.
  it.each([undefined, 'unbound', 'evidence_exceeds_audience'] as const)(
    'refuses an unverified audience before persistence or adapter send, preserving detail %s', async (detail) => {
      vi.mocked(addSessionMessage).mockClear()
      const authorizeDeliveryAudience = vi.fn(async () => ({
        allowed: false as const,
        reason: 'delivery_audience_unverified' as const,
        ...(detail ? { detail } : {}),
      }))
      const deliver = createWorkflowChannelDelivery({ integrationStore, authorizeDeliveryAudience })
      const outcome = await deliver({
        ...baseParams(),
        channelType: 'telegram',
        channelId: '-100123',
        scopeEvidence: { sensitivity: 'confidential', compartments: ['finance'] },
      })
      expect(outcome).toEqual({
        status: 'skipped',
        channelType: 'telegram',
        reason: 'delivery_audience_unverified',
        ...(detail ? { detail } : {}),
      })
      expect(addSessionMessage).not.toHaveBeenCalled()
      expect(sendMessage).not.toHaveBeenCalled()
    },
  )

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

  it('whatsapp cloud: replies to a non-allowlisted group participant when group access is enabled', async () => {
    vi.mocked(integrationStore.getCredentialsForAssistantIntegrationSystem)
      .mockResolvedValueOnce(whatsappCloudIntegration([], true))
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

    expect(outcome).toMatchObject({ status: 'delivered', channelId: 'group-1' })
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


describe('[COMP:workflow/channel-delivery] question fallback', () => {
  it.each(['telegram', 'slack'] as const)('delivers all options on %s without requiring buttons', async (channelType) => {
    sendMessage.mockResolvedValue('msg-42')
    const question = { question: 'Which?', options: ['First', 'Second'] }
    const deliver = createWorkflowChannelDelivery({ integrationStore })
    expect(await deliver({ ...baseParams(), channelType, text: '', question }))
      .toMatchObject({ status: 'delivered' })
    expect(sendMessage.mock.calls.at(-1)?.[1].text).toContain('Which?\n1. First\n2. Second')
    expect(sendMessage.mock.calls.at(-1)?.[1].text).toContain('Question reference: wq:')
  })

  it('supports questions without choices and retains ordinary text delivery', async () => {
    sendMessage.mockResolvedValue('msg-43')
    const deliver = createWorkflowChannelDelivery({ integrationStore })
    await deliver({ ...baseParams(), channelType: 'telegram', text: '', question: { question: 'Your thoughts?' } })
    expect(sendMessage.mock.calls.at(-1)?.[1].text).toContain('Your thoughts?')
    await deliver({ ...baseParams(), channelType: 'telegram' })
    expect(sendMessage.mock.calls.at(-1)?.[1].text).toBe('per-person update')
  })
})

describe('[COMP:workflow/channel-delivery] explicit prepared-output publication', () => {
  const params = () => ({ ...baseParams(), channelType: 'telegram' as const, channelId: '-100123:topic:7',
    channelIntegrationId: 'integration', scopeEvidence: { sensitivity: 'internal' as const },
    publication: { runId: 'run', stepId: 'remind' } })
  const denyAudience = async () => ({ allowed: false as const, reason: 'delivery_audience_unverified' as const })
  const dispatcher = (authorizePublication: AuthorizeWorkflowPublication) => createWorkflowPublicationDispatcher({
    authorizePublication,
    store: { withPublicationLock: async (_wf, _user, send) => send() } as PublicationConsentStore,
    runStore: { getRunSystem: async () => ({ workflowId: 'workflow', workspaceId: 'ws-1' }) as WorkflowRunRecord },
  })

  it('publishes only prepared text with its approval receipt and rechecks consent before sending', async () => {
    const authorizeWorkflowPublication = vi.fn(async () => ({ allowed: true as const, approvalId: 'consent-1' }))
    const outcome = await createWorkflowChannelDelivery({ integrationStore,
      authorizeDeliveryAudience: denyAudience, authorizeWorkflowPublication,
      dispatchWorkflowPublication: dispatcher(authorizeWorkflowPublication) })(params())
    expect(outcome).toMatchObject({ status: 'delivered', publicationApprovalId: 'consent-1' })
    expect(authorizeWorkflowPublication).toHaveBeenCalledTimes(2)
    expect(authorizeWorkflowPublication).toHaveBeenLastCalledWith(expect.objectContaining({
      channelId: '-100123:topic:7', channelIntegrationId: 'integration', scopeEvidence: { sensitivity: 'internal' },
      publication: { runId: 'run', stepId: 'remind' },
    }))
    expect(createTelegramAdapter).toHaveBeenLastCalledWith({ token: 'selected-token', strictTopic: true })
    expect(sendMessage).toHaveBeenCalledWith('-100123:topic:7', { text: 'per-person update', format: 'markdown', actions: undefined }, undefined)
  })
  it('does not send after publication consent is revoked during preparation', async () => {
    const authorizeWorkflowPublication = vi.fn()
      .mockResolvedValueOnce({ allowed: true, approvalId: 'consent-1' }).mockResolvedValueOnce({ allowed: false })
    const outcome = await createWorkflowChannelDelivery({ integrationStore,
      authorizeDeliveryAudience: denyAudience, authorizeWorkflowPublication,
      dispatchWorkflowPublication: dispatcher(authorizeWorkflowPublication) })(params())
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'delivery_audience_unverified' })
    expect(sendMessage).not.toHaveBeenCalled()
    expect(addSessionMessage).not.toHaveBeenCalled()
    expect(findOrCreateSession).not.toHaveBeenCalled()
  })
  it('retains mixed assistant provenance without manufacturing a lineage-free delivery transcript', async () => {
    const authorizeWorkflowPublication = vi.fn(async () => ({ allowed: true as const, approvalId: 'consent-1' }))
    const sources = ['assistant-one', 'assistant-two'].map((assistantId, index) => ({
      workspaceId: 'ws-1', userId: 'u-1', assistantId, resourceKind: 'memory', resourceId: `memory-${index}`,
      version: '1', sensitivity: 'internal' as const, compartments: [], projectIds: [],
    }))
    const scopeEvidence = { sensitivity: 'internal' as const, sources }
    const outcome = await createWorkflowChannelDelivery({ integrationStore, authorizeDeliveryAudience: denyAudience,
      authorizeWorkflowPublication, dispatchWorkflowPublication: dispatcher(authorizeWorkflowPublication),
    })({ ...params(), scopeEvidence })
    expect(outcome.status).toBe('delivered')
    expect(addSessionMessage).not.toHaveBeenCalled()
    expect(findOrCreateSession).not.toHaveBeenCalled()
    expect(authorizeWorkflowPublication).toHaveBeenLastCalledWith(expect.objectContaining({ scopeEvidence }))
    expect(scopeEvidence.sources).toHaveLength(2)
  })
  it.each(['interactive', 'question', 'missing-evidence', 'unpinned'])(
    'does not apply the exception to %s delivery', async kind => {
      const input = params()
      if (kind === 'interactive') input.publication = undefined as never
      if (kind === 'question') Object.assign(input, { question: { question: 'Your thoughts?' } })
      if (kind === 'missing-evidence') input.scopeEvidence = undefined as never
      if (kind === 'unpinned') input.channelIntegrationId = undefined as never
      const authorizeWorkflowPublication = vi.fn(async () => ({ allowed: true as const, approvalId: 'consent-1' }))
      const outcome = await createWorkflowChannelDelivery({ integrationStore,
        authorizeDeliveryAudience: denyAudience, authorizeWorkflowPublication })(input)
      expect(outcome).toMatchObject({ status: 'skipped' })
      expect(authorizeWorkflowPublication).not.toHaveBeenCalled()
      expect(sendMessage).not.toHaveBeenCalled()
    })
})

describe('[COMP:workflow/channel-delivery] durable question buttons', () => {
  it('binds the actual BYO integration and topic, persists original context, attaches the returned message id', async () => {
    const { createChannelQuestionStore } = await import('../channel-questions.js')
    const store = createChannelQuestionStore()
    const create = vi.spyOn(store, 'create').mockResolvedValue('a'.repeat(24))
    const attach = vi.spyOn(store, 'attach').mockResolvedValue()
    vi.mocked(integrationStore.getCredentialsForAssistantSystem).mockResolvedValueOnce({ id: 'byo-integration', credentials: { bot_token: 'byo' } } as never)
    sendMessage.mockResolvedValueOnce('123')
    const question = { question: 'Which?', options: ['dev', 'prod'], actionId: 'job-7', version: 5, allowCustom: true, context: 'Authored context' }
    const response = { toolName: 'answer_action', arguments: { action_id: 'job-7', version: 5 }, answerField: 'answer' }
    await createWorkflowChannelDelivery({ integrationStore, questionStore: store, defaultTelegramBotToken: 'official' })({
      ...baseParams(), channelType: 'telegram', channelId: '-100:topic:7', question, questionResponse: response,
    })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ integrationId: 'byo-integration', channelId: '-100:topic:7', question, response }))
    expect(createTelegramAdapter).toHaveBeenLastCalledWith({ token: 'byo', strictTopic: true })
    expect(sendMessage).toHaveBeenLastCalledWith('-100:topic:7', expect.objectContaining({
      actions: [{ id: '0', label: 'dev', data: `wq:${'a'.repeat(24)}:0`, replyText: `wq:${'a'.repeat(24)} 1` }, { id: '1', label: 'prod', data: `wq:${'a'.repeat(24)}:1`, replyText: `wq:${'a'.repeat(24)} 2` }],
    }), undefined)
    expect(attach).toHaveBeenCalledWith('a'.repeat(24), '123')
  })
  it('does not advertise answer buttons or typing when no response action is configured', async () => {
    vi.mocked(integrationStore.getCredentialsForAssistantSystem).mockResolvedValueOnce({ id: 'byo', credentials: { bot_token: 'byo' } } as never)
    sendMessage.mockResolvedValueOnce('123')
    await createWorkflowChannelDelivery({ integrationStore })({ ...baseParams(), channelType: 'telegram',
      question: { question: 'Which?', options: ['dev', 'prod'] } })
    expect(sendMessage.mock.calls.at(-1)?.[1].actions).toBeUndefined()
    expect(sendMessage.mock.calls.at(-1)?.[1].text).toContain('No response action is configured')
    expect(sendMessage.mock.calls.at(-1)?.[1].text).not.toContain('type another answer')
  })

  it('never retries a correlated BYO question through the official bot', async () => {
    vi.mocked(integrationStore.getCredentialsForAssistantSystem).mockResolvedValueOnce({ id: 'byo-integration', credentials: { bot_token: 'byo' } } as never)
    sendMessage.mockRejectedValueOnce(new Error('Telegram API sendMessage: chat not found'))
    const start = createTelegramAdapter.mock.calls.length
    await expect(createWorkflowChannelDelivery({ integrationStore, defaultTelegramBotToken: 'official' })({
      ...baseParams(), channelType: 'telegram', question: { question: 'Which?' },
    })).rejects.toThrow('chat not found')
    expect(vi.mocked(mockedCreateTelegramAdapter).mock.calls.slice(start).map(([opts]) => opts.token)).toEqual(['byo'])
  })
})

describe('durable question delivery parity', () => {
  it.each(['slack', 'feishu', 'msteams', 'custom', 'whatsapp'] as const)('binds %s replies to the selected integration and posted message', async (channelType) => {
    const { createChannelQuestionStore } = await import('../channel-questions.js')
    const store = createChannelQuestionStore()
    const create = vi.spyOn(store, 'create').mockResolvedValue('a'.repeat(24))
    const attach = vi.spyOn(store, 'attach').mockResolvedValue()
    vi.mocked(integrationStore.getCredentialsForAssistantIntegrationSystem).mockResolvedValueOnce({
      id: 'pinned', channelId: 'workspace-channel', credentials: {}, config: { msteamsServiceUrl: 'https://example.com' },
    } as never)
    sendMessage.mockResolvedValueOnce('posted')
    const question = { question: 'Choose', options: ['A', 'B'] }
    const response = { toolName: 'answer_action', arguments: { version: 3 }, answerField: 'answer' }
    const result = await createWorkflowChannelDelivery({ integrationStore, questionStore: store,
      waConnectorUrl: 'http://connector', waConnectorSecret: 'secret', customChannelStore: { enqueue: vi.fn() },
    })({ ...baseParams(), channelType, channelIntegrationId: 'pinned', channelId: 'peer@example', question, questionResponse: response })
    expect(result).toMatchObject({ status: 'delivered', messageId: 'posted' })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ integrationId: 'pinned', channelId: 'peer@example', question, response }))
    expect(attach).toHaveBeenCalledWith('a'.repeat(24), 'posted')
    expect(sendMessage.mock.calls.at(-1)?.[1].text).toContain('Question reference: wq:')
  })
  it('fails closed for an actionable integration-less WhatsApp question', async () => {
    const result = await createWorkflowChannelDelivery({ waConnectorUrl: 'http://connector', waConnectorSecret: 'secret' })({
      ...baseParams(), channelType: 'whatsapp', channelId: 'peer@example', question: { question: 'Choose' },
    })
    expect(result).toMatchObject({ status: 'skipped', reason: 'no_integration' })
    expect(sendMessage).not.toHaveBeenCalled()
  })
})

it('binds a WhatsApp Cloud trigger reply after provider/access/window validation', async () => {
  const { createChannelQuestionStore } = await import('../channel-questions.js')
  const store = createChannelQuestionStore()
  const create = vi.spyOn(store, 'create').mockResolvedValue('a'.repeat(24))
  const attach = vi.spyOn(store, 'attach').mockResolvedValue()
  vi.mocked(integrationStore.getCredentialsForAssistantIntegrationSystem).mockResolvedValueOnce(whatsappCloudIntegration())
  sendMessage.mockResolvedValueOnce('cloud-message')
  const result = await createWorkflowChannelDelivery({ integrationStore, questionStore: store, now: () => Date.parse('2026-08-18T12:00:00Z') })({
    ...baseParams(), channelType: 'whatsapp', channelId: '15551234567', channelIntegrationId: 'int-wa',
    question: { question: 'Choose', options: ['A', 'B'] },
    replyToTrigger: { actorId: '15551234567', recipientType: 'individual', providerAccountId: 'phone-1', occurredAt: '2026-08-18T11:00:00Z' },
  })
  expect(result).toMatchObject({ status: 'delivered', messageId: 'cloud-message' })
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ integrationId: 'int-wa', channelId: '15551234567' }))
  expect(attach).toHaveBeenCalledWith('a'.repeat(24), 'cloud-message')
})
