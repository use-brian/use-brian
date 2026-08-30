/**
 * PostgreSQL transaction port for the canonical CRM operations service.
 * Every query is workspace-qualified, including reads performed with the
 * system pool. This module owns persistence only; command sequencing remains
 * in `crm-operations/service.ts`.
 *
 * [COMP:crm/operations-store]
 */

import type { Pool, PoolClient, QueryResultRow } from 'pg'
import {
  CrmOperationsError,
  crmOperationsSha256,
  mayTransitionCrmEntitlement,
  mayTransitionCrmParticipation,
  type CrmIntakeDefinitionVersionInput,
  type CrmOperationsActor,
  type CrmOperationsContext,
  type CrmSegmentCatalog,
  type CrmSegmentPredicate,
} from '@use-brian/core'
import { getPool } from './client.js'
import { loadCrmSegmentCatalog } from './crm-segment-store.js'

export type CrmOperationsRecord = Record<string, unknown>

export type StoredIntakeDefinition = {
  id: string
  workspaceId: string
  definitionKey: string
  label: string
  active: boolean
  currentVersion: number
  versionId: string
  fields: CrmIntakeDefinitionVersionInput['fields']
  identityPolicy: CrmIntakeDefinitionVersionInput['identityPolicy']
  allowedIdentityProvider: string | null
  consentMappings: CrmIntakeDefinitionVersionInput['consentMappings']
  queueKey: string
  ownerUserId: string | null
  followUpTaskTemplate: CrmIntakeDefinitionVersionInput['followUpTaskTemplate'] | null
  followUpDueMinutes: number | null
  maxPayloadBytes: number
  schemaHash: string
  schemaSnapshot: Record<string, unknown>
  createdByUserId: string | null
}

export type ContactWrite = {
  name: string
  email: string | null
  phone: string | null
  tags: string[]
  customFields: Record<string, unknown>
}

export type AuditIdentity = {
  actorKind: string
  actorCredentialId: string
  actingUserId: string | null
}

export type IdempotencyClaim =
  | { kind: 'claimed'; claimId: string }
  | {
    kind: 'duplicate'
    claimId: string
    submissionId: string
    contactId: string
    followUpTaskId: string | null
  }
  | { kind: 'conflict'; claimId: string; storedHash: string }

export type CrmOperationsTransaction = {
  getIntakeDefinition(definitionKey: string): Promise<StoredIntakeDefinition | null>
  intakeCredentialMayUse(credentialId: string, definitionId: string): Promise<boolean>
  claimIdempotency(params: {
    actorScope: string
    credentialId: string | null
    definitionId: string
    idempotencyKey: string
    requestHash: string
  }): Promise<IdempotencyClaim>
  commitIdempotency(params: {
    claimId: string
    submissionId: string
    contactId: string
    followUpTaskId: string | null
  }): Promise<void>
  resolveExternalIdentity(provider: string, subject: string): Promise<string | null>
  findContactByEmail(email: string): Promise<string | null>
  resolveAttributionUser(preferredUserId?: string | null): Promise<string | null>
  createContact(input: ContactWrite, attribution: {
    createdByUserId: string
    createdByAssistantId: string | null
  }): Promise<CrmOperationsRecord>
  updateContact(contactId: string, input: ContactWrite): Promise<CrmOperationsRecord>
  bindExternalIdentity(contactId: string, provider: string, subject: string): Promise<void>
  createSubmission(params: {
    definition: StoredIntakeDefinition
    contactId: string
    sourceSubmissionId: string
    requestHash: string
    fields: Record<string, unknown>
    submittedAt: string
  }): Promise<CrmOperationsRecord>
  createFollowUpTask(params: {
    contactId: string
    submissionId: string
    title: string
    description: string
    priority: string
    tags: string[]
    due: string | null
    assigneeId: string | null
    createdByUserId: string | null
    createdByAssistantId: string | null
  }): Promise<CrmOperationsRecord>
  attachFollowUpTask(submissionId: string, taskId: string): Promise<void>
  getConsentPurpose(purposeKey: string): Promise<CrmOperationsRecord | null>
  appendConsent(params: {
    contactId: string
    purpose: CrmOperationsRecord
    action: 'granted' | 'withdrawn'
    source: string
    occurredAt: string
    provider?: string
    providerEventId?: string
    metadata: Record<string, unknown>
    actor: AuditIdentity
  }): Promise<{ record: CrmOperationsRecord; created: boolean }>
  appendSuppression(params: {
    contactId: string
    channel: string
    action: string
    reasonCode: string
    source: string
    occurredAt: string
    provider?: string
    providerEventId?: string
    metadata: Record<string, unknown>
    actor: AuditIdentity
  }): Promise<{ record: CrmOperationsRecord; created: boolean }>
  updateSubmission(params: {
    submissionId: string
    status?: string
    queueKey?: string
    ownerUserId?: string | null
    note?: string
    actor: AuditIdentity
  }): Promise<CrmOperationsRecord | null>
  saveIntakeDefinition(params: {
    definitionId?: string
    definitionKey: string
    label: string
    active: boolean
    expectedVersion?: number
    definition: CrmIntakeDefinitionVersionInput
    schemaHash: string
    schemaSnapshot: Record<string, unknown>
    createdByUserId: string | null
  }): Promise<{ record: CrmOperationsRecord; created: boolean }>
  createIntakeCredential(params: {
    credentialId: string
    label: string
    definitionIds: string[]
    secretPrefix: string
    secretHash: string
    createdByUserId: string | null
  }): Promise<CrmOperationsRecord>
  revokeIntakeCredential(credentialId: string): Promise<CrmOperationsRecord | null>
  saveConsentPurpose(params: {
    purposeId?: string
    purposeKey: string
    label: string
    description: string
    requiresConsent: boolean
    applicableChannels: string[]
    wordingVersion: string
    wording: string
    wordingHash: string
    archived: boolean
    createdByUserId: string | null
  }): Promise<{ record: CrmOperationsRecord; created: boolean }>
  saveSegment(params: {
    segmentId?: string
    segmentKey: string
    name: string
    description: string
    entityKind: string
    predicate: CrmSegmentPredicate
    expectedVersion?: number
    actorUserId: string | null
  }): Promise<{ record: CrmOperationsRecord; created: boolean }>
  getSegmentCatalog(entityKind: 'person' | 'company' | 'deal'): Promise<CrmSegmentCatalog>
  archiveSegment(segmentId: string, expectedVersion?: number): Promise<CrmOperationsRecord | null>
  grantEntitlement(params: CrmOperationsRecord): Promise<{ record: CrmOperationsRecord; created: boolean }>
  updateEntitlement(entitlementId: string, changes: CrmOperationsRecord): Promise<CrmOperationsRecord | null>
  recordParticipation(params: CrmOperationsRecord): Promise<{ record: CrmOperationsRecord; created: boolean }>
  updateParticipation(participationId: string, status: string): Promise<CrmOperationsRecord | null>
  setDealPipelineStage(params: {
    dealId: string
    pipelineId: string
    stageId: string
    actorUserId: string | null
    actorAssistantId: string | null
  }): Promise<CrmOperationsRecord | null>
  appendDomainAudit(params: {
    action: string
    subjectKind: string
    subjectId: string
    actor: AuditIdentity
    metadata?: Record<string, unknown>
  }): Promise<string>
  appendWorkspaceAudit(params: {
    eventType: string
    subjectId: string | null
    actorUserId: string | null
    details?: Record<string, unknown>
  }): Promise<string>
  emitDomainEvent(params: {
    eventType: string
    eventKey: string
    subjectKind: string
    subjectId: string
    payload: Record<string, unknown>
    actor: CrmOperationsActor
    occurredAt: string
  }): Promise<string>
}

export type CrmOperationsStore = {
  transaction<T>(
    context: CrmOperationsContext,
    fn: (tx: CrmOperationsTransaction) => Promise<T>,
  ): Promise<T>
}

type DbRecord = QueryResultRow & Record<string, unknown>

function first(result: { rows: DbRecord[] }): CrmOperationsRecord {
  return result.rows[0] ?? {}
}

function actorAssistantId(actor: CrmOperationsActor): string | null {
  return actor.kind === 'assistant' ? actor.assistantId : null
}

function createTransaction(client: PoolClient, context: CrmOperationsContext): CrmOperationsTransaction {
  const workspaceId = context.workspaceId
  return {
    async getIntakeDefinition(definitionKey) {
      const result = await client.query<DbRecord>(
        `SELECT d.id, d.workspace_id AS "workspaceId", d.definition_key AS "definitionKey",
                d.label, d.active, d.current_version AS "currentVersion",
                v.id AS "versionId", v.field_catalog AS fields,
                v.identity_policy AS "identityPolicy",
                v.allowed_identity_provider AS "allowedIdentityProvider",
                v.consent_mappings AS "consentMappings", v.queue_key AS "queueKey",
                v.owner_user_id AS "ownerUserId",
                v.follow_up_task_template AS "followUpTaskTemplate",
                v.follow_up_due_minutes AS "followUpDueMinutes",
                v.max_payload_bytes AS "maxPayloadBytes", v.schema_hash AS "schemaHash",
                v.schema_snapshot AS "schemaSnapshot",
                d.created_by_user_id AS "createdByUserId"
           FROM crm_intake_definitions d
           JOIN crm_intake_definition_versions v
             ON v.workspace_id = d.workspace_id AND v.definition_id = d.id
            AND v.version = d.current_version
          WHERE d.workspace_id = $1 AND d.definition_key = $2`,
        [workspaceId, definitionKey],
      )
      return (result.rows[0] as StoredIntakeDefinition | undefined) ?? null
    },

    async intakeCredentialMayUse(credentialId, definitionId) {
      const result = await client.query(
        `SELECT 1
           FROM crm_intake_credentials c
           JOIN crm_intake_credential_definitions b
             ON b.workspace_id = c.workspace_id AND b.credential_id = c.id
          WHERE c.workspace_id = $1 AND c.id = $2 AND b.definition_id = $3
            AND c.revoked_at IS NULL`,
        [workspaceId, credentialId, definitionId],
      )
      return result.rowCount === 1
    },

    async claimIdempotency(params) {
      const inserted = await client.query<DbRecord>(
        `INSERT INTO crm_intake_idempotency (
           workspace_id, credential_id, actor_scope, definition_id,
           idempotency_key, request_hash
         ) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (workspace_id, actor_scope, definition_id, idempotency_key)
         DO NOTHING
         RETURNING id`,
        [workspaceId, params.credentialId, params.actorScope, params.definitionId,
          params.idempotencyKey, params.requestHash],
      )
      if (inserted.rows[0]) return { kind: 'claimed', claimId: inserted.rows[0].id as string }

      const existing = await client.query<DbRecord>(
        `SELECT id, request_hash AS "requestHash", status,
                submission_id AS "submissionId", contact_id AS "contactId",
                follow_up_task_id AS "followUpTaskId"
           FROM crm_intake_idempotency
          WHERE workspace_id = $1 AND actor_scope = $2 AND definition_id = $3
            AND idempotency_key = $4
          FOR UPDATE`,
        [workspaceId, params.actorScope, params.definitionId, params.idempotencyKey],
      )
      const row = existing.rows[0]
      if (!row || row.requestHash !== params.requestHash || row.status !== 'committed') {
        return {
          kind: 'conflict',
          claimId: String(row?.id ?? ''),
          storedHash: String(row?.requestHash ?? ''),
        }
      }
      return {
        kind: 'duplicate',
        claimId: row.id as string,
        submissionId: row.submissionId as string,
        contactId: row.contactId as string,
        followUpTaskId: (row.followUpTaskId as string | null) ?? null,
      }
    },

    async commitIdempotency(params) {
      const result = await client.query(
        `UPDATE crm_intake_idempotency
            SET status = 'committed', submission_id = $3, contact_id = $4,
                follow_up_task_id = $5, committed_at = now()
          WHERE workspace_id = $1 AND id = $2 AND status = 'pending'`,
        [workspaceId, params.claimId, params.submissionId, params.contactId, params.followUpTaskId],
      )
      if (result.rowCount !== 1) throw new Error('crm idempotency claim was not pending')
    },

    async resolveExternalIdentity(provider, subject) {
      const result = await client.query<{ contactId: string }>(
        `SELECT contact_id AS "contactId"
           FROM association_external_identities
          WHERE workspace_id = $1 AND provider = $2 AND provider_subject = $3`,
        [workspaceId, provider, subject],
      )
      return result.rows[0]?.contactId ?? null
    },

    async findContactByEmail(email) {
      const result = await client.query<{ id: string }>(
        `SELECT id FROM entities
          WHERE workspace_id = $1 AND kind = 'person' AND valid_to IS NULL
            AND retracted_at IS NULL
            AND lower(COALESCE(attributes->>'email', canonical_id, '')) = $2
          ORDER BY created_at, id LIMIT 2`,
        [workspaceId, email.trim().toLowerCase()],
      )
      return result.rows.length === 1 ? result.rows[0]!.id : null
    },

    async resolveAttributionUser(preferredUserId) {
      if (preferredUserId) {
        const preferred = await client.query<{ id: string }>(
          `SELECT wm.user_id AS id
             FROM workspace_members wm
            WHERE wm.workspace_id = $1 AND wm.user_id = $2`,
          [workspaceId, preferredUserId],
        )
        if (preferred.rows[0]) return preferred.rows[0].id
      }
      const fallback = await client.query<{ id: string }>(
        `SELECT COALESCE(w.owner_user_id, wm.user_id) AS id
           FROM workspaces w
           LEFT JOIN LATERAL (
             SELECT user_id FROM workspace_members
              WHERE workspace_id = w.id
              ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, joined_at
              LIMIT 1
           ) wm ON true
          WHERE w.id = $1`,
        [workspaceId],
      )
      return fallback.rows[0]?.id ?? null
    },

    async createContact(input, attribution) {
      const result = await client.query<DbRecord>(
        `INSERT INTO entities (
           kind, display_name, canonical_id, attributes, sensitivity,
           workspace_id, user_id, created_by_user_id, created_by_assistant_id,
           source, compartments, project_ids
         ) VALUES ('person',$1,$2,$3::jsonb,'internal',$4,$5,$5,$6,'user','{}','{}')
         RETURNING id, workspace_id AS "workspaceId", display_name AS name,
                   canonical_id AS email, attributes, created_at AS "createdAt",
                   updated_at AS "updatedAt"`,
        [input.name, input.email, JSON.stringify({
          ...(input.email ? { email: input.email } : {}),
          ...(input.phone ? { phone: input.phone } : {}),
          tags: input.tags,
          custom_fields: input.customFields,
        }), workspaceId, attribution.createdByUserId, attribution.createdByAssistantId],
      )
      return first(result)
    },

    async updateContact(contactId, input) {
      const result = await client.query<DbRecord>(
        `UPDATE entities
            SET display_name = COALESCE(NULLIF($3,''), display_name),
                canonical_id = COALESCE($4, canonical_id),
                attributes = attributes || $5::jsonb,
                updated_at = now()
          WHERE workspace_id = $1 AND id = $2 AND kind = 'person'
            AND valid_to IS NULL AND retracted_at IS NULL
         RETURNING id, workspace_id AS "workspaceId", display_name AS name,
                   canonical_id AS email, attributes, created_at AS "createdAt",
                   updated_at AS "updatedAt"`,
        [workspaceId, contactId, input.name, input.email, JSON.stringify({
          ...(input.email ? { email: input.email } : {}),
          ...(input.phone ? { phone: input.phone } : {}),
          ...(input.tags.length > 0 ? { tags: input.tags } : {}),
          ...(Object.keys(input.customFields).length > 0 ? { custom_fields: input.customFields } : {}),
        })],
      )
      if (!result.rows[0]) throw new Error('crm contact not found in workspace')
      return first(result)
    },

    async bindExternalIdentity(contactId, provider, subject) {
      const result = await client.query<{ contactId: string }>(
        `INSERT INTO association_external_identities (
           workspace_id, contact_id, provider, provider_subject
         ) VALUES ($1,$2,$3,$4)
         ON CONFLICT (workspace_id, provider, provider_subject)
         DO UPDATE SET updated_at = now()
         RETURNING contact_id AS "contactId"`,
        [workspaceId, contactId, provider, subject],
      )
      if (result.rows[0]?.contactId !== contactId) {
        throw new Error('crm external identity is already bound to another contact')
      }
    },

    async createSubmission(params) {
      const result = await client.query<DbRecord>(
        `INSERT INTO association_enquiries (
           workspace_id, contact_id, source, source_submission_id,
           request_fingerprint, subject, message, submitted_data, status,
           queue_key, owner_user_id, submitted_at, definition_id,
           definition_version_id, definition_schema_hash,
           definition_schema_snapshot
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'new',$9,$10,$11,$12,$13,$14,$15::jsonb)
         RETURNING id, workspace_id AS "workspaceId", contact_id AS "contactId",
                   definition_id AS "definitionId", definition_version_id AS "definitionVersionId",
                   status, queue_key AS "queueKey", owner_user_id AS "ownerUserId",
                   submitted_at AS "submittedAt", follow_up_task_id AS "followUpTaskId",
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [workspaceId, params.contactId, params.definition.definitionKey,
          params.sourceSubmissionId, params.requestHash,
          `${params.definition.label} submission`,
          `Submission received through ${params.definition.label}.`,
          JSON.stringify(params.fields), params.definition.queueKey,
          params.definition.ownerUserId, params.submittedAt, params.definition.id,
          params.definition.versionId, params.definition.schemaHash,
          JSON.stringify(params.definition.schemaSnapshot)],
      )
      return first(result)
    },

    async createFollowUpTask(params) {
      const result = await client.query<DbRecord>(
        `INSERT INTO tasks (
           workspace_id, title, status, assignee_id, due, tags, attributes,
           created_by_user_id, created_by_assistant_id, source
         ) VALUES ($1,$2,'todo',$3,$4,$5,$6::jsonb,$7,$8,'user')
         RETURNING id, workspace_id AS "workspaceId", title, status,
                   assignee_id AS "assigneeId", due, tags,
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [workspaceId, params.title, params.assigneeId, params.due, params.tags,
          JSON.stringify({
            description: params.description,
            priority: params.priority,
            crm_contact_id: params.contactId,
            crm_submission_id: params.submissionId,
          }), params.createdByUserId, params.createdByAssistantId],
      )
      return first(result)
    },

    async attachFollowUpTask(submissionId, taskId) {
      await client.query(
        `UPDATE association_enquiries SET follow_up_task_id = $3
          WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, submissionId, taskId],
      )
    },

    async getConsentPurpose(purposeKey) {
      const result = await client.query<DbRecord>(
        `SELECT id, workspace_id AS "workspaceId", purpose_key AS "purposeKey",
                label, description, requires_consent AS "requiresConsent",
                applicable_channels AS "applicableChannels",
                active_wording_version AS "wordingVersion",
                wording_snapshot AS wording, wording_hash AS "wordingHash",
                archived_at AS "archivedAt"
           FROM crm_consent_purposes
          WHERE workspace_id = $1 AND purpose_key = $2`,
        [workspaceId, purposeKey],
      )
      return result.rows[0] ?? null
    },

    async appendConsent(params) {
      if (params.provider && params.providerEventId) {
        const existing = await client.query<DbRecord>(
          `SELECT id, contact_id AS "contactId", purpose, action,
                  wording_version AS "wordingVersion", wording_hash AS "wordingHash",
                  wording_snapshot AS wording, source, occurred_at AS "occurredAt",
                  provider, provider_event_id AS "providerEventId", metadata,
                  created_at AS "createdAt"
             FROM association_consent_events
            WHERE workspace_id = $1 AND provider = $2 AND provider_event_id = $3`,
          [workspaceId, params.provider, params.providerEventId],
        )
        if (existing.rows[0]) return { record: existing.rows[0], created: false }
      }
      const result = await client.query<DbRecord>(
        `INSERT INTO association_consent_events (
           workspace_id, contact_id, purpose, purpose_id, action,
           wording_version, wording_hash, wording_snapshot, source, occurred_at,
           provider, provider_event_id, metadata, actor_kind,
           actor_credential_id, acting_user_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16)
         ON CONFLICT (workspace_id, provider, provider_event_id)
           WHERE provider IS NOT NULL DO NOTHING
         RETURNING id, contact_id AS "contactId", purpose, action,
                   wording_version AS "wordingVersion", wording_hash AS "wordingHash",
                   wording_snapshot AS wording, source, occurred_at AS "occurredAt",
                   provider, provider_event_id AS "providerEventId", metadata,
                   created_at AS "createdAt"`,
        [workspaceId, params.contactId, params.purpose.purposeKey, params.purpose.id,
          params.action, params.purpose.wordingVersion, params.purpose.wordingHash,
          params.purpose.wording, params.source, params.occurredAt,
          params.provider ?? null, params.providerEventId ?? null,
          JSON.stringify(params.metadata), params.actor.actorKind,
          params.actor.actorCredentialId, params.actor.actingUserId],
      )
      if (result.rows[0]) return { record: result.rows[0], created: true }
      const existing = await client.query<DbRecord>(
        `SELECT id, contact_id AS "contactId", purpose, action,
                wording_version AS "wordingVersion", wording_hash AS "wordingHash",
                wording_snapshot AS wording, source, occurred_at AS "occurredAt",
                provider, provider_event_id AS "providerEventId", metadata,
                created_at AS "createdAt"
           FROM association_consent_events
          WHERE workspace_id = $1 AND provider = $2 AND provider_event_id = $3`,
        [workspaceId, params.provider, params.providerEventId],
      )
      return { record: first(existing), created: false }
    },

    async appendSuppression(params) {
      if (params.provider && params.providerEventId) {
        const existing = await client.query<DbRecord>(
          `SELECT id, contact_id AS "contactId", channel, action,
                  reason_code AS "reasonCode", source, occurred_at AS "occurredAt",
                  provider, provider_event_id AS "providerEventId", metadata,
                  created_at AS "createdAt"
             FROM crm_suppression_events
            WHERE workspace_id = $1 AND provider = $2 AND provider_event_id = $3`,
          [workspaceId, params.provider, params.providerEventId],
        )
        if (existing.rows[0]) return { record: existing.rows[0], created: false }
      }
      const result = await client.query<DbRecord>(
        `INSERT INTO crm_suppression_events (
           workspace_id, contact_id, channel, action, reason_code, source,
           actor_kind, actor_credential_id, acting_user_id, provider,
           provider_event_id, occurred_at, metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
         ON CONFLICT (workspace_id, provider, provider_event_id)
           WHERE provider IS NOT NULL DO NOTHING
         RETURNING id, contact_id AS "contactId", channel, action,
                   reason_code AS "reasonCode", source, occurred_at AS "occurredAt",
                   provider, provider_event_id AS "providerEventId", metadata,
                   created_at AS "createdAt"`,
        [workspaceId, params.contactId, params.channel, params.action,
          params.reasonCode, params.source, params.actor.actorKind,
          params.actor.actorCredentialId, params.actor.actingUserId,
          params.provider ?? null, params.providerEventId ?? null,
          params.occurredAt, JSON.stringify(params.metadata)],
      )
      if (result.rows[0]) return { record: result.rows[0], created: true }
      const existing = await client.query<DbRecord>(
        `SELECT id, contact_id AS "contactId", channel, action,
                reason_code AS "reasonCode", source, occurred_at AS "occurredAt",
                provider, provider_event_id AS "providerEventId", metadata,
                created_at AS "createdAt"
           FROM crm_suppression_events
          WHERE workspace_id = $1 AND provider = $2 AND provider_event_id = $3`,
        [workspaceId, params.provider, params.providerEventId],
      )
      return { record: first(existing), created: false }
    },

    async updateSubmission(params) {
      const result = await client.query<DbRecord>(
        `UPDATE association_enquiries
            SET status = COALESCE($3, status), queue_key = COALESCE($4, queue_key),
                owner_user_id = CASE WHEN $5::boolean THEN $6::uuid ELSE owner_user_id END,
                updated_at = now()
          WHERE workspace_id = $1 AND id = $2
         RETURNING id, contact_id AS "contactId", definition_id AS "definitionId",
                   status, queue_key AS "queueKey", owner_user_id AS "ownerUserId",
                   follow_up_task_id AS "followUpTaskId", submitted_at AS "submittedAt",
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [workspaceId, params.submissionId, params.status ?? null, params.queueKey ?? null,
          params.ownerUserId !== undefined, params.ownerUserId ?? null],
      )
      const record = result.rows[0]
      if (!record) return null
      if (params.note) {
        await client.query(
          `INSERT INTO association_enquiry_notes (
             workspace_id, enquiry_id, body, actor_kind,
             actor_credential_id, acting_user_id
           ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [workspaceId, params.submissionId, params.note, params.actor.actorKind,
            params.actor.actorCredentialId, params.actor.actingUserId],
        )
      }
      return record
    },

    async saveIntakeDefinition(params) {
      if (params.definitionId) {
        const updated = await client.query<DbRecord>(
          `UPDATE crm_intake_definitions
              SET label = $3, active = $4, current_version = current_version + 1,
                  updated_at = now()
            WHERE workspace_id = $1 AND id = $2
              AND ($5::int IS NULL OR current_version = $5)
           RETURNING id, definition_key AS "definitionKey", label, active,
                     current_version AS "currentVersion", created_at AS "createdAt",
                     updated_at AS "updatedAt"`,
          [workspaceId, params.definitionId, params.label, params.active,
            params.expectedVersion ?? null],
        )
        const row = updated.rows[0]
        if (!row) throw new Error('crm intake definition version conflict or not found')
        await client.query(
          `INSERT INTO crm_intake_definition_versions (
             workspace_id, definition_id, version, field_catalog, identity_policy,
             allowed_identity_provider, consent_mappings, queue_key, owner_user_id,
             follow_up_task_template, follow_up_due_minutes, max_payload_bytes,
             workflow_hint, schema_hash, schema_snapshot, created_by_user_id
           ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11,$12,$13,$14,$15::jsonb,$16)`,
          [workspaceId, params.definitionId, row.currentVersion,
            JSON.stringify(params.definition.fields), params.definition.identityPolicy,
            params.definition.allowedIdentityProvider ?? null,
            JSON.stringify(params.definition.consentMappings), params.definition.queueKey,
            params.definition.ownerUserId ?? null,
            params.definition.followUpTaskTemplate
              ? JSON.stringify(params.definition.followUpTaskTemplate) : null,
            params.definition.followUpDueMinutes ?? null,
            params.definition.maxPayloadBytes, params.definition.workflowHint ?? null,
            params.schemaHash, JSON.stringify(params.schemaSnapshot), params.createdByUserId],
        )
        return { record: row, created: false }
      }

      const created = await client.query<DbRecord>(
        `INSERT INTO crm_intake_definitions (
           workspace_id, definition_key, label, active, current_version, created_by_user_id
         ) VALUES ($1,$2,$3,$4,1,$5)
         RETURNING id, definition_key AS "definitionKey", label, active,
                   current_version AS "currentVersion", created_at AS "createdAt",
                   updated_at AS "updatedAt"`,
        [workspaceId, params.definitionKey, params.label, params.active, params.createdByUserId],
      )
      const row = created.rows[0]!
      await client.query(
        `INSERT INTO crm_intake_definition_versions (
           workspace_id, definition_id, version, field_catalog, identity_policy,
           allowed_identity_provider, consent_mappings, queue_key, owner_user_id,
           follow_up_task_template, follow_up_due_minutes, max_payload_bytes,
           workflow_hint, schema_hash, schema_snapshot, created_by_user_id
         ) VALUES ($1,$2,1,$3::jsonb,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10,$11,$12,$13,$14::jsonb,$15)`,
        [workspaceId, row.id, JSON.stringify(params.definition.fields),
          params.definition.identityPolicy, params.definition.allowedIdentityProvider ?? null,
          JSON.stringify(params.definition.consentMappings), params.definition.queueKey,
          params.definition.ownerUserId ?? null,
          params.definition.followUpTaskTemplate
            ? JSON.stringify(params.definition.followUpTaskTemplate) : null,
          params.definition.followUpDueMinutes ?? null,
          params.definition.maxPayloadBytes, params.definition.workflowHint ?? null,
          params.schemaHash, JSON.stringify(params.schemaSnapshot), params.createdByUserId],
      )
      return { record: row, created: true }
    },

    async createIntakeCredential(params) {
      const definitions = await client.query<{ id: string }>(
        `SELECT id FROM crm_intake_definitions
          WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND active`,
        [workspaceId, params.definitionIds],
      )
      if (definitions.rows.length !== new Set(params.definitionIds).size) {
        throw new Error('one or more intake definitions are unavailable')
      }
      const created = await client.query<DbRecord>(
        `INSERT INTO crm_intake_credentials (
           id, workspace_id, label, secret_prefix, secret_hash, created_by_user_id
         ) VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, label, secret_prefix AS "secretPrefix", revoked_at AS "revokedAt",
                   last_used_at AS "lastUsedAt", created_at AS "createdAt"`,
        [params.credentialId, workspaceId, params.label, params.secretPrefix,
          params.secretHash, params.createdByUserId],
      )
      const row = created.rows[0]!
      for (const definitionId of [...new Set(params.definitionIds)]) {
        await client.query(
          `INSERT INTO crm_intake_credential_definitions (
             workspace_id, credential_id, definition_id
           ) VALUES ($1,$2,$3)`,
          [workspaceId, row.id, definitionId],
        )
      }
      return { ...row, definitionIds: [...new Set(params.definitionIds)] }
    },

    async revokeIntakeCredential(credentialId) {
      const result = await client.query<DbRecord>(
        `UPDATE crm_intake_credentials SET revoked_at = COALESCE(revoked_at, now())
          WHERE workspace_id = $1 AND id = $2
         RETURNING id, label, secret_prefix AS "secretPrefix", revoked_at AS "revokedAt",
                   last_used_at AS "lastUsedAt", created_at AS "createdAt"`,
        [workspaceId, credentialId],
      )
      return result.rows[0] ?? null
    },

    async saveConsentPurpose(params) {
      if (params.purposeId) {
        const updated = await client.query<DbRecord>(
          `UPDATE crm_consent_purposes
              SET label=$3, description=$4, requires_consent=$5,
                  applicable_channels=$6, active_wording_version=$7,
                  wording_snapshot=$8, wording_hash=$9,
                  archived_at=CASE WHEN $10 THEN COALESCE(archived_at,now()) ELSE NULL END,
                  updated_at=now()
            WHERE workspace_id=$1 AND id=$2
           RETURNING id, purpose_key AS "purposeKey", label, description,
                     requires_consent AS "requiresConsent",
                     applicable_channels AS "applicableChannels",
                     active_wording_version AS "wordingVersion",
                     wording_snapshot AS wording, wording_hash AS "wordingHash",
                     archived_at AS "archivedAt", created_at AS "createdAt",
                     updated_at AS "updatedAt"`,
          [workspaceId, params.purposeId, params.label, params.description,
            params.requiresConsent, params.applicableChannels, params.wordingVersion,
            params.wording, params.wordingHash, params.archived],
        )
        if (!updated.rows[0]) throw new Error('crm consent purpose not found')
        return { record: updated.rows[0], created: false }
      }
      const created = await client.query<DbRecord>(
        `INSERT INTO crm_consent_purposes (
           workspace_id,purpose_key,label,description,requires_consent,
           applicable_channels,active_wording_version,wording_snapshot,
           wording_hash,archived_at,created_by_user_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $10 THEN now() END,$11)
         RETURNING id, purpose_key AS "purposeKey", label, description,
                   requires_consent AS "requiresConsent",
                   applicable_channels AS "applicableChannels",
                   active_wording_version AS "wordingVersion",
                   wording_snapshot AS wording, wording_hash AS "wordingHash",
                   archived_at AS "archivedAt", created_at AS "createdAt",
                   updated_at AS "updatedAt"`,
        [workspaceId, params.purposeKey, params.label, params.description,
          params.requiresConsent, params.applicableChannels, params.wordingVersion,
          params.wording, params.wordingHash, params.archived, params.createdByUserId],
      )
      return { record: first(created), created: true }
    },

    async saveSegment(params) {
      if (params.segmentId) {
        const updated = await client.query<DbRecord>(
          `UPDATE crm_segments
              SET name=$3, description=$4, entity_kind=$5, predicate=$6::jsonb,
                  version=version+1, updated_by_user_id=$7, updated_at=now()
            WHERE workspace_id=$1 AND id=$2 AND archived_at IS NULL
              AND ($8::int IS NULL OR version=$8)
           RETURNING id, segment_key AS "segmentKey", name, description,
                     entity_kind AS "entityKind", predicate, version,
                     archived_at AS "archivedAt", created_at AS "createdAt",
                     updated_at AS "updatedAt"`,
          [workspaceId, params.segmentId, params.name, params.description,
            params.entityKind, JSON.stringify(params.predicate), params.actorUserId,
            params.expectedVersion ?? null],
        )
        if (!updated.rows[0]) throw new Error('crm segment version conflict or not found')
        return { record: updated.rows[0], created: false }
      }
      const created = await client.query<DbRecord>(
        `INSERT INTO crm_segments (
           workspace_id,segment_key,name,description,entity_kind,predicate,
           created_by_user_id,updated_by_user_id
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$7)
         RETURNING id, segment_key AS "segmentKey", name, description,
                   entity_kind AS "entityKind", predicate, version,
                   archived_at AS "archivedAt", created_at AS "createdAt",
                   updated_at AS "updatedAt"`,
        [workspaceId, params.segmentKey, params.name, params.description,
          params.entityKind, JSON.stringify(params.predicate), params.actorUserId],
      )
      return { record: first(created), created: true }
    },

    async getSegmentCatalog(entityKind) {
      const loaded = await loadCrmSegmentCatalog(
        (sql, params) => client.query(sql, params),
        workspaceId,
        entityKind,
      )
      return loaded.catalog
    },

    async archiveSegment(segmentId, expectedVersion) {
      const result = await client.query<DbRecord>(
        `UPDATE crm_segments SET archived_at=COALESCE(archived_at,now()),
                version=version+1, updated_at=now()
          WHERE workspace_id=$1 AND id=$2
            AND ($3::int IS NULL OR version=$3)
         RETURNING id, segment_key AS "segmentKey", name, description,
                   entity_kind AS "entityKind", predicate, version,
                   archived_at AS "archivedAt", created_at AS "createdAt",
                   updated_at AS "updatedAt"`,
        [workspaceId, segmentId, expectedVersion ?? null],
      )
      return result.rows[0] ?? null
    },

    async grantEntitlement(params) {
      const legacyRequestHash = crmOperationsSha256({
        contactId: params.contactId,
        planId: params.planId,
        idempotencyKey: params.idempotencyKey,
        status: params.status,
        startsAt: params.startsAt,
        endsAt: params.endsAt,
        renewalMode: params.renewalMode,
        provider: params.provider,
        providerMembershipId: params.providerEntitlementId,
      })
      const sameRequest = (fingerprint: unknown) => fingerprint === params.requestHash
        || fingerprint === legacyRequestHash
      const existing = await client.query<DbRecord>(
        `SELECT m.id, m.contact_id AS "contactId", m.plan_id AS "planId",
                p.plan_key AS "planKey", p.name AS "planName", m.status, m.starts_at AS "startsAt",
                m.ends_at AS "endsAt", m.renewal_mode AS "renewalMode",
                m.idempotency_key AS "idempotencyKey",
                m.provider, m.provider_membership_id AS "providerEntitlementId",
                m.request_fingerprint AS "requestFingerprint",
                m.created_at AS "createdAt", m.updated_at AS "updatedAt"
           FROM association_memberships m
           JOIN association_membership_plans p
             ON p.workspace_id=m.workspace_id AND p.id=m.plan_id
          WHERE m.workspace_id=$1 AND m.idempotency_key=$2`,
        [workspaceId, params.idempotencyKey],
      )
      if (existing.rows[0]) {
        if (!sameRequest(existing.rows[0].requestFingerprint)) {
          throw new CrmOperationsError(
            'idempotency_conflict',
            'Idempotency key was already used for a different entitlement.',
          )
        }
        const { requestFingerprint: _ignored, ...record } = existing.rows[0]
        return { record, created: false }
      }
      const [contact, plan] = await Promise.all([
        client.query(
          `SELECT 1 FROM entities
            WHERE workspace_id=$1 AND id=$2 AND kind='person'
              AND valid_to IS NULL AND retracted_at IS NULL`,
          [workspaceId, params.contactId],
        ),
        client.query(
          `SELECT 1 FROM association_membership_plans
            WHERE workspace_id=$1 AND id=$2`,
          [workspaceId, params.planId],
        ),
      ])
      if (!contact.rowCount) throw new CrmOperationsError('not_found', 'CRM contact was not found.')
      if (!plan.rowCount) throw new CrmOperationsError('not_found', 'Entitlement plan was not found.')
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO association_memberships (
           workspace_id,contact_id,plan_id,idempotency_key,request_fingerprint,
           status,starts_at,ends_at,renewal_mode,provider,provider_membership_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (workspace_id,idempotency_key) DO NOTHING
         RETURNING id`,
        [workspaceId, params.contactId, params.planId, params.idempotencyKey,
          params.requestHash, params.status, params.startsAt, params.endsAt ?? null,
          params.renewalMode, params.provider ?? null,
          params.providerEntitlementId ?? null],
      )
      if (!inserted.rows[0]) {
        const raced = await client.query<DbRecord>(
          `SELECT m.id, m.contact_id AS "contactId", m.plan_id AS "planId",
                  p.plan_key AS "planKey", p.name AS "planName", m.status,
                  m.starts_at AS "startsAt", m.ends_at AS "endsAt",
                  m.renewal_mode AS "renewalMode", m.provider,
                  m.idempotency_key AS "idempotencyKey",
                  m.provider_membership_id AS "providerEntitlementId",
                  m.request_fingerprint AS "requestFingerprint",
                  m.created_at AS "createdAt", m.updated_at AS "updatedAt"
             FROM association_memberships m
             JOIN association_membership_plans p
               ON p.workspace_id=m.workspace_id AND p.id=m.plan_id
            WHERE m.workspace_id=$1 AND m.idempotency_key=$2`,
          [workspaceId, params.idempotencyKey],
        )
        if (!raced.rows[0]) {
          throw new CrmOperationsError('conflict', 'Entitlement could not be resolved after a concurrent grant.')
        }
        if (!sameRequest(raced.rows[0].requestFingerprint)) {
          throw new CrmOperationsError(
            'idempotency_conflict',
            'Idempotency key was already used for a different entitlement.',
          )
        }
        const { requestFingerprint: _ignored, ...record } = raced.rows[0]
        return { record, created: false }
      }
      const result = await client.query<DbRecord>(
        `SELECT m.id, m.contact_id AS "contactId", m.plan_id AS "planId",
                p.plan_key AS "planKey", p.name AS "planName", m.status,
                m.starts_at AS "startsAt", m.ends_at AS "endsAt",
                m.renewal_mode AS "renewalMode", m.provider,
                m.idempotency_key AS "idempotencyKey",
                m.provider_membership_id AS "providerEntitlementId",
                m.created_at AS "createdAt", m.updated_at AS "updatedAt"
           FROM association_memberships m
           JOIN association_membership_plans p
             ON p.workspace_id=m.workspace_id AND p.id=m.plan_id
          WHERE m.workspace_id=$1 AND m.id=$2`,
        [workspaceId, inserted.rows[0]!.id],
      )
      return { record: first(result), created: true }
    },

    async updateEntitlement(entitlementId, changes) {
      const current = await client.query<{ status: string; startsAt: Date }>(
        `SELECT status, starts_at AS "startsAt"
           FROM association_memberships
          WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
        [workspaceId, entitlementId],
      )
      const entitlement = current.rows[0]
      if (!entitlement) return null
      if (typeof changes.status === 'string'
        && !mayTransitionCrmEntitlement(entitlement.status, changes.status)) {
        throw new CrmOperationsError(
          'conflict',
          `Entitlement cannot transition from ${entitlement.status} to ${changes.status}.`,
        )
      }
      if (typeof changes.endsAt === 'string'
        && new Date(changes.endsAt) <= entitlement.startsAt) {
        throw new CrmOperationsError('conflict', 'endsAt must be after startsAt.')
      }
      const result = await client.query<DbRecord>(
        `UPDATE association_memberships
            SET status=COALESCE($3,status),
                ends_at=CASE WHEN $4::boolean THEN $5::timestamptz ELSE ends_at END,
                renewal_mode=COALESCE($6,renewal_mode),updated_at=now()
          WHERE workspace_id=$1 AND id=$2
         RETURNING id,contact_id AS "contactId",plan_id AS "planId",status,
                   (SELECT p.plan_key FROM association_membership_plans p
                     WHERE p.workspace_id=$1 AND p.id=plan_id) AS "planKey",
                   (SELECT p.name FROM association_membership_plans p
                     WHERE p.workspace_id=$1 AND p.id=plan_id) AS "planName",
                   starts_at AS "startsAt",ends_at AS "endsAt",
                   idempotency_key AS "idempotencyKey",
                   renewal_mode AS "renewalMode",provider,
                   provider_membership_id AS "providerEntitlementId",
                   created_at AS "createdAt",updated_at AS "updatedAt"`,
        [workspaceId, entitlementId, changes.status ?? null,
          Object.prototype.hasOwnProperty.call(changes, 'endsAt'), changes.endsAt ?? null,
          changes.renewalMode ?? null],
      )
      return result.rows[0] ?? null
    },

    async recordParticipation(params) {
      const existing = await client.query<DbRecord>(
        `SELECT id,event_id AS "eventId",attendee_contact_id AS "contactId",
                attendee_name AS "attendeeName",attendee_email AS "attendeeEmail",
                attendee_metadata AS metadata,status,source_kind AS "sourceKind",
                source_id AS "sourceId",request_fingerprint AS "requestFingerprint",
                checked_in_at AS "checkedInAt",
                created_at AS "createdAt",updated_at AS "updatedAt"
           FROM association_registrations
          WHERE workspace_id=$1 AND source_kind=$2 AND source_id=$3`,
        [workspaceId, params.sourceKind, params.sourceId],
      )
      if (existing.rows[0]) {
        if (existing.rows[0].requestFingerprint !== params.requestHash) {
          throw new CrmOperationsError(
            'idempotency_conflict',
            'Source identity was already used for different participation.',
          )
        }
        const { requestFingerprint: _ignored, ...record } = existing.rows[0]
        return { record, created: false }
      }
      const [contact, event] = await Promise.all([
        client.query(
          `SELECT 1 FROM entities
            WHERE workspace_id=$1 AND id=$2 AND kind='person'
              AND valid_to IS NULL AND retracted_at IS NULL`,
          [workspaceId, params.contactId],
        ),
        client.query(
          `SELECT 1 FROM association_events
            WHERE workspace_id=$1 AND id=$2`,
          [workspaceId, params.eventId],
        ),
      ])
      if (!contact.rowCount) throw new CrmOperationsError('not_found', 'CRM contact was not found.')
      if (!event.rowCount) throw new CrmOperationsError('not_found', 'CRM event was not found.')
      const result = await client.query<DbRecord>(
        `INSERT INTO association_registrations (
           workspace_id,event_id,attendee_contact_id,attendee_name,attendee_email,
           attendee_metadata,status,source_kind,source_id,request_fingerprint
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
         ON CONFLICT DO NOTHING
         RETURNING id,event_id AS "eventId",attendee_contact_id AS "contactId",
                   attendee_name AS "attendeeName",attendee_email AS "attendeeEmail",
                   attendee_metadata AS metadata,status,source_kind AS "sourceKind",
                   source_id AS "sourceId",checked_in_at AS "checkedInAt",
                   created_at AS "createdAt",updated_at AS "updatedAt"`,
        [workspaceId, params.eventId, params.contactId, params.attendeeName,
          params.attendeeEmail ?? null, JSON.stringify(params.metadata ?? {}), params.status,
          params.sourceKind, params.sourceId, params.requestHash],
      )
      if (!result.rows[0]) {
        const raced = await client.query<DbRecord>(
          `SELECT id,event_id AS "eventId",attendee_contact_id AS "contactId",
                  attendee_name AS "attendeeName",attendee_email AS "attendeeEmail",
                  attendee_metadata AS metadata,status,source_kind AS "sourceKind",
                  source_id AS "sourceId",request_fingerprint AS "requestFingerprint",
                  checked_in_at AS "checkedInAt",
                  created_at AS "createdAt",updated_at AS "updatedAt"
             FROM association_registrations
            WHERE workspace_id=$1 AND source_kind=$2 AND source_id=$3`,
          [workspaceId, params.sourceKind, params.sourceId],
        )
        if (!raced.rows[0]) {
          throw new CrmOperationsError('conflict', 'Participation could not be resolved after a concurrent record.')
        }
        if (raced.rows[0].requestFingerprint !== params.requestHash) {
          throw new CrmOperationsError(
            'idempotency_conflict',
            'Source identity was already used for different participation.',
          )
        }
        const { requestFingerprint: _ignored, ...record } = raced.rows[0]
        return { record, created: false }
      }
      return { record: first(result), created: true }
    },

    async updateParticipation(participationId, status) {
      const current = await client.query<{ status: string; sourceKind: string }>(
        `SELECT status, source_kind AS "sourceKind"
           FROM association_registrations
          WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
        [workspaceId, participationId],
      )
      const participation = current.rows[0]
      if (!participation) return null
      if (participation.sourceKind === 'commerce') {
        throw new CrmOperationsError(
          'conflict',
          'Commerce participation must be changed through Association order or registration operations.',
          { commerceManaged: true },
        )
      }
      if (!mayTransitionCrmParticipation(participation.status, status)) {
        throw new CrmOperationsError(
          'conflict',
          `Participation cannot transition from ${participation.status} to ${status}.`,
        )
      }
      const result = await client.query<DbRecord>(
        `UPDATE association_registrations
            SET status=$3,checked_in_at=CASE WHEN $3='attended'
              THEN COALESCE(checked_in_at,now()) ELSE checked_in_at END,updated_at=now()
          WHERE workspace_id=$1 AND id=$2
         RETURNING id,event_id AS "eventId",attendee_contact_id AS "contactId",
                   attendee_name AS "attendeeName",attendee_email AS "attendeeEmail",
                   attendee_metadata AS metadata,status,source_kind AS "sourceKind",
                   source_id AS "sourceId",checked_in_at AS "checkedInAt",
                   created_at AS "createdAt",updated_at AS "updatedAt"`,
        [workspaceId, participationId, status],
      )
      return result.rows[0] ?? null
    },

    async setDealPipelineStage(params) {
      const catalog = await client.query<DbRecord>(
        `SELECT p.id AS "pipelineId",p.name AS "pipelineName",
                p.id::text AS "pipelineKey",
                s.id AS "stageId",s.name AS "stageName",
                COALESCE(s.legacy_key,s.id::text) AS "stageKey",
                s.legacy_key AS "legacyStage",s.category,s.position,
                s.probability,s.required_fields AS "requiredFields"
           FROM crm_pipelines p
           JOIN crm_pipeline_stages s
             ON s.workspace_id=p.workspace_id AND s.pipeline_id=p.id
          WHERE p.workspace_id=$1 AND p.id=$2 AND s.id=$3
            AND p.archived_at IS NULL AND s.archived_at IS NULL`,
        [workspaceId, params.pipelineId, params.stageId],
      )
      const stage = catalog.rows[0]
      if (!stage) {
        const valid = await client.query<DbRecord>(
          `SELECT p.id AS "pipelineId",p.name AS "pipelineName",
                  s.id AS "stageId",s.name AS "stageName"
             FROM crm_pipelines p
             JOIN crm_pipeline_stages s
               ON s.workspace_id=p.workspace_id AND s.pipeline_id=p.id
            WHERE p.workspace_id=$1 AND p.archived_at IS NULL
              AND s.archived_at IS NULL
            ORDER BY p.position,s.position,p.id,s.id LIMIT 100`,
          [workspaceId],
        )
        throw new CrmOperationsError(
          'catalog_key_invalid',
          'Pipeline and stage must identify the same live workspace catalog entry.',
          { validValues: valid.rows },
        )
      }
      const current = await client.query<DbRecord>(
        `SELECT id,display_name AS name,attributes,
                created_at AS "createdAt",updated_at AS "updatedAt"
           FROM entities
          WHERE workspace_id=$1 AND id=$2 AND kind='deal'
            AND valid_to IS NULL AND retracted_at IS NULL FOR UPDATE`,
        [workspaceId, params.dealId],
      )
      const deal = current.rows[0]
      if (!deal) return null
      const custom = deal.attributes.custom_fields
      const customFields = custom && typeof custom === 'object' && !Array.isArray(custom)
        ? custom as Record<string, unknown> : {}
      const requiredFields = Array.isArray(stage.requiredFields)
        ? stage.requiredFields.filter((value): value is string => typeof value === 'string') : []
      const missing = requiredFields.filter((key) => {
        const value = Object.prototype.hasOwnProperty.call(deal.attributes, key)
          ? deal.attributes[key] : customFields[key]
        return value === null || value === undefined || value === ''
      })
      if (missing.length > 0) {
        throw new CrmOperationsError(
          'invalid_transition',
          'Required deal fields must be completed before moving to this stage.',
          { missingFields: missing },
        )
      }
      if (deal.attributes.pipeline_id === params.pipelineId
        && deal.attributes.pipeline_stage_id === params.stageId) {
        return { ...deal, pipeline: stage, unchanged: true }
      }
      const legacyStage = stage.legacyStage
        ?? (stage.category === 'won' ? 'won' : stage.category === 'lost' ? 'lost' : 'lead')
      const updated = await client.query<DbRecord>(
        `UPDATE entities
            SET attributes=attributes || jsonb_build_object(
                  'pipeline_id',$3::text,'pipeline_stage_id',$4::text,
                  'stage',COALESCE($5::text,attributes->>'stage')),
                updated_at=now()
          WHERE workspace_id=$1 AND id=$2 AND kind='deal'
            AND valid_to IS NULL AND retracted_at IS NULL
         RETURNING id,display_name AS name,attributes,
                   created_at AS "createdAt",updated_at AS "updatedAt"`,
        [workspaceId, params.dealId, params.pipelineId, params.stageId, legacyStage],
      )
      const updatedDeal = updated.rows[0]
      if (!updatedDeal) return null
      await client.query(
        `INSERT INTO crm_activities (
           workspace_id,entity_id,activity_type,direction,summary,source_kind,
           source_id,actor_user_id,actor_assistant_id,metadata
         ) VALUES ($1,$2,'stage_change','internal',$3,'crm_operation',$4,$5,$6,$7::jsonb)`,
        [workspaceId, params.dealId, `Moved deal to ${String(stage.stageName)}`,
          `${params.pipelineId}:${params.stageId}:${Date.now()}`,
          params.actorUserId, params.actorAssistantId,
          JSON.stringify({
            fromPipelineId: deal.attributes.pipeline_id ?? null,
            fromStageId: deal.attributes.pipeline_stage_id ?? null,
            pipelineId: params.pipelineId, stageId: params.stageId,
          })],
      )
      return { ...updatedDeal, pipeline: stage }
    },

    async appendDomainAudit(params) {
      const result = await client.query<{ id: string }>(
        `INSERT INTO association_audit_log (
           workspace_id,action,subject_kind,subject_id,actor_kind,
           actor_credential_id,acting_user_id,metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id`,
        [workspaceId, params.action, params.subjectKind, params.subjectId,
          params.actor.actorKind, params.actor.actorCredentialId,
          params.actor.actingUserId, JSON.stringify(params.metadata ?? {})],
      )
      return result.rows[0]!.id
    },

    async appendWorkspaceAudit(params) {
      const result = await client.query<{ id: string }>(
        `INSERT INTO workspace_audit_log (
           workspace_id,actor_user_id,event_type,subject_id,details
         ) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`,
        [workspaceId, params.actorUserId, params.eventType, params.subjectId,
          JSON.stringify(params.details ?? {})],
      )
      return result.rows[0]!.id
    },

    async emitDomainEvent(params) {
      const result = await client.query<{ id: string }>(
        `INSERT INTO crm_domain_event_outbox (
           workspace_id,event_type,event_key,subject_kind,subject_id,payload,
           actor_kind,occurred_at
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
         ON CONFLICT (workspace_id,event_key) DO UPDATE SET event_key=EXCLUDED.event_key
         RETURNING id`,
        [workspaceId, params.eventType, params.eventKey, params.subjectKind,
          params.subjectId, JSON.stringify(params.payload), params.actor.kind,
          params.occurredAt],
      )
      return result.rows[0]!.id
    },
  }
}

export function createDbCrmOperationsStore(pool: Pool = getPool()): CrmOperationsStore {
  return {
    async transaction(context, fn) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(`SELECT set_config('app.system_bypass', 'true', true)`)
        const result = await fn(createTransaction(client, context))
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
  }
}

export function crmOperationsActorAssistantId(actor: CrmOperationsActor): string | null {
  return actorAssistantId(actor)
}
