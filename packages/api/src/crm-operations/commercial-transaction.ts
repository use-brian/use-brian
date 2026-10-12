/**
 * Shared transaction mechanics for commercial commands: the operation receipt
 * registry, dual audit, the committed outbox and typed refusals. Every helper
 * runs on the caller's canonical CRM operations transaction.
 * Spec: docs/architecture/features/crm-commercial-operations.md
 *
 * [COMP:crm/business-references]
 */

import {
  CrmOperationsError,
  actorAuditIdentity,
  crmOperationsSha256,
  type CrmOperationsCommandResult,
  type CrmOperationsContext,
  type CrmOperationsCommand,
} from '@use-brian/core'
import type { CrmOperationsTransaction } from '../db/crm-operations-store.js'

export type CommercialResult = CrmOperationsCommandResult

export function commercialResult(
  command: CrmOperationsCommand['kind'],
  record: Record<string, unknown>,
  options: { created?: boolean; duplicate?: boolean; emittedEventIds?: string[] } = {},
): CommercialResult {
  return {
    command, record,
    created: options.created ?? false,
    duplicate: options.duplicate ?? false,
    emittedEventIds: options.emittedEventIds ?? [],
  }
}

export function refuse(code: ConstructorParameters<typeof CrmOperationsError>[0], message: string, details: Record<string, unknown> = {}): never {
  throw new CrmOperationsError(code, message, details)
}

/** Content-free refusal for a record the caller cannot see or may not use. */
export function unavailable(): never {
  throw new CrmOperationsError('not_found', 'The record is unavailable in your current scope.')
}

/**
 * Execute a commercial command once per stable operation id. A replay with the
 * same request and actor returns the committed result; anything else using the
 * id is an idempotency conflict. A rolled-back attempt leaves no receipt.
 */
export async function withOperationReceipt(
  tx: CrmOperationsTransaction,
  command: CrmOperationsCommand & { operationId: string },
  execute: () => Promise<CommercialResult>,
): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  const { operationId, ...payload } = command
  const fingerprint = crmOperationsSha256(payload)
  const identity = actorAuditIdentity(context.actor)
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`crm-operation:${context.workspaceId}:${operationId}`])
  const existing = await client.query<{ command_kind: string; request_fingerprint: string; actor_kind: string; actor_id: string; result: CommercialResult }>(
    `SELECT command_kind,request_fingerprint,actor_kind,actor_id,result FROM crm_operation_receipts
      WHERE workspace_id=$1 AND operation_id=$2`, [context.workspaceId, operationId])
  const prior = existing.rows[0]
  if (prior) {
    if (prior.command_kind !== command.kind || prior.request_fingerprint !== fingerprint
      || prior.actor_kind !== identity.actorKind || prior.actor_id !== identity.actorCredentialId) {
      refuse('idempotency_conflict', 'This operation id was already used for a different request or actor.')
    }
    return { ...prior.result, duplicate: true, created: false, emittedEventIds: [] }
  }
  const outcome = await execute()
  await client.query(
    `INSERT INTO crm_operation_receipts(workspace_id,operation_id,command_kind,request_fingerprint,actor_kind,actor_id,result)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [context.workspaceId, operationId, command.kind, fingerprint, identity.actorKind, identity.actorCredentialId,
      JSON.stringify({ ...outcome, emittedEventIds: outcome.emittedEventIds })],
  )
  return outcome
}

export async function commercialAudit(
  tx: CrmOperationsTransaction,
  context: CrmOperationsContext,
  params: { action: string; subjectKind: string; subjectId: string; details?: Record<string, unknown> },
): Promise<void> {
  const identity = actorAuditIdentity(context.actor)
  await tx.appendDomainAudit({
    action: params.action, subjectKind: params.subjectKind, subjectId: params.subjectId,
    actor: identity, metadata: params.details,
  })
  await tx.appendWorkspaceAudit({
    eventType: params.action, subjectId: params.subjectId, actorUserId: identity.actingUserId,
    details: { subjectKind: params.subjectKind, actorKind: context.actor.kind, ...params.details },
  })
}

export async function commercialEmit(
  tx: CrmOperationsTransaction,
  context: CrmOperationsContext,
  params: { eventType: string; eventKey: string; subjectKind: string; subjectId: string; payload: Record<string, unknown>; occurredAt: string },
): Promise<string> {
  return tx.emitDomainEvent({ ...params, actor: context.actor })
}

/** PostgreSQL unique-violation constraint name, when the error is one. */
export function uniqueViolation(error: unknown): string | null {
  const value = error as { code?: string; constraint?: string } | null
  return value?.code === '23505' ? value.constraint ?? '' : null
}

export function actorColumns(context: CrmOperationsContext): { kind: string; id: string; userId: string | null } {
  const identity = actorAuditIdentity(context.actor)
  return { kind: identity.actorKind, id: identity.actorCredentialId, userId: identity.actingUserId }
}
