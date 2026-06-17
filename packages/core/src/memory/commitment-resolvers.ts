/**
 * Commitment-memory resolvers — the per-kind resolution logic the
 * commitment-lifecycle worker delegates to.
 *
 * `createCommitmentLifecycleWorker` (commitment-lifecycle-worker.ts) is a
 * scaffold: it scans open `commitment:<kind>` memories and asks an injected
 * `CommitmentResolver` whether each has cleared. This module supplies that
 * resolver.
 *
 *  - `createDeadlineCommitmentResolver` — kind-agnostic; resolves a
 *    commitment once its `due:<ISO-8601>` tag is in the past. Drives
 *    `follow_up_due` and any kind that carries a due tag.
 *  - `createCompositeCommitmentResolver` — the production entry point;
 *    dispatches on the `commitment:<kind>` tag to a registered per-kind
 *    domain resolver, with the deadline resolver as a hard backstop.
 *
 * Per-kind domain resolvers (`sprint_variance`, `incident_summary`,
 * `investor_signal`, …) ship with their respective domain WUs and are
 * passed in via the `resolvers` map. `goal_<kind>` commitments are owned
 * by the `finalizeProduct` workflow — the composite never resolves them.
 *
 * Spec: docs/architecture/brain/corrections.md → "Commitment-memory
 * lifecycle" (resolver taxonomy) and decisions-log.md → "SV — Commitment-
 * memory convention".
 *
 * [COMP:brain/commitment-resolvers]
 */

import type { MemoryRecord } from './types.js'
import {
  COMMITMENT_OPEN_TAG,
  COMMITMENT_RESOLVED_TAG,
  type CommitmentResolver,
  type CommitmentResolution,
} from './commitment-lifecycle-worker.js'

/** Tag prefix for the `commitment:<kind>` discriminator. */
const COMMITMENT_TAG_PREFIX = 'commitment:'
/** Tag prefix carrying a commitment's resolution deadline (ISO-8601). */
export const DUE_TAG_PREFIX = 'due:'

/**
 * The commitment kind from a memory's tags — the suffix of the single
 * `commitment:<kind>` tag, ignoring the lifecycle tags `commitment:open`
 * and `commitment:resolved`. Returns null when no kind tag is present.
 */
export function commitmentKind(memory: MemoryRecord): string | null {
  for (const tag of memory.tags) {
    if (!tag.startsWith(COMMITMENT_TAG_PREFIX)) continue
    if (tag === COMMITMENT_OPEN_TAG || tag === COMMITMENT_RESOLVED_TAG) continue
    return tag.slice(COMMITMENT_TAG_PREFIX.length)
  }
  return null
}

/**
 * The resolution deadline from a memory's tags — the earliest parseable
 * `due:<ISO-8601>` tag, or null when none is present or parseable.
 */
export function commitmentDeadline(memory: MemoryRecord): Date | null {
  let earliestMs: number | null = null
  for (const tag of memory.tags) {
    if (!tag.startsWith(DUE_TAG_PREFIX)) continue
    const ms = Date.parse(tag.slice(DUE_TAG_PREFIX.length))
    if (Number.isNaN(ms)) continue
    if (earliestMs === null || ms < earliestMs) earliestMs = ms
  }
  return earliestMs === null ? null : new Date(earliestMs)
}

export type DeadlineResolverOptions = {
  /** Clock seam for tests. Defaults to `() => new Date()`. */
  now?: () => Date
}

/**
 * Kind-agnostic resolver: a commitment is resolved once its `due:` deadline
 * is at or before now. A commitment with no `due:` tag never resolves here
 * (stays open). Deadline passing means "stop surfacing this" — not "the
 * follow-up happened" — so the reason records that the window closed.
 */
export function createDeadlineCommitmentResolver(
  options: DeadlineResolverOptions = {},
): CommitmentResolver {
  const now = options.now ?? (() => new Date())
  return async (memory: MemoryRecord): Promise<CommitmentResolution> => {
    const deadline = commitmentDeadline(memory)
    if (deadline === null) return { resolved: false }
    if (deadline.getTime() > now().getTime()) return { resolved: false }
    return {
      resolved: true,
      reason: `deadline ${deadline.toISOString()} passed (window closed)`,
    }
  }
}

export type CompositeResolverOptions = {
  /**
   * Per-kind domain resolvers, keyed by the `commitment:<kind>` suffix
   * (e.g. `sprint_variance`). Ship with their domain WUs. A kind with no
   * entry here falls through to the deadline backstop.
   */
  resolvers?: Record<string, CommitmentResolver>
  /** Clock seam for tests. Defaults to `() => new Date()`. */
  now?: () => Date
}

/**
 * Production resolver wired into `createCommitmentLifecycleWorker`.
 * Dispatch order per memory:
 *
 *  1. `goal_*` kind → still-open. Goal commitments are closed by the
 *     `finalizeProduct` workflow; the worker must not race it.
 *  2. A registered per-kind domain resolver — if it resolves, return that.
 *  3. Deadline backstop — a past `due:` tag resolves the commitment even
 *     if a domain resolver kept it open.
 *  4. Otherwise still-open (fail-closed).
 */
export function createCompositeCommitmentResolver(
  options: CompositeResolverOptions = {},
): CommitmentResolver {
  const resolvers = options.resolvers ?? {}
  const deadlineResolver = createDeadlineCommitmentResolver({ now: options.now })

  return async (memory: MemoryRecord): Promise<CommitmentResolution> => {
    const kind = commitmentKind(memory)

    // 1. Goal commitments are workflow-owned — never resolved here.
    if (kind !== null && kind.startsWith('goal_')) return { resolved: false }

    // 2. Per-kind domain resolver.
    if (kind !== null && resolvers[kind]) {
      const outcome = await resolvers[kind](memory)
      if (outcome.resolved) return outcome
    }

    // 3. Deadline backstop (also covers step 4 — no past deadline → still-open).
    return deadlineResolver(memory)
  }
}
