/**
 * Inbound monitor: polls the container's chat list, detects dirty chats by
 * `lastMsgLocalId` vs the persisted cursor, fetches + maps the new rows oldest
 * first, POSTs each to `/inbound`, and advances the cursor after each 2xx.
 * Spec: docs/architecture/channels/wechat-desktop.md → "Monitor".
 */
import type { AgentWechatChat, AgentWechatClient, AgentWechatMediaResult, AgentWechatMessage } from './agent-wechat-client.js'
import { BridgeHttpError, type BrianBridgeClient } from './brian-bridge-client.js'
import { consoleLogger, errorMessage, sleep as defaultSleep, type Logger } from './log.js'
import { ATTACHMENT_UNAVAILABLE, mapMessage, messageMayHaveMedia, type MediaOutcome } from './map-message.js'
import { createMediaUpgrader, storeReadyMedia } from './media-upgrade.js'
import { saveStateFile, type BridgeStateFile } from './state-file.js'

const CHAT_LIST_LIMIT = 200
const MESSAGE_FETCH_LIMIT = 50

export type MonitorDeps = {
  agent: AgentWechatClient
  bridge: BrianBridgeClient
  state: BridgeStateFile
  stateFilePath: string
  pollIntervalMs: number
  backfillOnFirstBoot: boolean
  isLoggedIn: () => boolean
  /** Hello advertised `media_upgrade` - enables durable media recovery. */
  mediaUpgradeEnabled?: boolean
  /** Hello advertised `media_stream`; ready bytes take the raw upload path. */
  mediaStreamEnabled?: boolean
  log?: Logger
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
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

  const upgrader = createMediaUpgrader({
    agent: deps.agent,
    bridge: deps.bridge,
    state: deps.state,
    persist,
    enabled: deps.mediaUpgradeEnabled === true,
    mediaStreamEnabled: deps.mediaStreamEnabled === true,
    log,
    isStopped: () => abort.signal.aborted,
    onFatal: deps.onFatal,
  })

  function mediaReady(result: AgentWechatMediaResult): boolean {
    return result.status === 'ready' || (!result.status && Boolean(result.data))
  }

  function mediaTerminal(result: AgentWechatMediaResult): boolean {
    return result.status === 'unavailable'
      || result.recoverable === false
  }

  function stagedResult(entry: NonNullable<BridgeStateFile['pendingMediaUpgrades']>[string][number]): AgentWechatMediaResult {
    const media = entry.stagedMedia!
    const ext = media.name.includes('.') ? media.name.slice(media.name.lastIndexOf('.') + 1) : ''
    return {
      type: entry.kind === 'sticker' ? 'emoji' : entry.kind,
      kind: entry.kind,
      status: 'ready',
      variant: entry.variant,
      format: ext,
      filename: media.name,
      mime: media.mime,
      sizeBytes: media.sizeBytes,
      sha256: media.stored?.sha256,
    }
  }

  async function fetchMedia(
    chat: AgentWechatChat,
    msg: AgentWechatMessage,
  ): Promise<{ outcome: MediaOutcome; holdCursor: boolean; result?: AgentWechatMediaResult }> {
    if (!messageMayHaveMedia(msg)) return { outcome: { status: 'not_applicable' }, holdCursor: false }
    const chatId = chatIdOf(chat)
    const pending = upgrader.find(chatId, msg.localId)
    // The raw upload commits before /inbound. Persisting its stable reference
    // closes the crash/network window between those calls: retry delivery from
    // the archive even if WeChat has already evicted its local bytes.
    if (pending?.stagedMedia) {
      const result = stagedResult(pending)
      return { outcome: { status: 'stored', result, media: pending.stagedMedia }, holdCursor: false, result }
    }
    if (pending && !upgrader.isDue(pending)) {
      return {
        outcome: {
          status: 'pending',
          result: { type: pending.kind, format: '', filename: '', status: 'pending', kind: pending.kind },
        },
        holdCursor: !pending.delivered,
      }
    }

    let result: AgentWechatMediaResult
    try {
      // A due persisted row can go straight through the idempotent recovery
      // endpoint. A first-seen row gets a non-mutating read only and remains
      // behind the cursor until a later poll.
      result = pending
        && deps.mediaUpgradeEnabled === true
        && chat.unreadCount === 0
        ? await deps.agent.ensureMedia(chatId, msg.localId)
        : await deps.agent.getMedia(chatId, msg.localId)
      // The recovery endpoint may drive the desktop UI, so never call it for
      // an unread chat: opening it would clear the owner's phone badge.
      if (
        deps.mediaUpgradeEnabled !== true
        && !mediaReady(result)
        && !mediaTerminal(result)
        && chat.unreadCount === 0
      ) {
        result = await deps.agent.ensureMedia(chatId, msg.localId)
      }
    } catch (err) {
      log.warn(`media fetch ${chatId}:${msg.localId} failed: ${errorMessage(err)}`)
      const mapped = mapMessage(msg, chat, { status: 'unavailable' })
      if (mapped) {
        const entry = upgrader.defer({
          chatId,
          msg,
          message: mapped,
          result: {
            type: pending?.kind ?? 'pending',
            format: '',
            filename: '',
            status: 'pending',
            kind: pending?.kind ?? 'image',
          },
          delivered: false,
        })
        upgrader.noteAttempt(entry)
        await persist()
      }
      return { outcome: { status: 'unavailable' }, holdCursor: true }
    }

    // Legacy runtimes used `type: unsupported` to mean "this row carries no
    // attachment". The explicit contract preserves that as not-applicable;
    // only status=unavailable/recoverable=false is terminal loss.
    if ((!result.status && result.type === 'unsupported')
      || (result.status === 'unavailable' && result.kind === 'unsupported' && result.reason === 'unsupported')) {
      return { outcome: { status: 'unsupported' }, holdCursor: false, result }
    }

    if (mediaTerminal(result)) {
      return {
        outcome: { status: 'terminal', reason: result.reason ?? 'provider reported the attachment unavailable' },
        holdCursor: false,
        result,
      }
    }

    if (!mediaReady(result)) {
      const mapped = mapMessage(msg, chat, { status: 'pending', result })
      if (mapped) {
        const entry = upgrader.defer({ chatId, msg, message: mapped, result, delivered: false })
        if (pending) upgrader.noteAttempt(entry, result.retryAfterMs)
        await persist()
      }
      return { outcome: { status: 'pending', result }, holdCursor: true, result }
    }

    try {
      const media = await storeReadyMedia({
        agent: deps.agent,
        bridge: deps.bridge,
        chatId,
        peerId: chatId,
        msg,
        result,
        mediaStreamEnabled: deps.mediaStreamEnabled === true,
      })
      if (media.stored) {
        const mapped = mapMessage(msg, chat, { status: 'stored', result, media })
        if (mapped) {
          const { media: _media, ...messageSansMedia } = mapped
          upgrader.defer({
            chatId,
            msg,
            message: messageSansMedia,
            result,
            delivered: false,
            forwardedSha256: result.sha256 ?? media.stored.sha256,
            stagedMedia: media,
          })
          await persist()
        }
      }
      return { outcome: { status: 'stored', result, media }, holdCursor: false, result }
    } catch (err) {
      log.warn(`media transfer ${chatId}:${msg.localId} failed: ${errorMessage(err)}`)
      const mapped = mapMessage(msg, chat, { status: 'pending', result })
      if (mapped) {
        const entry = upgrader.defer({ chatId, msg, message: mapped, result, delivered: false })
        upgrader.noteAttempt(entry, result.retryAfterMs)
        await persist()
      }
      return { outcome: { status: 'pending', result }, holdCursor: true, result }
    }
  }

  /** Returns true when the cursor may advance past this message. */
  async function forward(chat: AgentWechatChat, msg: AgentWechatMessage): Promise<boolean> {
    const chatId = chatIdOf(chat)
    const acquisition = await fetchMedia(chat, msg)
    if (acquisition.holdCursor) return false
    const mapped = mapMessage(msg, chat, acquisition.outcome)
    if (!mapped) return true
    try {
      await deps.bridge.postInbound({ message: mapped })
      if (acquisition.result?.variant === 'preview') {
        upgrader.markDeliveredPreview({ chatId, msg, message: mapped, result: acquisition.result })
      } else {
        upgrader.remove(chatId, msg.localId)
      }
      return true
    } catch (err) {
      if (err instanceof BridgeHttpError && err.status === 413 && mapped.media) {
        // Too large for the API: re-send the text row with a note of our own.
        const note = '[attachment too large]'
        const text = mapped.text && mapped.text !== ATTACHMENT_UNAVAILABLE ? `${mapped.text} ${note}` : note
        const { media: _dropped, ...rest } = mapped
        try {
          await deps.bridge.postInbound({ message: { ...rest, text } })
          // The platform explicitly rejected these bytes. Advance with the
          // honest terminal note rather than retaining recovery work whose
          // eventual upload would be rejected in exactly the same way.
          upgrader.remove(chatId, msg.localId)
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
      upgrader.remove(chatId, msg.localId)
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
      // Delivered-preview upgrade pass, after normal forwarding so newly
      // registered previews are eligible on later ticks.
      try {
        await upgrader.sweep(chats)
      } catch (err) {
        log.warn(`media upgrade sweep failed: ${errorMessage(err)}`)
      }
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
