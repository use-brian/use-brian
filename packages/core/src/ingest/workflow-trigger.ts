/**
 * Ingest → workflow event-trigger adapter (the connector half).
 *
 * Every connector with an ingest poller — GitHub, Fathom, Gmail, Calendar —
 * routes its events through `createIngestEngine` (`./engine.ts`), which fires
 * its `onEvent` port once per matched event. This module is that `onEvent`
 * implementation: it normalizes the ingest event into the source-agnostic
 * `DispatchEvent` and hands it to the shared `WorkflowEventDispatcher`
 * (`../workflow/event-trigger.ts`).
 *
 * One dispatcher, two producers. The dispatcher is shared with the *channel*
 * half — a channel webhook (Slack) builds its own `DispatchEvent` and calls
 * the same `dispatch`. Connectors and channels are equal event sources; this
 * adapter is just the connector-side normalizer.
 *
 * Decoupled from the ingest rule's `alert` flag — the engine fires `onEvent`
 * for every matched event regardless. A workflow's own `match` filter
 * (evaluated inside the dispatcher) owns selectivity.
 *
 * The sibling `createIngestAlertTrigger` (`engine-triggers.ts`) — an
 * `alert`-gated dedicated-assistant cron turn — stays an unwired reference.
 *
 * Spec: docs/plans/company-brain/workflow-builder.md §Event trigger;
 * docs/architecture/features/workflow.md §Trigger surface.
 *
 * [COMP:brain/ingest-workflow-trigger]
 */

import type { IngestContext, IngestEngineDeps } from './engine.js'
import type { IngestEvent } from './filters.js'
import type {
  DispatchEvent,
  WorkflowEventDispatcher,
} from '../workflow/event-trigger.js'

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

function readStr(n: Record<string, unknown>, key: string): string | null {
  const v = n[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

function readStrArray(n: Record<string, unknown>, key: string): string[] {
  const v = n[key]
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** Actor id from the flat `actor_id` / `sender` keys, or nested `actor.login`. */
function readActor(n: Record<string, unknown>): string | null {
  const flat = readStr(n, 'actor_id') ?? readStr(n, 'sender')
  if (flat) return flat
  const actor = asRecord(n.actor)
  return actor ? readStr(actor, 'login') : null
}

/** Bot flag from the flat `is_bot` / `bot_id` keys, or nested `actor.is_bot`. */
function readBot(n: Record<string, unknown>): boolean {
  if (n.is_bot === true) return true
  if (typeof n.bot_id === 'string' && n.bot_id.length > 0) return true
  return asRecord(n.actor)?.is_bot === true
}

/**
 * Normalize an ingest engine event into a source-agnostic `DispatchEvent`.
 * The connector `normalized` payload shape varies per provider, so the
 * matchable fields are read defensively against the documented key
 * conventions — `text` / `title` / `summary`, `actor_id` / `sender` /
 * `actor.login`, `channel_id` / `repo`, `mentions`, `is_bot` / `bot_id` /
 * `actor.is_bot`. An absent field is `null` / `[]` / `false`, never fatal.
 */
export function ingestEventToDispatchEvent(
  event: IngestEvent,
  ctx: IngestContext,
): DispatchEvent {
  const n = event.normalized
  return {
    workspaceId: ctx.workspace_id,
    source: {
      type: 'connector',
      connectorInstanceId: ctx.connector_instance_id,
      provider: event.source,
    },
    text: readStr(n, 'text') ?? readStr(n, 'title') ?? readStr(n, 'summary'),
    actorId: readActor(n),
    channelId: readStr(n, 'channel_id') ?? readStr(n, 'repo'),
    mentions: readStrArray(n, 'mentions'),
    isBot: readBot(n),
    payload: n,
  }
}

/**
 * Build the ingest engine's `onEvent` callback. Wire it into the poll
 * producers at app boot — it forwards every matched ingest event to the
 * shared workflow event dispatcher:
 *
 * ```ts
 * createIngestEngine({
 *   ...,
 *   onEvent: createIngestWorkflowTrigger(dispatcher),
 * })
 * ```
 *
 * The `rule` / `episodeId` arguments of the `onEvent` port are unused — the
 * adapter is decoupled from the ingest rule, and an event-triggered run that
 * needs the brain Episode searches the brain.
 */
export function createIngestWorkflowTrigger(
  dispatcher: WorkflowEventDispatcher,
): NonNullable<IngestEngineDeps['onEvent']> {
  return async (event, ctx) => {
    await dispatcher.dispatch(ingestEventToDispatchEvent(event, ctx))
  }
}
