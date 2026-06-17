/**
 * Classifier circuit breaker — caps blast radius of buggy
 * deterministic rules.
 *
 * Per (workspace, rule, hour-window), tracks the count of silent
 * supersedes. Crossing `hourlyCap` trips the rule for that workspace
 * for `suspensionMs` (default 24h). Tripped rules' overrides are
 * skipped until the suspension expires.
 *
 * Spec: docs/architecture/brain/classification/operational.md §O2
 */

import { sanitize, type AnalyticsLogger } from '../analytics/logger.js'
import type { ClassifierBoundary } from './types.js'

export type CircuitBreakerCounterStore = {
  /**
   * Increment the counter for (workspaceId, ruleId, currentHourFloor).
   * Returns the new count. System-level — bypasses RLS.
   */
  increment(workspaceId: string, ruleId: string, now: Date): Promise<number>

  /**
   * Returns the `suspended_until` timestamp for the rule in the
   * workspace, or null if not suspended.
   */
  getSuspension(workspaceId: string, ruleId: string): Promise<Date | null>

  /**
   * Set `suspended_until` for the rule in the workspace.
   */
  setSuspension(workspaceId: string, ruleId: string, suspendedUntil: Date): Promise<void>

  /**
   * Clear suspension (manual ops reset).
   */
  clearSuspension(workspaceId: string, ruleId: string): Promise<void>

  /**
   * Cleanup — delete rows with window_start older than the cutoff.
   * Returns the count of pruned rows.
   */
  pruneOlderThan(cutoff: Date): Promise<number>
}

export type CircuitBreakerOptions = {
  /** Threshold per (workspace, rule, hour-window). Default 200. */
  hourlyCap?: number
  /** How long a tripped rule stays suspended. Default 24 hours. */
  suspensionMs?: number
  /** Optional analytics logger for trip events. */
  analytics?: AnalyticsLogger
  /** Override `Date.now` for tests. */
  now?: () => Date
}

export type CircuitBreaker = {
  /**
   * Check whether a rule is currently suspended for the workspace.
   * Returns true → caller should skip the override.
   */
  isTripped(workspaceId: string, ruleId: string): Promise<boolean>

  /**
   * Record a deterministic override. Returns true if the breaker tripped
   * as a result of this increment (caller should NOT proceed with the
   * supersede; the supersede that just happened is the last one).
   *
   * Practical pattern at the call site:
   *   if (await breaker.isTripped(ws, rule)) return  // skip override
   *   await applySupersede(...)                        // do the work
   *   await breaker.record(ws, rule, boundary)         // count + trip-if-over
   */
  record(workspaceId: string, ruleId: string, boundary: ClassifierBoundary): Promise<boolean>

  /**
   * Manual reset — clear suspension for a rule in a workspace.
   * Ops tool only.
   */
  reset(actorUserId: string, workspaceId: string, ruleId: string): Promise<void>

  /** Periodic cleanup — drop window-counter rows older than 7 days. */
  prune(): Promise<number>
}

export function createCircuitBreaker(
  store: CircuitBreakerCounterStore,
  options: CircuitBreakerOptions = {},
): CircuitBreaker {
  const hourlyCap = options.hourlyCap ?? 200
  const suspensionMs = options.suspensionMs ?? 24 * 60 * 60 * 1000
  const now = options.now ?? (() => new Date())

  return {
    async isTripped(workspaceId, ruleId) {
      const suspendedUntil = await store.getSuspension(workspaceId, ruleId)
      if (!suspendedUntil) return false
      if (suspendedUntil.getTime() <= now().getTime()) return false
      return true
    },

    async record(workspaceId, ruleId, boundary) {
      const t = now()
      const count = await store.increment(workspaceId, ruleId, t)
      if (count >= hourlyCap) {
        const suspendedUntil = new Date(t.getTime() + suspensionMs)
        await store.setSuspension(workspaceId, ruleId, suspendedUntil)
        if (options.analytics) {
          options.analytics.logEvent({
            userId: 'system',
            eventName: 'classifier_circuit_breaker_tripped',
            metadata: {
              rule_id: sanitize(ruleId),
              workspace_id: sanitize(workspaceId),
              observed_count_per_hour: count,
              suspended_until: sanitize(suspendedUntil.toISOString()),
              boundary: sanitize(boundary),
            },
          })
        }
        return true
      }
      return false
    },

    async reset(_actorUserId, workspaceId, ruleId) {
      await store.clearSuspension(workspaceId, ruleId)
    },

    async prune() {
      const cutoff = new Date(now().getTime() - 7 * 24 * 60 * 60 * 1000)
      return store.pruneOlderThan(cutoff)
    },
  }
}

/**
 * Helper for tests / in-memory deployments. Counter state in a Map;
 * window-keying matches the DB store (hourly floor).
 */
export function createInMemoryCounterStore(): CircuitBreakerCounterStore {
  const counts = new Map<string, number>()
  const suspensions = new Map<string, Date>()

  function windowKey(ws: string, rule: string, now: Date): string {
    const hour = new Date(now)
    hour.setMinutes(0, 0, 0)
    return `${ws}|${rule}|${hour.toISOString()}`
  }
  function suspensionKey(ws: string, rule: string): string {
    return `${ws}|${rule}`
  }

  return {
    async increment(ws, rule, now) {
      const k = windowKey(ws, rule, now)
      const next = (counts.get(k) ?? 0) + 1
      counts.set(k, next)
      return next
    },
    async getSuspension(ws, rule) {
      return suspensions.get(suspensionKey(ws, rule)) ?? null
    },
    async setSuspension(ws, rule, until) {
      suspensions.set(suspensionKey(ws, rule), until)
    },
    async clearSuspension(ws, rule) {
      suspensions.delete(suspensionKey(ws, rule))
    },
    async pruneOlderThan(cutoff) {
      let pruned = 0
      for (const key of Array.from(counts.keys())) {
        const hourIso = key.split('|')[2]!
        const ts = new Date(hourIso)
        if (ts.getTime() < cutoff.getTime()) {
          counts.delete(key)
          pruned++
        }
      }
      return pruned
    },
  }
}
