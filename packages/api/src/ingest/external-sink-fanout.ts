/**
 * External-sink fan-out — the producer-side half of the outbox transport
 * (docs/architecture/brain/ingest-external-sink.md → "Fan-out").
 *
 * A producer that has normalized events into canonical message records calls
 * `fanout()` beside its brain landing. Per enabled sink on the instance:
 *
 *   - `mode: 'all'` (archive-always, X5) — every event is enqueued,
 *     including events NO ingest_rule matched and events a rule routed
 *     `drop`. The brain flow stays selective and parallel; `drop` governs
 *     Pipeline B only, never the sink.
 *   - `mode: 'rule_filtered'` — enqueued only when the engine's routing
 *     decision matched and was not `drop` (the curated slice).
 *
 * `landIngestEvent()` is the D10 atomic capture: it opens one transaction
 * and commits the brain landing (`appendBatchEvent`) and the outbox rows
 * together, so a crash can never lose an event that was accepted, nor
 * deliver an event the brain never saw (or vice versa).
 *
 * Provider knowledge never enters this module (X1): callers hand it
 * already-canonical `ub.ingest.append.v1` message records.
 *
 * [COMP:brain/ingest-outbox]
 */

import type pg from 'pg'
import type { CanonicalIngestMessage } from '@use-brian/shared'
import { getPool } from '../db/client.js'
import { appendBatchEvent } from '../db/pending-ingest-batches-store.js'
import type { IngestOutboxRow, IngestOutboxStore } from '../db/ingest-outbox-store.js'
import type { IngestSinkStore } from '../db/ingest-sink-store.js'

type Queryable = Pick<pg.ClientBase, 'query'>

/**
 * Structural subset of the engine's `RoutingDecision` — the fan-out only
 * cares whether a rule matched and whether it was a drop.
 */
export type SinkRoutingDecision = {
  matched: boolean
  routing_mode: 'realtime' | 'scheduled' | 'drop'
}

export type ExternalSinkEvent = {
  connectorInstanceId: string
  workspaceId: string
  /** Compartment owner for person-scoped consumers (D3); omit when N/A. */
  ownerUserId?: string | null
  source: string
  messages: CanonicalIngestMessage[]
  /** Opaque producer cursor, echoed back by the sink on ack. */
  sourceCursor?: unknown
  /**
   * The engine's routing decision for this event, consulted by
   * `rule_filtered` sinks. Omit (or null) when the event went through no
   * engine — `mode: 'all'` sinks still receive it.
   */
  decision?: SinkRoutingDecision | null
}

export type FanoutResult = {
  /** Outbox rows written (one per receiving sink). */
  enqueued: IngestOutboxRow[]
}

export type ExternalSinkFanout = {
  /**
   * Enqueue this event for every enabled sink on the instance whose mode
   * accepts it. Pass `client` to enlist in the caller's transaction.
   */
  fanout(event: ExternalSinkEvent, client?: Queryable): Promise<FanoutResult>

  /**
   * The one-transaction capture (D10): brain landing + sink fan-out commit
   * atomically. `batch` is the `appendBatchEvent` input for a scheduled
   * brain match — pass null when the event has no brain landing here
   * (realtime inline processing, or no rule matched).
   */
  landIngestEvent(
    input: {
      event: ExternalSinkEvent
      batch?: Parameters<typeof appendBatchEvent>[0] | null
    },
    pool?: pg.Pool,
  ): Promise<FanoutResult>
}

/** Does this sink's mode accept the event, given the routing decision? */
export function sinkAcceptsEvent(
  mode: 'all' | 'rule_filtered',
  decision: SinkRoutingDecision | null | undefined,
): boolean {
  if (mode === 'all') return true
  return !!decision && decision.matched && decision.routing_mode !== 'drop'
}

export function createExternalSinkFanout(deps: {
  sinks: Pick<IngestSinkStore, 'listEnabledByInstance'>
  outbox: Pick<IngestOutboxStore, 'enqueue'>
}): ExternalSinkFanout {
  const fanout = async (
    event: ExternalSinkEvent,
    client?: Queryable,
  ): Promise<FanoutResult> => {
    if (event.messages.length === 0) return { enqueued: [] }
    const sinks = await deps.sinks.listEnabledByInstance(event.connectorInstanceId)
    const receiving = sinks.filter((s) => sinkAcceptsEvent(s.mode, event.decision))
    const enqueued: IngestOutboxRow[] = []
    for (const sink of receiving) {
      enqueued.push(
        await deps.outbox.enqueue(
          {
            sinkId: sink.id,
            connectorInstanceId: event.connectorInstanceId,
            workspaceId: event.workspaceId,
            ownerUserId: event.ownerUserId ?? null,
            source: event.source,
            messages: event.messages,
            sourceCursor: event.sourceCursor,
          },
          client,
        ),
      )
    }
    return { enqueued }
  }

  return {
    fanout,

    async landIngestEvent(input, pool = getPool()) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        if (input.batch) await appendBatchEvent(input.batch, client)
        const result = await fanout(input.event, client)
        await client.query('COMMIT')
        return result
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
  }
}
