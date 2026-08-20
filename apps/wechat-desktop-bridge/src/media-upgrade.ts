/**
 * Original-image upgrade sweep. WeChat auto-downloads only a ~6–10 KB
 * thumbnail with an image message; the full-size bytes appear on disk only
 * after the client renders the chat. The monitor registers every forwarded
 * image row here; the sweep opens read chats (`unreadCount === 0` — opening
 * marks a chat read and WeChat syncs read state to the phone, so an unread
 * chat is never touched), re-fetches the media, and re-posts the message with
 * `mediaUpgrade: true` when the bytes changed.
 * Spec: docs/architecture/channels/wechat-desktop.md → "Original image upgrade".
 */
import { createHash } from 'node:crypto'
import type { AgentWechatChat, AgentWechatClient, AgentWechatMessage } from './agent-wechat-client.js'
import { BridgeHttpError, FatalConfigError, type BrianBridgeClient } from './brian-bridge-client.js'
import { consoleLogger, errorMessage, sleep as defaultSleep, type Logger } from './log.js'
import { messageIsImage, toBridgeMedia } from './map-message.js'
import type { BridgeInboundMessage } from './protocol-types.js'
import type { BridgeStateFile, PendingMediaUpgrade } from './state-file.js'

/** Chats opened per sweep — keeps the client UI calm on a busy account. */
const MAX_CHATS_PER_SWEEP = 2
/** Wait after the open before re-fetching, so the download can land. */
const OPEN_SETTLE_MS = 2500
/** Same-bytes re-fetches (spread across sweeps) before giving up. */
const MAX_ATTEMPTS = 4
const MAX_AGE_MS = 72 * 60 * 60 * 1000
/** Per-chat pending cap; oldest entries drop first. */
const MAX_PENDING_PER_CHAT = 20

export type MediaUpgraderDeps = {
  agent: AgentWechatClient
  bridge: BrianBridgeClient
  state: BridgeStateFile
  /** Persist the state file (the monitor's own persist). */
  persist: () => Promise<void>
  /** Hello advertised the `media_upgrade` feature. False disables everything. */
  enabled: boolean
  log?: Logger
  sleep?: (ms: number) => Promise<void>
  isStopped?: () => boolean
  now?: () => number
  /** Wrong token / deleted channel — the process must exit (monitor parity). */
  onFatal?: (err: unknown) => void
}

export type MediaUpgrader = {
  /** Track a just-forwarded image row for a later upgrade attempt. */
  register(input: { chatId: string; msg: AgentWechatMessage; mapped: BridgeInboundMessage }): void
  /** One upgrade pass over the current chat list. */
  sweep(chats: AgentWechatChat[]): Promise<void>
}

export function sha256Base64(dataBase64: string): string {
  return createHash('sha256').update(Buffer.from(dataBase64, 'base64')).digest('hex')
}

export function createMediaUpgrader(deps: MediaUpgraderDeps): MediaUpgrader {
  const log = deps.log ?? consoleLogger
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now
  const stopped = deps.isStopped ?? (() => false)

  function pendings(): Record<string, PendingMediaUpgrade[]> {
    if (!deps.state.pendingMediaUpgrades) deps.state.pendingMediaUpgrades = {}
    return deps.state.pendingMediaUpgrades
  }

  /** Drop exhausted/expired entries; returns true when anything changed. */
  function prune(chatId: string): boolean {
    const map = pendings()
    const entries = map[chatId]
    if (!entries) return false
    const kept = entries.filter((e) => e.attempts < MAX_ATTEMPTS && now() - e.firstSeenAt <= MAX_AGE_MS)
    const changed = kept.length !== entries.length
    if (kept.length === 0) delete map[chatId]
    else map[chatId] = kept
    return changed
  }

  return {
    register({ chatId, msg, mapped }) {
      if (!deps.enabled || !messageIsImage(msg)) return
      const { media: _media, ...messageSansMedia } = mapped
      const dataBase64 = mapped.media?.[0]?.dataBase64
      const entry: PendingMediaUpgrade = {
        localId: msg.localId,
        message: messageSansMedia,
        forwardedSha256: dataBase64 ? sha256Base64(dataBase64) : null,
        attempts: 0,
        firstSeenAt: now(),
      }
      const map = pendings()
      const entries = (map[chatId] ??= [])
      entries.push(entry)
      if (entries.length > MAX_PENDING_PER_CHAT) entries.splice(0, entries.length - MAX_PENDING_PER_CHAT)
      // The caller persists right after (cursor advance) — no extra write here.
    },

    async sweep(chats) {
      if (!deps.enabled) return
      const map = deps.state.pendingMediaUpgrades
      if (!map || Object.keys(map).length === 0) return
      const byChat = new Map(chats.map((c) => [c.id || c.username, c]))
      let changed = false
      let opened = 0
      for (const chatId of Object.keys(map)) {
        if (stopped()) break
        if (prune(chatId)) changed = true
        const entries = map[chatId]
        if (!entries || entries.length === 0) continue
        const chat = byChat.get(chatId)
        if (!chat) continue
        // Read-safety gate: opening a chat marks it read (and syncs to the
        // phone). Only touch chats the owner has already read everywhere.
        if (chat.unreadCount !== 0) continue
        if (opened >= MAX_CHATS_PER_SWEEP) break
        opened++

        let openOk = false
        try {
          const result = await deps.agent.openChat(chatId)
          openOk = result.ok
          if (!result.ok) log.warn(`media upgrade: open ${chatId} refused: ${result.error ?? 'unknown'}`)
        } catch (err) {
          log.warn(`media upgrade: open ${chatId} failed: ${errorMessage(err)}`)
        }
        if (!openOk) {
          for (const e of entries) e.attempts++
          changed = true
          continue
        }
        await sleep(OPEN_SETTLE_MS)

        for (const entry of [...entries]) {
          if (stopped()) break
          let upgradedBase64: string | null = null
          let mediaResult
          try {
            mediaResult = await deps.agent.getMedia(chatId, entry.localId)
            if (mediaResult.data) {
              const sha = sha256Base64(mediaResult.data)
              if (sha !== entry.forwardedSha256) upgradedBase64 = mediaResult.data
            }
          } catch (err) {
            log.warn(`media upgrade: fetch ${chatId}:${entry.localId} failed: ${errorMessage(err)}`)
          }
          if (!upgradedBase64 || !mediaResult) {
            entry.attempts++
            changed = true
            continue
          }
          const media = toBridgeMedia(mediaResult, { localId: entry.localId, type: 3 })
          if (!media) {
            entry.attempts++
            changed = true
            continue
          }
          try {
            await deps.bridge.postInbound({
              message: { ...entry.message, media: [media] },
              mediaUpgrade: true,
            })
            log.info(
              `media upgrade: ${chatId}:${entry.localId} upgraded (${media.sizeBytes ?? '?'} bytes replaces thumbnail)`,
            )
            entries.splice(entries.indexOf(entry), 1)
            changed = true
          } catch (err) {
            if (err instanceof FatalConfigError) {
              deps.onFatal?.(err)
              return
            }
            if (err instanceof BridgeHttpError && err.status >= 400 && err.status < 500) {
              // Poison for this flow: oversize, or a platform that stopped
              // advertising the feature. Keep the thumbnail.
              log.error(`media upgrade: ${chatId}:${entry.localId} rejected (${err.status}); keeping thumbnail`)
              entries.splice(entries.indexOf(entry), 1)
              changed = true
            } else {
              // 5xx / network: leave untouched for the next sweep.
              log.warn(`media upgrade: post ${chatId}:${entry.localId} failed; will retry: ${errorMessage(err)}`)
            }
          }
        }
        if (prune(chatId)) changed = true
        if (entries.length === 0 && map[chatId]) delete map[chatId]
      }
      if (changed) await deps.persist()
    },
  }
}
