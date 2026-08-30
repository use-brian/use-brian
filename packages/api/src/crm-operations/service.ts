/**
 * Canonical actor-aware CRM command service.
 *
 * All adapters call this service directly. One command runs inside one store
 * transaction that includes domain rows, audit evidence, idempotency, and the
 * committed-event outbox.
 *
 * [COMP:crm/operations-service]
 */

import { randomBytes, randomUUID } from 'node:crypto'
import {
  CrmOperationsCommandSchema,
  CrmOperationsContextSchema,
  CrmOperationsError,
  CrmSegmentPredicateSchema,
  actorAuditIdentity,
  assertCrmOperationsAuthority,
  canonicalCrmRequest,
  crmOperationsSha256,
  validateCrmSegmentCatalog,
  type CrmIntakeFieldDefinition,
  type CrmOperationsActor,
  type CrmOperationsCommand,
  type CrmOperationsCommandResult,
  type CrmOperationsContext,
  type CrmOperationsServicePort,
} from '@use-brian/core'
import type {
  AuditIdentity,
  ContactWrite,
  CrmOperationsRecord,
  CrmOperationsStore,
  CrmOperationsTransaction,
  StoredIntakeDefinition,
} from '../db/crm-operations-store.js'
import { hashSecret } from '../db/api-key-store.js'

type ServiceClock = () => Date

export type CrmOperationsServiceOptions = {
  now?: ServiceClock
  randomCredentialId?: () => string
  randomSecret?: () => string
  hashCredentialSecret?: (secret: string) => Promise<string>
}

function actorUserId(actor: CrmOperationsActor): string | null {
  return 'userId' in actor ? actor.userId ?? null : null
}

function actorAssistantId(actor: CrmOperationsActor): string | null {
  return actor.kind === 'assistant' ? actor.assistantId : null
}

function actorScope(actor: CrmOperationsActor): string {
  switch (actor.kind) {
    case 'user': return `user:${actor.userId}`
    case 'assistant': return `assistant:${actor.assistantId}:${actor.sessionId}`
    case 'workflow': return `workflow:${actor.workflowId}:${actor.runId}`
    case 'brain_key': return `brain_key:${actor.credentialId}`
    case 'oauth_token': return `oauth_token:${actor.credentialId}`
    case 'intake_key': return `intake_key:${actor.credentialId}`
    case 'home_app': return `home_app:${actor.credentialId}`
    case 'provider': return `provider:${actor.provider}:${actor.eventId}`
  }
}

function recordId(record: CrmOperationsRecord, label: string): string {
  const id = record.id
  if (typeof id !== 'string') throw new Error(`${label} did not return a stable id`)
  return id
}

function contactId(record: CrmOperationsRecord): string {
  const value = record.contactId
  if (typeof value !== 'string') throw new Error('CRM operation did not return a contact id')
  return value
}

function result(
  command: CrmOperationsCommand['kind'],
  record: CrmOperationsRecord,
  options: {
    created?: boolean
    duplicate?: boolean
    emittedEventIds?: string[]
    oneTimeSecret?: string
  } = {},
): CrmOperationsCommandResult {
  return {
    command,
    record,
    created: options.created ?? false,
    duplicate: options.duplicate ?? false,
    emittedEventIds: options.emittedEventIds ?? [],
    ...(options.oneTimeSecret ? { oneTimeSecret: options.oneTimeSecret } : {}),
  }
}

function invalidInput(message: string, details: Record<string, unknown> = {}): never {
  throw new CrmOperationsError('invalid_input', message, details)
}

function assertFieldValue(field: CrmIntakeFieldDefinition, value: unknown): void {
  if (value === undefined || value === null || value === '') {
    if (field.required) invalidInput(`Required intake field "${field.key}" is missing.`, { field: field.key })
    return
  }
  const invalid = () => invalidInput(`Intake field "${field.key}" is not a valid ${field.type}.`, {
    field: field.key,
    type: field.type,
  })
  switch (field.type) {
    case 'text':
      if (typeof value !== 'string') invalid()
      break
    case 'email':
      if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) invalid()
      break
    case 'phone':
      if (typeof value !== 'string') invalid()
      break
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) invalid()
      break
    case 'boolean':
      if (typeof value !== 'boolean') invalid()
      break
    case 'date':
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) invalid()
      break
    case 'string_array':
      if (!Array.isArray(value) || value.length > 100
        || value.some((item) => typeof item !== 'string')) invalid()
      break
  }
  if (typeof value === 'string' && field.maxLength !== undefined && value.length > field.maxLength) {
    invalidInput(`Intake field "${field.key}" exceeds its configured length.`, { field: field.key })
  }
  if (field.options) {
    const values = Array.isArray(value) ? value : [value]
    const invalidOptions = values.filter((item) => !field.options!.includes(String(item)))
    if (invalidOptions.length > 0) {
      invalidInput(`Intake field "${field.key}" contains an unknown option.`, {
        field: field.key,
        validValues: field.options,
      })
    }
  }
}

function validateAndMapFields(
  definition: StoredIntakeDefinition,
  values: Record<string, unknown>,
): ContactWrite {
  const declared = new Map(definition.fields.map((field) => [field.key, field]))
  const unknown = Object.keys(values).filter((key) => !declared.has(key))
  if (unknown.length > 0) {
    invalidInput('Submission contains fields outside the intake definition.', {
      fields: unknown.slice(0, 100),
      validValues: [...declared.keys()].slice(0, 100),
    })
  }

  let name = ''
  let email: string | null = null
  let phone: string | null = null
  const tags: string[] = []
  const customFields: Record<string, unknown> = {}
  for (const field of definition.fields) {
    const value = values[field.key]
    assertFieldValue(field, value)
    if (value === undefined || value === null || value === '') continue
    if (field.mapping.kind === 'custom_field') {
      customFields[field.mapping.fieldKey] = value
    } else if (field.mapping.kind === 'base_field') {
      if (field.mapping.field === 'name') name = String(value).trim()
      if (field.mapping.field === 'email') email = String(value).trim().toLowerCase()
      if (field.mapping.field === 'phone') phone = String(value).trim()
      if (field.mapping.field === 'tags') tags.push(...(value as string[]).map((tag) => tag.trim()))
    }
  }
  return {
    name: name || email || `${definition.label} contact`,
    email,
    phone,
    tags: [...new Set(tags)].slice(0, 100),
    customFields,
  }
}

function consentWasGranted(actual: unknown, expected: unknown): boolean {
  return canonicalCrmRequest(actual) === canonicalCrmRequest(expected)
}

async function audit(
  tx: CrmOperationsTransaction,
  actor: CrmOperationsActor,
  params: {
    action: string
    subjectKind: string
    subjectId: string
    details?: Record<string, unknown>
  },
): Promise<void> {
  const identity = actorAuditIdentity(actor)
  await tx.appendDomainAudit({
    action: params.action,
    subjectKind: params.subjectKind,
    subjectId: params.subjectId,
    actor: identity,
    metadata: params.details,
  })
  await tx.appendWorkspaceAudit({
    eventType: params.action,
    subjectId: params.subjectId,
    actorUserId: identity.actingUserId,
    details: { subjectKind: params.subjectKind, actorKind: actor.kind, ...params.details },
  })
}

async function emit(
  tx: CrmOperationsTransaction,
  context: CrmOperationsContext,
  params: {
    eventType: Parameters<CrmOperationsTransaction['emitDomainEvent']>[0]['eventType']
    eventKey: string
    subjectKind: string
    subjectId: string
    payload: Record<string, unknown>
    occurredAt: string
  },
): Promise<string> {
  return tx.emitDomainEvent({ ...params, actor: context.actor })
}

async function executeSubmission(
  tx: CrmOperationsTransaction,
  context: CrmOperationsContext,
  command: Extract<CrmOperationsCommand, { kind: 'record_submission' }>,
  now: Date,
): Promise<CrmOperationsCommandResult> {
  const definition = await tx.getIntakeDefinition(command.definitionKey)
  if (!definition || !definition.active) {
    throw new CrmOperationsError('not_found', 'The intake definition is unavailable.')
  }
  if (context.actor.kind === 'intake_key') {
    if (context.actor.definitionId !== definition.id
      || !await tx.intakeCredentialMayUse(context.actor.credentialId, definition.id)) {
      throw new CrmOperationsError('credential_revoked', 'The intake credential cannot use this definition.')
    }
  }
  const payloadBytes = Buffer.byteLength(canonicalCrmRequest(command.fields), 'utf8')
  if (payloadBytes > definition.maxPayloadBytes) {
    throw new CrmOperationsError('payload_too_large', 'Submission exceeds the definition payload limit.', {
      maxPayloadBytes: definition.maxPayloadBytes,
    })
  }
  const mapped = validateAndMapFields(definition, command.fields)
  const submittedAt = command.submittedAt ?? now.toISOString()
  const requestHash = crmOperationsSha256({
    definitionKey: command.definitionKey,
    fields: command.fields,
    externalIdentity: command.externalIdentity ?? null,
    submittedAt: command.submittedAt ?? null,
  })
  const claim = await tx.claimIdempotency({
    actorScope: actorScope(context.actor),
    credentialId: context.actor.kind === 'intake_key' ? context.actor.credentialId : null,
    definitionId: definition.id,
    idempotencyKey: command.idempotencyKey,
    requestHash,
  })
  if (claim.kind === 'conflict') {
    throw new CrmOperationsError('idempotency_conflict', 'Idempotency key was already used with another request.')
  }
  if (claim.kind === 'duplicate') {
    return result(command.kind, {
      submissionId: claim.submissionId,
      contactId: claim.contactId,
      followUpTaskId: claim.followUpTaskId,
    }, { duplicate: true })
  }

  let resolvedContactId: string | null = null
  if (definition.identityPolicy === 'external_subject') {
    const identity = command.externalIdentity
    if (!identity || identity.provider !== definition.allowedIdentityProvider) {
      invalidInput('This definition requires its configured external identity provider.')
    }
    resolvedContactId = await tx.resolveExternalIdentity(identity.provider, identity.subject)
  } else if (command.externalIdentity) {
    invalidInput('This intake definition does not accept an external identity claim.')
  }
  if (definition.identityPolicy === 'trusted_verified_email') {
    if (!mapped.email) invalidInput('This intake definition requires a mapped email field.')
    resolvedContactId = await tx.findContactByEmail(mapped.email)
  }

  const attributionUserId = await tx.resolveAttributionUser(
    actorUserId(context.actor) ?? definition.createdByUserId,
  )
  if (!attributionUserId) throw new Error('CRM contact attribution user is unavailable')
  const contact = resolvedContactId
    ? await tx.updateContact(resolvedContactId, mapped)
    : await tx.createContact(mapped, {
      createdByUserId: attributionUserId,
      createdByAssistantId: actorAssistantId(context.actor),
    })
  resolvedContactId = recordId(contact, 'contact')

  if (definition.identityPolicy === 'external_subject' && command.externalIdentity) {
    await tx.bindExternalIdentity(
      resolvedContactId,
      command.externalIdentity.provider,
      command.externalIdentity.subject,
    )
  }
  const submission = await tx.createSubmission({
    definition,
    contactId: resolvedContactId,
    sourceSubmissionId: command.idempotencyKey,
    requestHash,
    fields: command.fields,
    submittedAt,
  })
  const submissionId = recordId(submission, 'submission')

  const emittedEventIds: string[] = []
  const auditIdentity: AuditIdentity = actorAuditIdentity(context.actor)
  for (const mapping of definition.consentMappings) {
    const purpose = await tx.getConsentPurpose(mapping.purposeKey)
    if (!purpose || purpose.archivedAt) {
      throw new CrmOperationsError('catalog_key_invalid', 'Configured consent purpose is unavailable.', {
        purposeKey: mapping.purposeKey,
      })
    }
    const action = consentWasGranted(command.fields[mapping.fieldKey], mapping.grantedValue)
      ? 'granted' as const
      : 'withdrawn' as const
    const consent = await tx.appendConsent({
      contactId: resolvedContactId,
      purpose,
      action,
      source: 'intake',
      occurredAt: submittedAt,
      metadata: { submissionId, definitionId: definition.id },
      actor: auditIdentity,
    })
    if (consent.created) {
      const consentId = recordId(consent.record, 'consent event')
      emittedEventIds.push(await emit(tx, context, {
        eventType: 'crm.consent.changed',
        eventKey: `crm.consent.changed:${consentId}`,
        subjectKind: 'contact',
        subjectId: resolvedContactId,
        payload: {
          contactId: resolvedContactId,
          purposeKey: mapping.purposeKey,
          action,
          actorKind: context.actor.kind,
          occurredAt: submittedAt,
        },
        occurredAt: submittedAt,
      }))
    }
  }

  let followUpTaskId: string | null = null
  if (definition.followUpTaskTemplate) {
    const due = definition.followUpDueMinutes === null
      ? null
      : new Date(now.getTime() + definition.followUpDueMinutes * 60_000).toISOString()
    const task = await tx.createFollowUpTask({
      contactId: resolvedContactId,
      submissionId,
      ...definition.followUpTaskTemplate,
      due,
      assigneeId: definition.ownerUserId,
      createdByUserId: attributionUserId,
      createdByAssistantId: actorAssistantId(context.actor),
    })
    followUpTaskId = recordId(task, 'follow-up task')
    await tx.attachFollowUpTask(submissionId, followUpTaskId)
  }

  await audit(tx, context.actor, {
    action: 'crm.submission.received',
    subjectKind: 'submission',
    subjectId: submissionId,
    details: { definitionId: definition.id, definitionKey: definition.definitionKey },
  })
  emittedEventIds.unshift(await emit(tx, context, {
    eventType: 'crm.submission.received',
    eventKey: `crm.submission.received:${submissionId}`,
    subjectKind: 'submission',
    subjectId: submissionId,
    payload: {
      submissionId,
      contactId: resolvedContactId,
      definitionId: definition.id,
      definitionKey: definition.definitionKey,
      actorKind: context.actor.kind,
      occurredAt: submittedAt,
    },
    occurredAt: submittedAt,
  }))
  await tx.commitIdempotency({ claimId: claim.claimId, submissionId, contactId: resolvedContactId, followUpTaskId })

  return result(command.kind, { submissionId, contactId: resolvedContactId, followUpTaskId }, {
    created: true,
    emittedEventIds,
  })
}

export function createCrmOperationsService(
  store: CrmOperationsStore,
  options: CrmOperationsServiceOptions = {},
): CrmOperationsServicePort {
  const clock = options.now ?? (() => new Date())
  const makeCredentialId = options.randomCredentialId ?? randomUUID
  const makeSecret = options.randomSecret ?? (() => randomBytes(32).toString('base64url'))
  const hashCredentialSecret = options.hashCredentialSecret ?? hashSecret

  return {
    async execute(rawContext, rawCommand) {
      const context = CrmOperationsContextSchema.parse(rawContext)
      const command = CrmOperationsCommandSchema.parse(rawCommand)
      assertCrmOperationsAuthority(context, command)
      const now = clock()
      const occurredAt = now.toISOString()
      const identity = actorAuditIdentity(context.actor)

      return store.transaction(context, async (tx) => {
        if (command.kind === 'record_submission') {
          return executeSubmission(tx, context, command, now)
        }
        if (command.kind === 'save_intake_definition') {
          const snapshot = command.definition
          const saved = await tx.saveIntakeDefinition({
            ...command,
            schemaHash: crmOperationsSha256(snapshot),
            schemaSnapshot: snapshot,
            createdByUserId: actorUserId(context.actor),
          })
          const id = recordId(saved.record, 'intake definition')
          await audit(tx, context.actor, {
            action: saved.created ? 'crm.intake_definition.created' : 'crm.intake_definition.updated',
            subjectKind: 'intake_definition', subjectId: id,
          })
          return result(command.kind, saved.record, { created: saved.created })
        }
        if (command.kind === 'create_intake_credential') {
          const credentialId = makeCredentialId()
          const secret = makeSecret()
          const oneTimeSecret = `sk_intake_${credentialId}_${secret}`
          const prefix = oneTimeSecret.slice(0, 14)
          const record = await tx.createIntakeCredential({
            credentialId,
            label: command.label,
            definitionIds: command.definitionIds,
            secretPrefix: prefix,
            secretHash: await hashCredentialSecret(secret),
            createdByUserId: actorUserId(context.actor),
          })
          await audit(tx, context.actor, {
            action: 'crm.intake_credential.created', subjectKind: 'intake_credential', subjectId: credentialId,
            details: { definitionIds: command.definitionIds },
          })
          return result(command.kind, record, { created: true, oneTimeSecret })
        }
        if (command.kind === 'revoke_intake_credential') {
          const record = await tx.revokeIntakeCredential(command.credentialId)
          if (!record) throw new CrmOperationsError('not_found', 'Intake credential was not found.')
          await audit(tx, context.actor, {
            action: 'crm.intake_credential.revoked', subjectKind: 'intake_credential', subjectId: command.credentialId,
          })
          return result(command.kind, record)
        }
        if (command.kind === 'save_consent_purpose') {
          const saved = await tx.saveConsentPurpose({
            ...command,
            wordingHash: crmOperationsSha256(command.wording),
            createdByUserId: actorUserId(context.actor),
          })
          const id = recordId(saved.record, 'consent purpose')
          await audit(tx, context.actor, {
            action: saved.created ? 'crm.consent_purpose.created' : 'crm.consent_purpose.updated',
            subjectKind: 'consent_purpose', subjectId: id,
          })
          return result(command.kind, saved.record, { created: saved.created })
        }
        if (command.kind === 'update_submission') {
          const record = await tx.updateSubmission({ ...command, actor: identity })
          if (!record) throw new CrmOperationsError('not_found', 'Submission was not found.')
          const id = recordId(record, 'submission')
          await audit(tx, context.actor, { action: 'crm.submission.updated', subjectKind: 'submission', subjectId: id })
          const eventId = await emit(tx, context, {
            eventType: 'crm.submission.updated', eventKey: `crm.submission.updated:${id}:${String(record.updatedAt)}`,
            subjectKind: 'submission', subjectId: id,
            payload: { submissionId: id, contactId: contactId(record), status: record.status, queueKey: record.queueKey, actorKind: context.actor.kind, occurredAt },
            occurredAt,
          })
          return result(command.kind, record, { emittedEventIds: [eventId] })
        }
        if (command.kind === 'record_consent') {
          const purpose = await tx.getConsentPurpose(command.purposeKey)
          if (!purpose || purpose.archivedAt) throw new CrmOperationsError('catalog_key_invalid', 'Consent purpose is unavailable.', { purposeKey: command.purposeKey })
          const saved = await tx.appendConsent({
            ...command,
            purpose,
            occurredAt: command.occurredAt ?? occurredAt,
            actor: identity,
          })
          const id = recordId(saved.record, 'consent event')
          if (!saved.created) return result(command.kind, saved.record, { duplicate: true })
          await audit(tx, context.actor, { action: 'crm.consent.changed', subjectKind: 'contact', subjectId: command.contactId, details: { eventId: id, purposeKey: command.purposeKey, action: command.action } })
          const eventId = await emit(tx, context, {
            eventType: 'crm.consent.changed', eventKey: `crm.consent.changed:${id}`,
            subjectKind: 'contact', subjectId: command.contactId,
            payload: { contactId: command.contactId, purposeKey: command.purposeKey, action: command.action, actorKind: context.actor.kind, occurredAt: command.occurredAt ?? occurredAt },
            occurredAt: command.occurredAt ?? occurredAt,
          })
          return result(command.kind, saved.record, { created: true, emittedEventIds: [eventId] })
        }
        if (command.kind === 'record_suppression') {
          const saved = await tx.appendSuppression({ ...command, occurredAt: command.occurredAt ?? occurredAt, actor: identity })
          const id = recordId(saved.record, 'suppression event')
          if (!saved.created) return result(command.kind, saved.record, { duplicate: true })
          await audit(tx, context.actor, { action: 'crm.suppression.changed', subjectKind: 'contact', subjectId: command.contactId, details: { eventId: id, channel: command.channel, action: command.action } })
          const eventId = await emit(tx, context, {
            eventType: 'crm.suppression.changed', eventKey: `crm.suppression.changed:${id}`,
            subjectKind: 'contact', subjectId: command.contactId,
            payload: { contactId: command.contactId, channel: command.channel, action: command.action, reasonCode: command.reasonCode, actorKind: context.actor.kind, occurredAt: command.occurredAt ?? occurredAt },
            occurredAt: command.occurredAt ?? occurredAt,
          })
          return result(command.kind, saved.record, { created: true, emittedEventIds: [eventId] })
        }
        if (command.kind === 'save_segment') {
          const predicate = CrmSegmentPredicateSchema.safeParse(command.predicate)
          if (!predicate.success) invalidInput('Segment predicate is invalid.', { issues: predicate.error.issues })
          const catalog = await tx.getSegmentCatalog(command.entityKind)
          const catalogIssues = validateCrmSegmentCatalog(predicate.data, catalog)
          if (catalogIssues.length > 0) {
            throw new CrmOperationsError(
              'catalog_key_invalid',
              'Segment predicate uses unavailable catalog values.',
              { issues: catalogIssues.slice(0, 100) },
            )
          }
          const saved = await tx.saveSegment({ ...command, predicate: predicate.data, actorUserId: actorUserId(context.actor) })
          const id = recordId(saved.record, 'segment')
          await audit(tx, context.actor, { action: saved.created ? 'crm.segment.created' : 'crm.segment.updated', subjectKind: 'segment', subjectId: id })
          return result(command.kind, saved.record, { created: saved.created })
        }
        if (command.kind === 'archive_segment') {
          const record = await tx.archiveSegment(command.segmentId, command.expectedVersion)
          if (!record) throw new CrmOperationsError('not_found', 'Segment was not found.')
          await audit(tx, context.actor, { action: 'crm.segment.archived', subjectKind: 'segment', subjectId: command.segmentId })
          return result(command.kind, record)
        }
        if (command.kind === 'grant_entitlement') {
          const saved = await tx.grantEntitlement({ ...command, requestHash: crmOperationsSha256(command) })
          const id = recordId(saved.record, 'entitlement')
          if (!saved.created) return result(command.kind, saved.record, { duplicate: true })
          await audit(tx, context.actor, { action: 'crm.entitlement.changed', subjectKind: 'entitlement', subjectId: id, details: { status: command.status } })
          const eventId = await emit(tx, context, {
            eventType: 'crm.entitlement.changed', eventKey: `crm.entitlement.changed:${id}:created`,
            subjectKind: 'entitlement', subjectId: id,
            payload: { entitlementId: id, contactId: command.contactId, planId: command.planId, status: command.status, actorKind: context.actor.kind, occurredAt }, occurredAt,
          })
          return result(command.kind, saved.record, { created: true, emittedEventIds: [eventId] })
        }
        if (command.kind === 'update_entitlement') {
          const record = await tx.updateEntitlement(command.entitlementId, command)
          if (!record) throw new CrmOperationsError('not_found', 'Entitlement was not found.')
          await audit(tx, context.actor, { action: 'crm.entitlement.changed', subjectKind: 'entitlement', subjectId: command.entitlementId, details: { status: record.status } })
          const eventId = await emit(tx, context, {
            eventType: 'crm.entitlement.changed', eventKey: `crm.entitlement.changed:${command.entitlementId}:${String(record.updatedAt)}`,
            subjectKind: 'entitlement', subjectId: command.entitlementId,
            payload: { entitlementId: command.entitlementId, contactId: record.contactId, planId: record.planId, status: record.status, actorKind: context.actor.kind, occurredAt }, occurredAt,
          })
          return result(command.kind, record, { emittedEventIds: [eventId] })
        }
        if (command.kind === 'record_participation') {
          const saved = await tx.recordParticipation({ ...command, requestHash: crmOperationsSha256(command) })
          const id = recordId(saved.record, 'participation')
          if (!saved.created) return result(command.kind, saved.record, { duplicate: true })
          await audit(tx, context.actor, { action: 'crm.participation.changed', subjectKind: 'participation', subjectId: id, details: { status: command.status } })
          const eventId = await emit(tx, context, {
            eventType: 'crm.participation.changed', eventKey: `crm.participation.changed:${id}:created`,
            subjectKind: 'participation', subjectId: id,
            payload: { participationId: id, contactId: command.contactId, eventId: command.eventId, status: command.status, actorKind: context.actor.kind, occurredAt }, occurredAt,
          })
          return result(command.kind, saved.record, { created: true, emittedEventIds: [eventId] })
        }
        if (command.kind === 'update_participation') {
          const record = await tx.updateParticipation(command.participationId, command.status)
          if (!record) throw new CrmOperationsError('not_found', 'Participation was not found.')
          await audit(tx, context.actor, { action: 'crm.participation.changed', subjectKind: 'participation', subjectId: command.participationId, details: { status: command.status } })
          const eventId = await emit(tx, context, {
            eventType: 'crm.participation.changed', eventKey: `crm.participation.changed:${command.participationId}:${String(record.updatedAt)}`,
            subjectKind: 'participation', subjectId: command.participationId,
            payload: { participationId: command.participationId, contactId: record.contactId, eventId: record.eventId, status: command.status, actorKind: context.actor.kind, occurredAt }, occurredAt,
          })
          return result(command.kind, record, { emittedEventIds: [eventId] })
        }
        if (command.kind === 'set_deal_pipeline_stage') {
          const record = await tx.setDealPipelineStage({ ...command, actorUserId: actorUserId(context.actor), actorAssistantId: actorAssistantId(context.actor) })
          if (!record) throw new CrmOperationsError('catalog_key_invalid', 'Deal, pipeline, or stage is unavailable.')
          await audit(tx, context.actor, { action: 'crm.deal.stage_changed', subjectKind: 'deal', subjectId: command.dealId, details: { pipelineId: command.pipelineId, stageId: command.stageId } })
          const eventId = await emit(tx, context, {
            eventType: 'crm.deal.stage_changed', eventKey: `crm.deal.stage_changed:${command.dealId}:${String(record.updatedAt)}`,
            subjectKind: 'deal', subjectId: command.dealId,
            payload: { dealId: command.dealId, pipelineId: command.pipelineId, stageId: command.stageId, actorKind: context.actor.kind, occurredAt }, occurredAt,
          })
          return result(command.kind, record, { emittedEventIds: [eventId] })
        }
        throw new CrmOperationsError('invalid_input', 'Unsupported CRM operation command.')
      })
    },
  }
}
