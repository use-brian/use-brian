/**
 * Per-chat cursor + pending-media-upgrade persistence.
 * Shape `{ version: 1, cursors: { [chatId]: localId }, pendingMediaUpgrades?: { [chatId]: entry[] } }`.
 * Writes go through a temp file + rename so a crash mid-write never leaves a
 * truncated file (the next boot would otherwise re-seed every cursor).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { BridgeInboundMedia, BridgeInboundMessage } from './protocol-types.js'

/**
 * One media row waiting for provider bytes, or an image preview waiting for
 * its original. `message` is the normalized row without recoverable bytes;
 * undelivered rows hold the cursor, while a delivered preview may later be
 * re-posted as a media upgrade.
 */
export type PendingMediaUpgrade = {
  localId: number
  message: BridgeInboundMessage
  kind: 'image' | 'file' | 'video' | 'voice' | 'sticker'
  /** False while the chat cursor is deliberately held before this row. */
  delivered: boolean
  /** Last delivered provider variant, if any. */
  variant?: 'original' | 'preview' | 'raw'
  /** sha256 hex of the forwarded bytes; null when the original fetch produced nothing. */
  forwardedSha256: string | null
  /** Raw upload committed before /inbound; lets a crash retry without provider bytes. */
  stagedMedia?: BridgeInboundMedia
  attempts: number
  /** ms epoch */
  firstSeenAt: number
  /** ms epoch; durable exponential-backoff deadline. */
  nextAttemptAt: number
}

export type BridgeStateFile = {
  version: 1
  cursors: Record<string, number>
  pendingMediaUpgrades?: Record<string, PendingMediaUpgrade[]>
}

export function emptyState(): BridgeStateFile {
  return { version: 1, cursors: {} }
}

function sanitizePending(raw: unknown): Record<string, PendingMediaUpgrade[]> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, PendingMediaUpgrade[]> = {}
  for (const [chatId, entries] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue
    const kept: PendingMediaUpgrade[] = []
    for (const e of entries) {
      if (!e || typeof e !== 'object') continue
      const entry = e as Partial<PendingMediaUpgrade>
      if (
        typeof entry.localId !== 'number'
        || !entry.message
        || typeof entry.message !== 'object'
        || typeof (entry.message as BridgeInboundMessage).messageId !== 'string'
      ) continue
      kept.push({
        localId: entry.localId,
        message: entry.message as BridgeInboundMessage,
        kind: entry.kind === 'file' || entry.kind === 'video' || entry.kind === 'voice' || entry.kind === 'sticker'
          ? entry.kind
          : 'image',
        // Old entries were created only after the message had been forwarded.
        delivered: typeof entry.delivered === 'boolean' ? entry.delivered : true,
        variant: entry.variant === 'original' || entry.variant === 'preview' || entry.variant === 'raw'
          ? entry.variant
          : undefined,
        forwardedSha256: typeof entry.forwardedSha256 === 'string' ? entry.forwardedSha256 : null,
        stagedMedia: sanitizeStagedMedia(entry.stagedMedia),
        attempts: typeof entry.attempts === 'number' && Number.isFinite(entry.attempts) ? entry.attempts : 0,
        firstSeenAt: typeof entry.firstSeenAt === 'number' && Number.isFinite(entry.firstSeenAt) ? entry.firstSeenAt : Date.now(),
        nextAttemptAt: typeof entry.nextAttemptAt === 'number' && Number.isFinite(entry.nextAttemptAt)
          ? entry.nextAttemptAt
          : Date.now(),
      })
    }
    if (kept.length > 0) out[chatId] = kept
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function sanitizeStagedMedia(raw: unknown): BridgeInboundMedia | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const media = raw as Partial<BridgeInboundMedia>
  const kind = media.kind
  if (kind !== 'image' && kind !== 'document' && kind !== 'voice' && kind !== 'audio' && kind !== 'video') return undefined
  if (typeof media.mime !== 'string' || typeof media.name !== 'string') return undefined
  if (!media.stored || typeof media.stored.assetId !== 'string' || !/^[a-f0-9]{64}$/i.test(media.stored.sha256)) return undefined
  if (typeof media.sizeBytes !== 'number' || !Number.isFinite(media.sizeBytes) || media.sizeBytes < 0) return undefined
  return {
    kind,
    mime: media.mime,
    name: media.name,
    sizeBytes: media.sizeBytes,
    stored: { assetId: media.stored.assetId, sha256: media.stored.sha256.toLowerCase() },
    ...(typeof media.durationSec === 'number' && Number.isFinite(media.durationSec) ? { durationSec: media.durationSec } : {}),
  }
}

/** Returns the persisted state, or an empty one when the file is missing or unreadable. */
export async function loadStateFile(path: string): Promise<{ state: BridgeStateFile; fresh: boolean }> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return { state: emptyState(), fresh: true }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<BridgeStateFile>
    if (parsed && parsed.version === 1 && parsed.cursors && typeof parsed.cursors === 'object') {
      const cursors: Record<string, number> = {}
      for (const [k, v] of Object.entries(parsed.cursors)) {
        if (typeof v === 'number' && Number.isFinite(v)) cursors[k] = v
      }
      const state: BridgeStateFile = { version: 1, cursors }
      const pending = sanitizePending(parsed.pendingMediaUpgrades)
      if (pending) state.pendingMediaUpgrades = pending
      return { state, fresh: false }
    }
  } catch {
    /* fall through */
  }
  console.warn(`[bridge] state file ${path} is unreadable; starting with empty cursors`)
  return { state: emptyState(), fresh: true }
}

export async function saveStateFile(path: string, state: BridgeStateFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(state), 'utf8')
  await rename(tmp, path)
}
