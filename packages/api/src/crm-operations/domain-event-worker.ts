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
  type WorkflowEventInput,
} from '@use-brian/core'
import { query, getPool } from '../db/client.js'
import { acquireCrmPrivacyWriterAdmission } from './privacy-admission.js'

export type LeasedCrmDomainEvent = {
  id: string
  workspaceId: string
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
  dispatchLeased(lease: LeasedCrmDomainEvent, workerId: string,
    dispatch: (event: CrmDomainEventEnvelope) => Promise<void>): Promise<'delivered' | 'skipped'>
  markFailed(lease: LeasedCrmDomainEvent, workerId: string, retryAt: Date): Promise<void>
}

export function createDbCrmDomainEventOutboxStore(): CrmDomainEventOutboxStore {
  return {
    async leaseBatch(workerId, limit, leaseMs) {
      const bounded = Math.min(50, Math.max(1, limit))
      const result = await query<LeasedCrmDomainEvent>(
        `WITH candidates AS (
           SELECT id FROM crm_domain_event_outbox
            WHERE ((status IN ('pending','failed') AND next_attempt_at <= now())
               OR (status='leased' AND leased_until < now()))
              AND pg_try_advisory_xact_lock_shared(hashtextextended('crm-privacy-admission:'||workspace_id::text,0))
            ORDER BY next_attempt_at,created_at,id
            FOR UPDATE SKIP LOCKED LIMIT $2
         )
         UPDATE crm_domain_event_outbox e
            SET status='leased',lease_owner=$1,
                leased_until=now()+($3::int * interval '1 millisecond'),
                attempts=e.attempts+1,last_error=NULL
           FROM candidates c WHERE e.id=c.id
         RETURNING e.id,e.workspace_id AS "workspaceId",e.attempts`,
        [workerId, bounded, leaseMs],
      )
      return result.rows
    },
    async dispatchLeased(lease, workerId, dispatch) {
      const client=await getPool().connect()
      try {
        await client.query('BEGIN')
        await acquireCrmPrivacyWriterAdmission(client,lease.workspaceId)
        // NO KEY UPDATE admits the new workflow run's source FK/key-share
        // check on another connection while fencing competing dispatchers.
        const result=await client.query<CrmDomainEventEnvelope>(`SELECT id,workspace_id AS "workspaceId",
          event_type AS "eventType",subject_kind AS "subjectKind",subject_id AS "subjectId",
          payload,actor_kind AS "actorKind",occurred_at AS "occurredAt"
          FROM crm_domain_event_outbox WHERE id=$1 AND workspace_id=$2
            AND status='leased' AND lease_owner=$3 AND attempts=$4 AND leased_until>clock_timestamp()
          FOR NO KEY UPDATE`,[lease.id,lease.workspaceId,workerId,lease.attempts])
        const current=result.rows[0]
        if(!current) {await client.query('COMMIT');return 'skipped'}
        // Projection invalidation is never routine/workflow intake or work authority.
        if (current.eventType !== 'crm.delivery_projection.changed') await dispatch(current)
        await client.query(`UPDATE crm_domain_event_outbox SET status='delivered',delivered_at=clock_timestamp(),
          lease_owner=NULL,leased_until=NULL,last_error=NULL WHERE id=$1 AND workspace_id=$2`,[lease.id,lease.workspaceId])
        await client.query('COMMIT')
        return 'delivered'
      } catch(error) {
        await client.query('ROLLBACK').catch(()=>{})
        throw error
      } finally {client.release()}
    },
    async markFailed(lease, workerId, retryAt) {
      await query(
        `UPDATE crm_domain_event_outbox
            SET status='failed',next_attempt_at=$5,lease_owner=NULL,
                leased_until=NULL,last_error='CRM workflow dispatch failed'
          WHERE id=$1 AND workspace_id=$2 AND status='leased' AND lease_owner=$3 AND attempts=$4`,
        [lease.id,lease.workspaceId,workerId,lease.attempts,retryAt],
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
        await options.store.dispatchLeased(row,options.workerId,
          current=>options.dispatcher.dispatchStrict(crmDomainEventToDispatchEvent(current)))
      } catch {
        const delaySeconds = Math.min(3_600, Math.max(5, 2 ** Math.min(row.attempts, 11)))
        try {
          await options.store.markFailed(row,options.workerId,new Date(now().getTime()+delaySeconds*1_000))
        } catch {
          // A privacy operation or newer lease can win after dispatch fails.
          // Never copy the original error/row payload into logs or retry state.
        }
        options.onError?.(new Error('CRM workflow dispatch failed'),row)
      }
    }
    return rows.length
  }

  const tick = () => {
    if (running) return running
    running = runTick().catch(() => { throw new Error('CRM domain event processing failed') }).finally(() => { running = null })
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
