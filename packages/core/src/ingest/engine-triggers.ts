/**
 * Event-triggered assistant turn dispatcher (WU-3.11).
 *
 * An `IngestEngineDeps['onEvent']`-shaped reference implementation (see
 * `./engine.ts`) — NOT wired; it predates the `alert`-decoupling, when the
 * engine had an `alert`-gated hook. The production `onEvent` impl is
 * `createIngestWorkflowTrigger` (`./workflow-trigger.ts`). When invoked for
 * a matched `alert=true` rule, this dispatcher resolves the connector
 * instance's dedicated
 * assistant (if any) and enqueues a `scheduled_jobs` row with
 * `channel_type='cron'`, `fires_at=now()`, and
 * `payload.trigger_kind='ingest_alert'`. The existing poll worker then
 * spawns the dedicated assistant's cron-session turn — so the brain
 * doesn't just write to itself, it reacts.
 *
 * Spec: docs/plans/company-brain/ingest.md §"Event-triggered assistant
 * turn (SV 2026-05-14)".
 *
 * Design — ports over imports. Mirrors the engine's seam pattern:
 * `packages/core` stays pg-free, and the API package fulfils both ports
 * at app-boot time. The `ScheduledJobInserter` is intentionally a
 * narrow, payload-shaped insert (not `JobStore.create`) — alert rows
 * carry no `assistant_id`/`user_id`/`schedule`/`instructions`; they
 * exist only to wake the poll worker with a trigger payload.
 *
 * [COMP:brain/event-triggered-turn]
 */

import type { IngestContext, IngestRule } from './engine.js'
import type { IngestEvent } from './filters.js'

/** Literal trigger-kind tag for the locked payload taxonomy. */
export const INGEST_ALERT_TRIGGER_KIND = 'ingest_alert' as const

/**
 * Payload written into `scheduled_jobs.payload` for an ingest-alert
 * trigger row.
 *
 * `episode_id` carries the Episode the matched realtime event produced.
 * It is the idempotency key per ingest.md §"Event-triggered assistant
 * turn" — "the `scheduled_jobs` row idempotency comes from
 * `(workspace_id, payload.episode_id)` uniqueness". A `scheduled` /
 * `drop`-routed alert has no Episode at alert time, so `episode_id` is
 * `null` for those (rare — alert is normally paired with realtime).
 */
export type IngestAlertPayload = {
  trigger_kind: typeof INGEST_ALERT_TRIGGER_KIND
  dedicated_assistant_id: string
  /** Episode produced by the realtime Pipeline B run; `null` when none. */
  episode_id: string | null
}

/**
 * Narrow port for inserting the trigger row. Kept payload-shaped — not a
 * `JobStore.create` reuse — because alert rows have no schedule,
 * assistant, or user binding.
 *
 * Idempotency contract: the implementation must be a no-op when a row
 * with the same `(workspace_id, payload.episode_id)` already exists, so
 * a re-delivered ingest event produces at most one assistant turn
 * (ingest.md §"Event-triggered assistant turn" → Lifecycle). When
 * `payload.episode_id` is `null` (a `scheduled` / `drop` alert with no
 * Episode), the dedup is skipped and the row is always inserted.
 */
export type ScheduledJobInserter = (params: {
  workspace_id: string
  channel_type: 'cron'
  fires_at: Date
  payload: IngestAlertPayload
}) => Promise<void>

/**
 * Resolve `connector_instance_id` → dedicated assistant id, or `null`
 * when the connector is not bound to one. Concrete impl reads
 * `channel_integrations.dedicated_assistant_id` (column TBD — plan-file
 * "Issues to report" #2).
 */
export type DedicatedAssistantResolver = (
  connectorInstanceId: string,
) => Promise<string | null>

export type IngestAlertTriggerDeps = {
  insertScheduledJob: ScheduledJobInserter
  resolveDedicatedAssistant: DedicatedAssistantResolver
  /** Injected for deterministic tests. Defaults to `Date.now()`. */
  now?: () => Date
}

/**
 * Build a callback shaped like `IngestEngineDeps['onEvent']` — the
 * dedicated-assistant cron-turn reaction.
 *
 * **Reference-only — not a wiring target.** The engine has a single
 * reaction port, `onEvent`; there is no `onAlert` port (the `alert`
 * flag was decoupled from the engine seam — see `engine.ts`). The
 * production `onEvent` implementation is `createIngestWorkflowTrigger`
 * (`./workflow-trigger.ts`), which dispatches matched events to the
 * workspace's `event`-trigger workflows. This `alert`-gated variant is
 * a parallel design retained for reference per
 * `docs/plans/company-brain/ingest.md` §"Event-triggered assistant
 * turn"; do not wire it into `createIngestEngine`.
 *
 * If it were ever promoted to production, the `episodeId` the engine
 * threads in lands on `payload.episode_id` and drives the
 * `(workspace_id, episode_id)` insert idempotency. Errors from either
 * port propagate to the caller.
 */
export function createIngestAlertTrigger(
  deps: IngestAlertTriggerDeps,
): (
  event: IngestEvent,
  ctx: IngestContext,
  rule: IngestRule,
  episodeId: string | null,
) => Promise<void> {
  return async (_event, ctx, _rule, episodeId) => {
    const dedicatedAssistantId = await deps.resolveDedicatedAssistant(
      ctx.connector_instance_id,
    )
    if (dedicatedAssistantId === null) return

    await deps.insertScheduledJob({
      workspace_id: ctx.workspace_id,
      channel_type: 'cron',
      fires_at: deps.now?.() ?? new Date(),
      payload: {
        trigger_kind: INGEST_ALERT_TRIGGER_KIND,
        dedicated_assistant_id: dedicatedAssistantId,
        episode_id: episodeId ?? null,
      },
    })
  }
}
