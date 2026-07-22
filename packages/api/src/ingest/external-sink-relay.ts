/**
 * External-sink relay worker — drains `ingest_outbox` to each sink's
 * endpoint under `ub.ingest.append.v1`
 * (docs/architecture/brain/ingest-external-sink.md → "The relay").
 *
 * Loop shape follows `createBatchWorker` (setInterval + re-entry guard +
 * start/stop); lease/claim semantics follow the extraction outbox. Per
 * claimed row:
 *
 *   POST endpoint_url (batch of canonical records + cursor)
 *     200 + valid ack            → markDelivered; recordAck(ack_cursor)
 *                                  — the ONLY path that moves the sink
 *                                  cursor (X3)
 *     200 + accepted+duplicates ≠ messages.length
 *                                → partial failure: retry whole batch
 *     200 + unparseable ack      → retry (durability unconfirmed)
 *     429 / 5xx / network error  → fail(): capped backoff, unbounded (X7)
 *     other 4xx                  → deadLetter() + `ingest_sink_dead_letter`
 *                                  analytics event (admin-visible, X7)
 *
 * Delivery is at-least-once: a crash after the sink stored the batch but
 * before markDelivered re-sends it, and the consumer's `(instance_id,
 * provider_message_id)` idempotency (X4) reports it all-duplicates — which
 * the relay counts as success. Rows are processed oldest-first but a
 * failing row never blocks later rows (no head-of-line blocking); the
 * consumer-side idempotency + coverage model absorb reordering.
 *
 * [COMP:api/ingest-external-relay]
 */

import { sanitize } from '@use-brian/core'
import {
  INGEST_APPEND_CONTRACT_V1,
  INGEST_APPEND_IDEMPOTENCY_HEADER,
  INGEST_APPEND_SIGNATURE_HEADER,
  ingestAppendResponseSchema,
  type IngestAppendRequest,
} from '@use-brian/shared'
import type { IngestOutboxRow, IngestOutboxStore } from '../db/ingest-outbox-store.js'
import type { IngestSinkStore } from '../db/ingest-sink-store.js'
import { signIngestAppendBody } from './append-signing.js'

/** Default drain cadence. */
export const INGEST_SINK_RELAY_INTERVAL_MS = 30_000

/** Analytics port — structural subset of core's AnalyticsLogger. */
type AnalyticsPort = {
  logEvent(event: {
    userId: string
    eventName: string
    channelType?: string
    metadata: Record<string, unknown>
  }): void
}

export type ExternalSinkRelayDeps = {
  outbox: IngestOutboxStore
  sinks: Pick<IngestSinkStore, 'get' | 'getSecretSystem' | 'recordAck'>
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
  intervalMs?: number
  /** Rows claimed per tick. */
  batchLimit?: number
  requestTimeoutMs?: number
  /** Dead-letter events are surfaced here (analytics is the admin log). */
  analytics?: AnalyticsPort | null
  workerId?: string
}

export type ExternalSinkRelay = {
  start(): void
  stop(): void
  /** One drain pass — exposed for tests and manual kicks. */
  tick(): Promise<void>
  readonly isRunning: boolean
}

export function buildAppendRequest(row: IngestOutboxRow): IngestAppendRequest {
  return {
    contract: INGEST_APPEND_CONTRACT_V1,
    instance_id: row.connectorInstanceId,
    source: row.source,
    workspace_id: row.workspaceId,
    owner_user_id: row.ownerUserId,
    cursor: row.sourceCursor ?? null,
    messages: row.messages as IngestAppendRequest['messages'],
  }
}

export function createExternalSinkRelay(deps: ExternalSinkRelayDeps): ExternalSinkRelay {
  const fetchImpl = deps.fetchImpl ?? fetch
  const intervalMs = deps.intervalMs ?? INGEST_SINK_RELAY_INTERVAL_MS
  const batchLimit = deps.batchLimit ?? 20
  const requestTimeoutMs = deps.requestTimeoutMs ?? 30_000
  const workerId = deps.workerId ?? `sink-relay-${process.pid}`

  let timer: ReturnType<typeof setInterval> | null = null
  let draining = false

  async function deliverRow(row: IngestOutboxRow): Promise<void> {
    const sink = await deps.sinks.get(row.sinkId)
    if (!sink) {
      // FK cascade should make this unreachable; never retry into a void.
      await deps.outbox.deadLetter(row.id, 'sink no longer exists')
      return
    }
    if (!sink.enabled) {
      // claimDue filters enabled sinks; a disable that raced the claim just
      // re-queues — the row resumes when the sink re-enables.
      await deps.outbox.fail(row.id, 'sink disabled')
      return
    }

    const secret = await deps.sinks.getSecretSystem(row.sinkId)
    if (!secret) {
      await deps.outbox.fail(row.id, 'sink secret missing — cannot authenticate delivery')
      return
    }

    const body = JSON.stringify(buildAppendRequest(row))
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      [INGEST_APPEND_IDEMPOTENCY_HEADER]: row.batchId,
    }
    if (sink.authKind === 'bearer') {
      headers.authorization = `Bearer ${secret}`
    } else {
      headers[INGEST_APPEND_SIGNATURE_HEADER] = signIngestAppendBody(body, secret)
    }

    let res: Response
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), requestTimeoutMs)
    try {
      res = await fetchImpl(sink.endpointUrl, {
        method: 'POST',
        headers,
        body,
        signal: abort.signal,
      })
    } catch (err) {
      await deps.outbox.fail(row.id, `fetch failed: ${err instanceof Error ? err.message : String(err)}`)
      return
    } finally {
      clearTimeout(timeout)
    }

    if (res.status === 200) {
      let parsed: ReturnType<typeof ingestAppendResponseSchema.safeParse>
      try {
        parsed = ingestAppendResponseSchema.safeParse(await res.json())
      } catch {
        await deps.outbox.fail(row.id, 'ack unreadable: response body is not JSON')
        return
      }
      if (!parsed.success) {
        await deps.outbox.fail(row.id, `ack invalid: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`)
        return
      }
      const ack = parsed.data
      if (ack.accepted + ack.duplicates !== row.messages.length) {
        await deps.outbox.fail(
          row.id,
          `partial ack: accepted ${ack.accepted} + duplicates ${ack.duplicates} != ${row.messages.length}`,
        )
        return
      }
      // Durable storage proven. Cursor advances only when the sink echoed
      // one (X3); delivery completes either way.
      if (ack.ack_cursor !== undefined) {
        await deps.sinks.recordAck(sink.id, ack.ack_cursor)
      }
      await deps.outbox.markDelivered(row.id)
      return
    }

    if (res.status === 429 || res.status >= 500) {
      await deps.outbox.fail(row.id, `HTTP ${res.status}`)
      return
    }

    // Remaining 4xx — the sink rejected the batch itself. Dead-letter +
    // surface (X7): a console.warn on a worker nobody tails is a silent
    // drop; analytics_events is the admin log.
    const snippet = (await res.text().catch(() => '')).slice(0, 300)
    await deps.outbox.deadLetter(row.id, `HTTP ${res.status}: ${snippet}`)
    console.warn(
      `[external-sink-relay] dead-lettered outbox row ${row.id} (sink ${row.sinkId}): HTTP ${res.status}`,
    )
    deps.analytics?.logEvent({
      userId: row.ownerUserId ?? row.workspaceId,
      channelType: 'workflow',
      eventName: 'ingest_sink_dead_letter',
      metadata: {
        sink_id: sanitize(row.sinkId),
        outbox_id: sanitize(row.id),
        connector_instance_id: sanitize(row.connectorInstanceId),
        workspace_id: sanitize(row.workspaceId),
        source: sanitize(row.source),
        http_status: res.status,
        message_count: row.messages.length,
      },
    })
  }

  async function tick(): Promise<void> {
    if (draining) return
    draining = true
    try {
      await deps.outbox.reclaimExpired()
      const rows = await deps.outbox.claimDue(batchLimit, workerId)
      for (const row of rows) {
        try {
          await deliverRow(row)
        } catch (err) {
          // A store hiccup mid-row must not kill the drain loop; the lease
          // reclaims the row next tick.
          console.error(`[external-sink-relay] row ${row.id} delivery error:`, err)
        }
      }
    } catch (err) {
      console.error('[external-sink-relay] tick error:', err)
    } finally {
      draining = false
    }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => void tick(), intervalMs)
      void tick()
    },
    stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
    tick,
    get isRunning() {
      return timer !== null
    },
  }
}
