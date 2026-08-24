/**
 * Owns exactly one official Feishu/Lark long connection per channel app and
 * relays provider-normalized events to brian-api.
 *
 * [COMP:app/feishu-connector]
 */

import { createLarkChannel } from '@larksuite/channel'
import type {
  FeishuBrand,
  FeishuCardAction,
  FeishuNormalizedMessage,
} from '@use-brian/channels'

const DOMAIN: Readonly<Record<FeishuBrand, string>> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
}

export type FeishuConnectorCredentials = {
  appId: string
  appSecret: string
  brand: FeishuBrand
}

export type FeishuConnectorStatus = {
  channelId: string
  brand: FeishuBrand
  status: 'connecting' | 'connected' | 'disconnected'
  botOpenId?: string
  botName?: string
  connectedAt?: number
  lastEventAt?: number
  reconnectCount: number
  rejectCount: number
  lastErrorCode?: string
  connection?: unknown
}

type RejectEvent = {
  messageId: string
  chatId: string
  senderId: string
  reason: string
}

type ReactionEvent = {
  messageId: string
  operator: { openId: string; userId?: string }
  emojiType: string
  action: 'added' | 'removed'
  actionTime?: number
}

type ChannelHandlers = {
  message?: (message: FeishuNormalizedMessage & { raw?: unknown }) => void | Promise<void>
  cardAction?: (event: FeishuCardAction & { raw?: unknown }) => unknown
  reaction?: (event: ReactionEvent & { raw?: unknown }) => void
  reject?: (event: RejectEvent) => void
  error?: (error: unknown) => void
  reconnecting?: () => void
  reconnected?: () => void
}

type FeishuChannelPort = {
  on(handlers: ChannelHandlers): () => void
  connect(): Promise<void>
  disconnect(): Promise<void>
  getBotIdentity(): { openId: string; name: string }
  getConnectionStatus(): unknown
}

export type FeishuChannelFactory = (input: {
  appId: string
  appSecret: string
  domain: string
  transport: 'websocket'
  policy: Record<string, unknown>
  safety: Record<string, unknown>
  resolveChatMode: boolean
  resolveSenderNames: boolean
  includeRawEvent: false
  handshakeTimeoutMs: number
  httpTimeoutMs: number
  keepalive: { enabled: true; intervalMs: number; onUnrecoverable: (error: unknown) => void }
  source: string
}) => FeishuChannelPort

export type FeishuConnectorManagerOptions = {
  apiUrl: string
  connectorSecret: string
  createChannel?: FeishuChannelFactory
  fetchImpl?: typeof fetch
}

type Managed = {
  channel: FeishuChannelPort
  status: FeishuConnectorStatus
  unsubscribe: () => void
}

type RestoredChannel = {
  channelId: string
  credentials: {
    app_id: string
    app_secret: string
    brand: FeishuBrand
  }
}

function normalizedMessage(message: FeishuNormalizedMessage & { raw?: unknown }): FeishuNormalizedMessage {
  return {
    messageId: message.messageId,
    chatId: message.chatId,
    chatType: message.chatType,
    ...(message.chatMode ? { chatMode: message.chatMode } : {}),
    senderId: message.senderId,
    ...(message.senderName ? { senderName: message.senderName } : {}),
    ...(message.senderType ? { senderType: message.senderType } : {}),
    ...(message.senderIsBot != null ? { senderIsBot: message.senderIsBot } : {}),
    content: message.content,
    rawContentType: message.rawContentType,
    resources: message.resources.map((resource) => ({ ...resource })),
    mentions: message.mentions.map((mention) => ({ ...mention })),
    mentionAll: message.mentionAll,
    mentionedBot: message.mentionedBot,
    ...(message.rootId ? { rootId: message.rootId } : {}),
    ...(message.threadId ? { threadId: message.threadId } : {}),
    ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
    createTime: message.createTime,
  }
}

function normalizedCardAction(event: FeishuCardAction & { raw?: unknown }): FeishuCardAction {
  return {
    messageId: event.messageId,
    chatId: event.chatId,
    operator: { ...event.operator },
    action: {
      value: event.action.value,
      tag: event.action.tag,
      ...(event.action.name ? { name: event.action.name } : {}),
      ...(event.action.option ? { option: event.action.option } : {}),
      ...(event.action.formValue ? { formValue: { ...event.action.formValue } } : {}),
    },
  }
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code.slice(0, 80)
  }
  return 'unknown'
}

export function createFeishuConnectorManager(options: FeishuConnectorManagerOptions) {
  const fetchImpl = options.fetchImpl ?? fetch
  const createChannel: FeishuChannelFactory = options.createChannel
    ?? ((input) => createLarkChannel(input) as unknown as FeishuChannelPort)
  const base = options.apiUrl.replace(/\/$/, '')
  const managed = new Map<string, Managed>()

  async function apiCall(path: string, body?: unknown): Promise<unknown> {
    const response = await fetchImpl(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'X-Connector-Secret': options.connectorSecret,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) {
      throw new Error(`brian-api ${path} failed with HTTP ${response.status}`)
    }
    if (response.status === 204) return undefined
    return response.json()
  }

  function detachPost(channelId: string, path: string, body: unknown): void {
    void apiCall(path, body).catch((error) => {
      const current = managed.get(channelId)
      if (current) current.status.lastErrorCode = errorCode(error)
    })
  }

  async function connect(
    channelId: string,
    credentials: FeishuConnectorCredentials,
  ): Promise<FeishuConnectorStatus> {
    await disconnect(channelId)

    const status: FeishuConnectorStatus = {
      channelId,
      brand: credentials.brand,
      status: 'connecting',
      reconnectCount: 0,
      rejectCount: 0,
    }
    let channel!: FeishuChannelPort
    channel = createChannel({
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      domain: DOMAIN[credentials.brand],
      transport: 'websocket',
      // The API route applies the live integration config. The bridge accepts
      // every event delivered by the app's least-privilege subscription.
      policy: {
        requireMention: false,
        dmMode: 'open',
        respondToMentionAll: true,
        botLoopGuard: { enabled: true, maxBotMentions: 3, onTrip: 'reject' },
      },
      safety: {
        chatQueue: { enabled: false },
        staleMessageWindowMs: 5 * 60_000,
      },
      resolveChatMode: true,
      resolveSenderNames: true,
      includeRawEvent: false,
      handshakeTimeoutMs: 15_000,
      httpTimeoutMs: 15_000,
      keepalive: {
        enabled: true,
        intervalMs: 15_000,
        onUnrecoverable: (error) => {
          const current = managed.get(channelId)
          if (current) {
            current.status.status = 'disconnected'
            current.status.lastErrorCode = errorCode(error)
          }
        },
      },
      source: 'use-brian',
    })

    const unsubscribe = channel.on({
      message(message) {
        status.lastEventAt = Date.now()
        detachPost(channelId, '/internal/feishu/inbound', {
          channelId,
          message: normalizedMessage(message),
        })
      },
      cardAction(event) {
        status.lastEventAt = Date.now()
        detachPost(channelId, '/internal/feishu/interaction', {
          channelId,
          interaction: normalizedCardAction(event),
        })
        return { toast: { type: 'info', content: 'Received' } }
      },
      reaction(event) {
        status.lastEventAt = Date.now()
        detachPost(channelId, '/internal/feishu/reaction', {
          channelId,
          reaction: {
            messageId: event.messageId,
            operator: { ...event.operator },
            emojiType: event.emojiType,
            action: event.action,
            ...(event.actionTime != null ? { actionTime: event.actionTime } : {}),
          },
        })
      },
      reject(event) {
        status.rejectCount += 1
        status.lastEventAt = Date.now()
        status.lastErrorCode = `reject:${event.reason}`.slice(0, 80)
      },
      reconnecting() {
        status.status = 'connecting'
        status.reconnectCount += 1
      },
      reconnected() {
        status.status = 'connected'
        status.connectedAt = Date.now()
        status.lastErrorCode = undefined
      },
      error(error) {
        status.lastErrorCode = errorCode(error)
      },
    })

    managed.set(channelId, { channel, status, unsubscribe })
    try {
      await channel.connect()
      const bot = channel.getBotIdentity()
      status.status = 'connected'
      status.botOpenId = bot.openId
      status.botName = bot.name
      status.connectedAt = Date.now()
      status.connection = channel.getConnectionStatus()
      status.lastErrorCode = undefined
      return { ...status }
    } catch (error) {
      status.status = 'disconnected'
      status.lastErrorCode = errorCode(error)
      try {
        await channel.disconnect()
      } catch {
        // best effort
      }
      throw error
    }
  }

  async function disconnect(channelId: string): Promise<void> {
    const current = managed.get(channelId)
    if (!current) return
    managed.delete(channelId)
    current.unsubscribe()
    await current.channel.disconnect().catch(() => {})
    current.status.status = 'disconnected'
  }

  function getStatus(channelId: string): FeishuConnectorStatus | null {
    const current = managed.get(channelId)
    if (!current) return null
    return {
      ...current.status,
      connection: current.channel.getConnectionStatus(),
    }
  }

  async function restoreAll(): Promise<void> {
    const response = await apiCall('/internal/feishu/channels') as { channels?: RestoredChannel[] }
    for (const item of response.channels ?? []) {
      try {
        await connect(item.channelId, {
          appId: item.credentials.app_id,
          appSecret: item.credentials.app_secret,
          brand: item.credentials.brand,
        })
      } catch (error) {
        console.error(
          `[feishu-connector] restore failed for channel ${item.channelId}: ${errorCode(error)}`,
        )
      }
    }
  }

  async function disconnectAll(): Promise<void> {
    await Promise.all([...managed.keys()].map((channelId) => disconnect(channelId)))
  }

  return { connect, disconnect, disconnectAll, getStatus, restoreAll }
}
