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
  ImportHistoricalCrmSubmissionSchema,
  CrmLocaleWordingsSchema,
  CrmWordingLocaleSchema,
  CrmSegmentPredicateSchema,
  actorAuditIdentity,
  assertCrmOperationsAuthority,
  isCrmConfigCommand,
  canonicalCrmRequest,
  crmOperationsSha256,
  prepareCrmSubmissionAttachments,
  requireCrmIntegrationResources,
  validateCrmSegmentCatalog,
  type CrmIntakeFieldDefinition,
  type CrmOperationsActor,
  type CrmOperationsCommand,
  type CrmOperationsCommandResult,
  type CrmOperationsContext,
  type CrmOperationsServicePort,
  type CrmHistoricalSubmissionImportPort,
  type CrmDeliveryServicePort,
  type CrmPrivacyServicePort,
  type CrmRetentionServicePort,
  type CrmImportFileCleanupPort,
} from '@use-brian/core'
import type {
  AuditIdentity,
  ContactWrite,
  CrmOperationsRecord,
  CrmOperationsStore,
  CrmOperationsTransaction,
  StoredIntakeDefinition,
} from '../db/crm-operations-store.js'
import {createCrmPrivacyService} from './privacy-previews.js'
import {createCrmImportFileCleanupService} from './import-file-cleanup-service.js'
import {createCrmRetentionService} from './retention-service.js'
import { hashSecret } from '../db/api-key-store.js'
import { assertIntakeVerificationConfiguration, verifyIntakeIdentity } from './identity-verification.js'

type ServiceClock = () => Date

export type CrmOperationsServiceOptions = {
  deliveries?: CrmDeliveryServicePort
  privacy?:CrmPrivacyServicePort
  fileCleanup?:CrmImportFileCleanupPort
  retention?:CrmRetentionServicePort
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
    case 'integration_key': return `integration_key:${actor.credentialId}`
    case 'system_job': return `system_job:${actor.job}:${actor.runId}`
    case 'oauth_token': return `oauth_token:${actor.credentialId}`
    case 'intake_key': return `intake_key:${actor.credentialId}`
    case 'home_app': return `home_app:${actor.credentialId}`
    case 'provider': return `provider:${actor.provider}:${actor.eventId}`
    case 'import': return `import:${actor.jobId}`
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
      if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) invalid()
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
  let scope = actorScope(context.actor)
  if (context.actor.kind === 'intake_key') {
    const replayScopeId = context.actor.definitionId === definition.id
      ? await tx.intakeCredentialReplayScope(context.actor.credentialId, definition.id) : null
    if (!replayScopeId) {
      throw new CrmOperationsError('credential_revoked', 'The intake credential cannot use this definition.')
    }
    scope = `intake_key:${replayScopeId}`
  }
  const submittedAt = command.submittedAt ?? now.toISOString()
  const requestHash = crmOperationsSha256({
    definitionKey: command.definitionKey,
    fields: command.fields,
    ...(command.attachments?.length ? { attachments: command.attachments } : {}),
    externalIdentity: command.externalIdentity ?? null,
    submittedAt: command.submittedAt ?? null,
    campaignAttribution: command.campaignAttribution ?? null,
  })
  const claim = await tx.claimIdempotency({
    actorScope: scope,
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

  if (claim.kind === 'retired') {
    return result(command.kind, { outcome: 'submission_retired' }, { duplicate: true })
  }

  const payloadBytes = Buffer.byteLength(canonicalCrmRequest(command.fields), 'utf8')
  if (payloadBytes > definition.maxPayloadBytes) {
    throw new CrmOperationsError('payload_too_large', 'Submission exceeds the definition payload limit.', {
      maxPayloadBytes: definition.maxPayloadBytes,
    })
  }
  const mapped = validateAndMapFields(definition, command.fields)
  const attachments = await prepareCrmSubmissionAttachments(command.attachments ?? [], definition.attachments)
  const identityVerificationEvidence = verifyIntakeIdentity(context, definition, command, requestHash, now)

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
  // An unverified claim may join the one live contact that already holds the
  // address, but only fills its gaps below. Several live matches are a staff
  // review case: keep the submission and create a contact as new_or_review does.
  let fillGapsOnly = false
  if (definition.identityPolicy === 'existing_or_new' && mapped.email) {
    try {
      resolvedContactId = await tx.findContactByEmail(mapped.email)
      fillGapsOnly = resolvedContactId !== null
    } catch (error) {
      if (!(error instanceof CrmOperationsError && error.details?.reason === 'identity_review_required')) throw error
    }
  }

  const attributionUserId = await tx.resolveAttributionUser(
    actorUserId(context.actor) ?? definition.createdByUserId,
  )
  if (!attributionUserId) throw new Error('CRM contact attribution user is unavailable')
  const contact = resolvedContactId
    ? fillGapsOnly ? await tx.fillContactGaps(resolvedContactId, mapped) : await tx.updateContact(resolvedContactId, mapped)
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
    sourceSubmissionId: `crm:${claim.claimId}`,
    requestHash,
    fields: command.fields,
    submittedAt,
    identityVerificationEvidence,
  })
  const submissionId = recordId(submission, 'submission')
  await tx.createSubmissionAttachments(submissionId, attachments)

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
      submissionId,
      contactId: resolvedContactId,
      purpose,
      purposeKey: mapping.purposeKey,
      locale: mapping.locale ?? (mapping.localeFieldKey ? CrmWordingLocaleSchema.parse(command.fields[mapping.localeFieldKey]) : undefined),
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
  if (command.campaignAttribution?.siteId) {
    await tx.enqueueCampaignConversion({
      sitePublicId: command.campaignAttribution.siteId,
      externalOutcomeId: submissionId,
      occurredAt: submittedAt,
      contactId: resolvedContactId,
      attribution: command.campaignAttribution,
      test: false,
    })
  }
  await tx.commitIdempotency({ claimId: claim.claimId, submissionId, contactId: resolvedContactId, followUpTaskId })

  return result(command.kind, { submissionId, contactId: resolvedContactId, followUpTaskId }, {
    created: true,
    emittedEventIds,
  })
}

export function createCrmOperationsService(
  store: CrmOperationsStore,
  options: CrmOperationsServiceOptions = {},
): CrmOperationsServicePort & CrmHistoricalSubmissionImportPort {
  const clock = options.now ?? (() => new Date())
  const makeCredentialId = options.randomCredentialId ?? randomUUID
  const makeSecret = options.randomSecret ?? (() => randomBytes(32).toString('base64url'))
  const hashCredentialSecret = options.hashCredentialSecret ?? hashSecret

  return {
    async importHistoricalSubmission(rawContext, rawInput) {
      const context = CrmOperationsContextSchema.parse(rawContext)
      const input = ImportHistoricalCrmSubmissionSchema.parse(rawInput)
      if (!context.authority.canWrite) {
        throw new CrmOperationsError('not_authorized', 'CRM import write authority is required.')
      }
      if (context.actor.kind === 'import') {
        if (context.actor.jobId !== input.importJobId || !['owner', 'admin'].includes(context.authority.role)) {
          throw new CrmOperationsError('not_authorized', 'Historical submission imports require the current owner/admin import job.')
        }
      } else if (context.actor.kind === 'integration_key') {
        if (context.authority.integration?.credentialId !== context.actor.credentialId) {
          throw new CrmOperationsError('not_authorized', 'Historical import authority must come from its authenticated credential.')
        }
        requireCrmIntegrationResources(context.authority.integration, 'crm.submissions.write', { definitionIds: null })
      } else {
        throw new CrmOperationsError('not_authorized', 'Historical submissions are only available to the confirmed production importer.')
      }
      const requestFingerprint = crmOperationsSha256({
        contactId: input.contactId,
        source: input.source,
        sourceSite: input.sourceSite,
        sourceForm: input.sourceForm,
        sourceSubmissionId: input.sourceSubmissionId,
        submittedAt: input.submittedAt,
        status: input.status,
        subject: input.subject,
        message: input.message,
        queueKey: input.queueKey,
        fields: input.fields,
      })
      return store.transaction(context, async (tx) => {
        const saved = await tx.importHistoricalSubmission({ ...input, requestFingerprint })
        if (saved.created) await audit(tx, context.actor, {
          action: 'crm.submission.historical_imported',
          subjectKind: 'submission',
          subjectId: recordId(saved.record, 'historical submission'),
          details: {
            source: input.source,
            sourceSite: input.sourceSite,
            sourceForm: input.sourceForm,
            sourceSubmissionId: input.sourceSubmissionId,
            importJobId: input.importJobId,
            importRow: input.importRow,
          },
        })
        return { record: saved.record, created: saved.created, duplicate: !saved.created }
      })
    },
    async execute(rawContext, rawCommand) {
      const context = CrmOperationsContextSchema.parse(rawContext)
      const command = CrmOperationsCommandSchema.parse(rawCommand)
      assertCrmOperationsAuthority(context, command)
      if(command.kind==='preview_import_file_cleanup') {
        const preview=await (options.fileCleanup ?? createCrmImportFileCleanupService()).preview(context,command)
        return result(command.kind,{...preview},{created:true})
      }
      if(command.kind==='execute_import_file_cleanup') {
        const executed=await (options.fileCleanup ?? createCrmImportFileCleanupService()).execute(context,command)
        return result(command.kind,executed.receipt,{created:!executed.duplicate,duplicate:executed.duplicate})
      }
      if(command.kind==='preview_retention') {
        const preview=await (options.retention ?? createCrmRetentionService()).preview(context,command)
        return result(command.kind,{...preview},{created:true})
      }
      if(command.kind==='execute_retention') {
        const executed=await (options.retention ?? createCrmRetentionService()).execute(context,command)
        return result(command.kind,executed.receipt,{created:!executed.duplicate,duplicate:executed.duplicate})
      }
      if(command.kind==='send_message') {
        if(!options.deliveries) throw new CrmOperationsError('conflict','CRM delivery is unavailable.',{reason:'delivery_unavailable'})
        const sent=await options.deliveries.send(context,command)
        return result(command.kind,{...sent.receipt},{created:!sent.duplicate,duplicate:sent.duplicate})
      }
      if(command.kind==='preview_contact_erasure') {
        const preview=await (options.privacy ?? createCrmPrivacyService()).preview(context,command)
        return result(command.kind,{...preview},{created:true})
      }
      if(command.kind==='erase_contact_with_preview') {
        const erased=await (options.privacy ?? createCrmPrivacyService()).erase(context,command)
        return result(command.kind,erased.receipt,{created:!erased.duplicate,duplicate:erased.duplicate})
      }
      const now = clock()
      const occurredAt = now.toISOString()
      const identity = actorAuditIdentity(context.actor)

      return store.transaction(context, async (tx) => {
        if (context.authority.integration && !isCrmConfigCommand(command)) await tx.authorizeIntegration(command)
        if (isCrmConfigCommand(command)) {
          const saved = await tx.configureCatalog(command)
          if (saved.changed) await audit(tx, context.actor, {
            action: `crm.${saved.subjectKind}.${saved.created ? 'created' : 'updated'}`,
            subjectKind: saved.subjectKind, subjectId: recordId(saved.record, saved.subjectKind),
          })
          return result(command.kind, saved.record, { created: saved.created, duplicate: !saved.changed })
        }
        if (command.kind === 'release_address_suppression') {
          const saved = await tx.releaseAddressSuppression(command)
          if (saved.changed) await audit(tx, context.actor, { action: 'crm.address_suppression.released',subjectKind: 'address_suppression',
            subjectId: recordId(saved.record,'suppression'),details: { evidenceKind: command.evidenceKind,evidenceId: command.evidenceId } })
          return result(command.kind,saved.record,{ duplicate: !saved.changed })
        }
        if (command.kind === 'save_managed_mailbox_policy') {
          const saved = await tx.saveManagedMailboxPolicy(command)
          if (saved.changed) await audit(tx,context.actor,{ action:'crm.mailbox_policy.approved',subjectKind:'mailbox_policy',
            subjectId:recordId(saved.record,'mailbox policy'),details:{ version:saved.record.version,managed:saved.record.managed } })
          return result(command.kind,saved.record,{ duplicate:!saved.changed })
        }
        if(command.kind==='save_mailbox_integration_grant') {
          const saved=await tx.saveMailboxIntegrationGrant(command)
          if(saved.changed) await audit(tx,context.actor,{action:'crm.mailbox_integration_grant.approved',subjectKind:'mailbox_integration_grant',
            subjectId:recordId(saved.record,'mailbox grant'),details:{version:saved.record.version,enabled:saved.record.enabled}})
          return result(command.kind,saved.record,{duplicate:!saved.changed})
        }
        if (command.kind === 'save_privacy_policy') {
          const saved = await tx.savePrivacyPolicy(command)
          if (saved.created) await audit(tx, context.actor, {
            action: 'crm.privacy_policy.approved', subjectKind: 'privacy_policy',
            subjectId: recordId(saved.record, 'privacy policy'),
            details: { version: saved.record.version, intakeReplayConfigured: saved.record.policy.intakeReplay !== null },
          })
          return result(command.kind, saved.record, { created: saved.created })
        }
        if (command.kind === 'save_entitlement_plan' || command.kind === 'save_event') {
          const saved = command.kind === 'save_entitlement_plan'
            ? await tx.saveEntitlementPlan(command) : await tx.saveEvent(command)
          const subjectKind = command.kind === 'save_entitlement_plan' ? 'entitlement_plan' : 'event'
          await audit(tx, context.actor, {
            action: `crm.${subjectKind}.${saved.created ? 'created' : 'updated'}`,
            subjectKind, subjectId: recordId(saved.record, subjectKind),
          })
          return result(command.kind, saved.record, { created: saved.created })
        }
        if (command.kind === 'record_submission') {
          return executeSubmission(tx, context, command, now)
        }
        if (command.kind === 'save_intake_definition') {
          assertIntakeVerificationConfiguration(context, command.definition)
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
          const prefix = `sk_intake_${credentialId}`
          const record = await tx.createIntakeCredential({
            credentialId,
            rotateFromCredentialId: command.rotateFromCredentialId,
            label: command.label,
            definitionIds: command.definitionIds,
            departmentBinding: command.departmentBinding,
            secretPrefix: prefix,
            secretHash: await hashCredentialSecret(secret),
            createdByUserId: actorUserId(context.actor),
          })
          await audit(tx, context.actor, {
            action: 'crm.intake_credential.created', subjectKind: 'intake_credential', subjectId: credentialId,
            details: { definitionIds: command.definitionIds, ...(command.rotateFromCredentialId ? { rotatedFromCredentialId: command.rotateFromCredentialId } : {}) },
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
          const previous = command.purposeId ? await tx.getConsentPurpose(command.purposeKey) : null
          if (command.purposeId && previous?.id !== command.purposeId) {
            throw new CrmOperationsError('not_found', 'Consent purpose was not found for this stable key.')
          }
          const defaultLocale = command.defaultLocale === undefined ? (previous?.defaultLocale as string | null) ?? null : command.defaultLocale
          const localeWordings = CrmLocaleWordingsSchema.parse(command.localeWordings ?? previous?.localeWordings ?? {})
          if (defaultLocale && localeWordings[defaultLocale as keyof typeof localeWordings] !== undefined
            && localeWordings[defaultLocale as keyof typeof localeWordings] !== command.wording) {
            invalidInput('The default locale translation must equal the default wording.')
          }
          const saved = await tx.saveConsentPurpose({
            ...command,
            defaultLocale,
            localeWordings,
            localeWordingHashes: Object.fromEntries(Object.entries(localeWordings).map(([locale, text]) => [locale, crmOperationsSha256(text)])),
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
          const saved = await tx.appendConsent({
            ...command,
            purpose,
            requestedOccurredAt: command.occurredAt,
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
          const saved = await tx.appendSuppression({ ...command, requestedOccurredAt: command.occurredAt, occurredAt: command.occurredAt ?? occurredAt, actor: identity })
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
        if(command.kind==='expire_due_entitlement') {
          const record=await tx.expireDueEntitlement(command.entitlementId)
          if(!record)return result(command.kind,{id:command.entitlementId,changed:false},{duplicate:true})
          await audit(tx,context.actor,{action:'crm.entitlement.changed',subjectKind:'entitlement',subjectId:command.entitlementId,details:{status:'expired'}})
          const eventId=await emit(tx,context,{eventType:'crm.entitlement.changed',eventKey:`crm.entitlement.changed:${command.entitlementId}:expired`,
            subjectKind:'entitlement',subjectId:command.entitlementId,payload:{entitlementId:command.entitlementId,contactId:record.contactId,
              planId:record.planId,status:'expired',actorKind:context.actor.kind,occurredAt},occurredAt})
          return result(command.kind,{...record,changed:true},{emittedEventIds:[eventId]})
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
        if (command.kind === 'correct_participation_check_in') {
          const record = await tx.correctParticipationCheckIn(command.participationId, command.expectedStatus)
          if (!record) throw new CrmOperationsError('not_found', 'Participation was not found.')
          await audit(tx, context.actor, { action: 'crm.participation.check_in_corrected', subjectKind: 'participation',
            subjectId: command.participationId, details: { from: command.expectedStatus, to: 'registered', reason: command.reason } })
          const eventId = await emit(tx, context, {
            eventType: 'crm.participation.changed', eventKey: `crm.participation.changed:${command.participationId}:${String(record.updatedAt)}`,
            subjectKind: 'participation', subjectId: command.participationId,
            payload: { participationId: command.participationId, contactId: record.contactId, eventId: record.eventId,
              status: 'registered', actorKind: context.actor.kind, occurredAt }, occurredAt,
          })
          return result(command.kind, record, { emittedEventIds: [eventId] })
        }
        if (command.kind === 'set_deal_pipeline_stage') {
          const record = await tx.setDealPipelineStage({ ...command, actorUserId: actorUserId(context.actor), actorAssistantId: actorAssistantId(context.actor) })
          if (!record) throw new CrmOperationsError('catalog_key_invalid', 'Deal, pipeline, or stage is unavailable.')
          if (record.unchanged === true) return result(command.kind, record, { duplicate: true })
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
