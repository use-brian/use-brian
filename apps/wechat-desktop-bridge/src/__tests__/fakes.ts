/** Test doubles shared by the bridge suites. Fictional ids only. */
import type {
  AgentWechatChat,
  AgentWechatClient,
  AgentWechatLoginEvent,
  AgentWechatMediaResult,
  AgentWechatMessage,
  AgentWechatSendParams,
} from '../agent-wechat-client.js'
import type { BrianBridgeClient } from '../brian-bridge-client.js'
import type { BridgeInbound, BridgeState, OutboxAckResult, OutboxItem } from '../protocol-types.js'

export function chat(over: Partial<AgentWechatChat> & { id: string }): AgentWechatChat {
  return {
    username: over.id,
    name: 'Test Contact',
    unreadCount: 0,
    isGroup: over.id.endsWith('@chatroom'),
    ...over,
  }
}

export function msg(over: Partial<AgentWechatMessage> & { localId: number; chatId: string }): AgentWechatMessage {
  return {
    serverId: 1_000_000 + over.localId,
    type: 1,
    content: `hello ${over.localId}`,
    timestamp: '2026-08-19T10:00:00.000Z',
    ...over,
  }
}

export type FakeAgent = AgentWechatClient & {
  chats: AgentWechatChat[]
  messages: Map<string, AgentWechatMessage[]>
  media: Map<string, AgentWechatMediaResult[]>
  sent: AgentWechatSendParams[]
  sendResult: { success: boolean; error?: string }
  auth: { status: 'logged_in' | 'logged_out' | 'app_not_running' | 'unknown'; loggedInUser?: string }
  authCalls: number
  logoutCalls: number
  mediaCalls: number
  openedChats: string[]
  openResult: { ok: boolean; error?: string }
  /** Login WS control: push events into the most recent subscription. */
  emit(event: AgentWechatLoginEvent): void
  subscriptions: number
  closedSubscriptions: number
}

export function fakeAgent(): FakeAgent {
  let handlers: { onEvent: (e: AgentWechatLoginEvent) => void; onClose?: () => void } | null = null
  const a: FakeAgent = {
    chats: [],
    messages: new Map(),
    media: new Map(),
    sent: [],
    sendResult: { success: true },
    auth: { status: 'logged_out' },
    authCalls: 0,
    logoutCalls: 0,
    mediaCalls: 0,
    openedChats: [],
    openResult: { ok: true },
    subscriptions: 0,
    closedSubscriptions: 0,
    emit(event) {
      handlers?.onEvent(event)
    },
    async health() {
      return true
    },
    async authStatus() {
      a.authCalls++
      return a.auth
    },
    async logout() {
      a.logoutCalls++
      a.auth = { status: 'logged_out' }
      return { success: true }
    },
    async listChats() {
      return a.chats
    },
    async listMessages(chatId, limit = 50) {
      // Newest first, like the container.
      return [...(a.messages.get(chatId) ?? [])].sort((x, y) => y.localId - x.localId).slice(0, limit)
    },
    async getMedia(chatId, localId) {
      a.mediaCalls++
      const key = `${chatId}:${localId}`
      const queue = a.media.get(key)
      if (!queue || queue.length === 0) return { type: 'unsupported', format: '', filename: '' }
      return queue.length > 1 ? queue.shift()! : queue[0]!
    },
    async sendMessage(params) {
      a.sent.push(params)
      return a.sendResult
    },
    async openChat(chatId) {
      a.openedChats.push(chatId)
      return a.openResult
    },
    subscribeLogin(h) {
      a.subscriptions++
      handlers = h
      return {
        close: () => {
          a.closedSubscriptions++
          if (handlers === h) handlers = null
          h.onClose?.()
        },
      }
    },
  }
  return a
}

export type FakeBridge = BrianBridgeClient & {
  states: BridgeState[]
  inbound: BridgeInbound[]
  acks: OutboxAckResult[][]
  queue: OutboxItem[][]
  /** Throw this on the next N postInbound calls. */
  failInboundWith: Error | null
  failInboundTimes: number
}

export function fakeBridge(): FakeBridge {
  const b: FakeBridge = {
    states: [],
    inbound: [],
    acks: [],
    queue: [],
    failInboundWith: null,
    failInboundTimes: 0,
    async hello() {
      return {
        channelId: 'chan_example',
        workspaceId: 'ws_example',
        displayName: 'Test WeChat',
        kind: 'wechat-desktop',
        config: {},
        protocol: 1,
        serverTime: new Date(0).toISOString(),
      }
    },
    async putState(state) {
      b.states.push(state)
    },
    async postInbound(inbound) {
      if (b.failInboundWith && b.failInboundTimes > 0) {
        b.failInboundTimes--
        throw b.failInboundWith
      }
      b.inbound.push(inbound)
      return { status: 200, archivedOnly: false }
    },
    async pollOutbox() {
      // Yield a macrotask like a real long-poll would, so loops under test never starve the event loop.
      await new Promise((r) => setImmediate(r))
      return b.queue.shift() ?? []
    },
    async ack(results) {
      b.acks.push(results)
    },
    async heartbeat() {},
  }
  return b
}
