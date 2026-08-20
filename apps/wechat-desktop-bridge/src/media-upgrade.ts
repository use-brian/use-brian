/**
 * Durable media recovery for the WeChat desktop bridge.
 *
 * A message row can exist before WeChat has materialized its attachment. The
 * bridge persists that pending state, keeps an undelivered row ahead of the
 * chat cursor, and retries with exponential backoff. Preview bytes may be
 * delivered once; their recovery entry remains until original bytes arrive,
 * then the same provider message id is re-posted as an archive-only upgrade.
 *
 * Spec: docs/architecture/channels/wechat-desktop.md -> "Durable media recovery".
 */
import type {
  AgentWechatChat,
  AgentWechatClient,
  AgentWechatMediaResult,
  AgentWechatMessage,
} from './agent-wechat-client.js'
import { BridgeHttpError, FatalConfigError, type BrianBridgeClient } from './brian-bridge-client.js'
import { consoleLogger, errorMessage, type Logger } from './log.js'
import { messageIdOf, toBridgeMedia, toBridgeStoredMedia } from './map-message.js'
import type { BridgeInboundMedia, BridgeInboundMessage } from './protocol-types.js'
import type { BridgeStateFile, PendingMediaUpgrade } from './state-file.js'

const MAX_CHATS_PER_SWEEP = 2
const BACKOFF_BASE_MS = 2_000
const BACKOFF_MAX_MS = 60 * 60 * 1000

function isReady(result: AgentWechatMediaResult): boolean {
  return result.status === 'ready' || (!result.status && Boolean(result.data))
}

function isTerminal(result: AgentWechatMediaResult): boolean {
  return result.status === 'unavailable'
    || result.recoverable === false
    || result.type === 'unsupported'
}

function mediaKind(result: AgentWechatMediaResult): PendingMediaUpgrade['kind'] {
  if (result.kind === 'file' || result.kind === 'video' || result.kind === 'voice' || result.kind === 'sticker') {
    return result.kind
  }
  return 'image'
}

function archiveUploadKind(result: AgentWechatMediaResult): 'image' | 'video' | 'voice' | 'file' {
  if (result.variant === 'preview' && result.mime?.startsWith('image/')) return 'image'
  if (result.kind === 'sticker' || result.kind === 'image' || result.type === 'image' || result.type === 'emoji') return 'image'
  if (result.kind === 'video' || result.type === 'video') return 'video'
  if (result.kind === 'voice' || result.type === 'voice') return 'voice'
  return 'file'
}

function nextDelay(attempts: number, retryAfterMs?: number): number {
  const exponential = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempts, 11))
  return Math.max(exponential, retryAfterMs ?? 0)
}

/**
 * Turn a ready runtime descriptor into one custom-channel media item. New
 * servers use raw streaming; an older server falls back to the descriptor's
 * embedded base64 so a rolling deploy remains compatible.
 */
export async function storeReadyMedia(input: {
  agent: AgentWechatClient
  bridge: BrianBridgeClient
  chatId: string
  peerId: string
  msg: AgentWechatMessage
  result: AgentWechatMediaResult
  mediaStreamEnabled: boolean
}): Promise<BridgeInboundMedia> {
  const { result } = input
  if (!isReady(result)) throw new Error('cannot store media that is not ready')

  if (input.mediaStreamEnabled && result.sha256 && result.sizeBytes != null) {
    const content = await input.agent.getMediaContent(input.chatId, input.msg.localId)
    if (content.contentLength !== result.sizeBytes) {
      throw new Error(`agent-wechat media size changed (${content.contentLength} != ${result.sizeBytes})`)
    }
    if (content.etag && content.etag.toLowerCase() !== result.sha256.toLowerCase()) {
      throw new Error('agent-wechat media digest changed before upload')
    }
    const stored = await input.bridge.uploadMedia({
      messageId: messageIdOf(input.msg),
      peerId: input.peerId,
      kind: archiveUploadKind(result),
      mime: result.mime ?? content.mime,
      filename: result.filename || content.filename,
      sha256: result.sha256,
      sizeBytes: result.sizeBytes,
      body: content.body,
    })
    return toBridgeStoredMedia(result, input.msg, stored)
  }

  const inline = toBridgeMedia(result, input.msg)
  if (!inline) throw new Error('ready media carried neither a stream descriptor nor inline bytes')
  return inline
}

export type MediaUpgraderDeps = {
  agent: AgentWechatClient
  bridge: BrianBridgeClient
  state: BridgeStateFile
  persist: () => Promise<void>
  /** Hello advertised `media_upgrade`. */
  enabled: boolean
  /** Hello advertised `media_stream`. */
  mediaStreamEnabled?: boolean
  log?: Logger
  isStopped?: () => boolean
  now?: () => number
  onFatal?: (err: unknown) => void
}

export type MediaUpgrader = {
  find(chatId: string, localId: number): PendingMediaUpgrade | undefined
  isDue(entry: PendingMediaUpgrade): boolean
  /** Persist a provider-pending row. `delivered=false` keeps the cursor behind it. */
  defer(input: {
    chatId: string
    msg: AgentWechatMessage
    message: BridgeInboundMessage
    result: AgentWechatMediaResult
    delivered?: boolean
    forwardedSha256?: string | null
    stagedMedia?: BridgeInboundMedia
  }): PendingMediaUpgrade
  noteAttempt(entry: PendingMediaUpgrade, retryAfterMs?: number): void
  remove(chatId: string, localId: number): void
  /** A preview was successfully posted; keep recovering it as an archive upgrade. */
  markDeliveredPreview(input: {
    chatId: string
    msg: AgentWechatMessage
    message: BridgeInboundMessage
    result: AgentWechatMediaResult
  }): void
  sweep(chats: AgentWechatChat[]): Promise<void>
}

export function createMediaUpgrader(deps: MediaUpgraderDeps): MediaUpgrader {
  const log = deps.log ?? consoleLogger
  const now = deps.now ?? Date.now
  const stopped = deps.isStopped ?? (() => false)

  function pendings(): Record<string, PendingMediaUpgrade[]> {
    if (!deps.state.pendingMediaUpgrades) deps.state.pendingMediaUpgrades = {}
    return deps.state.pendingMediaUpgrades
  }

  function find(chatId: string, localId: number): PendingMediaUpgrade | undefined {
    return deps.state.pendingMediaUpgrades?.[chatId]?.find((entry) => entry.localId === localId)
  }

  function remove(chatId: string, localId: number): void {
    const map = deps.state.pendingMediaUpgrades
    const entries = map?.[chatId]
    if (!entries) return
    const kept = entries.filter((entry) => entry.localId !== localId)
    if (kept.length > 0) map![chatId] = kept
    else delete map![chatId]
    if (map && Object.keys(map).length === 0) delete deps.state.pendingMediaUpgrades
  }

  function defer(input: {
    chatId: string
    msg: AgentWechatMessage
    message: BridgeInboundMessage
    result: AgentWechatMediaResult
    delivered?: boolean
    forwardedSha256?: string | null
    stagedMedia?: BridgeInboundMedia
  }): PendingMediaUpgrade {
    const map = pendings()
    const entries = (map[input.chatId] ??= [])
    let entry = entries.find((candidate) => candidate.localId === input.msg.localId)
    if (!entry) {
      entry = {
        localId: input.msg.localId,
        message: input.message,
        kind: mediaKind(input.result),
        delivered: input.delivered === true,
        variant: input.result.variant,
        forwardedSha256: input.forwardedSha256 ?? null,
        stagedMedia: input.stagedMedia,
        attempts: 0,
        firstSeenAt: now(),
        nextAttemptAt: now() + nextDelay(0, input.result.retryAfterMs),
      }
      entries.push(entry)
    } else {
      entry.message = input.message
      entry.kind = mediaKind(input.result)
      entry.variant = input.result.variant
      if (input.delivered !== undefined) entry.delivered = input.delivered
      if (input.forwardedSha256 !== undefined) entry.forwardedSha256 = input.forwardedSha256
      if (input.stagedMedia !== undefined) entry.stagedMedia = input.stagedMedia
    }
    return entry
  }

  function noteAttempt(entry: PendingMediaUpgrade, retryAfterMs?: number): void {
    entry.attempts += 1
    entry.nextAttemptAt = now() + nextDelay(entry.attempts, retryAfterMs)
  }

  const api: MediaUpgrader = {
    find,
    isDue: (entry) => now() >= entry.nextAttemptAt,
    defer,
    noteAttempt,
    remove,
    markDeliveredPreview({ chatId, msg, message, result }) {
      if (!deps.enabled || result.variant !== 'preview') return
      const { media: _media, ...messageSansMedia } = message
      const entry = defer({
        chatId,
        msg,
        message: messageSansMedia,
        result,
        delivered: true,
        forwardedSha256: result.sha256 ?? null,
      })
      delete entry.stagedMedia
    },

    async sweep(chats) {
      if (!deps.enabled) return
      const map = deps.state.pendingMediaUpgrades
      if (!map) return
      const byChat = new Map(chats.map((chat) => [chat.id || chat.username, chat]))
      let changed = false
      let drivenChats = 0

      for (const chatId of Object.keys(map)) {
        if (stopped() || drivenChats >= MAX_CHATS_PER_SWEEP) break
        const chat = byChat.get(chatId)
        if (!chat || chat.unreadCount !== 0) continue
        const due = (map[chatId] ?? []).filter((entry) => entry.delivered && api.isDue(entry))
        if (due.length === 0) continue
        drivenChats += 1

        for (const entry of [...due]) {
          if (stopped()) break
          if (entry.stagedMedia) {
            try {
              await deps.bridge.postInbound({
                message: { ...entry.message, media: [entry.stagedMedia] },
                mediaUpgrade: true,
              })
              remove(chatId, entry.localId)
              changed = true
              log.info(`media recovery: ${chatId}:${entry.localId} delivered its committed archive upgrade`)
            } catch (err) {
              if (err instanceof FatalConfigError) {
                deps.onFatal?.(err)
                return
              }
              if (err instanceof BridgeHttpError && err.status >= 400 && err.status < 500) {
                log.error(`media recovery: staged upgrade ${chatId}:${entry.localId} rejected (${err.status})`)
                remove(chatId, entry.localId)
              } else {
                log.warn(`media recovery: staged upgrade ${chatId}:${entry.localId} failed; will retry: ${errorMessage(err)}`)
                noteAttempt(entry)
              }
              changed = true
            }
            continue
          }
          let result: AgentWechatMediaResult
          try {
            result = await deps.agent.ensureMedia(chatId, entry.localId)
          } catch (err) {
            log.warn(`media recovery: ensure ${chatId}:${entry.localId} failed: ${errorMessage(err)}`)
            noteAttempt(entry)
            changed = true
            continue
          }

          if (isTerminal(result)) {
            log.warn(`media recovery: ${chatId}:${entry.localId} is terminal (${result.reason ?? 'unavailable'}); keeping delivered preview`)
            remove(chatId, entry.localId)
            changed = true
            continue
          }
          if (!isReady(result) || result.variant === 'preview' || result.sha256 === entry.forwardedSha256) {
            noteAttempt(entry, result.retryAfterMs)
            changed = true
            continue
          }

          try {
            const synthetic: AgentWechatMessage = {
              localId: entry.localId,
              serverId: Number(entry.message.messageId) || 0,
              chatId,
              type: entry.kind === 'image' ? 3
                : entry.kind === 'voice' ? 34
                  : entry.kind === 'video' ? 43
                    : entry.kind === 'sticker' ? 47 : 49,
              content: '',
              timestamp: new Date(entry.message.timestamp).toISOString(),
            }
            const media = await storeReadyMedia({
              agent: deps.agent,
              bridge: deps.bridge,
              chatId,
              peerId: entry.message.peerId,
              msg: synthetic,
              result,
              mediaStreamEnabled: deps.mediaStreamEnabled === true,
            })
            if (media.stored) {
              entry.stagedMedia = media
              entry.variant = result.variant
              // Commit the stable archive reference before the separate
              // /inbound call, so a crash cannot strand an uploaded original.
              await deps.persist()
            }
            await deps.bridge.postInbound({
              message: { ...entry.message, media: [media] },
              mediaUpgrade: true,
            })
            remove(chatId, entry.localId)
            changed = true
            log.info(`media recovery: ${chatId}:${entry.localId} upgraded to ${result.variant ?? 'ready'}`)
          } catch (err) {
            if (err instanceof FatalConfigError) {
              deps.onFatal?.(err)
              return
            }
            if (err instanceof BridgeHttpError && err.status >= 400 && err.status < 500) {
              log.error(`media recovery: upgrade ${chatId}:${entry.localId} rejected (${err.status}); keeping delivered preview`)
              remove(chatId, entry.localId)
              changed = true
            } else {
              log.warn(`media recovery: upgrade ${chatId}:${entry.localId} failed; will retry: ${errorMessage(err)}`)
              noteAttempt(entry)
              changed = true
            }
          }
        }
      }
      if (changed) await deps.persist()
    },
  }

  return api
}
