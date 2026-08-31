/**
 * Durable CRM domain-event outbox lease and delivery worker.
 *
 * Writes commit before rows become visible. The worker leases a bounded batch,
 * dispatches through the strict workflow seam, and records at-least-once retry
 * state without ever touching the originating CRM transaction.
 *
 * [COMP:crm/domain-events]
 */

import { createHash } from 'node:crypto'
import {
  crmDomainEventToDispatchEvent,
  type CrmDomainEventEnvelope,
  type CrmDomainEventType,
  type WorkflowEventInput,
} from '@use-brian/core'
import { query } from '../db/client.js'

export type LeasedCrmDomainEvent = CrmDomainEventEnvelope & {
  attempts: number
}

export function crmWorkflowAdmission(input: WorkflowEventInput): {
  idempotencyKey: string
  bodySha256: string
} | null {
  const domainEventId = input.trigger.sourceType === 'crm'
    && typeof input.event.domainEventId === 'string'
    ? input.event.domainEventId
    : null
  if (!domainEventId) return null
  return {
    idempotencyKey: `crm:${domainEventId}`,
    bodySha256: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
  }
}

export type CrmDomainEventOutboxStore = {
  leaseBatch(workerId: string, limit: number, leaseMs: number): Promise<LeasedCrmDomainEvent[]>
  markDelivered(eventId: string, workerId: string): Promise<void>
  markFailed(eventId: string, workerId: string, message: string, retryAt: Date): Promise<void>
}

export function createDbCrmDomainEventOutboxStore(): CrmDomainEventOutboxStore {
  return {
    async leaseBatch(workerId, limit, leaseMs) {
      const bounded = Math.min(50, Math.max(1, limit))
      const result = await query<{
        id: string
        workspaceId: string
        eventType: CrmDomainEventType
        subjectKind: string
        subjectId: string
        payload: Record<string, unknown>
        actorKind: string
        occurredAt: Date
        attempts: number
      }>(
        `WITH candidates AS (
           SELECT id FROM crm_domain_event_outbox
            WHERE (status IN ('pending','failed') AND next_attempt_at <= now())
               OR (status='leased' AND leased_until < now())
            ORDER BY next_attempt_at,created_at,id
            FOR UPDATE SKIP LOCKED LIMIT $2
         )
         UPDATE crm_domain_event_outbox e
            SET status='leased',lease_owner=$1,
                leased_until=now()+($3::int * interval '1 millisecond'),
                attempts=e.attempts+1,last_error=NULL
           FROM candidates c WHERE e.id=c.id
         RETURNING e.id,e.workspace_id AS "workspaceId",e.event_type AS "eventType",
                   e.subject_kind AS "subjectKind",e.subject_id AS "subjectId",
                   e.payload,e.actor_kind AS "actorKind",e.occurred_at AS "occurredAt",
                   e.attempts`,
        [workerId, bounded, leaseMs],
      )
      return result.rows
    },
    async markDelivered(eventId, workerId) {
      await query(
        `UPDATE crm_domain_event_outbox
            SET status='delivered',delivered_at=now(),lease_owner=NULL,
                leased_until=NULL,last_error=NULL
          WHERE id=$1 AND status='leased' AND lease_owner=$2`,
        [eventId, workerId],
      )
    },
    async markFailed(eventId, workerId, message, retryAt) {
      await query(
        `UPDATE crm_domain_event_outbox
            SET status='failed',next_attempt_at=$3,lease_owner=NULL,
                leased_until=NULL,last_error=$4
          WHERE id=$1 AND status='leased' AND lease_owner=$2`,
        [eventId, workerId, retryAt, message.slice(0, 2_000)],
      )
    },
  }
}

export type CrmDomainEventWorker = {
  tick(): Promise<number>
  start(): void
  stop(): void
  nudge(): void
}

export function createCrmDomainEventWorker(options: {
  store: CrmDomainEventOutboxStore
  dispatcher: { dispatchStrict(event: ReturnType<typeof crmDomainEventToDispatchEvent>): Promise<void> }
  workerId: string
  batchSize?: number
  leaseMs?: number
  intervalMs?: number
  now?: () => Date
  onError?: (error: unknown, event?: LeasedCrmDomainEvent) => void
}): CrmDomainEventWorker {
  const batchSize = Math.min(50, Math.max(1, options.batchSize ?? 25))
  const leaseMs = Math.max(5_000, options.leaseMs ?? 60_000)
  const intervalMs = Math.max(1_000, options.intervalMs ?? 5_000)
  const now = options.now ?? (() => new Date())
  let timer: ReturnType<typeof setInterval> | null = null
  let running: Promise<number> | null = null

  async function runTick(): Promise<number> {
    const rows = await options.store.leaseBatch(options.workerId, batchSize, leaseMs)
    for (const row of rows) {
      try {
        await options.dispatcher.dispatchStrict(crmDomainEventToDispatchEvent(row))
        await options.store.markDelivered(row.id, options.workerId)
      } catch (error) {
        const delaySeconds = Math.min(3_600, Math.max(5, 2 ** Math.min(row.attempts, 11)))
        await options.store.markFailed(
          row.id,
          options.workerId,
          error instanceof Error ? error.message : String(error),
          new Date(now().getTime() + delaySeconds * 1_000),
        )
        options.onError?.(error, row)
      }
    }
    return rows.length
  }

  const tick = () => {
    if (running) return running
    running = runTick().finally(() => { running = null })
    return running
  }

  return {
    tick,
    start() {
      if (timer) return
      timer = setInterval(() => { void tick().catch((error) => options.onError?.(error)) }, intervalMs)
      if (typeof timer.unref === 'function') timer.unref()
      void tick().catch((error) => options.onError?.(error))
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    nudge() {
      void tick().catch((error) => options.onError?.(error))
    },
  }
}
