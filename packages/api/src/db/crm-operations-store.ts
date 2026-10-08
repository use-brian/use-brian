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
  deriveResourceScope,
  CrmLocaleWordingsSchema,
  crmOperationsSha256,
  mayTransitionCrmEntitlement,
  mayTransitionCrmParticipation,
  type CrmIntakeDefinitionVersionInput,
  type CrmIntakeAttachmentPolicy,
  type PreparedCrmSubmissionAttachment,
  type ImportHistoricalCrmSubmission,
  type CrmOperationsActor,
  type CrmOperationsContext,
  type CrmSegmentCatalog,
  type CrmSegmentPredicate,
  type AccessContext,
} from '@use-brian/core'
import { getPool } from './client.js'
import { associationProviderInheritance, associationCheckoutInheritance, assertAssociationCheckoutParent, admitAssociationSourceScope, beginAssociationCreation, assertAssociationOrderAuthority, loadAssociationOrderScope } from '../association/source-scope.js'
import type { AssociationActor } from '@use-brian/core'
import { readCrmPrivacyPolicy, saveCrmPrivacyPolicy } from '../crm-operations/privacy-policy.js'
import { releaseCrmAddressSuppression } from '../crm-operations/suppression-tombstones.js'
import { saveCrmManagedMailboxPolicy, saveCrmMailboxIntegrationGrant } from '../crm-operations/delivery-policy.js'
import { saveCrmEntitlementPlanRecord, saveCrmEventRecord } from './crm-catalog-records.js'
import { prepareProviderEntitlementPeriod, requireProviderEntitlementActor } from '../crm-operations/entitlement-periods.js'
import { actorAuditIdentity, isUnverifiedIdentityPolicy } from '@use-brian/core'
import { lockAssociationInventory, refreshAssociationInventory } from '../association/inventory.js'
import type { PlanInput, EventInput } from '../association/domain.js'
import { authorizeCrmIntegrationCommand } from '../crm-operations/integration-authority.js'
import type { CrmOperationsCommand } from '@use-brian/core'
import { loadCrmSegmentCatalog } from './crm-segment-store.js'
import { crmEvidenceRequestHash, resolveCrmEvidenceReplay, type CrmEvidenceRequest } from '../crm-operations/evidence-replay.js'
import { executeCrmConfigCommand } from './crm-config-commands.js'
import type { CrmConfigCommand } from '@use-brian/core'
import { readCrmMutationSource } from './crm.js'
import { updateEntity } from './entities-store.js'
import { currentAgentAccess, runWithAgentAccess } from './agent-access-context.js'
import { admitCrmIntegrationBinding } from '../crm-operations/integration-department-authority.js'
import { readCrmIntakeAuthority } from '../crm-operations/intake-department-authority.js'
import { lockCrmIntegrationCredential } from './crm-integration-store.js'
import { admitWorkspaceResource } from '../workspace-access/resource-admission.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'
import { mutationActorAccess } from './access-predicate.js'

/** A command role or credential author is not a resource principal. */
async function stageActorAccess(client: PoolClient, context: CrmOperationsContext): Promise<AccessContext> {
  const denied = () => Object.assign(new Error('This operation requires a verifiable current resource scope.'), { code: 'scope_operation_denied' })
  const actor = context.actor
  if (!['user', 'import', 'assistant', 'workflow'].includes(actor.kind)
    || !('userId' in actor) || !actor.userId || !context.authority.canWrite) throw denied()
  const access = mutationActorAccess(actor.userId, context.workspaceId)
  const member = await client.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE', [context.workspaceId, actor.userId])
  if (!member.rowCount) throw denied()
  if (actor.kind === 'assistant' || actor.kind === 'workflow') {
    const scope = currentAgentAccess()
    if (!scope || scope.workspaceId !== context.workspaceId || scope.userId !== actor.userId
      || scope.compartments === undefined || scope.mutationCompartments === undefined
      || scope.projectIds === undefined || scope.visibilityAssistantIds === undefined) throw denied()
    Object.assign(access, scope)
    if (actor.kind === 'assistant') {
      const assistant = await client.query<{ kind: AccessContext['assistantKind']; clearance: AccessContext['clearance'] }>(
        'SELECT kind,clearance FROM assistants WHERE workspace_id=$1 AND id=$2 FOR SHARE', [context.workspaceId, actor.assistantId])
      if (!assistant.rows[0] || (scope.visibilityAssistantIds !== null && !scope.visibilityAssistantIds.includes(actor.assistantId))) throw denied()
      access.assistantId = actor.assistantId
      access.assistantKind = assistant.rows[0].kind
      // The predicate intersects this current ceiling with the retained turn ceiling.
      access.clearance = assistant.rows[0].clearance
    }
  }
  return access
}

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
  attachments: CrmIntakeAttachmentPolicy[]
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
  verificationAcknowledgedByUserId?: string | null
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
  | { kind: 'retired'; claimId: string }
  | {
    kind: 'duplicate'
    claimId: string
    submissionId: string
    contactId: string
    followUpTaskId: string | null
  }
  | { kind: 'conflict'; claimId: string; storedHash: string }

export type CrmOperationsTransaction = {
  configureCatalog(command: CrmConfigCommand): ReturnType<typeof executeCrmConfigCommand>
  savePrivacyPolicy(command: Extract<CrmOperationsCommand, { kind: 'save_privacy_policy' }>): ReturnType<typeof saveCrmPrivacyPolicy>
  releaseAddressSuppression(command: Extract<CrmOperationsCommand, { kind: 'release_address_suppression' }>): ReturnType<typeof releaseCrmAddressSuppression>
  saveMailboxIntegrationGrant(command: Extract<CrmOperationsCommand, {kind:'save_mailbox_integration_grant'}>): ReturnType<typeof saveCrmMailboxIntegrationGrant>
  saveManagedMailboxPolicy(command: Extract<CrmOperationsCommand, { kind: 'save_managed_mailbox_policy' }>): ReturnType<typeof saveCrmManagedMailboxPolicy>
  authorizeIntegration(command: CrmOperationsCommand): Promise<void>
  saveEntitlementPlan(input: PlanInput): Promise<{ record: CrmOperationsRecord; created: boolean }>
  saveEvent(input: EventInput): Promise<{ record: CrmOperationsRecord; created: boolean }>
  getIntakeDefinition(definitionKey: string): Promise<StoredIntakeDefinition | null>
  intakeCredentialReplayScope(credentialId: string, definitionId: string): Promise<string | null>
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
  enqueueCampaignConversion(params: {
    sitePublicId: string
    externalOutcomeId: string
    occurredAt: string
    contactId: string
    attribution: Record<string, unknown>
    test: boolean
  }): Promise<void>
  resolveExternalIdentity(provider: string, subject: string): Promise<string | null>
  findContactByEmail(email: string): Promise<string | null>
  resolveAttributionUser(preferredUserId?: string | null): Promise<string | null>
  createContact(input: ContactWrite, attribution: {
    createdByUserId: string
    createdByAssistantId: string | null
  }): Promise<CrmOperationsRecord>
  updateContact(contactId: string, input: ContactWrite): Promise<CrmOperationsRecord>
  /** Unverified claims (`existing_or_new`): set only what the contact lacks. A
   *  populated name, phone or custom field is never replaced; tags are added. */
  fillContactGaps(contactId: string, input: ContactWrite): Promise<CrmOperationsRecord>
  bindExternalIdentity(contactId: string, provider: string, subject: string): Promise<void>
  createSubmission(params: {
    definition: StoredIntakeDefinition
    contactId: string
    sourceSubmissionId: string
    requestHash: string
    fields: Record<string, unknown>
    submittedAt: string
    identityVerificationEvidence?: Record<string, unknown> | null
  }): Promise<CrmOperationsRecord>
  createSubmissionAttachments(
    submissionId: string,
    attachments: readonly PreparedCrmSubmissionAttachment[],
  ): Promise<void>
  importHistoricalSubmission(params: ImportHistoricalCrmSubmission & {
    requestFingerprint: string
  }): Promise<{ record: CrmOperationsRecord; created: boolean }>
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
    submissionId?: string
    contactId: string
    purpose: CrmOperationsRecord | null
    purposeKey: string
    locale?: 'en' | 'zh' | 'zh-CN' | 'ja'
    action: 'granted' | 'withdrawn'
    source: string
    occurredAt: string
    requestedOccurredAt?: string
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
    requestedOccurredAt?: string
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
    rotateFromCredentialId?: string
    credentialId: string
    label: string
    definitionIds: string[]
    secretPrefix: string
    secretHash: string
    createdByUserId: string | null
    departmentBinding?: Extract<CrmOperationsCommand, { kind: 'create_intake_credential' }>['departmentBinding']
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
    defaultLocale: string | null
    localeWordings: Record<string, string>
    localeWordingHashes: Record<string, string>
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
  expireDueEntitlement(entitlementId:string):Promise<CrmOperationsRecord|null>
  updateEntitlement(entitlementId: string, changes: CrmOperationsRecord): Promise<CrmOperationsRecord | null>
  recordParticipation(params: CrmOperationsRecord): Promise<{ record: CrmOperationsRecord; created: boolean }>
  updateParticipation(participationId: string, status: string): Promise<CrmOperationsRecord | null>
  correctParticipationCheckIn(participationId: string, expectedStatus: 'attended'): Promise<CrmOperationsRecord | null>
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
  const identity = actorAuditIdentity(context.actor)
  const operationalActor: AssociationActor = { credentialKind: context.actor.kind, credentialId: identity.actorCredentialId,
    ...(identity.actingUserId ? { actingUserId: identity.actingUserId } : {}),
    ...(context.authority.integration ? { integration: context.authority.integration } : {}) }
  const departmentV2 = async () => (await client.query('SELECT department_read_v2 FROM workspaces WHERE id=$1', [workspaceId])).rows[0]?.department_read_v2 === true
  const resourceUser = () => {
    const actor = context.actor, ambient = currentAgentAccess()
    const userId = 'userId' in actor ? actor.userId : ambient?.departmentRead?.userId
    if (!userId || !context.authority.canWrite || (ambient?.workspaceId && ambient.workspaceId !== workspaceId)
      || (ambient?.userId && ambient.userId !== userId)
      || (!['user','import'].includes(actor.kind) && !ambient?.departmentRead)) {
      throw new CrmOperationsError('not_authorized', 'Current contact authority is unavailable.')
    }
    return userId
  }
  const admitContactMutation = async (contactId: string) => {
    if (!await departmentV2()) return
    const source = await readCrmMutationSource(mutationActorAccess(resourceUser(), workspaceId), contactId, ['person'], client)
    if (!source) throw new CrmOperationsError('not_authorized', 'The contact is unavailable in this scope.')
  }
  return {
    configureCatalog: (command) => executeCrmConfigCommand(client, context, command),
    savePrivacyPolicy: (command) => saveCrmPrivacyPolicy(client, context, command),
    releaseAddressSuppression: (command) => releaseCrmAddressSuppression(client, context, command),
    saveMailboxIntegrationGrant: (command) => saveCrmMailboxIntegrationGrant(client,context,command),
    saveManagedMailboxPolicy: (command) => saveCrmManagedMailboxPolicy(client, context, command),
    authorizeIntegration: (command) => authorizeCrmIntegrationCommand(client, context, command),
    saveEntitlementPlan: (input) => saveCrmEntitlementPlanRecord(client, workspaceId, input),
    saveEvent: (input) => saveCrmEventRecord(client, workspaceId, input, context.actor.kind),
    async getIntakeDefinition(definitionKey) {
      const result = await client.query<DbRecord>(
        `SELECT d.id, d.workspace_id AS "workspaceId", d.definition_key AS "definitionKey",
                d.label, d.active, d.current_version AS "currentVersion",
                v.id AS "versionId", v.field_catalog AS fields,
                COALESCE(v.schema_snapshot->'attachments','[]'::jsonb) AS attachments,
                v.identity_policy AS "identityPolicy",
                v.allowed_identity_provider AS "allowedIdentityProvider",
                v.consent_mappings AS "consentMappings", v.queue_key AS "queueKey",
                v.owner_user_id AS "ownerUserId",
                v.follow_up_task_template AS "followUpTaskTemplate",
                v.follow_up_due_minutes AS "followUpDueMinutes",
                v.max_payload_bytes AS "maxPayloadBytes", v.schema_hash AS "schemaHash",
                v.schema_snapshot AS "schemaSnapshot",
                v.created_by_user_id AS "verificationAcknowledgedByUserId",
                d.created_by_user_id AS "createdByUserId"
           FROM crm_intake_definitions d
           JOIN crm_intake_definition_versions v
             ON v.workspace_id = d.workspace_id AND v.definition_id = d.id
            AND v.version = d.current_version
          WHERE d.workspace_id = $1 AND d.definition_key = $2 FOR SHARE OF d`,
        [workspaceId, definitionKey],
      )
      return (result.rows[0] as StoredIntakeDefinition | undefined) ?? null
    },

    async intakeCredentialReplayScope(credentialId, definitionId) {
      return (await readCrmIntakeAuthority(client, workspaceId, credentialId, definitionId, true)).replayScopeId
    },

    async claimIdempotency(params) {
      // Serialize reuse of a retired namespace slot. Lock an existing receipt
      // before inspecting expiry so retention cannot delete it between reads.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        JSON.stringify(['crm-intake-replay', workspaceId, params.actorScope, params.definitionId, params.idempotencyKey]),
      ])
      for (let attempt = 0; attempt < 2; attempt++) {
        const existing = await client.query<DbRecord>(
          `SELECT id, request_hash AS "requestHash", status,
                  submission_id AS "submissionId", contact_id AS "contactId",
                  follow_up_task_id AS "followUpTaskId",
                  replay_expires_at<=clock_timestamp() AS expired
             FROM crm_intake_idempotency
            WHERE workspace_id=$1 AND actor_scope=$2 AND definition_id=$3 AND idempotency_key=$4
            FOR UPDATE`,
          [workspaceId, params.actorScope, params.definitionId, params.idempotencyKey],
        )
        const row = existing.rows[0]
        if (row?.status === 'retired' && row.expired === true) {
          await client.query('DELETE FROM crm_intake_idempotency WHERE workspace_id=$1 AND id=$2', [workspaceId, row.id])
        } else if (row) {
          if (row.requestHash !== params.requestHash || !['committed', 'retired'].includes(String(row.status))) {
            return { kind: 'conflict', claimId: String(row.id), storedHash: String(row.requestHash) }
          }
          if (row.status === 'retired') return { kind: 'retired', claimId: row.id as string }
          await assertAssociationOrderAuthority(client, workspaceId, row.submissionId as string, operationalActor, 'submission')
          return { kind: 'duplicate', claimId: row.id as string, submissionId: row.submissionId as string,
            contactId: row.contactId as string, followUpTaskId: (row.followUpTaskId as string | null) ?? null }
        }
        const policy = await readCrmPrivacyPolicy(workspaceId, client)
        const seconds = policy.policy.intakeReplay?.retentionSeconds ?? null
        const inserted = await client.query<DbRecord>(
          `INSERT INTO crm_intake_idempotency (
             workspace_id,credential_id,actor_scope,definition_id,idempotency_key,request_hash,
             replay_policy_version,replay_expires_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,now()+$8::integer*interval '1 second')
           ON CONFLICT (workspace_id,actor_scope,definition_id,idempotency_key) DO NOTHING RETURNING id`,
          [workspaceId, params.credentialId, params.actorScope, params.definitionId,
            params.idempotencyKey, params.requestHash, seconds === null ? null : policy.version, seconds],
        )
        if (inserted.rows[0]) return { kind: 'claimed', claimId: inserted.rows[0].id as string }
        // A pre-migration process may still claim without the advisory lock.
        // Re-read its committed receipt once; never create a second result.
      }
      throw new CrmOperationsError('conflict', 'Intake receipt changed concurrently. Retry the same request.')
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

    async enqueueCampaignConversion(params) {
      const site = await client.query<{ id: string }>(
        `SELECT id FROM campaign_sites
          WHERE workspace_id=$1 AND public_id=$2 AND enabled=true FOR SHARE`,
        [workspaceId, params.sitePublicId],
      )
      if (!site.rows[0]) {
        throw new CrmOperationsError('not_found', 'The campaign site is unavailable.')
      }
      const payload = {
        version: 1,
        siteId: params.sitePublicId,
        conversionKind: 'enquiry_submitted',
        externalOutcomeId: params.externalOutcomeId,
        occurredAt: params.occurredAt,
        attribution: params.attribution,
        contactId: params.contactId,
        test: params.test,
      }
      const payloadHash = crmOperationsSha256(payload)
      const inserted = await client.query<{ payloadHash: string }>(
        `INSERT INTO campaign_conversion_outbox
           (workspace_id,site_id,outcome_kind,external_outcome_id,payload,payload_hash)
         VALUES($1,$2,'enquiry_submitted',$3,$4::jsonb,$5)
         ON CONFLICT(workspace_id,site_id,outcome_kind,external_outcome_id) DO NOTHING
         RETURNING payload_hash AS "payloadHash"`,
        [workspaceId, site.rows[0].id, params.externalOutcomeId, JSON.stringify(payload), payloadHash],
      )
      if (inserted.rows[0]) return
      const existing = await client.query<{ payloadHash: string }>(
        `SELECT payload_hash AS "payloadHash" FROM campaign_conversion_outbox
          WHERE workspace_id=$1 AND site_id=$2 AND outcome_kind='enquiry_submitted' AND external_outcome_id=$3`,
        [workspaceId, site.rows[0].id, params.externalOutcomeId],
      )
      if (existing.rows[0]?.payloadHash !== payloadHash) {
        throw new CrmOperationsError('idempotency_conflict', 'Campaign conversion projection identity was reused with changed evidence.')
      }
    },

    async resolveExternalIdentity(provider, subject) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        JSON.stringify(['crm-intake-identity', workspaceId, 'external_subject', provider, subject]),
      ])
      const result = await client.query<{ contactId: string; isLive: boolean }>(
        `SELECT i.contact_id AS "contactId",
                (e.kind='person' AND e.valid_to IS NULL AND e.retracted_at IS NULL
                  AND NOT (e.attributes ? 'crm_archived_at')) AS "isLive"
           FROM association_external_identities i
           JOIN entities e ON e.workspace_id=i.workspace_id AND e.id=i.contact_id
          WHERE i.workspace_id=$1 AND i.provider=$2 AND i.provider_subject=$3`,
        [workspaceId, provider, subject],
      )
      const row = result.rows[0]
      if (row) await admitContactMutation(row.contactId)
      if (row && !row.isLive) throw new CrmOperationsError('conflict', 'The identity binding requires contact review.', { reason: 'identity_review_required' })
      return row?.contactId ?? null
    },

    async findContactByEmail(email) {
      const normalized = email.trim().toLowerCase()
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        JSON.stringify(['crm-intake-identity', workspaceId, 'email', normalized]),
      ])
      const result = await client.query<{ id: string }>(
        `SELECT id FROM entities
          WHERE workspace_id = $1 AND kind = 'person' AND valid_to IS NULL
            AND retracted_at IS NULL AND NOT (attributes ? 'crm_archived_at')
            AND lower(btrim(COALESCE(NULLIF(btrim(attributes->>'email'),''),canonical_id,'')))=$2
          ORDER BY created_at,id LIMIT 2`,
        [workspaceId, normalized],
      )
      for (const row of result.rows) await admitContactMutation(row.id)
      if (result.rows.length > 1) throw new CrmOperationsError('conflict', 'Multiple live contacts match this email; review is required.', { reason: 'identity_review_required' })
      return result.rows[0]?.id ?? null
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
      const v2 = await departmentV2()
      const binding = ['intake_key','integration_key'].includes(context.actor.kind) ? currentAgentAccess()?.departmentRead?.binding : null
      const admitted = v2 ? await admitWorkspaceResource(client, workspaceId, resourceUser(), {
        visibility: 'workspace', sensitivity: 'internal', writerKind: 'entity', rowVisibility: { userId: null, assistantId: null },
        ...(binding?.length === 0 ? { destination: { kind: 'general' as const } }
          : binding ? { requestedLabels: { compartments: binding.map(id => `team:${id}`) } } : {}),
      }) : null
      const result = await client.query<DbRecord>(
        `INSERT INTO entities (
           kind, display_name, canonical_id, attributes, sensitivity,
           workspace_id, user_id, created_by_user_id, created_by_assistant_id,
           source, compartments, project_ids
         ) VALUES ('person',$1,$2,$3::jsonb,$7,$4,$8,$5,$6,'user',$9,$10)
         RETURNING id, workspace_id AS "workspaceId", display_name AS name,
                   canonical_id AS email, attributes, created_at AS "createdAt",
                   updated_at AS "updatedAt"`,
        [input.name, input.email, JSON.stringify({
          ...(input.email ? { email: input.email } : {}),
          ...(input.phone ? { phone: input.phone } : {}),
          tags: input.tags,
          custom_fields: input.customFields,
        }), workspaceId, attribution.createdByUserId, attribution.createdByAssistantId,
          admitted?.envelope.sensitivity ?? 'internal', v2 ? null : attribution.createdByUserId,
          admitted?.envelope.compartments ?? [], admitted?.envelope.projectIds ?? []],
      )
      return first(result)
    },

    async updateContact(contactId, input) {
      await admitContactMutation(contactId)
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

    async fillContactGaps(contactId, input) {
      await admitContactMutation(contactId)
      const result = await client.query<DbRecord>(
        `UPDATE entities
            SET display_name = CASE
                  WHEN NULLIF(btrim(display_name),'') IS NULL
                    OR lower(btrim(display_name)) = lower(btrim(COALESCE(NULLIF(btrim(attributes->>'email'),''),canonical_id,'')))
                  THEN COALESCE(NULLIF(btrim($3),''), display_name)
                  ELSE display_name END,
                attributes = attributes
                  || CASE WHEN NULLIF(btrim(attributes->>'phone'),'') IS NULL AND NULLIF(btrim($4),'') IS NOT NULL
                       THEN jsonb_build_object('phone',$4::text) ELSE '{}'::jsonb END
                  || CASE WHEN cardinality($5::text[]) > 0
                       THEN jsonb_build_object('tags', (
                         SELECT jsonb_agg(tag ORDER BY position)
                           FROM (SELECT tag, min(position) AS position FROM (
                                   SELECT value AS tag, ordinality AS position
                                     FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(attributes->'tags')='array' THEN attributes->'tags' ELSE '[]'::jsonb END)
                                          WITH ORDINALITY
                                   UNION ALL
                                   SELECT tag, 1000000 + position FROM unnest($5::text[]) WITH ORDINALITY AS added(tag, position)
                                 ) merged GROUP BY tag) ordered))
                       ELSE '{}'::jsonb END
                  || CASE WHEN $6::jsonb <> '{}'::jsonb
                       THEN jsonb_build_object('custom_fields', $6::jsonb
                         || CASE WHEN jsonb_typeof(attributes->'custom_fields')='object' THEN attributes->'custom_fields' ELSE '{}'::jsonb END)
                       ELSE '{}'::jsonb END,
                updated_at = now()
          WHERE workspace_id = $1 AND id = $2 AND kind = 'person'
            AND valid_to IS NULL AND retracted_at IS NULL
         RETURNING id, workspace_id AS "workspaceId", display_name AS name,
                   canonical_id AS email, attributes, created_at AS "createdAt",
                   updated_at AS "updatedAt"`,
        [workspaceId, contactId, input.name, input.phone, input.tags, JSON.stringify(input.customFields)],
      )
      if (!result.rows[0]) throw new Error('crm contact not found in workspace')
      return first(result)
    },

    async bindExternalIdentity(contactId, provider, subject) {
      await admitContactMutation(contactId)
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
      const evidence = await departmentV2() ? await admitAssociationSourceScope(client, workspaceId, operationalActor,
        await loadAssociationOrderScope(client, workspaceId, [params.contactId])) : null
      const result = await client.query<DbRecord>(
        `INSERT INTO association_enquiries (
           workspace_id, contact_id, source, source_submission_id,
           request_fingerprint, subject, message, submitted_data, status,
           queue_key, owner_user_id, submitted_at, definition_id,
           definition_version_id, definition_schema_hash,
           definition_schema_snapshot, identity_verification_evidence,scope_snapshot,scope_sources
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'new',$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb)
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
          JSON.stringify(params.definition.schemaSnapshot),
          params.identityVerificationEvidence ? JSON.stringify(params.identityVerificationEvidence) : null,
          evidence ? JSON.stringify(evidence.scope) : null, evidence ? JSON.stringify(evidence.sources) : null],
      )
      return first(result)
    },

    async createSubmissionAttachments(submissionId, attachments) {
      await assertAssociationOrderAuthority(client, workspaceId, submissionId, operationalActor, 'submission')
      for (const attachment of attachments) {
        await client.query(
          `INSERT INTO association_submission_attachments(
             workspace_id,submission_id,attachment_key,original_name,mime_type,
             content_bytes,size_bytes,sha256
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [workspaceId, submissionId, attachment.key, attachment.originalName,
            attachment.mimeType, attachment.contentBytes, attachment.sizeBytes, attachment.sha256],
        )
      }
    },

    async importHistoricalSubmission(params) {
      const evidence = await departmentV2() ? await admitAssociationSourceScope(client, workspaceId, operationalActor,
        await loadAssociationOrderScope(client, workspaceId, [params.contactId])) : null
      const submittedData = {
        historicalSource: {
          source: params.source,
          site: params.sourceSite,
          form: params.sourceForm,
          submissionId: params.sourceSubmissionId,
        },
        originalData: params.fields,
      }
      const inserted = await client.query<DbRecord>(
        `INSERT INTO association_enquiries (
           workspace_id,contact_id,source,source_site,source_form,source_submission_id,
           request_fingerprint,subject,message,submitted_data,status,queue_key,
           submitted_at,historical_import,scope_snapshot,scope_sources
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,true,$14::jsonb,$15::jsonb)
         ON CONFLICT DO NOTHING
         RETURNING id,workspace_id AS "workspaceId",contact_id AS "contactId",
           source,source_site AS "sourceSite",source_form AS "sourceForm",
           source_submission_id AS "sourceSubmissionId",status,queue_key AS "queueKey",
           submitted_at AS "submittedAt",historical_import AS "historicalImport",
           created_at AS "createdAt",updated_at AS "updatedAt"`,
        [workspaceId, params.contactId, params.source, params.sourceSite,
          params.sourceForm, params.sourceSubmissionId, params.requestFingerprint,
          params.subject, params.message, JSON.stringify(submittedData), params.status,
          params.queueKey, params.submittedAt, evidence ? JSON.stringify(evidence.scope) : null,
          evidence ? JSON.stringify(evidence.sources) : null],
      )
      if (inserted.rows[0]) return { record: inserted.rows[0], created: true }
      const existing = await client.query<DbRecord & { requestFingerprint: string }>(
        `SELECT id,workspace_id AS "workspaceId",contact_id AS "contactId",
           source,source_site AS "sourceSite",source_form AS "sourceForm",
           source_submission_id AS "sourceSubmissionId",request_fingerprint AS "requestFingerprint",
           status,queue_key AS "queueKey",submitted_at AS "submittedAt",
           historical_import AS "historicalImport",created_at AS "createdAt",updated_at AS "updatedAt"
         FROM association_enquiries
         WHERE workspace_id=$1 AND source=$2 AND source_site=$3
           AND source_form=$4 AND source_submission_id=$5 FOR UPDATE`,
        [workspaceId, params.source, params.sourceSite, params.sourceForm, params.sourceSubmissionId],
      )
      if (!existing.rows[0]) throw new Error('Historical submission identity could not be claimed.')
      await assertAssociationOrderAuthority(client, workspaceId, String(existing.rows[0].id), operationalActor, 'submission')
      if (existing.rows[0].requestFingerprint !== params.requestFingerprint) {
        throw new CrmOperationsError('idempotency_conflict', 'Historical submission identity was already used with different evidence.')
      }
      const { requestFingerprint: _requestFingerprint, ...record } = existing.rows[0]
      return { record, created: false }
    },

    async createFollowUpTask(params) {
      const submission = await assertAssociationOrderAuthority(client, workspaceId, params.submissionId, operationalActor, 'submission')
      const scope = await departmentV2() ? (await admitAssociationSourceScope(client, workspaceId, operationalActor,
        submission ?? await loadAssociationOrderScope(client, workspaceId, [params.contactId]))).scope : null
      if (scope) await admitWorkspaceResource(client, workspaceId, resourceUser(), {
        visibility: scope.userId ? 'private' : 'workspace', sensitivity: scope.sensitivity,
        inherited: { ...scope, visibility: scope.userId ? 'private' : 'workspace' }, inheritedAuthority: 'read',
        writerKind: 'task', rowVisibility: { userId: scope.userId, assistantId: scope.assistantId },
      })
      const result = await client.query<DbRecord>(
        `INSERT INTO tasks (
           workspace_id, title, status, assignee_id, due, tags, attributes,
           created_by_user_id, created_by_assistant_id, source,
           sensitivity,compartments,project_ids,user_id,assistant_id
         ) VALUES ($1,$2,'todo',$3,$4,$5,$6::jsonb,$7,$8,'user',$9,$10,$11,$12,$13)
         RETURNING id, workspace_id AS "workspaceId", title, status,
                   assignee_id AS "assigneeId", due, tags,
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [workspaceId, params.title, params.assigneeId, params.due, params.tags,
          JSON.stringify({
            description: params.description,
            priority: params.priority,
            crm_contact_id: params.contactId,
            crm_submission_id: params.submissionId,
          }), params.createdByUserId, params.createdByAssistantId, scope?.sensitivity ?? 'internal',
          scope?.compartments ?? [], scope?.projectIds ?? [], scope?.userId ?? null, scope?.assistantId ?? null],
      )
      return first(result)
    },

    async attachFollowUpTask(submissionId, taskId) {
      await assertAssociationOrderAuthority(client, workspaceId, submissionId, operationalActor, 'submission')
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
                default_locale AS "defaultLocale",locale_wordings AS "localeWordings",
                locale_wording_hashes AS "localeWordingHashes",
                (SELECT v.id FROM crm_consent_purpose_versions v
                  WHERE v.workspace_id=crm_consent_purposes.workspace_id AND v.purpose_id=crm_consent_purposes.id
                    AND v.version=crm_consent_purposes.active_wording_version) AS "wordingVersionId",
                archived_at AS "archivedAt"
           FROM crm_consent_purposes
          WHERE workspace_id = $1 AND purpose_key = $2`,
        [workspaceId, purposeKey],
      )
      return result.rows[0] ?? null
    },

    async appendConsent(params) {
      const savedSubmission = params.submissionId ? await assertAssociationOrderAuthority(client, workspaceId, params.submissionId, operationalActor, 'submission') : null
      const evidence = await departmentV2() ? await admitAssociationSourceScope(client, workspaceId, operationalActor,
        savedSubmission ?? await loadAssociationOrderScope(client, workspaceId, [params.contactId])) : null
      const request: CrmEvidenceRequest = { kind: 'consent', contactId: params.contactId,
        purposeKey: params.purposeKey, action: params.action, source: params.source,
        locale: params.locale,
        occurredAt: params.requestedOccurredAt, metadata: params.metadata }
      const select = `id, contact_id AS "contactId", purpose, action,
        wording_version AS "wordingVersion", wording_hash AS "wordingHash",
        wording_snapshot AS wording, source, occurred_at AS "occurredAt",
        wording_version_id AS "wordingVersionId",wording_locale AS "wordingLocale",
        provider, provider_event_id AS "providerEventId", metadata, created_at AS "createdAt"`
      const replay = () => client.query<DbRecord>(
        `SELECT ${select}, request_fingerprint AS "__requestHash",
                to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "__occurredAt"
           FROM association_consent_events
          WHERE workspace_id=$1 AND provider=$2 AND provider_event_id=$3`,
        [workspaceId, params.provider, params.providerEventId],
      )
      if (params.provider && params.providerEventId) {
        const existing = await replay()
        if (existing.rows[0]) {
          await assertAssociationOrderAuthority(client, workspaceId, String(existing.rows[0].id), operationalActor, 'consent')
          return { record: resolveCrmEvidenceReplay(existing.rows[0], request), created: false }
        }
      }
      const purpose = params.purpose
      if (!purpose || purpose.archivedAt || purpose.purposeKey !== params.purposeKey) {
        throw new CrmOperationsError('catalog_key_invalid', 'Consent purpose is unavailable.', { purposeKey: params.purposeKey })
      }
      const locales = CrmLocaleWordingsSchema.parse(purpose.localeWordings ?? {})
      const localized = params.locale ? locales[params.locale] : undefined
      const wording = localized ?? purpose.wording
      const wordingLocale = localized ? params.locale : purpose.defaultLocale ?? null
      const wordingHash = localized
        ? (purpose.localeWordingHashes as Record<string, string>)[params.locale!]
        : purpose.wordingHash
      const result = await client.query<DbRecord>(
        `INSERT INTO association_consent_events (
           workspace_id, contact_id, purpose, purpose_id, action,
           wording_version, wording_hash, wording_snapshot, source, occurred_at,
           provider, provider_event_id, metadata, actor_kind,
           actor_credential_id, acting_user_id, request_fingerprint,wording_version_id,wording_locale,scope_snapshot,scope_sources
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19,$20::jsonb,$21::jsonb)
         ON CONFLICT (workspace_id, provider, provider_event_id)
           WHERE provider IS NOT NULL DO NOTHING
         RETURNING ${select}`,
        [workspaceId, params.contactId, purpose.purposeKey, purpose.id,
          params.action, purpose.wordingVersion, wordingHash,
          wording, params.source, params.occurredAt,
          params.provider ?? null, params.providerEventId ?? null,
          JSON.stringify(params.metadata), params.actor.actorKind,
          params.actor.actorCredentialId, params.actor.actingUserId,
          params.provider ? crmEvidenceRequestHash(request) : null,
          purpose.wordingVersionId ?? null,wordingLocale,
          evidence ? JSON.stringify(evidence.scope) : null, evidence ? JSON.stringify(evidence.sources) : null],
      )
      if (result.rows[0]) return { record: result.rows[0], created: true }
      const raced = first(await replay())
      await assertAssociationOrderAuthority(client, workspaceId, String(raced.id), operationalActor, 'consent')
      return { record: resolveCrmEvidenceReplay(raced, request), created: false }
    },

    async appendSuppression(params) {
      const evidence = await departmentV2() ? await admitAssociationSourceScope(client, workspaceId, operationalActor,
        await loadAssociationOrderScope(client, workspaceId, [params.contactId])) : null
      const request: CrmEvidenceRequest = { kind: 'suppression', contactId: params.contactId,
        channel: params.channel, action: params.action, reasonCode: params.reasonCode,
        source: params.source, occurredAt: params.requestedOccurredAt, metadata: params.metadata }
      const select = `id, contact_id AS "contactId", channel, action,
        reason_code AS "reasonCode", source, occurred_at AS "occurredAt",
        provider, provider_event_id AS "providerEventId", metadata, created_at AS "createdAt"`
      const replay = () => client.query<DbRecord>(
        `SELECT ${select}, request_fingerprint AS "__requestHash",
                to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "__occurredAt"
           FROM crm_suppression_events
          WHERE workspace_id=$1 AND provider=$2 AND provider_event_id=$3`,
        [workspaceId, params.provider, params.providerEventId],
      )
      if (params.provider && params.providerEventId) {
        const existing = await replay()
        if (existing.rows[0]) {
          await assertAssociationOrderAuthority(client, workspaceId, String(existing.rows[0].id), operationalActor, 'suppression')
          return { record: resolveCrmEvidenceReplay(existing.rows[0], request), created: false }
        }
      }
      const result = await client.query<DbRecord>(
        `INSERT INTO crm_suppression_events (
           workspace_id, contact_id, channel, action, reason_code, source,
           actor_kind, actor_credential_id, acting_user_id, provider,
           provider_event_id, occurred_at, metadata, request_fingerprint,scope_snapshot,scope_sources
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15::jsonb,$16::jsonb)
         ON CONFLICT (workspace_id, provider, provider_event_id)
           WHERE provider IS NOT NULL DO NOTHING
         RETURNING ${select}`,
        [workspaceId, params.contactId, params.channel, params.action,
          params.reasonCode, params.source, params.actor.actorKind,
          params.actor.actorCredentialId, params.actor.actingUserId,
          params.provider ?? null, params.providerEventId ?? null,
          params.occurredAt, JSON.stringify(params.metadata),
          params.provider ? crmEvidenceRequestHash(request) : null,
          evidence ? JSON.stringify(evidence.scope) : null, evidence ? JSON.stringify(evidence.sources) : null],
      )
      if (result.rows[0]) return { record: result.rows[0], created: true }
      const raced = first(await replay())
      await assertAssociationOrderAuthority(client, workspaceId, String(raced.id), operationalActor, 'suppression')
      return { record: resolveCrmEvidenceReplay(raced, request), created: false }
    },

    async updateSubmission(params) {
      await assertAssociationOrderAuthority(client, workspaceId, params.submissionId, operationalActor, 'submission')
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
      if (!isUnverifiedIdentityPolicy(params.definition.identityPolicy)) {
        const member = context.actor.kind === 'user' ? await client.query(
          `SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND role IN ('owner','admin') FOR SHARE`,
          [workspaceId, context.actor.userId],
        ) : null
        if (!member?.rowCount) throw new CrmOperationsError('not_authorized', 'A current workspace owner or admin must acknowledge backend verification.')
      }
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
      const v2 = (await client.query('SELECT department_read_v2 FROM workspaces WHERE id=$1', [workspaceId])).rows[0]?.department_read_v2
      if (v2 && !params.createdByUserId) throw new CrmOperationsError('not_authorized', 'Intake issuance requires a current issuer.')
      const binding = v2 ? await admitCrmIntegrationBinding(client, workspaceId, params.createdByUserId!, params.departmentBinding) : null
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
           id, workspace_id, label, secret_prefix, secret_hash, created_by_user_id,rotated_from_credential_id,department_binding
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         RETURNING id, label, secret_prefix AS "secretPrefix", revoked_at AS "revokedAt",
                   rotated_from_credential_id AS "rotatedFromCredentialId",
                   department_binding AS "departmentBinding",
                   last_used_at AS "lastUsedAt", created_at AS "createdAt"`,
        [params.credentialId, workspaceId, params.label, params.secretPrefix,
          params.secretHash, params.createdByUserId,params.rotateFromCredentialId ?? null, binding ? JSON.stringify(binding) : null],
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
                   rotated_from_credential_id AS "rotatedFromCredentialId",
                   last_used_at AS "lastUsedAt", created_at AS "createdAt"`,
        [workspaceId, credentialId],
      )
      return result.rows[0] ?? null
    },

    async saveConsentPurpose(params) {
      // A separate statement sees rows inserted by the BEFORE trigger; a
      // RETURNING subquery still uses the original statement snapshot.
      const withVersion = async (record: CrmOperationsRecord) => {
        const version = await client.query<{ id: string }>(
          `SELECT id FROM crm_consent_purpose_versions WHERE workspace_id=$1 AND purpose_id=$2 AND version=$3`,
          [workspaceId, record.id, record.wordingVersion],
        )
        return { ...record, wordingVersionId: first(version).id }
      }
      if (params.purposeId) {
        const updated = await client.query<DbRecord>(
          `UPDATE crm_consent_purposes
              SET label=$3, description=$4, requires_consent=$5,
                  applicable_channels=$6, active_wording_version=$7,
                  wording_snapshot=$8, wording_hash=$9,
                  default_locale=$11,locale_wordings=$12::jsonb,locale_wording_hashes=$13::jsonb,
                  archived_at=CASE WHEN $10 THEN COALESCE(archived_at,now()) ELSE NULL END,
                  updated_at=now()
            WHERE workspace_id=$1 AND id=$2
           RETURNING id, purpose_key AS "purposeKey", label, description,
                     requires_consent AS "requiresConsent",
                     applicable_channels AS "applicableChannels",
                     active_wording_version AS "wordingVersion",
                     wording_snapshot AS wording, wording_hash AS "wordingHash",
                     default_locale AS "defaultLocale",locale_wordings AS "localeWordings",locale_wording_hashes AS "localeWordingHashes",
                     archived_at AS "archivedAt", created_at AS "createdAt",
                     updated_at AS "updatedAt"`,
          [workspaceId, params.purposeId, params.label, params.description,
            params.requiresConsent, params.applicableChannels, params.wordingVersion,
            params.wording, params.wordingHash, params.archived,params.defaultLocale,
            JSON.stringify(params.localeWordings),JSON.stringify(params.localeWordingHashes)],
        )
        if (!updated.rows[0]) throw new Error('crm consent purpose not found')
        return { record: await withVersion(updated.rows[0]), created: false }
      }
      const created = await client.query<DbRecord>(
        `INSERT INTO crm_consent_purposes (
           workspace_id,purpose_key,label,description,requires_consent,
           applicable_channels,active_wording_version,wording_snapshot,
           wording_hash,archived_at,created_by_user_id,default_locale,locale_wordings,locale_wording_hashes
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $10 THEN now() END,$11,$12,$13::jsonb,$14::jsonb)
         RETURNING id, purpose_key AS "purposeKey", label, description,
                   requires_consent AS "requiresConsent",
                   applicable_channels AS "applicableChannels",
                   active_wording_version AS "wordingVersion",
                   wording_snapshot AS wording, wording_hash AS "wordingHash",
                   default_locale AS "defaultLocale",locale_wordings AS "localeWordings",locale_wording_hashes AS "localeWordingHashes",
                   archived_at AS "archivedAt", created_at AS "createdAt",
                   updated_at AS "updatedAt"`,
        [workspaceId, params.purposeKey, params.label, params.description,
          params.requiresConsent, params.applicableChannels, params.wordingVersion,
          params.wording, params.wordingHash, params.archived, params.createdByUserId,
          params.defaultLocale,JSON.stringify(params.localeWordings),JSON.stringify(params.localeWordingHashes)],
      )
      return { record: await withVersion(first(created)), created: true }
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
      const provider = await associationProviderInheritance(client, workspaceId, String(params.contactId), String(params.planId), operationalActor)
      const checkout = await associationCheckoutInheritance(client, workspaceId, String(params.contactId), String(params.planId), operationalActor)
      if (params.provider) {
        requireProviderEntitlementActor({ credentialKind: context.actor.kind, credentialId: actorAuditIdentity(context.actor).actorCredentialId },
          String(params.provider), context.actor.kind === 'provider' ? context.actor.provider : undefined)
      }
      const period = await prepareProviderEntitlementPeriod(client, workspaceId, params as Parameters<typeof prepareProviderEntitlementPeriod>[2])
      if (period) params = { ...params, requestHash: period.requestHash }

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
        || (!params.providerPeriodId && fingerprint === legacyRequestHash)
      const existing = await client.query<DbRecord>(
        `SELECT m.id, m.contact_id AS "contactId", m.plan_id AS "planId",
                p.plan_key AS "planKey", p.name AS "planName", m.status, m.starts_at AS "startsAt",
                m.ends_at AS "endsAt", m.renewal_mode AS "renewalMode",
                m.idempotency_key AS "idempotencyKey",
                m.provider, m.provider_membership_id AS "providerEntitlementId",m.provider_period_id AS "providerPeriodId",m.predecessor_id AS "predecessorId",
                m.request_fingerprint AS "requestFingerprint",
                m.created_at AS "createdAt", m.updated_at AS "updatedAt"
           FROM association_memberships m
           JOIN association_membership_plans p
             ON p.workspace_id=m.workspace_id AND p.id=m.plan_id
          WHERE m.workspace_id=$1 AND (m.idempotency_key=$2 OR m.id=$3) ORDER BY (m.idempotency_key=$2) DESC`,
        [workspaceId, params.idempotencyKey, period?.existingId ?? null],
      )
      if (existing.rows[0]) {
        await assertAssociationOrderAuthority(client, workspaceId, String(existing.rows[0].id), operationalActor, 'membership')
        await assertAssociationCheckoutParent(client, workspaceId, String(existing.rows[0].id), checkout?.checkoutId)
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
      const live = await loadAssociationOrderScope(client, workspaceId, [String(params.contactId)])
      const sources = [...(checkout?.evidence?.sources ?? []), ...(provider?.sources ?? []), ...live.sources]
      const evidence = await admitAssociationSourceScope(client, workspaceId, operationalActor, {
        sources, scope: deriveResourceScope({ producer: 'association.entitlement', sources: [...sources, ...(provider ? [{ ...provider.scope, resourceKind: 'provider_receipt', resourceId: provider.receiptId, version: 'saved' }] : [])] }, checkout?.evidence?.scope ?? live.scope),
      })
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO association_memberships (
           workspace_id,contact_id,plan_id,idempotency_key,request_fingerprint,
           status,starts_at,ends_at,renewal_mode,provider,provider_membership_id,provider_period_id,predecessor_id,scope_snapshot,scope_sources,membership_checkout_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16)
         ON CONFLICT (workspace_id,idempotency_key) DO NOTHING
         RETURNING id`,
        [workspaceId, params.contactId, params.planId, params.idempotencyKey,
          params.requestHash, params.status, params.startsAt, params.endsAt ?? null,
          params.renewalMode, params.provider ?? null,
          params.providerEntitlementId ?? null, params.providerPeriodId ?? null, params.predecessorId ?? null, JSON.stringify(evidence.scope), JSON.stringify(evidence.sources), checkout?.checkoutId ?? null],
      )
      if (!inserted.rows[0]) {
        const raced = await client.query<DbRecord>(
          `SELECT m.id, m.contact_id AS "contactId", m.plan_id AS "planId",
                  p.plan_key AS "planKey", p.name AS "planName", m.status,
                  m.starts_at AS "startsAt", m.ends_at AS "endsAt",
                  m.renewal_mode AS "renewalMode", m.provider,
                  m.idempotency_key AS "idempotencyKey",
                  m.provider_membership_id AS "providerEntitlementId",m.provider_period_id AS "providerPeriodId",m.predecessor_id AS "predecessorId",
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
        await assertAssociationOrderAuthority(client, workspaceId, String(raced.rows[0].id), operationalActor, 'membership')
        await assertAssociationCheckoutParent(client, workspaceId, String(raced.rows[0].id), checkout?.checkoutId)
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
                m.provider_membership_id AS "providerEntitlementId",m.provider_period_id AS "providerPeriodId",m.predecessor_id AS "predecessorId",
                m.created_at AS "createdAt", m.updated_at AS "updatedAt"
           FROM association_memberships m
           JOIN association_membership_plans p
             ON p.workspace_id=m.workspace_id AND p.id=m.plan_id
          WHERE m.workspace_id=$1 AND m.id=$2`,
        [workspaceId, inserted.rows[0]!.id],
      )
      await assertAssociationOrderAuthority(client, workspaceId, inserted.rows[0]!.id, operationalActor, 'membership')
      return { record: first(result), created: true }
    },

    async expireDueEntitlement(entitlementId) {
      if(context.actor.kind!=='system_job' || context.actor.job!=='entitlement_expiry')
        throw new CrmOperationsError('not_authorized','Due entitlement expiry requires its dedicated system job.')
      await client.query('SELECT id FROM association_memberships WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[workspaceId,entitlementId])
      const changed=await client.query<DbRecord>(`UPDATE association_memberships SET status='expired',updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND id=$2 AND status='active' AND provider IS NULL AND ends_at<=clock_timestamp()
        RETURNING id,contact_id AS "contactId",plan_id AS "planId",status,starts_at AS "startsAt",ends_at AS "endsAt",updated_at AS "updatedAt"`,[workspaceId,entitlementId])
      return changed.rows[0] ?? null
    },

    async updateEntitlement(entitlementId, changes) {
      if(context.actor.kind==='system_job' && context.actor.job==='entitlement_expiry')
        throw new CrmOperationsError('not_authorized','Expiry jobs must recheck a due manual entitlement.')
      const current = await client.query<{ status: string; startsAt: Date; provider: string | null }>(
        `SELECT status, starts_at AS "startsAt",provider
           FROM association_memberships
          WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
        [workspaceId, entitlementId],
      )
      await assertAssociationOrderAuthority(client, workspaceId, entitlementId, operationalActor, 'membership')
      const entitlement = current.rows[0]
      if (!entitlement) return null
      if (entitlement.provider) requireProviderEntitlementActor({ credentialKind: context.actor.kind, credentialId: actorAuditIdentity(context.actor).actorCredentialId },
        entitlement.provider, context.actor.kind === 'provider' ? context.actor.provider : undefined)
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
                   provider_membership_id AS "providerEntitlementId",provider_period_id AS "providerPeriodId",predecessor_id AS "predecessorId",
                   created_at AS "createdAt",updated_at AS "updatedAt"`,
        [workspaceId, entitlementId, changes.status ?? null,
          Object.prototype.hasOwnProperty.call(changes, 'endsAt'), changes.endsAt ?? null,
          changes.renewalMode ?? null],
      )
      await assertAssociationOrderAuthority(client, workspaceId, entitlementId, operationalActor, 'membership')
      return result.rows[0] ?? null
    },

    async recordParticipation(params) {
      const historical = params.historicalImport === true
      if (historical) {
        const actor = context.actor
        if (params.sourceKind !== 'import' || (actor.kind !== 'user' && actor.kind !== 'import')) {
          throw new CrmOperationsError('not_authorized', 'Historical participation requires a human admin import.')
        }
        const admin = await client.query(
          `SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND role IN('owner','admin') FOR SHARE`,
          [workspaceId, actor.userId],
        )
        if (!admin.rowCount) throw new CrmOperationsError('not_authorized', 'Historical participation requires a current workspace admin.')
        await client.query("SELECT set_config('app.crm_historical_actor',$1,true)", [actor.userId])
      }
      const existing = await client.query<DbRecord>(
        `SELECT id,event_id AS "eventId",attendee_contact_id AS "contactId",
                attendee_name AS "attendeeName",attendee_email AS "attendeeEmail",
                attendee_metadata AS metadata,status,source_kind AS "sourceKind",
                source_id AS "sourceId",historical_import AS "historicalImport",request_fingerprint AS "requestFingerprint",
                checked_in_at AS "checkedInAt",
                created_at AS "createdAt",updated_at AS "updatedAt"
           FROM association_registrations
          WHERE workspace_id=$1 AND source_kind=$2 AND source_id=$3`,
        [workspaceId, params.sourceKind, params.sourceId],
      )
      if (existing.rows[0]) {
        await assertAssociationOrderAuthority(client, workspaceId, String(existing.rows[0].id), operationalActor, 'registration')
        if (existing.rows[0].requestFingerprint !== params.requestHash) {
          throw new CrmOperationsError(
            'idempotency_conflict',
            'Source identity was already used for different participation.',
          )
        }
        const { requestFingerprint: _ignored, ...record } = existing.rows[0]
        return { record, created: false }
      }
      const eventIds = await lockAssociationInventory(client, workspaceId, { eventIds: [String(params.eventId)] })
      const [contact, event] = await Promise.all([
        client.query(
          `SELECT 1 FROM entities
            WHERE workspace_id=$1 AND id=$2 AND kind='person'
              AND valid_to IS NULL AND retracted_at IS NULL`,
          [workspaceId, params.contactId],
        ),
        client.query(
          `SELECT ends_at<=clock_timestamp() AS ended,
                  capacity IS NOT NULL OR EXISTS(SELECT 1 FROM association_ticket_types t WHERE t.workspace_id=$1 AND t.event_id=e.id) AS controlled
             FROM association_events e WHERE workspace_id=$1 AND id=$2`,
          [workspaceId, params.eventId],
        ),
      ])
      if (!contact.rowCount) throw new CrmOperationsError('not_found', 'CRM contact was not found.')
      if (!event.rowCount) throw new CrmOperationsError('not_found', 'CRM event was not found.')
      if (historical && !event.rows[0].ended) {
        throw new CrmOperationsError('conflict', 'Historical imports require an event that has already ended.', { reason: 'historical_event_not_ended' })
      }
      if (!historical && event.rows[0].controlled) {
        throw new CrmOperationsError('conflict', 'This event requires an Association order to admit participants.', { reason: 'association_order_required' })
      }
      const evidence = await admitAssociationSourceScope(client, workspaceId, operationalActor,
        await loadAssociationOrderScope(client, workspaceId, [String(params.contactId)]))
      const result = await client.query<DbRecord>(
        `INSERT INTO association_registrations (
           workspace_id,event_id,attendee_contact_id,attendee_name,attendee_email,
           attendee_metadata,status,source_kind,source_id,request_fingerprint,historical_import,scope_snapshot,scope_sources
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb)
         ON CONFLICT DO NOTHING
         RETURNING id,event_id AS "eventId",attendee_contact_id AS "contactId",
                   attendee_name AS "attendeeName",attendee_email AS "attendeeEmail",
                   attendee_metadata AS metadata,status,source_kind AS "sourceKind",
                   source_id AS "sourceId",historical_import AS "historicalImport",checked_in_at AS "checkedInAt",
                   created_at AS "createdAt",updated_at AS "updatedAt"`,
        [workspaceId, params.eventId, params.contactId, params.attendeeName,
          params.attendeeEmail ?? null, JSON.stringify(params.metadata ?? {}), params.status,
          params.sourceKind, params.sourceId, params.requestHash, historical, JSON.stringify(evidence.scope), JSON.stringify(evidence.sources)],
      )
      if (!result.rows[0]) {
        const raced = await client.query<DbRecord>(
          `SELECT id,event_id AS "eventId",attendee_contact_id AS "contactId",
                  attendee_name AS "attendeeName",attendee_email AS "attendeeEmail",
                  attendee_metadata AS metadata,status,source_kind AS "sourceKind",
                  source_id AS "sourceId",historical_import AS "historicalImport",request_fingerprint AS "requestFingerprint",
                  checked_in_at AS "checkedInAt",
                  created_at AS "createdAt",updated_at AS "updatedAt"
             FROM association_registrations
            WHERE workspace_id=$1 AND source_kind=$2 AND source_id=$3`,
          [workspaceId, params.sourceKind, params.sourceId],
        )
        if (!raced.rows[0]) {
          throw new CrmOperationsError('conflict', 'Participation could not be resolved after a concurrent record.')
        }
        await assertAssociationOrderAuthority(client, workspaceId, String(raced.rows[0].id), operationalActor, 'registration')
        if (raced.rows[0].requestFingerprint !== params.requestHash) {
          throw new CrmOperationsError(
            'idempotency_conflict',
            'Source identity was already used for different participation.',
          )
        }
        const { requestFingerprint: _ignored, ...record } = raced.rows[0]
        return { record, created: false }
      }
      await refreshAssociationInventory(client, workspaceId, eventIds, context.actor.kind)
      await assertAssociationOrderAuthority(client, workspaceId, String(result.rows[0].id), operationalActor, 'registration')
      return { record: first(result), created: true }
    },

    async updateParticipation(participationId, status) {
      const eventIds = await lockAssociationInventory(client, workspaceId, { registrationId: participationId })
      const current = await client.query<{ status: string; sourceKind: string }>(
        `SELECT status, source_kind AS "sourceKind"
           FROM association_registrations
          WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
        [workspaceId, participationId],
      )
      await assertAssociationOrderAuthority(client, workspaceId, participationId, operationalActor, 'registration')
      const participation = current.rows[0]
      if (!participation) return null
      if (['commerce', 'source_order'].includes(participation.sourceKind)) {
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
                   source_id AS "sourceId",historical_import AS "historicalImport",checked_in_at AS "checkedInAt",
                   created_at AS "createdAt",updated_at AS "updatedAt"`,
        [workspaceId, participationId, status],
      )
      await refreshAssociationInventory(client, workspaceId, eventIds, context.actor.kind)
      await assertAssociationOrderAuthority(client, workspaceId, participationId, operationalActor, 'registration')
      return result.rows[0] ?? null
    },

    async correctParticipationCheckIn(participationId, expectedStatus) {
      const eventIds = await lockAssociationInventory(client, workspaceId, { registrationId: participationId })
      const current = await client.query<{ status: string; sourceKind: string }>(
        `SELECT status,source_kind AS "sourceKind" FROM association_registrations
          WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [workspaceId, participationId],
      )
      await assertAssociationOrderAuthority(client, workspaceId, participationId, operationalActor, 'registration')
      const participation = current.rows[0]
      if (!participation) return null
      if (['commerce', 'source_order'].includes(participation.sourceKind)) throw new CrmOperationsError('conflict',
        'Commerce participation must be corrected through Association registration operations.', { commerceManaged: true })
      if (participation.status !== expectedStatus) throw new CrmOperationsError('conflict',
        'Participation status no longer matches the expected check-in state.', { expectedStatus, currentStatus: participation.status })
      const result = await client.query<DbRecord>(
        `UPDATE association_registrations SET status='registered',checked_in_at=NULL,updated_at=now()
          WHERE workspace_id=$1 AND id=$2
          RETURNING id,event_id AS "eventId",attendee_contact_id AS "contactId",
            attendee_name AS "attendeeName",attendee_email AS "attendeeEmail",attendee_metadata AS metadata,
            status,source_kind AS "sourceKind",source_id AS "sourceId",historical_import AS "historicalImport",
            checked_in_at AS "checkedInAt",created_at AS "createdAt",updated_at AS "updatedAt"`,
        [workspaceId, participationId],
      )
      await refreshAssociationInventory(client, workspaceId, eventIds, context.actor.kind)
      await assertAssociationOrderAuthority(client, workspaceId, participationId, operationalActor, 'registration')
      return result.rows[0] ?? null
    },

    async setDealPipelineStage(params) {
      const access = await stageActorAccess(client, context)
      const source = await readCrmMutationSource(access, params.dealId, ['deal'], client)
      if (!source) return null
      const project = (entity: typeof source) => ({ id: entity.id, name: entity.displayName,
        attributes: entity.attributes, createdAt: entity.createdAt, updatedAt: entity.updatedAt })
      const deal = project(source)
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
            AND p.archived_at IS NULL AND s.archived_at IS NULL FOR SHARE OF p,s`,
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
      const updated = await updateEntity(access.userId, params.dealId, { attributes: {
        ...deal.attributes, pipeline_id: params.pipelineId, pipeline_stage_id: params.stageId, stage: legacyStage,
      } }, access, client)
      const updatedDeal = updated ? project(updated) : null
      if (!updatedDeal) return null
      await client.query(
        `INSERT INTO crm_activities (
           workspace_id,entity_id,activity_type,direction,summary,source_kind,
           source_id,actor_user_id,actor_assistant_id,metadata
         ) VALUES ($1,$2,'stage_change','internal',$3,'crm_operation',$4,$5,$6,$7::jsonb)`,
        [workspaceId, params.dealId, `Moved deal to ${String(stage.stageName)}`,
          `${params.pipelineId}:${params.stageId}:${Date.now()}`,
          access.userId, actorAssistantId(context.actor),
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

export function createDbCrmOperationsStore(pool: Pool = getPool(), transactionClient?: PoolClient): CrmOperationsStore {
  return {
    async transaction(context, fn) {
      const client = transactionClient ?? await pool.connect()
      try {
        if (!transactionClient) {
          await client.query('BEGIN')
          await client.query(`SELECT set_config('app.system_bypass', 'true', true)`)
        }
        await beginAssociationCreation(client, context.workspaceId)
        const actor = context.actor
        const intake = actor.kind === 'intake_key'
          ? await readCrmIntakeAuthority(client, context.workspaceId, actor.credentialId, actor.definitionId, true) : null
        if (actor.kind === 'integration_key' && context.authority.integration?.credentialId !== actor.credentialId) {
          throw new CrmOperationsError('not_authorized', 'Integration identity is unavailable.')
        }
        const integration = actor.kind === 'integration_key'
          ? await lockCrmIntegrationCredential(client, context.workspaceId, actor.credentialId) : null
        const departmentRead = intake?.departmentRead ?? integration?.departmentRead
        const execute = async () => {
          const result = await fn(createTransaction(client, context))
          if (intake && actor.kind === 'intake_key') {
            const renewed = await readCrmIntakeAuthority(client, context.workspaceId, actor.credentialId, actor.definitionId, true)
            if (JSON.stringify(renewed) !== JSON.stringify(intake)) throw new CrmOperationsError('not_authorized', 'Intake authority changed.')
          }
          if (integration && actor.kind === 'integration_key') {
            const renewed = await lockCrmIntegrationCredential(client, context.workspaceId, actor.credentialId)
            if (JSON.stringify(renewed) !== JSON.stringify(integration)) throw new CrmOperationsError('not_authorized', 'Integration authority changed.')
          }
          return result
        }
        const result = departmentRead ? await runWithAgentAccess({ workspaceId: context.workspaceId,
          userId: departmentRead.userId, departmentRead,
          clearance: 'confidential', compartments: null, ...(intake?.executionLimits ?? integration?.executionLimits) }, execute) : await execute()
        if (!transactionClient) await client.query('COMMIT')
        return result
      } catch (error) {
        if (!transactionClient) await client.query('ROLLBACK')
        if (error instanceof WorkspaceAccessError || (error as {code?:string}).code === 'scope_operation_denied') {
          throw new CrmOperationsError('not_authorized', 'The source or destination is unavailable in this scope.')
        }
        if ((error as { constraint?: string }).constraint === 'crm_intake_credential_rotation_fk') {
          throw new CrmOperationsError('not_found', 'Intake rotation source is unavailable.')
        }
        if ((error as { constraint?: string }).constraint === 'crm_consent_wording_immutable') {
          throw new CrmOperationsError('conflict', 'Wording versions are immutable. Save changed wording under a new version.',
            { reason: 'wording_version_immutable' })
        }
        throw error
      } finally {
        if (!transactionClient) client.release()
      }
    },
  }
}

export function crmOperationsActorAssistantId(actor: CrmOperationsActor): string | null {
  return actorAssistantId(actor)
}
