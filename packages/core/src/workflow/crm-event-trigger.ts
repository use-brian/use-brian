/**
 * Committed CRM domain-event to workflow-dispatch adapter.
 *
 * It is intentionally a pointer/classification projection: arbitrary CRM
 * payload keys and object/array values are dropped before workflow input.
 *
 * [COMP:crm/domain-events]
 */

import { CrmDomainEventTypeSchema, type CrmDomainEventType } from '../crm/operations-types.js'
import type { DispatchEvent } from './event-trigger.js'

export type CrmDomainEventEnvelope = {
  id: string
  workspaceId: string
  eventType: CrmDomainEventType
  subjectKind: string
  subjectId: string
  payload: Record<string, unknown>
  actorKind: string
  occurredAt: string | Date
}

const POINTER_KEYS = new Set([
  'submissionId', 'contactId', 'definitionId', 'definitionKey', 'status',
  'queueKey', 'purposeKey', 'action', 'channel', 'reasonCode',
  'entitlementId', 'planId', 'planKey', 'participationId', 'eventId',
  'eventKey', 'dealId', 'pipelineId', 'pipelineKey', 'stageId', 'stageKey',
  'actorKind', 'occurredAt', 'batchId', 'batchCount',
])

const STABLE_KEY_FIELDS = [
  'definitionKey', 'purposeKey', 'planKey', 'eventKey', 'pipelineKey', 'stageKey',
] as const

export function redactCrmDomainEventPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).filter(([key, value]) =>
      POINTER_KEYS.has(key)
      && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null),
    ),
  )
}

export function crmDomainEventToDispatchEvent(event: CrmDomainEventEnvelope): DispatchEvent {
  const eventType = CrmDomainEventTypeSchema.parse(event.eventType)
  const payload = redactCrmDomainEventPayload(event.payload)
  const stableKeys = STABLE_KEY_FIELDS
    .map((key) => payload[key])
    .filter((value): value is string => typeof value === 'string')
  const occurredAt = event.occurredAt instanceof Date
    ? event.occurredAt.toISOString()
    : event.occurredAt
  return {
    workspaceId: event.workspaceId,
    source: { type: 'crm' },
    text: eventType,
    actorId: null,
    channelId: eventType,
    mentions: [event.subjectId],
    tags: [...new Set(stableKeys)],
    isBot: event.actorKind !== 'user' && event.actorKind !== 'provider',
    occurredAt,
    payload: {
      domainEventId: event.id,
      eventType,
      subjectKind: event.subjectKind,
      subjectId: event.subjectId,
      ...payload,
      occurredAt,
    },
  }
}
