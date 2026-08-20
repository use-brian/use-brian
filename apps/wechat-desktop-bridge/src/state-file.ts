/**
 * Per-chat cursor + pending-media-upgrade persistence.
 * Shape `{ version: 1, cursors: { [chatId]: localId }, pendingMediaUpgrades?: { [chatId]: entry[] } }`.
 * Writes go through a temp file + rename so a crash mid-write never leaves a
 * truncated file (the next boot would otherwise re-seed every cursor).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { BridgeInboundMessage } from './protocol-types.js'

/**
 * One image row waiting for its full-size bytes (wechat-desktop.md →
 * "Original image upgrade"). `message` is the row as originally forwarded,
 * minus its media bytes; re-posted with the upgraded bytes attached.
 */
export type PendingMediaUpgrade = {
  localId: number
  message: BridgeInboundMessage
  /** sha256 hex of the forwarded bytes; null when the original fetch produced nothing. */
  forwardedSha256: string | null
  attempts: number
  /** ms epoch */
  firstSeenAt: number
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
        forwardedSha256: typeof entry.forwardedSha256 === 'string' ? entry.forwardedSha256 : null,
        attempts: typeof entry.attempts === 'number' && Number.isFinite(entry.attempts) ? entry.attempts : 0,
        firstSeenAt: typeof entry.firstSeenAt === 'number' && Number.isFinite(entry.firstSeenAt) ? entry.firstSeenAt : Date.now(),
      })
    }
    if (kept.length > 0) out[chatId] = kept
  }
  return Object.keys(out).length > 0 ? out : undefined
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
