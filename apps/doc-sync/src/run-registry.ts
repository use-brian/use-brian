/**
 * Assistant-run registry — the authoritative, in-memory record of "an assistant
 * is working on page X right now", keyed by `pageId`.
 *
 * The sync service is single-instance (Cloud Run `min=max=1`), so this map IS
 * the source of truth — no DB row, no cross-instance coordination. Runs are
 * opened/refreshed/closed by `apps/api`'s chat route at the turn boundary
 * (through the `DocGateway` → the secret-gated `/internal/run/*`
 * endpoints), from ANY channel (a Telegram/Slack/web turn anchored to a page
 * has no browser open). On every mutation the registry calls `publish` so the
 * wiring can broadcast the state to connected tabs over the page's Yjs
 * awareness; `publish(pageId, null)` means the run cleared (→ idle).
 *
 * A `sweep()` (run on an interval by `index.ts`) drops any run whose `expiresAt`
 * has passed — the TTL safety-net for a turn that crashed without sending
 * `end`, so a page never shows "working" forever.
 *
 * Pure + injectable (`publish`, `now`) so it unit-tests without Hocuspocus or a
 * socket. [COMP:doc-sync/run-registry]
 */

import {
  ASSISTANT_RUN_TTL_MS,
  type AssistantRunState,
  type AssistantRunStep,
  type AssistantRunChannel,
} from '@sidanclaw/doc-model'

/** Broadcast the current run state for a page (or `null` to clear → idle). */
export type RunPublisher = (pageId: string, state: AssistantRunState | null) => void

export type RunRegistryOptions = {
  publish: RunPublisher
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?: () => number
  /** Override the TTL; defaults to `ASSISTANT_RUN_TTL_MS`. */
  ttlMs?: number
}

export type RunStartInput = {
  pageId: string
  actor: AssistantRunState['actor']
  channel: AssistantRunChannel
}

export type RunProgressInput = {
  pageId: string
  step?: AssistantRunStep
  toolName?: string
  blockId?: string
}

export type RunRegistry = {
  /** Open a run for a page (or refresh an open one), then publish it. */
  start(input: RunStartInput): AssistantRunState
  /**
   * Heartbeat an open run with the latest progress, then publish it. No-op
   * (returns null) if the page has no open run — a progress without a start
   * (e.g. an `end` already raced in) must not resurrect the "working" banner.
   */
  progress(input: RunProgressInput): AssistantRunState | null
  /** Close a page's run and publish the clear. Idempotent. */
  end(pageId: string): void
  /** Drop + publish-clear every run past its TTL. Returns the cleared pageIds. */
  sweep(): string[]
  /** The current run for a page, or null. */
  get(pageId: string): AssistantRunState | null
  /** Re-publish the current state for a page (for late-joiner seeding). */
  republish(pageId: string): void
  /** Active run count (diagnostics/tests). */
  readonly size: number
}

export function createRunRegistry(opts: RunRegistryOptions): RunRegistry {
  const runs = new Map<string, AssistantRunState>()
  const now = opts.now ?? (() => Date.now())
  const ttl = opts.ttlMs ?? ASSISTANT_RUN_TTL_MS

  return {
    start({ pageId, actor, channel }) {
      const t = now()
      const existing = runs.get(pageId)
      const state: AssistantRunState = {
        pageId,
        status: 'running',
        actor,
        channel,
        // Preserve the original start time across heartbeats so the "for Ns"
        // caption counts from when the run actually began, not the last refresh.
        startedAt: existing?.startedAt ?? t,
        expiresAt: t + ttl,
      }
      runs.set(pageId, state)
      opts.publish(pageId, state)
      return state
    },

    progress({ pageId, step, toolName, blockId }) {
      const existing = runs.get(pageId)
      if (!existing) return null
      const state: AssistantRunState = {
        ...existing,
        expiresAt: now() + ttl,
        ...(step !== undefined ? { step } : {}),
        ...(toolName !== undefined ? { toolName } : {}),
        ...(blockId !== undefined ? { blockId } : {}),
      }
      runs.set(pageId, state)
      opts.publish(pageId, state)
      return state
    },

    end(pageId) {
      if (!runs.delete(pageId)) return
      opts.publish(pageId, null)
    },

    sweep() {
      const t = now()
      const cleared: string[] = []
      for (const [pageId, state] of runs) {
        if (state.expiresAt <= t) {
          runs.delete(pageId)
          opts.publish(pageId, null)
          cleared.push(pageId)
        }
      }
      return cleared
    },

    get(pageId) {
      return runs.get(pageId) ?? null
    },

    republish(pageId) {
      opts.publish(pageId, runs.get(pageId) ?? null)
    },

    get size() {
      return runs.size
    },
  }
}
