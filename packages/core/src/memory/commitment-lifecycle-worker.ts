/**
 * Commitment-memory lifecycle worker — drains `commitment:open` memories on
 * a timer, hands each one to a domain resolver, and supersedes the row
 * (D.7 bi-temporal tombstone via `MemoryStore.update`) when the resolver
 * says the commitment has cleared.
 *
 * Convention (SV 2026-05-14): a `commitment:<kind>` memory is open while
 * `valid_to IS NULL` and tags contain `commitment:open`. Resolution swaps
 * `commitment:open` for `commitment:resolved` via supersession; the
 * superseded chain is the audit history (`getRowHistory`).
 *
 * Scope of this WU (6.6): scaffold + interface only. The resolver is
 * supplied by the caller. `commitment-resolvers.ts` provides the composite
 * resolver + the kind-agnostic deadline resolver (drives `follow_up_due`);
 * per-kind domain resolvers (`sprint_variance`, `investor_signal`,
 * `incident_summary`, etc.) ship with their respective domain WUs.
 *
 * Single-instance assumption shared with the consolidation worker; the
 * optional `lockId` + `MemoryStore.withWorkerLock` plumbing makes
 * multi-instance an operational flip rather than a code change.
 *
 * Specs:
 *  - docs/historical/decisions-log.md → "SV — Commitment-memory convention"
 *  - docs/architecture/brain/corrections.md → "Commitment-memory lifecycle"
 *  - docs/architecture/engine/scheduled-jobs.md → "Worker lease semantics"
 */

import type { MemoryRecord, MemoryStore } from './types.js'

/** Tag sentinels — kept in sync with packages/api/src/db/memories.ts. */
export const COMMITMENT_OPEN_TAG = 'commitment:open'
export const COMMITMENT_RESOLVED_TAG = 'commitment:resolved'

export type CommitmentResolution =
  | { resolved: false }
  | {
      resolved: true
      /** Free-text rationale stamped into the superseding row's `detail`
       *  unless `supersedeWith.detail` is provided. */
      reason: string
      /** Optional content for the superseding row. When omitted the worker
       *  retags `commitment:open` → `commitment:resolved` and appends the
       *  reason to the existing detail. */
      supersedeWith?: { summary?: string; detail?: string }
    }

export type CommitmentResolver = (memory: MemoryRecord) => Promise<CommitmentResolution>

export type CommitmentLifecycleEvent =
  | { type: 'scan_started'; count: number }
  | { type: 'resolved'; memoryId: string; newMemoryId: string | null; reason: string }
  | { type: 'still_open'; memoryId: string }
  | { type: 'scan_completed'; resolved: number; openRemaining: number }

export type CommitmentLifecycleScope = {
  workspaceId?: string | null
  assistantId?: string | null
}

export type CommitmentLifecycleWorkerOptions = {
  store: MemoryStore
  resolver: CommitmentResolver
  /** Default 5 min. Commitments don't resolve at sub-minute granularity. */
  intervalMs?: number
  /** Per-tick fetch cap; default 200. */
  batchLimit?: number
  /** Narrow the scan to a single assistant / workspace. Default: all open commitments. */
  scope?: CommitmentLifecycleScope
  /** Optional advisory-lock ID for multi-instance future-proofing. The
   *  consolidation worker uses `900_001`; pick a different number here. */
  lockId?: number
  onEvent?: (e: CommitmentLifecycleEvent) => void
  onError?: (err: unknown, memoryId: string) => void
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000
const DEFAULT_BATCH_LIMIT = 200

export function createCommitmentLifecycleWorker(options: CommitmentLifecycleWorkerOptions) {
  const {
    store,
    resolver,
    intervalMs = DEFAULT_INTERVAL_MS,
    batchLimit = DEFAULT_BATCH_LIMIT,
    scope,
    lockId,
    onEvent,
    onError = (err, memoryId) =>
      console.error(`[commitment-lifecycle] resolver failed for memory ${memoryId}:`, err),
  } = options

  let timer: ReturnType<typeof setInterval> | undefined
  let running = false

  async function tickInner(): Promise<void> {
    const open = await store.listOpenCommitments({
      workspaceId: scope?.workspaceId,
      assistantId: scope?.assistantId,
      limit: batchLimit,
    })
    onEvent?.({ type: 'scan_started', count: open.length })

    let resolvedCount = 0
    for (const memory of open) {
      let outcome: CommitmentResolution
      try {
        outcome = await resolver(memory)
      } catch (err) {
        onError(err, memory.id)
        continue
      }
      if (!outcome.resolved) {
        onEvent?.({ type: 'still_open', memoryId: memory.id })
        continue
      }

      // Swap commitment:open → commitment:resolved while preserving every
      // other tag (kind discriminator, sprint tag, etc.). updateMemory
      // handles D.7 supersession atomically (new row + tombstone old row).
      const nextTags = memory.tags
        .filter((t) => t !== COMMITMENT_OPEN_TAG)
        .concat(memory.tags.includes(COMMITMENT_RESOLVED_TAG) ? [] : [COMMITMENT_RESOLVED_TAG])

      const existingDetail = memory.detail ?? ''
      const nextDetail = outcome.supersedeWith?.detail
        ?? (existingDetail ? `${existingDetail}\n[resolved] ${outcome.reason}` : `[resolved] ${outcome.reason}`)

      try {
        const updated = await store.update(memory.id, {
          tags: nextTags,
          detail: nextDetail,
          ...(outcome.supersedeWith?.summary ? { summary: outcome.supersedeWith.summary } : {}),
        })
        resolvedCount += 1
        onEvent?.({
          type: 'resolved',
          memoryId: memory.id,
          newMemoryId: updated?.id ?? null,
          reason: outcome.reason,
        })
      } catch (err) {
        onError(err, memory.id)
      }
    }

    onEvent?.({
      type: 'scan_completed',
      resolved: resolvedCount,
      openRemaining: open.length - resolvedCount,
    })
  }

  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      if (lockId !== undefined && store.withWorkerLock) {
        await store.withWorkerLock(lockId, tickInner, { holderLabel: 'commitment-lifecycle' })
      } else {
        await tickInner()
      }
    } catch (err) {
      console.error('[commitment-lifecycle] tick failed:', err)
    } finally {
      running = false
    }
  }

  return {
    /** Run one tick immediately. Exposed for tests and explicit triggers. */
    tick,
    start() {
      if (timer) return
      console.log(`[commitment-lifecycle] worker started (interval: ${intervalMs}ms)`)
      timer = setInterval(() => { void tick() }, intervalMs)
      void tick()
    },
    stop() {
      if (timer) {
        clearInterval(timer)
        timer = undefined
        console.log('[commitment-lifecycle] worker stopped')
      }
    },
    get isRunning() {
      return timer !== undefined
    },
  }
}
