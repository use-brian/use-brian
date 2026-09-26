import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  api: {
    send: vi.fn(),
    editMessage: vi.fn(),
    updateCard: vi.fn(),
    recallMessage: vi.fn(),
    addReaction: vi.fn(),
    removeReactionByEmoji: vi.fn(),
    getMessageChatId: vi.fn(),
    downloadResource: vi.fn(),
  },
  claimChannelEvent: vi.fn(),
  getChannelForWebhook: vi.fn(),
  resolveRoutingForSurface: vi.fn(),
  findAssistantById: vi.fn(),
  findUserById: vi.fn(),
  channelLinkBindsHere: vi.fn(),
  ensureAssistantMember: vi.fn(),
  resolveChannelUser: vi.fn(),
  mergeShadowUser: vi.fn(),
  tryResolveSchedulerConfirmation: vi.fn(),
  dispatchReactionFeedback: vi.fn(),
  billingPartyForAssistant: vi.fn(),
  ensureFeishuConnectorInstance: vi.fn(),
  processChannelMessage: vi.fn(),
}))

vi.mock('../../feishu/client.js', () => ({ createFeishuApi: () => mocks.api }))
vi.mock('../../db/channel-event-dedup.js', () => ({ claimChannelEvent: mocks.claimChannelEvent }))
vi.mock('../../db/channels-store.js', () => ({
  getChannelForWebhook: mocks.getChannelForWebhook,
  resolveRoutingForSurface: mocks.resolveRoutingForSurface,
}))
vi.mock('../../db/users.js', () => ({
  findAssistantById: mocks.findAssistantById,
  findUserById: mocks.findUserById,
}))
vi.mock('../../db/channel-user-store.js', () => ({
  channelLinkBindsHere: mocks.channelLinkBindsHere,
  ensureAssistantMember: mocks.ensureAssistantMember,
  resolveChannelUser: mocks.resolveChannelUser,
}))
vi.mock('../../db/linked-accounts.js', () => ({ mergeShadowUser: mocks.mergeShadowUser }))
vi.mock('../../scheduling/confirmation-registry.js', () => ({
  tryResolveSchedulerConfirmation: mocks.tryResolveSchedulerConfirmation,
}))
vi.mock('../../feedback/reaction-dispatch.js', () => ({
  dispatchReactionFeedback: mocks.dispatchReactionFeedback,
}))
vi.mock('../../billing-party.js', () => ({ billingPartyForAssistant: mocks.billingPartyForAssistant }))
vi.mock('../../ingest/feishu-connector-instance.js', () => ({
  ensureFeishuConnectorInstance: mocks.ensureFeishuConnectorInstance,
}))
vi.mock('../../db/chat-lock.js', () => ({ withChatLock: (_key: string, fn: () => unknown) => fn() }))
vi.mock('../channel-pipeline.js', () => ({ processChannelMessage: mocks.processChannelMessage }))

import { feishuRoutes, resolveFeishuThreadScope, type FeishuRouteOptions } from '../feishu.js'

const CHANNEL_ROW_ID = '11111111-1111-4111-8111-111111111111'
const ASSISTANT_ID = '22222222-2222-4222-8222-222222222222'

function normalizedMessage(over: Record<string, unknown> = {}) {
  return {
    messageId: 'om_1',
    chatId: 'oc_chat',
    chatType: 'p2p',
    senderId: 'ou_sender',
    senderName: 'Sender',
    senderType: 'user',
    senderIsBot: false,
    content: 'hello',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
    ...over,
  }
}

describe('[COMP:api/feishu-route] thread session identity', () => {
  it('opens a distinct session for each top-level message when replies start threads', () => {
    expect(resolveFeishuThreadScope(normalizedMessage({ messageId: 'om_first' }), true))
      .toEqual({ sessionChannelId: 'oc_chat:thread:om_first', threadRoot: 'om_first' })
    expect(resolveFeishuThreadScope(normalizedMessage({ messageId: 'om_second' }), true))
      .toEqual({ sessionChannelId: 'oc_chat:thread:om_second', threadRoot: 'om_second' })
  })

  it('resumes a nested reply on its om_ root and never uses the omt_ topic first', () => {
    expect(resolveFeishuThreadScope(normalizedMessage({
      messageId: 'om_current',
      threadId: 'omt_topic',
      rootId: 'om_root',
      replyToMessageId: 'om_parent',
    }), true)).toEqual({
      sessionChannelId: 'oc_chat:thread:om_root',
      threadRoot: 'om_root',
    })
  })

  it('keeps existing topics isolated but preserves a bare top-level session when thread replies are disabled', () => {
    expect(resolveFeishuThreadScope(normalizedMessage({ threadId: 'omt_topic' }), false))
      .toEqual({ sessionChannelId: 'oc_chat:thread:omt_topic', threadRoot: 'omt_topic' })
    expect(resolveFeishuThreadScope(normalizedMessage(), false))
      .toEqual({ sessionChannelId: 'oc_chat', threadRoot: undefined })
  })
})

function setup(over: {
  config?: Record<string, unknown>
  connectorInstanceId?: string | null
  list?: unknown[]
  route?: Partial<FeishuRouteOptions>
} = {}) {
  const integrationStore = {
    listActiveWithCredentialsSystem: vi.fn(async () => over.list ?? [{
      channelId: CHANNEL_ROW_ID,
      botUserId: 'ou_bot',
      credentials: { app_id: 'cli_a', app_secret: 'secret', brand: 'feishu' },
    }]),
    getByChannelForWebhook: vi.fn(async () => ({
      id: 'integration-1',
      channelId: CHANNEL_ROW_ID,
      botUserId: 'ou_bot',
      config: over.config ?? {},
      connectorInstanceId: over.connectorInstanceId === undefined
        ? 'archive-instance-1'
        : over.connectorInstanceId,
      credentials: { app_id: 'cli_a', app_secret: 'secret', brand: 'feishu' },
    })),
    mergeConfigSystem: vi.fn(async (
      _id: string,
      mutate: (current: Record<string, unknown>) => Record<string, unknown>,
    ) => {
      mutate(over.config ?? {})
    }),
    touchLastEventAt: vi.fn(async () => {}),
  }
  const options = {
    connectorSecret: 'shared-secret',
    integrationStore,
    provider: {},
    systemPrompt: 'system',
    tools: new Map(),
    memoryStore: {},
    capabilityStore: {},
    ...over.route,
  } as unknown as FeishuRouteOptions
  const app = express()
  app.use(express.json())
  app.use('/internal/feishu', feishuRoutes(options))
  return { app, integrationStore }
}

describe('[COMP:api/feishu-route] bridge route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.claimChannelEvent.mockResolvedValue(true)
    mocks.getChannelForWebhook.mockResolvedValue({
      id: CHANNEL_ROW_ID,
      workspaceId: 'workspace-1',
      status: 'active',
      enabledCapabilities: ['chat', 'broadcast'],
    })
    mocks.resolveRoutingForSurface.mockResolvedValue({ assistantId: ASSISTANT_ID, modelAlias: 'pro' })
    mocks.findAssistantById.mockResolvedValue({
      id: ASSISTANT_ID,
      ownerUserId: 'owner-1',
      workspaceId: 'workspace-1',
    })
    mocks.billingPartyForAssistant.mockResolvedValue('owner-1')
    mocks.ensureFeishuConnectorInstance.mockResolvedValue('promoted-instance-1')
    mocks.findUserById.mockResolvedValue({ id: 'linked-user-1' })
    mocks.channelLinkBindsHere.mockResolvedValue(true)
    mocks.ensureAssistantMember.mockResolvedValue(undefined)
    mocks.mergeShadowUser.mockResolvedValue(undefined)
    mocks.tryResolveSchedulerConfirmation.mockReturnValue(true)
    mocks.processChannelMessage.mockResolvedValue(undefined)
    mocks.api.send.mockResolvedValue({ messageId: 'om_status' })
    mocks.api.updateCard.mockResolvedValue(undefined)
    mocks.api.addReaction.mockResolvedValue('reaction-1')
    mocks.api.getMessageChatId.mockResolvedValue('oc_chat')
    mocks.api.downloadResource.mockResolvedValue({
      data: new Uint8Array([1, 2, 3]),
      contentType: 'image/png',
    })
  })

  it('records an added Feishu reaction as linked-account feedback', async () => {
    const linkedAccountStore = {
      findByProvider: vi.fn(async () => ({
        userId: 'linked-user-1',
        assistantId: ASSISTANT_ID,
      })),
    }
    const channelUserStore = {} as never
    const { app } = setup({
      route: { linkedAccountStore, channelUserStore } as never,
    })

    await request(app)
      .post('/internal/feishu/reaction')
      .set('X-Connector-Secret', 'shared-secret')
      .send({
        channelId: CHANNEL_ROW_ID,
        reaction: {
          messageId: 'om_assistant',
          operator: { openId: 'ou_reactor' },
          emojiType: 'THUMBSDOWN',
          action: 'added',
        },
      })
      .expect(202)

    await vi.waitFor(() => expect(mocks.dispatchReactionFeedback).toHaveBeenCalledOnce())
    const input = mocks.dispatchReactionFeedback.mock.calls[0][0]
    expect(input).toMatchObject({
      source: 'feishu',
      channelId: 'oc_chat',
      channelMessageId: 'om_assistant',
      rawEmoji: 'THUMBSDOWN',
    })
    await expect(input.resolveUserId(ASSISTANT_ID)).resolves.toBe('linked-user-1')
    expect(mocks.ensureAssistantMember).toHaveBeenCalledWith(ASSISTANT_ID, 'linked-user-1')
  })

  it('protects the credential-bearing restore endpoint', async () => {
    const { app } = setup()
    await request(app).get('/internal/feishu/channels').expect(401)
    const response = await request(app)
      .get('/internal/feishu/channels')
      .set('X-Connector-Secret', 'shared-secret')
      .expect(200)
    expect(response.body).toEqual([{
      channelId: CHANNEL_ROW_ID,
      credentials: { app_id: 'cli_a', app_secret: 'secret', brand: 'feishu' },
    }])
  })

  it('acknowledges before a slow model turn completes', async () => {
    let release!: () => void
    mocks.processChannelMessage.mockImplementation(() => new Promise<void>((resolve) => { release = resolve }))
    const { app } = setup()
    const response = await request(app)
      .post('/internal/feishu/inbound')
      .set('X-Connector-Secret', 'shared-secret')
      .send({ channelId: CHANNEL_ROW_ID, message: normalizedMessage() })
      .expect(202)
    expect(response.body).toEqual({ accepted: true })
    await vi.waitFor(() => expect(mocks.processChannelMessage).toHaveBeenCalledOnce())
    release()
  })

  it('durably deduplicates before entering the shared channel pipeline', async () => {
    mocks.claimChannelEvent.mockResolvedValue(false)
    const { app } = setup()
    await request(app)
      .post('/internal/feishu/inbound')
      .set('X-Connector-Secret', 'shared-secret')
      .send({ channelId: CHANNEL_ROW_ID, message: normalizedMessage() })
      .expect(202)
    await vi.waitFor(() => expect(mocks.claimChannelEvent).toHaveBeenCalledWith(CHANNEL_ROW_ID, 'om_1'))
    expect(mocks.processChannelMessage).not.toHaveBeenCalled()
  })

  it('records the Feishu chat against the exact integration for workflow delivery', async () => {
    const { app, integrationStore } = setup()
    await request(app)
      .post('/internal/feishu/inbound')
      .set('X-Connector-Secret', 'shared-secret')
      .send({ channelId: CHANNEL_ROW_ID, message: normalizedMessage() })
      .expect(202)

    await vi.waitFor(() => expect(integrationStore.mergeConfigSystem).toHaveBeenCalledOnce())
    const mutate = integrationStore.mergeConfigSystem.mock.calls[0][1]
    expect(mutate({})).toMatchObject({
      seenChats: [expect.objectContaining({ chatId: 'oc_chat', chatType: 'p2p' })],
    })
  })

  it('passively ingests a non-addressed message from an admin-enabled group', async () => {
    const feishuWebhookIngestor = { ingest: vi.fn(async () => null) }
    mocks.getChannelForWebhook.mockResolvedValue({
      id: CHANNEL_ROW_ID,
      workspaceId: 'workspace-1',
      status: 'active',
      enabledCapabilities: ['chat', 'broadcast', 'ingest'],
    })
    const { app } = setup({
      config: {
        requireMention: true,
        ambientIngestChatIds: ['oc_chat'],
      },
      route: { feishuWebhookIngestor } as never,
    })
    await request(app)
      .post('/internal/feishu/inbound')
      .set('X-Connector-Secret', 'shared-secret')
      .send({
        channelId: CHANNEL_ROW_ID,
        message: normalizedMessage({ chatType: 'group', mentionedBot: false }),
      })
      .expect(202)

    await vi.waitFor(() => expect(feishuWebhookIngestor.ingest).toHaveBeenCalledOnce())
    expect(feishuWebhookIngestor.ingest).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-1',
      connectorInstanceId: 'archive-instance-1',
      appId: 'cli_a',
      chatId: 'oc_chat',
      senderId: 'ou_sender',
      senderName: 'Sender',
      text: 'hello',
    }))
    expect(mocks.processChannelMessage).not.toHaveBeenCalled()
  })

  it('does not let an ingest rule bypass the per-group ambient allowlist', async () => {
    const feishuWebhookIngestor = { ingest: vi.fn(async () => null) }
    mocks.getChannelForWebhook.mockResolvedValue({
      id: CHANNEL_ROW_ID,
      workspaceId: 'workspace-1',
      status: 'active',
      enabledCapabilities: ['chat', 'broadcast', 'ingest'],
    })
    const { app } = setup({
      config: { requireMention: true, ambientIngestChatIds: [] },
      route: { feishuWebhookIngestor } as never,
    })
    await request(app)
      .post('/internal/feishu/inbound')
      .set('X-Connector-Secret', 'shared-secret')
      .send({
        channelId: CHANNEL_ROW_ID,
        message: normalizedMessage({ chatType: 'group', mentionedBot: false }),
      })
      .expect(202)
    await vi.waitFor(() => expect(mocks.claimChannelEvent).toHaveBeenCalled())
    expect(feishuWebhookIngestor.ingest).not.toHaveBeenCalled()
  })

  it('lazily provisions a default-off source for a pre-feature Feishu integration', async () => {
    const feishuWebhookIngestor = { ingest: vi.fn(async () => null) }
    mocks.getChannelForWebhook.mockResolvedValue({
      id: CHANNEL_ROW_ID,
      workspaceId: 'workspace-1',
      status: 'active',
      enabledCapabilities: ['chat', 'broadcast', 'ingest'],
    })
    const { app } = setup({
      connectorInstanceId: null,
      config: { requireMention: true, ambientIngestChatIds: [] },
      route: { feishuWebhookIngestor } as never,
    })
    await request(app)
      .post('/internal/feishu/inbound')
      .set('X-Connector-Secret', 'shared-secret')
      .send({
        channelId: CHANNEL_ROW_ID,
        message: normalizedMessage({ chatType: 'group', mentionedBot: false }),
      })
      .expect(202)

    await vi.waitFor(() => expect(mocks.ensureFeishuConnectorInstance).toHaveBeenCalledWith({
      channelIntegrationId: 'integration-1',
      actingUserId: 'owner-1',
    }))
    expect(feishuWebhookIngestor.ingest).not.toHaveBeenCalled()
  })

  it('keeps addressed group turns out of passive ingest to prevent duplication', async () => {
    const feishuWebhookIngestor = { ingest: vi.fn(async () => null) }
    mocks.getChannelForWebhook.mockResolvedValue({
      id: CHANNEL_ROW_ID,
      workspaceId: 'workspace-1',
      status: 'active',
      enabledCapabilities: ['chat', 'broadcast', 'ingest'],
    })
    const { app } = setup({
      config: {
        requireMention: true,
        ambientIngestChatIds: ['oc_chat'],
      },
      route: { feishuWebhookIngestor } as never,
    })
    await request(app)
      .post('/internal/feishu/inbound')
      .set('X-Connector-Secret', 'shared-secret')
      .send({
        channelId: CHANNEL_ROW_ID,
        message: normalizedMessage({ chatType: 'group', mentionedBot: true }),
      })
      .expect(202)
    await vi.waitFor(() => expect(mocks.processChannelMessage).toHaveBeenCalledOnce())
    expect(feishuWebhookIngestor.ingest).not.toHaveBeenCalled()
  })

  it('applies the live group mention gate in the API route', async () => {
    const { app } = setup({ config: { requireMention: true } })
    await request(app)
      .post('/internal/feishu/inbound')
      .set('X-Connector-Secret', 'shared-secret')
      .send({
        channelId: CHANNEL_ROW_ID,
        message: normalizedMessage({ chatType: 'group', mentionedBot: false }),
      })
      .expect(202)
    await vi.waitFor(() => expect(mocks.claimChannelEvent).toHaveBeenCalled())
    expect(mocks.processChannelMessage).not.toHaveBeenCalled()
  })

  it('dispatches bot and non-mention traffic to Feishu workflow event subscribers', async () => {
    const workflowEventDispatcher = { dispatch: vi.fn(async () => []) }
    const { app } = setup({
      config: { requireMention: true },
      route: { workflowEventDispatcher } as never,
    })
    await request(app)
      .post('/internal/feishu/inbound')
      .set('X-Connector-Secret', 'shared-secret')
      .send({
        channelId: CHANNEL_ROW_ID,
        message: normalizedMessage({
          chatType: 'group',
          mentionedBot: false,
          senderId: 'ou_monitor_bot',
          senderType: 'bot',
          senderIsBot: true,
          content: 'service alert',
        }),
      })
      .expect(202)

    await vi.waitFor(() => expect(workflowEventDispatcher.dispatch).toHaveBeenCalledOnce())
    expect(workflowEventDispatcher.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-1',
      source: {
        type: 'channel',
        channelIntegrationId: 'integration-1',
        channel: 'feishu',
      },
      text: 'service alert',
      actorId: 'ou_monitor_bot',
      channelId: 'oc_chat',
      isBot: true,
    }))
    expect(mocks.processChannelMessage).not.toHaveBeenCalled()
  })

  it('routes an addressed group turn with Feishu channel context', async () => {
    const { app } = setup({ config: { requireMention: true } })
    await request(app)
      .post('/internal/feishu/inbound')
      .set('X-Connector-Secret', 'shared-secret')
      .send({
        channelId: CHANNEL_ROW_ID,
        message: normalizedMessage({ chatType: 'group', mentionedBot: true, rootId: 'om_root' }),
      })
      .expect(202)
    await vi.waitFor(() => expect(mocks.processChannelMessage).toHaveBeenCalledOnce())
    expect(mocks.processChannelMessage).toHaveBeenCalledWith(expect.objectContaining({
      channelType: 'feishu',
      channelId: 'oc_chat',
      sessionChannelId: 'oc_chat:thread:om_root',
      connectorAuthority: 'assistant',
      incomingChannelMessageId: 'om_1',
      replyToMessageId: null,
      modelAlias: 'pro',
    }))
  })

  it('can disable assistant connector authority explicitly in channel config', async () => {
    const { app } = setup({
      config: { requireMention: true, allowAssistantConnectorTools: false },
    })
    await request(app)
      .post('/internal/feishu/inbound')
      .set('X-Connector-Secret', 'shared-secret')
      .send({
        channelId: CHANNEL_ROW_ID,
        message: normalizedMessage({ chatType: 'group', mentionedBot: true }),
      })
      .expect(202)

    await vi.waitFor(() => expect(mocks.processChannelMessage).toHaveBeenCalledOnce())
    expect(mocks.processChannelMessage).toHaveBeenCalledWith(expect.objectContaining({
      connectorAuthority: 'disabled',
    }))
  })

  it('targets every nested-thread delivery at the current message id and sends finals as rich posts', async () => {
    const firstFinal = [
      '**coordinationOverview**',
      '',
      '1. Review the current state',
      '2. Call `whoAmI`',
    ].join('\n')
    const secondFinal = '[Open the runbook](https://example.com/runbook)'
    let firstDelivery: unknown
    mocks.processChannelMessage.mockImplementation(async (params: {
      hooks: {
        onProcessingStart(): Promise<void>
        sendResponse(text: string): Promise<unknown>
        sendError(error: Error): Promise<void>
      }
    }) => {
      await params.hooks.onProcessingStart()
      firstDelivery = await params.hooks.sendResponse(firstFinal)
      await params.hooks.sendResponse(secondFinal)
      await params.hooks.onProcessingStart()
      await params.hooks.sendError(new Error('provider failed'))
    })
    mocks.api.send
      .mockResolvedValueOnce({ messageId: 'om_status_one' })
      .mockResolvedValueOnce({ messageId: 'om_final_one' })
      .mockResolvedValueOnce({ messageId: 'om_final_two' })
      .mockResolvedValueOnce({ messageId: 'om_status_two' })
      .mockResolvedValueOnce({ messageId: 'om_error' })
    const { app } = setup({
      config: { requireMention: true, replyInThread: true },
    })

    await request(app)
      .post('/internal/feishu/inbound')
      .set('X-Connector-Secret', 'shared-secret')
      .send({
        channelId: CHANNEL_ROW_ID,
        message: normalizedMessage({
          messageId: 'om_current',
          threadId: 'omt_topic',
          rootId: 'om_root',
          replyToMessageId: 'om_parent',
          chatType: 'group',
          mentionedBot: true,
        }),
      })
      .expect(202)

    await vi.waitFor(() => expect(mocks.api.send).toHaveBeenCalledTimes(5))
    expect(firstDelivery).toEqual({ channelMessageId: 'om_final_one' })
    expect(mocks.api.editMessage).not.toHaveBeenCalled()
    expect(mocks.api.recallMessage).toHaveBeenCalledTimes(2)
    expect(mocks.api.recallMessage).toHaveBeenNthCalledWith(1, 'om_status_one')
    expect(mocks.api.recallMessage).toHaveBeenNthCalledWith(2, 'om_status_two')
    expect(mocks.api.send.mock.invocationCallOrder[1])
      .toBeLessThan(mocks.api.recallMessage.mock.invocationCallOrder[0])
    for (const call of mocks.api.send.mock.calls) {
      expect(call[2]).toEqual({
        replyTo: 'om_current',
        replyInThread: true,
        resolveMentionsInText: true,
      })
    }
    expect(mocks.api.send.mock.calls.map((call) => call[1])).toEqual([
      { text: 'Thinking...' },
      { markdown: firstFinal },
      { markdown: secondFinal },
      { text: 'Thinking...' },
      { text: 'Something went wrong. Please try again.' },
    ])
    expect(JSON.stringify(mocks.api.send.mock.calls)).not.toContain('omt_topic')
    expect(JSON.stringify(mocks.api.send.mock.calls)).not.toContain('om_root')
    expect(JSON.stringify(mocks.api.send.mock.calls)).not.toContain('om_parent')
  })

  it('keeps the progress status when a rich final send fails', async () => {
    const providerError = new Error('rich post rejected')
    let caught: unknown
    mocks.processChannelMessage.mockImplementation(async (params: {
      hooks: {
        onProcessingStart(): Promise<void>
        sendResponse(text: string): Promise<unknown>
      }
    }) => {
      await params.hooks.onProcessingStart()
      try {
        await params.hooks.sendResponse('**Formatted answer**')
      } catch (error) {
        caught = error
      }
    })
    mocks.api.send
      .mockResolvedValueOnce({ messageId: 'om_status' })
      .mockRejectedValueOnce(providerError)
    const { app } = setup({ config: { replyInThread: true } })

    await request(app)
      .post('/internal/feishu/inbound')
      .set('X-Connector-Secret', 'shared-secret')
      .send({ channelId: CHANNEL_ROW_ID, message: normalizedMessage({ messageId: 'om_current' }) })
      .expect(202)

    await vi.waitFor(() => expect(mocks.api.send).toHaveBeenCalledTimes(2))
    expect(caught).toBe(providerError)
    expect(mocks.api.send).toHaveBeenNthCalledWith(
      2,
      'oc_chat',
      { markdown: '**Formatted answer**' },
      {
        replyTo: 'om_current',
        replyInThread: true,
        resolveMentionsInText: true,
      },
    )
    expect(mocks.api.recallMessage).not.toHaveBeenCalled()
  })

  it('adds the configured acknowledgment reaction before processing', async () => {
    const { app } = setup({ config: { ackReaction: '👀' } })
    await request(app)
      .post('/internal/feishu/inbound')
      .set('X-Connector-Secret', 'shared-secret')
      .send({ channelId: CHANNEL_ROW_ID, message: normalizedMessage() })
      .expect(202)

    await vi.waitFor(() => expect(mocks.processChannelMessage).toHaveBeenCalledOnce())
    expect(mocks.api.addReaction).toHaveBeenCalledWith('om_1', 'EYES')
  })

  it('claims a link code and merges the prior Feishu shadow before chat', async () => {
    const linkCodeStore = {
      findValidCode: vi.fn(async () => ({ id: 'code-1' })),
      claim: vi.fn(async () => ({
        id: 'code-1',
        userId: 'linked-user-1',
        assistantId: ASSISTANT_ID,
      })),
    }
    const linkedAccountStore = {
      upsert: vi.fn(async () => ({})),
      findByProvider: vi.fn(),
    }
    const { app } = setup({
      route: { linkCodeStore, linkedAccountStore } as never,
    })

    await request(app)
      .post('/internal/feishu/inbound')
      .set('X-Connector-Secret', 'shared-secret')
      .send({ channelId: CHANNEL_ROW_ID, message: normalizedMessage({ content: 'ABC123' }) })
      .expect(202)

    await vi.waitFor(() => expect(linkedAccountStore.upsert).toHaveBeenCalledOnce())
    expect(linkedAccountStore.upsert).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'linked-user-1',
      provider: 'feishu',
      providerId: 'ou_sender',
      providerMetadata: expect.objectContaining({ brand: 'feishu', channelId: 'oc_chat' }),
    }))
    expect(mocks.mergeShadowUser).toHaveBeenCalledWith(
      'linked-user-1',
      'ou_sender',
      'feishu',
      expect.objectContaining({ reason: 'link-code' }),
    )
    expect(mocks.processChannelMessage).not.toHaveBeenCalled()
  })

  it('uses a linked Feishu identity before anonymous shadow resolution', async () => {
    const linkedAccountStore = {
      findByProvider: vi.fn(async () => ({
        userId: 'linked-user-1',
        assistantId: ASSISTANT_ID,
      })),
    }
    const channelUserStore = { cache: vi.fn() }
    const { app } = setup({
      route: { linkedAccountStore, channelUserStore } as never,
    })

    await request(app)
      .post('/internal/feishu/inbound')
      .set('X-Connector-Secret', 'shared-secret')
      .send({ channelId: CHANNEL_ROW_ID, message: normalizedMessage() })
      .expect(202)

    await vi.waitFor(() => expect(mocks.processChannelMessage).toHaveBeenCalledOnce())
    expect(mocks.channelLinkBindsHere).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'linked-user-1' }),
      ASSISTANT_ID,
      'owner-1',
      'workspace-1',
    )
    expect(mocks.ensureAssistantMember).toHaveBeenCalledWith(ASSISTANT_ID, 'linked-user-1')
    expect(mocks.resolveChannelUser).not.toHaveBeenCalled()
    expect(mocks.processChannelMessage).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'linked-user-1',
      isIdentified: true,
    }))
  })

  it('resolves a deferred scheduled confirmation from a card action', async () => {
    const deferredConfirmationStore = {
      findPendingByChannel: vi.fn(async () => ({ toolCallId: 'tool-1' })),
      markResolved: vi.fn(async () => {}),
    }
    const { app } = setup({ route: { deferredConfirmationStore } as never })

    await request(app)
      .post('/internal/feishu/interaction')
      .set('X-Connector-Secret', 'shared-secret')
      .send({
        channelId: CHANNEL_ROW_ID,
        interaction: {
          messageId: 'om_card',
          chatId: 'oc_chat',
          operator: { openId: 'ou_sender' },
          action: { value: 'mcp_confirm:tool-1:allow', tag: 'button' },
        },
      })
      .expect(202)

    await vi.waitFor(() => expect(deferredConfirmationStore.markResolved).toHaveBeenCalledOnce())
    expect(deferredConfirmationStore.findPendingByChannel).toHaveBeenCalledWith('feishu', 'oc_chat')
    expect(mocks.tryResolveSchedulerConfirmation).toHaveBeenCalledWith(
      'tool-1',
      'allow',
      { channelType: 'feishu', channelId: 'oc_chat' },
    )
    expect(mocks.api.updateCard).toHaveBeenCalledWith(
      'om_card',
      expect.objectContaining({ elements: expect.any(Array) }),
    )
  })

  it('resolves a deferred scheduled confirmation from the text fallback', async () => {
    const deferredConfirmationStore = {
      findPendingByChannel: vi.fn(async () => ({ toolCallId: 'tool-2' })),
      markResolved: vi.fn(async () => {}),
    }
    const { app } = setup({ route: { deferredConfirmationStore } as never })

    await request(app)
      .post('/internal/feishu/inbound')
      .set('X-Connector-Secret', 'shared-secret')
      .send({ channelId: CHANNEL_ROW_ID, message: normalizedMessage({ content: 'yes' }) })
      .expect(202)

    await vi.waitFor(() => expect(deferredConfirmationStore.markResolved).toHaveBeenCalledOnce())
    expect(deferredConfirmationStore.findPendingByChannel).toHaveBeenCalledWith(
      'feishu',
      'oc_chat',
      ASSISTANT_ID,
    )
    expect(mocks.processChannelMessage).not.toHaveBeenCalled()
  })

  it('downloads and stages provider media before the archive append', async () => {
    const storeBuffer = vi.fn(async () => ({
      assetId: 'asset-1',
      sha256: 'a'.repeat(64),
      filename: 'photo.png',
      mime: 'image/png',
      sizeBytes: 3,
    }))
    const { app } = setup({
      route: { archiveMedia: { storeBuffer } as never },
    })
    await request(app)
      .post('/internal/feishu/inbound')
      .set('X-Connector-Secret', 'shared-secret')
      .send({
        channelId: CHANNEL_ROW_ID,
        message: normalizedMessage({
          content: '',
          rawContentType: 'image',
          resources: [{ type: 'image', fileKey: 'img_1', fileName: 'photo.png' }],
        }),
      })
      .expect(202)

    await vi.waitFor(() => expect(mocks.processChannelMessage).toHaveBeenCalledOnce())
    expect(mocks.api.downloadResource).toHaveBeenCalledWith('om_1', 'img_1', 'image')
    expect(storeBuffer).toHaveBeenCalledWith(expect.objectContaining({
      source: 'feishu',
      providerMessageId: 'om_1',
      kind: 'image',
      filename: 'photo.png',
      mime: 'image/png',
    }))
    expect(mocks.processChannelMessage).toHaveBeenCalledWith(expect.objectContaining({
      archiveIncoming: expect.objectContaining({
        archiveMediaRef: expect.objectContaining({ assetId: 'asset-1' }),
      }),
      userContentBlocks: expect.arrayContaining([
        expect.objectContaining({ type: 'image', mimeType: 'image/png' }),
      ]),
    }))
  })
})
