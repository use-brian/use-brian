/** Cross-surface operation errors, fingerprints and event vocabulary only. [COMP:crm/operations-contract] */
import { createHash } from 'node:crypto'
import { z } from 'zod'
export const CrmOperationsStableKeySchema = z.string().trim().toLowerCase()
  .regex(/^[a-z][a-z0-9_-]{0,62}$/)
export const CrmDomainEventTypeSchema = z.enum([
  'crm.delivery_projection.changed',
  'crm.submission.received',
  'crm.submission.updated',
  'crm.consent.changed',
  'crm.suppression.changed',
  'crm.entitlement.changed',
  'crm.participation.changed',
  'crm.deal.stage_changed',
  'association.inventory.sold_out',
  'association.inventory.available',
  'crm.reference.assigned',
  'crm.reference.replaced',
  'crm.reference.retired',
  'crm.change_request.submitted',
  'crm.change_request.decided',
])
export type CrmDomainEventType = z.infer<typeof CrmDomainEventTypeSchema>

export type CrmOperationsErrorCode =
  | 'invalid_input'
  | 'not_authorized'
  | 'not_found'
  | 'catalog_key_invalid'
  | 'conflict'
  | 'idempotency_conflict'
  | 'identity_conflict'
  | 'invalid_transition'
  | 'payload_too_large'
  | 'credential_revoked'
  | 'empty_import'

export class CrmOperationsError extends Error {
  constructor(
    readonly code: CrmOperationsErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'CrmOperationsError'
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    )
  }
  return value
}

export function canonicalCrmRequest(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function crmOperationsSha256(value: unknown): string {
  return createHash('sha256').update(canonicalCrmRequest(value)).digest('hex')
}

