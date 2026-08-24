import { describe, expect, it, vi } from 'vitest'
import type { FeishuNormalizedMessage } from '@use-brian/channels'
import {
  createFeishuConnectorManager,
  type FeishuChannelFactory,
} from '../manager.js'

function harness() {
  let handlers: Record<string, ((value?: unknown) => unknown)> = {}
  const channel = {
    on: vi.fn((next: typeof handlers) => {
      handlers = next
      return vi.fn()
    }),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    getBotIdentity: vi.fn(() => ({ openId: 'ou_bot', name: 'Brian' })),
    getConnectionStatus: vi.fn(() => ({ state: 'connected' })),
  }
  const factory = vi.fn(() => channel) as unknown as FeishuChannelFactory
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url)
    if (path.endsWith('/internal/feishu/channels')) {
      return new Response(JSON.stringify({ channels: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
  const manager = createFeishuConnectorManager({
    apiUrl: 'https://api.example.com/',
    connectorSecret: 'shared',
    createChannel: factory,
    fetchImpl,
  })
  return { manager, factory, channel, fetchImpl, getHandlers: () => handlers }
}

function message(): FeishuNormalizedMessage & { raw?: unknown } {
  return {
    messageId: 'om_1',
    chatId: 'oc_1',
    chatType: 'p2p',
    senderId: 'ou_1',
    content: 'hello',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
    raw: { secretProviderField: true },
  }
}

describe('[COMP:app/feishu-connector] connection manager', () => {
  it('connects with the exact brand domain and route-authoritative policy', async () => {
    const h = harness()
    await expect(h.manager.connect('channel_1', {
      appId: 'cli_app',
      appSecret: 'secret',
      brand: 'lark',
    })).resolves.toMatchObject({
      channelId: 'channel_1',
      brand: 'lark',
      status: 'connected',
      botOpenId: 'ou_bot',
    })
    expect(h.factory).toHaveBeenCalledWith(expect.objectContaining({
      appId: 'cli_app',
      domain: 'https://open.larksuite.com',
      transport: 'websocket',
      policy: expect.objectContaining({ requireMention: false, dmMode: 'open' }),
      includeRawEvent: false,
    }))
  })

  it('detaches normalized inbound forwarding and never includes raw events', async () => {
    const h = harness()
    await h.manager.connect('channel_1', {
      appId: 'cli_app', appSecret: 'secret', brand: 'feishu',
    })
    const handler = h.getHandlers().message
    expect(handler).toBeTypeOf('function')
    handler(message())
    await vi.waitFor(() => expect(h.fetchImpl).toHaveBeenCalled())

    const call = vi.mocked(h.fetchImpl).mock.calls.find(([url]) =>
      String(url).endsWith('/internal/feishu/inbound'))
    expect(call).toBeDefined()
    const body = JSON.parse(String(call![1]?.body))
    expect(body).toMatchObject({ channelId: 'channel_1', message: { messageId: 'om_1' } })
    expect(body.message.raw).toBeUndefined()
    expect(call![1]?.headers).toMatchObject({ 'X-Connector-Secret': 'shared' })
  })

  it('forwards card actions immediately and returns a synchronous toast', async () => {
    const h = harness()
    await h.manager.connect('channel_1', {
      appId: 'cli_app', appSecret: 'secret', brand: 'feishu',
    })
    const result = h.getHandlers().cardAction?.({
      messageId: 'om_card',
      chatId: 'oc_1',
      operator: { openId: 'ou_1' },
      action: { value: { data: 'mcp_confirm:call:allow' }, tag: 'button' },
      raw: { never: 'forward' },
    })
    expect(result).toEqual({ toast: { type: 'info', content: 'Received' } })
    await vi.waitFor(() => expect(vi.mocked(h.fetchImpl).mock.calls.some(([url]) =>
      String(url).endsWith('/internal/feishu/interaction'))).toBe(true))
  })

  it('forwards normalized reaction feedback without the raw event', async () => {
    const h = harness()
    await h.manager.connect('channel_1', {
      appId: 'cli_app', appSecret: 'secret', brand: 'feishu',
    })
    h.getHandlers().reaction?.({
      messageId: 'om_assistant',
      operator: { openId: 'ou_reactor' },
      emojiType: 'THUMBSDOWN',
      action: 'added',
      actionTime: 1_700_000_000_000,
      raw: { never: 'forward' },
    })

    await vi.waitFor(() => expect(vi.mocked(h.fetchImpl).mock.calls.some(([url]) =>
      String(url).endsWith('/internal/feishu/reaction'))).toBe(true))
    const call = vi.mocked(h.fetchImpl).mock.calls.find(([url]) =>
      String(url).endsWith('/internal/feishu/reaction'))
    const body = JSON.parse(String(call![1]?.body))
    expect(body).toEqual({
      channelId: 'channel_1',
      reaction: {
        messageId: 'om_assistant',
        operator: { openId: 'ou_reactor' },
        emojiType: 'THUMBSDOWN',
        action: 'added',
        actionTime: 1_700_000_000_000,
      },
    })
  })

  it('tracks reconnects/rejects and disconnects idempotently', async () => {
    const h = harness()
    await h.manager.connect('channel_1', {
      appId: 'cli_app', appSecret: 'secret', brand: 'feishu',
    })
    h.getHandlers().reconnecting?.()
    h.getHandlers().reject?.({ reason: 'no_mention' })
    h.getHandlers().reconnected?.()
    expect(h.manager.getStatus('channel_1')).toMatchObject({
      status: 'connected',
      reconnectCount: 1,
      rejectCount: 1,
    })
    await h.manager.disconnect('channel_1')
    await h.manager.disconnect('channel_1')
    expect(h.channel.disconnect).toHaveBeenCalledTimes(1)
    expect(h.manager.getStatus('channel_1')).toBeNull()
  })

  it('restores every active channel returned by the API', async () => {
    const h = harness()
    const response = {
      channels: [{
        channelId: 'channel_restore',
        credentials: { app_id: 'cli', app_secret: 'secret', brand: 'lark' },
      }],
    }
    vi.mocked(h.fetchImpl).mockResolvedValueOnce(new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    await h.manager.restoreAll()
    expect(h.manager.getStatus('channel_restore')).toMatchObject({
      status: 'connected',
      brand: 'lark',
    })
  })
})
