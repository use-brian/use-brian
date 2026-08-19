/**
 * Inbound monitor: polls the container's chat list, detects dirty chats by
 * `lastMsgLocalId` vs the persisted cursor, fetches + maps the new rows oldest
 * first, POSTs each to `/inbound`, and advances the cursor after each 2xx.
 * Spec: docs/architecture/channels/wechat-desktop.md → "Monitor".
 */
import type { AgentWechatChat, AgentWechatClient, AgentWechatMessage } from './agent-wechat-client.js'
import { BridgeHttpError, type BrianBridgeClient } from './brian-bridge-client.js'
import { consoleLogger, errorMessage, sleep as defaultSleep, type Logger } from './log.js'
import { ATTACHMENT_UNAVAILABLE, mapMessage, messageMayHaveMedia, type MediaOutcome } from './map-message.js'
import { saveStateFile, type BridgeStateFile } from './state-file.js'

const CHAT_LIST_LIMIT = 200
const MESSAGE_FETCH_LIMIT = 50
const MEDIA_RETRY_ATTEMPTS = 15
const MEDIA_RETRY_INTERVAL_MS = 1000

export type MonitorDeps = {
  agent: AgentWechatClient
  bridge: BrianBridgeClient
  state: BridgeStateFile
  stateFilePath: string
  pollIntervalMs: number
  backfillOnFirstBoot: boolean
  isLoggedIn: () => boolean
  log?: Logger
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  mediaRetry?: { attempts: number; intervalMs: number }
  onFatal?: (err: unknown) => void
}

export type Monitor = {
  start(): void
  stop(): void
  /** One poll pass. Exposed for tests. */
  tick(): Promise<void>
}

function chatIdOf(chat: Pick<AgentWechatChat, 'id' | 'username'>): string {
  return chat.id || chat.username
}

/**
 * Official accounts (`gh_…`) are never forwarded (subscription/marketing spam).
 * File Transfer (`filehelper`) IS forwarded: it is the owner's own notes/files
 * scratchpad and belongs in a personal-account mirror (archived as outbound via
 * the isSelf path).
 */
export function isSkippedChat(chat: Pick<AgentWechatChat, 'id' | 'username'>): boolean {
  const ids = [chat.id, chat.username].filter(Boolean) as string[]
  return ids.some((id) => id.startsWith('gh_'))
}

export function createMonitor(deps: MonitorDeps): Monitor {
  const log = deps.log ?? consoleLogger
  const sleep = deps.sleep ?? defaultSleep
  const retry = deps.mediaRetry ?? { attempts: MEDIA_RETRY_ATTEMPTS, intervalMs: MEDIA_RETRY_INTERVAL_MS }
  const abort = new AbortController()
  let loopPromise: Promise<void> | null = null
  let ticking = false

  async function persist(): Promise<void> {
    try {
      await saveStateFile(deps.stateFilePath, deps.state)
    } catch (err) {
      log.error(`failed to persist state file: ${errorMessage(err)}`)
    }
  }

  async function fetchMedia(chatId: string, msg: AgentWechatMessage): Promise<MediaOutcome> {
    if (!messageMayHaveMedia(msg)) return { status: 'not_applicable' }
    for (let attempt = 1; attempt <= retry.attempts; attempt++) {
      if (abort.signal.aborted) break
      try {
        const result = await deps.agent.getMedia(chatId, msg.localId)
        if (result.type === 'unsupported') return { status: 'unsupported' }
        if (result.data) return { status: 'fetched', result }
      } catch (err) {
        log.warn(`media fetch ${chatId}:${msg.localId} attempt ${attempt} failed: ${errorMessage(err)}`)
      }
      if (attempt < retry.attempts) await sleep(retry.intervalMs, abort.signal)
    }
    return { status: 'unavailable' }
  }

  /** Returns true when the cursor may advance past this message. */
  async function forward(chat: AgentWechatChat, msg: AgentWechatMessage): Promise<boolean> {
    const chatId = chatIdOf(chat)
    const media = await fetchMedia(chatId, msg)
    const mapped = mapMessage(msg, chat, media)
    if (!mapped) return true
    try {
      await deps.bridge.postInbound({ message: mapped })
      return true
    } catch (err) {
      if (err instanceof BridgeHttpError && err.status === 413 && mapped.media) {
        // Too large for the API: re-send the text row with a note of our own.
        const note = '[attachment too large]'
        const text = mapped.text && mapped.text !== ATTACHMENT_UNAVAILABLE ? `${mapped.text} ${note}` : note
        const { media: _dropped, ...rest } = mapped
        try {
          await deps.bridge.postInbound({ message: { ...rest, text } })
          return true
        } catch (err2) {
          return handleInboundError(chatId, msg, err2)
        }
      }
      return handleInboundError(chatId, msg, err)
    }
  }

  function handleInboundError(chatId: string, msg: AgentWechatMessage, err: unknown): boolean {
    if ((err as { name?: string })?.name === 'FatalConfigError') {
      deps.onFatal?.(err)
      return false
    }
    if (err instanceof BridgeHttpError && err.status >= 400 && err.status < 500) {
      // A 4xx is a poison row, not an outage: skip it so it cannot block the chat forever.
      log.error(`inbound ${chatId}:${msg.localId} rejected (${err.status}); skipping row: ${err.message}`)
      return true
    }
    log.warn(`inbound ${chatId}:${msg.localId} failed; will retry next tick: ${errorMessage(err)}`)
    return false
  }

  async function processChat(chat: AgentWechatChat, cursor: number): Promise<void> {
    const chatId = chatIdOf(chat)
    let rows: AgentWechatMessage[]
    try {
      rows = await deps.agent.listMessages(chatId, MESSAGE_FETCH_LIMIT)
    } catch (err) {
      log.warn(`list messages ${chatId} failed: ${errorMessage(err)}`)
      return
    }
    const fresh = rows.filter((m) => m.localId > cursor).sort((a, b) => a.localId - b.localId)
    for (const msg of fresh) {
      if (abort.signal.aborted) return
      const ok = await forward(chat, msg)
      if (!ok) return
      deps.state.cursors[chatId] = msg.localId
      await persist()
    }
  }

  async function tick(): Promise<void> {
    if (ticking || !deps.isLoggedIn()) return
    ticking = true
    try {
      let chats: AgentWechatChat[]
      try {
        chats = await deps.agent.listChats(CHAT_LIST_LIMIT)
      } catch (err) {
        log.warn(`list chats failed: ${errorMessage(err)}`)
        return
      }
      let seededAny = false
      for (const chat of chats) {
        if (abort.signal.aborted) return
        if (isSkippedChat(chat)) continue
        const chatId = chatIdOf(chat)
        if (!chatId) continue
        const last = chat.lastMsgLocalId
        if (typeof last !== 'number') continue
        const cursor = deps.state.cursors[chatId]
        if (cursor === undefined) {
          if (deps.backfillOnFirstBoot) {
            deps.state.cursors[chatId] = 0
          } else {
            deps.state.cursors[chatId] = last
            seededAny = true
            continue
          }
        }
        const effective = deps.state.cursors[chatId] ?? 0
        if (last <= effective) continue
        await processChat(chat, effective)
      }
      if (seededAny) await persist()
    } finally {
      ticking = false
    }
  }

  async function loop(): Promise<void> {
    while (!abort.signal.aborted) {
      try {
        await tick()
      } catch (err) {
        log.error(`monitor tick crashed: ${errorMessage(err)}`)
      }
      await sleep(deps.pollIntervalMs, abort.signal)
    }
  }

  return {
    start() {
      if (!loopPromise) loopPromise = loop()
    },
    stop() {
      abort.abort()
    },
    tick,
  }
}
