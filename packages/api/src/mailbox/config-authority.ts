/** Operational mailbox state is not connector authority. [COMP:api/mcp-inject] */
import { z } from 'zod'
import type { MailboxIdleStatus } from './idle-watcher.js'
import type { MailboxBackfillState, MailboxFolderCursor, MailboxSkip, MailboxSyncState, MailboxUidRetry } from './sync-worker.js'

const count = z.number().int().nonnegative()
const diagnostic = z.string().nullable().optional()
const retry = z.object({
  attempts: count,
  lastError: z.string(),
  lastAttemptAt: z.string(),
} satisfies Record<keyof MailboxUidRetry, z.ZodTypeAny>).strict()
const cursor = z.object({
  uidvalidity: z.string(),
  lastUid: count,
  serverMessages: count.optional(),
  backfillLow: count.optional(),
  backfillDone: z.boolean().optional(),
  retryUids: z.record(retry).optional(),
  consecutiveListMisses: count.optional(),
} satisfies Record<keyof MailboxFolderCursor, z.ZodTypeAny>).strict()
const backfill = z.object({
  scope: z.enum(['12m', '2y', 'all']),
  requestedAt: z.string(),
  reconcileVersion: count.optional(),
  status: z.enum(['running', 'done', 'stalled']),
  totalEstimate: count.optional(),
  estimateComplete: z.boolean().optional(),
  consecutiveFailures: count.optional(),
  lastError: diagnostic,
  lastProgressAt: z.string().optional(),
} satisfies Record<keyof MailboxBackfillState, z.ZodTypeAny>).strict()
const skip = z.object({
  folder: z.string(), uid: count, reason: z.string(), at: z.string(),
} satisfies Record<keyof MailboxSkip, z.ZodTypeAny>).strict()
const idle = z.object({
  status: z.enum(['connected', 'unsupported', 'reconnecting', 'off']),
  since: z.string(),
  lastEventAt: diagnostic,
  lastError: diagnostic,
} satisfies Record<keyof MailboxIdleStatus, z.ZodTypeAny>).strict().nullable()
const sync = z.object({
  // The reader defaults missing/null sync state to an empty folder map.
  folders: z.record(cursor).optional(),
  folderDiscoveryMisses: z.record(count).optional(),
  backfill: backfill.optional(),
  lastSyncAt: z.string().optional(),
  lastError: diagnostic,
  lastFailedSyncAt: diagnostic,
  skippedCount: count.optional(),
  recentSkips: z.array(skip).optional(),
} satisfies Record<keyof MailboxSyncState, z.ZodTypeAny>).strict().nullable()

/**
 * Compare only authority configuration for the built-in IMAP connector.
 * Strict whole-container recognition keeps unknown/malformed nested values
 * pinned. Stored configuration and every other connector remain unchanged.
 * This projection never admits a source or caches a permission decision.
 */
export function projectMailboxAuthorityConfig(instance: {
  readonly provider?: unknown; readonly custom?: unknown; readonly config?: unknown
}): unknown {
  const config = instance.config
  if (instance.provider !== 'imap' || instance.custom !== false
    || !config || typeof config !== 'object' || Array.isArray(config)) return config
  const projected = { ...config } as Record<string, unknown>
  if (Object.hasOwn(projected, 'mailboxIdle') && idle.safeParse(projected.mailboxIdle).success) delete projected.mailboxIdle
  if (Object.hasOwn(projected, 'mailboxSync') && sync.safeParse(projected.mailboxSync).success) delete projected.mailboxSync
  return projected
}
