/**
 * Read/authentication store for CRM intake definitions and credentials.
 * Authentication is deliberately separate from Brain/API keys: an intake
 * principal resolves only a workspace and one bound definition.
 *
 * [COMP:api/crm-intake-route]
 */

import {
  CrmOperationsError, CrmEffectiveEntitlementQuerySchema,
  type CrmPage, type CrmPageQuery,
  CrmIntegrationScopeError,
  crmIntegrationResourceSelection, requireCrmIntegrationOperation, requireCrmIntegrationResources,
  type CrmIntegrationAuthority, type CrmIntegrationOperation, type CrmIntegrationSelector,
  evaluateCrmSendability,
  type CrmDeliveryChannel,
  type CrmOperationsReadPort,
} from '@use-brian/core'
import { query } from './client.js'
import { readCrmAddressSuppressions } from '../crm-operations/suppression-tombstones.js'
import { crmPageInstant, queryCrmPage } from '../crm-operations/pagination.js'
import { verifySecret } from './api-key-store.js'
import { createDbCrmSegmentStore } from './crm-segment-store.js'
import { readCrmFieldCatalog } from './crm-config-catalog.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KEY_PREFIX = 'sk_intake_'

export function parseCrmIntakeToken(token: string): { credentialId: string; secret: string } | null {
  if (!token.startsWith(KEY_PREFIX)) return null
  const rest = token.slice(KEY_PREFIX.length)
  const separator = rest.indexOf('_')
  if (separator < 0) return null
  const credentialId = rest.slice(0, separator)
  const secret = rest.slice(separator + 1)
  if (!UUID_RE.test(credentialId) || !secret || secret.length > 200) return null
  return { credentialId, secret }
}

export type CrmIntakePrincipal = {
  workspaceId: string
  credentialId: string
  definitionId: string
  definitionKey: string
}

type AuthRow = CrmIntakePrincipal & {
  secretHash: string
  revokedAt: Date | null
}

export type CrmIntakeReadStore = {
  authenticate(token: string, definitionKey: string): Promise<CrmIntakePrincipal | null>
  listDefinitions(workspaceId: string, filters?: CrmPageQuery): Promise<CrmPage<'definitions'>>
  listCredentials(workspaceId: string, filters?: CrmPageQuery): Promise<CrmPage<'credentials'>>
}

export type DbCrmOperationsReadStore = CrmIntakeReadStore & CrmOperationsReadPort & {
  getSubmissionAttachment(workspaceId: string, submissionId: string, attachmentId: string): Promise<{
    name: string
    mimeType: string
    contentBytes: Buffer
  } | null>
  listRecordFields(workspaceId: string, filters?: unknown): Promise<CrmPage<'fields'>>
  resolveLegacyPipelineStage(workspaceId: string, stageKey: string): Promise<{
    pipelineId: string
    stageId: string
  } | null>
  listCrmEventFilterCatalog(workspaceId: string): Promise<{
    eventTypes: string[]
    stableKeys: Array<{ kind: string; key: string; label: string }>
  }>
}

export function createDbCrmIntakeReadStore(integration?: CrmIntegrationAuthority & { workspaceId: string }): DbCrmOperationsReadStore {
  const authorize = (workspaceId: string, operation: CrmIntegrationOperation) => {
    if (!integration) return
    if (workspaceId !== integration.workspaceId) throw new CrmIntegrationScopeError(operation)
    requireCrmIntegrationOperation(integration, operation)
  }
  const select = (workspaceId: string, operation: CrmIntegrationOperation, dimension: CrmIntegrationSelector): readonly string[] | null => {
    if (!integration) return null
    authorize(workspaceId, operation)
    const allowed = crmIntegrationResourceSelection(integration, operation, dimension)
    return allowed === 'all' ? null : [...allowed].sort()
  }

  const page = <Key extends string>(key: Key, workspaceId: string, filters: CrmPageQuery, sql: string, params: unknown[]) =>
    queryCrmPage(query, { workspaceId, resource: `crm.${key}`, key, sql, params,
      query: { limit: filters.limit, cursor: filters.cursor, createdAfter: filters.createdAfter, createdBefore: filters.createdBefore } })
  const segmentStore = createDbCrmSegmentStore()
  const authorizeSegments = (workspaceId: string) => {
    if (!integration) return
    authorize(workspaceId, 'crm.records.read')
    // These legacy segment APIs return a workspace-wide derived catalog or
    // audience. Never let them become an alternate unfiltered integration read.
    requireCrmIntegrationResources(integration, 'crm.catalog.read', { definitionIds: null, purposeKeys: null, planIds: null, eventIds: null })
    requireCrmIntegrationResources(integration, 'crm.consent.read', { purposeKeys: null })
    requireCrmIntegrationResources(integration, 'crm.entitlements.read', { planIds: null })
    requireCrmIntegrationResources(integration, 'crm.participation.read', { eventIds: null })
  }
  const listDefinitions = async (workspaceId: string, filters: CrmPageQuery = {}) => {
    return page('definitions', workspaceId, filters,
      `SELECT d.id, d.definition_key AS "definitionKey", d.label, d.active,
              d.current_version AS "currentVersion", v.field_catalog AS fields,
              COALESCE(v.schema_snapshot->'attachments','[]'::jsonb) AS attachments,
              v.identity_policy AS "identityPolicy",
              v.schema_snapshot->'identityVerification' AS "identityVerification",
              CASE WHEN v.schema_snapshot ? 'identityVerification' THEN v.created_by_user_id END AS "verificationAcknowledgedByUserId",
              CASE WHEN v.schema_snapshot ? 'identityVerification' THEN v.created_at END AS "verificationAcknowledgedAt",
              v.allowed_identity_provider AS "allowedIdentityProvider",
              v.consent_mappings AS "consentMappings", v.queue_key AS "queueKey",
              v.owner_user_id AS "ownerUserId",
              v.follow_up_task_template AS "followUpTaskTemplate",
              v.follow_up_due_minutes AS "followUpDueMinutes",
              v.max_payload_bytes AS "maxPayloadBytes",
              v.workflow_hint AS "workflowHint", v.schema_hash AS "schemaHash",
              d.created_at AS "createdAt", d.updated_at AS "updatedAt"
         FROM crm_intake_definitions d
         JOIN crm_intake_definition_versions v
           ON v.workspace_id = d.workspace_id AND v.definition_id = d.id
          AND v.version = d.current_version
        WHERE d.workspace_id = $1 AND ($2::uuid[] IS NULL OR d.id=ANY($2::uuid[]))`,
      [workspaceId, select(workspaceId, 'crm.catalog.read', 'definitionIds')],
    )
  }

  const listConsentPurposes = async (workspaceId: string, includeArchived = false, filters: CrmPageQuery = {}, operation: CrmIntegrationOperation = 'crm.catalog.read') => {
    return page('purposes', workspaceId, filters,
      `SELECT id, purpose_key AS "purposeKey", label, description,
              requires_consent AS "requiresConsent",
              applicable_channels AS "applicableChannels",
              active_wording_version AS "wordingVersion",
              wording_snapshot AS wording, wording_hash AS "wordingHash",
              default_locale AS "defaultLocale", locale_wordings AS "localeWordings",
              locale_wording_hashes AS "localeWordingHashes",
              (SELECT v.id FROM crm_consent_purpose_versions v WHERE v.workspace_id=crm_consent_purposes.workspace_id
                AND v.purpose_id=crm_consent_purposes.id AND v.version=crm_consent_purposes.active_wording_version) AS "wordingVersionId",
              archived_at AS "archivedAt", created_at AS "createdAt",
              updated_at AS "updatedAt"
         FROM crm_consent_purposes
        WHERE workspace_id=$1 AND ($2::boolean OR archived_at IS NULL)
          AND ($3::text[] IS NULL OR purpose_key=ANY($3::text[]))`,
      [workspaceId, includeArchived, select(workspaceId, operation, 'purposeKeys')],
    )
  }

  return {
    listSegments: (workspaceId, filters) => { authorizeSegments(workspaceId); return segmentStore.listSegments(workspaceId, filters) },
    getSegment: (workspaceId, segmentId) => { authorizeSegments(workspaceId); return segmentStore.getSegment(workspaceId, segmentId) },
    previewSegment: (workspaceId, segmentId, options) => { authorizeSegments(workspaceId); return segmentStore.previewSegment(workspaceId, segmentId, options) },
    listCrmEventFilterCatalog: (workspaceId) => { authorizeSegments(workspaceId); return segmentStore.listCrmEventFilterCatalog(workspaceId) },
    async authenticate(token, definitionKey) {
      if (integration) throw new CrmOperationsError('not_authorized', 'A scoped integration read store cannot authenticate another credential family.')
      const parsed = parseCrmIntakeToken(token)
      if (!parsed) return null
      const found = await query<AuthRow>(
        `SELECT c.id AS "credentialId", c.workspace_id AS "workspaceId",
                c.secret_hash AS "secretHash", c.revoked_at AS "revokedAt",
                d.id AS "definitionId", d.definition_key AS "definitionKey"
           FROM crm_intake_credentials c
           JOIN crm_intake_credential_definitions b
             ON b.workspace_id = c.workspace_id AND b.credential_id = c.id
           JOIN crm_intake_definitions d
             ON d.workspace_id = b.workspace_id AND d.id = b.definition_id
          WHERE c.id = $1 AND d.definition_key = $2 AND d.active`,
        [parsed.credentialId, definitionKey],
      )
      const row = found.rows[0]
      if (!row || row.revokedAt || !await verifySecret(parsed.secret, row.secretHash)) return null
      await query(
        `UPDATE crm_intake_credentials SET last_used_at = now()
          WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL`,
        [row.workspaceId, row.credentialId],
      )
      return {
        workspaceId: row.workspaceId,
        credentialId: row.credentialId,
        definitionId: row.definitionId,
        definitionKey: row.definitionKey,
      }
    },

    listDefinitions,
    listIntakeDefinitions: listDefinitions,

    async resolveLegacyPipelineStage(workspaceId, stageKey) {
      authorize(workspaceId, 'crm.records.read')
      const result = await query<{ pipelineId: string; stageId: string }>(
        `SELECT p.id AS "pipelineId",s.id AS "stageId"
           FROM crm_pipelines p
           JOIN crm_pipeline_stages s
             ON s.workspace_id=p.workspace_id AND s.pipeline_id=p.id
          WHERE p.workspace_id=$1 AND p.is_default
            AND p.archived_at IS NULL AND s.archived_at IS NULL
            AND s.legacy_key=$2
          LIMIT 1`,
        [workspaceId, stageKey],
      )
      return result.rows[0] ?? null
    },

    async listCredentials(workspaceId, filters = {}) {
      if (integration) throw new CrmOperationsError('not_authorized', 'Integration credentials cannot administer intake credentials.')
      return page('credentials', workspaceId, filters,
        `SELECT c.id, c.label, c.secret_prefix AS prefix,
                c.rotated_from_credential_id AS "rotatedFromCredentialId",
                c.revoked_at AS "revokedAt", c.last_used_at AS "lastUsedAt",
                c.created_at AS "createdAt",
                COALESCE(array_agg(b.definition_id ORDER BY b.definition_id)
                  FILTER (WHERE b.definition_id IS NOT NULL), '{}') AS "definitionIds"
           FROM crm_intake_credentials c
           LEFT JOIN crm_intake_credential_definitions b
             ON b.workspace_id = c.workspace_id AND b.credential_id = c.id
          WHERE c.workspace_id = $1
          GROUP BY c.id`,
        [workspaceId],
      )
    },

    async listSubmissions(workspaceId, filters = {}) {
      return page('submissions', workspaceId, filters,
        `SELECT e.id, e.contact_id AS "contactId", c.display_name AS "contactName",
                e.definition_id AS "definitionId", d.definition_key AS "definitionKey",
                d.label AS "definitionLabel", e.status, e.queue_key AS "queueKey",
                e.owner_user_id AS "ownerUserId", e.follow_up_task_id AS "followUpTaskId",
                (SELECT count(*)::int FROM association_submission_attachments a
                  WHERE a.workspace_id=e.workspace_id AND a.submission_id=e.id) AS "attachmentCount",
                e.submitted_at AS "submittedAt", e.created_at AS "createdAt",
                e.updated_at AS "updatedAt"
           FROM association_enquiries e
           JOIN entities c ON c.workspace_id=e.workspace_id AND c.id=e.contact_id
           LEFT JOIN crm_intake_definitions d
             ON d.workspace_id=e.workspace_id AND d.id=e.definition_id
          WHERE e.workspace_id=$1
            AND ($2::text IS NULL OR e.status=$2)
            AND ($3::text IS NULL OR d.definition_key=$3)
            AND ($4::uuid IS NULL OR e.owner_user_id=$4)
            AND ($5::uuid[] IS NULL OR e.definition_id=ANY($5::uuid[]))`,
        [workspaceId, filters.status ?? null, filters.definitionKey ?? null,
          filters.ownerUserId ?? null, select(workspaceId, 'crm.submissions.read', 'definitionIds')],
      )
    },

    async getSubmission(workspaceId, submissionId) {
      const result = await query<Record<string, unknown>>(
        `SELECT e.id, e.contact_id AS "contactId", c.display_name AS "contactName",
                e.definition_id AS "definitionId", d.definition_key AS "definitionKey",
                d.label AS "definitionLabel", e.definition_version_id AS "definitionVersionId",
                e.definition_schema_hash AS "definitionSchemaHash",
                e.definition_schema_snapshot AS "definitionSchemaSnapshot",
                e.identity_verification_evidence AS "identityVerificationEvidence",
                e.submitted_data AS fields, e.status, e.queue_key AS "queueKey",
                e.owner_user_id AS "ownerUserId", e.follow_up_task_id AS "followUpTaskId",
                e.submitted_at AS "submittedAt", e.created_at AS "createdAt",
                e.updated_at AS "updatedAt",
                COALESCE((SELECT jsonb_agg(jsonb_build_object(
                  'id', n.id, 'body', n.body, 'actorKind', n.actor_kind,
                  'actingUserId', n.acting_user_id, 'createdAt', n.created_at
                ) ORDER BY n.created_at, n.id)
                FROM association_enquiry_notes n
                WHERE n.workspace_id=e.workspace_id AND n.enquiry_id=e.id), '[]'::jsonb) AS notes,
                COALESCE((SELECT jsonb_agg(jsonb_build_object(
                  'id', a.id, 'key', a.attachment_key, 'name', a.original_name,
                  'mimeType', a.mime_type, 'sizeBytes', a.size_bytes,
                  'sha256', a.sha256, 'createdAt', a.created_at
                ) ORDER BY a.created_at,a.id)
                FROM association_submission_attachments a
                WHERE a.workspace_id=e.workspace_id AND a.submission_id=e.id), '[]'::jsonb) AS attachments
           FROM association_enquiries e
           JOIN entities c ON c.workspace_id=e.workspace_id AND c.id=e.contact_id
           LEFT JOIN crm_intake_definitions d
             ON d.workspace_id=e.workspace_id AND d.id=e.definition_id
          WHERE e.workspace_id=$1 AND e.id=$2 AND ($3::uuid[] IS NULL OR e.definition_id=ANY($3::uuid[]))`,
        [workspaceId, submissionId, select(workspaceId, 'crm.submissions.read', 'definitionIds')],
      )
      return result.rows[0] ?? null
    },

    async getSubmissionAttachment(workspaceId, submissionId, attachmentId) {
      const result = await query<{ name: string; mimeType: string; contentBytes: Buffer }>(
        `SELECT a.original_name AS name,a.mime_type AS "mimeType",a.content_bytes AS "contentBytes"
           FROM association_submission_attachments a
           JOIN association_enquiries e
             ON e.workspace_id=a.workspace_id AND e.id=a.submission_id
          WHERE a.workspace_id=$1 AND a.submission_id=$2 AND a.id=$3
            AND ($4::uuid[] IS NULL OR e.definition_id=ANY($4::uuid[]))`,
        [workspaceId, submissionId, attachmentId,
          select(workspaceId, 'crm.submissions.read', 'definitionIds')],
      )
      return result.rows[0] ?? null
    },

    listConsentPurposes,

    async getConsent(workspaceId, contactId) {
      const purposesAllowed = select(workspaceId, 'crm.consent.read', 'purposeKeys')
      if (purposesAllowed?.length === 0) throw new CrmIntegrationScopeError('crm.consent.read', 'purposeKeys')
      const contact = await query(`SELECT 1 FROM entities WHERE workspace_id=$1 AND id=$2 AND kind='person'`, [workspaceId, contactId])
      if (contact.rowCount !== 1) throw new CrmOperationsError('not_found', 'CRM contact was not found.')
      const evidence = async (resource: string, sql: string, params: unknown[]) => {
        const rows: Record<string, unknown>[] = []
        let cursor: string | undefined
        do {
          const page = await queryCrmPage(query, { workspaceId, resource, key: 'rows', sql, params, query: { limit: 100, cursor } })
          rows.push(...page.rows)
          cursor = page.nextCursor ?? undefined
        } while (cursor)
        // Keep the legacy occurrence-time display order after complete traversal.
        rows.sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt))
          || String(b.__recordedAt).localeCompare(String(a.__recordedAt)) || String(b.id).localeCompare(String(a.id)))
        return rows.map(({ __recordedAt: _recordedAt, ...row }) => row)
      }
      const [purposes, events, suppressions] = await Promise.all([
        (async () => {
          const all: Record<string, unknown>[] = []
          let cursor: string | undefined
          do {
            const result = await listConsentPurposes(workspaceId, true, { limit: 100, cursor }, 'crm.consent.read')
            all.push(...result.purposes)
            cursor = result.nextCursor ?? undefined
          } while (cursor)
          return all
        })(),
        evidence('crm.contact-consent',
          `SELECT e.id, e.purpose_id AS "purposeId", e.purpose AS "purposeKey",
                  e.action, e.wording_version AS "wordingVersion",
                  e.wording_hash AS "wordingHash", e.wording_snapshot AS wording,
                  e.wording_version_id AS "wordingVersionId", e.wording_locale AS "wordingLocale",
                  e.source, to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt", e.provider,
                  e.provider_event_id AS "providerEventId", e.actor_kind AS "actorKind",
                  e.acting_user_id AS "actingUserId", e.created_at AS "createdAt",
                  to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "__recordedAt"
             FROM association_consent_events e
            WHERE e.workspace_id=$1 AND e.contact_id=$2 AND ($3::text[] IS NULL OR e.purpose=ANY($3::text[]))
`,
          [workspaceId, contactId, purposesAllowed],
        ),
        evidence('crm.contact-suppressions',
          `SELECT id, channel, action, reason_code AS "reasonCode", source,
                  to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt", provider,
                  provider_event_id AS "providerEventId", actor_kind AS "actorKind",
                  acting_user_id AS "actingUserId", created_at AS "createdAt",
                  to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "__recordedAt"
             FROM crm_suppression_events
            WHERE workspace_id=$1 AND contact_id=$2
`,
          [workspaceId, contactId],
        ),
      ])
      return { purposes, events, suppressions }
    },

    async listEntitlementPlans(workspaceId, filters = {}) {
      return page('plans', workspaceId, filters,
        `SELECT p.id, p.plan_key AS "planKey", p.name, p.currency,
                p.fee_minor::text AS "feeMinor", p.billing_period AS "billingPeriod",
                p.benefits, p.eligibility_note AS "eligibilityNote",
                p.active_from AS "activeFrom", p.active_to AS "activeTo",
                p.published, p.provider, p.provider_plan_id AS "providerPlanId",
                (p.fee_minor > 0 OR p.provider IS NOT NULL) AS "commerceManaged",
                p.created_at AS "createdAt", p.updated_at AS "updatedAt"
           FROM association_membership_plans p
          WHERE p.workspace_id=$1
            AND ($2::boolean IS NULL OR p.published=$2) AND ($3::uuid[] IS NULL OR p.id=ANY($3::uuid[]))`,
        [workspaceId, filters.published ?? null, select(workspaceId, 'crm.catalog.read', 'planIds')],
      )
    },

    async listEntitlements(workspaceId, filters = {}) {
      const effective = CrmEffectiveEntitlementQuerySchema.parse({ activeOnly: filters.activeOnly, effectiveAt: filters.effectiveAt })
      const at = 'coalesce($7::timestamptz,(SELECT at FROM crm_page_context))'
      return page('entitlements', workspaceId, filters,
        `SELECT m.id, m.contact_id AS "contactId", c.display_name AS "contactName",
                m.plan_id AS "planId", p.plan_key AS "planKey", p.name AS "planName",
                m.status, m.starts_at AS "startsAt", m.ends_at AS "endsAt",
                association_membership_is_effective(m.workspace_id,m.id,m.status,m.starts_at,m.ends_at,${at}) AS "isEffective",
                to_char(${at} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "effectiveAt",
                m.renewal_mode AS "renewalMode", m.provider,
                m.provider_membership_id AS "providerEntitlementId",m.provider_period_id AS "providerPeriodId",m.predecessor_id AS "predecessorId",
                m.sponsorship_allocation_id AS "sponsorshipAllocationId",
                (s.id IS NOT NULL) AS "sourceImport",
                CASE WHEN s.id IS NULL THEN NULL ELSE jsonb_build_object(
                  'source',s.source_system,'site',s.source_site,'membershipId',s.source_membership_id,
                  'planId',s.source_plan_id,'memberId',s.source_member_id,'orderId',s.source_order_id,
                  'subscriptionId',s.source_subscription_id,'paymentProvider',s.source_payment_provider,
                  'paymentReference',s.source_payment_reference,'status',s.source_status,
                  'renewalStatus',s.source_renewal_status,'paymentStatus',s.source_payment_status,
                  'refundStatus',s.source_refund_status,'purchasedAt',s.purchased_at,
                  'cancelledAt',s.cancelled_at,'relationships',s.relationships,'metadata',s.metadata)
                END AS "sourceEvidence",
                m.created_at AS "createdAt", m.updated_at AS "updatedAt"
           FROM association_memberships m
           JOIN association_membership_plans p
             ON p.workspace_id=m.workspace_id AND p.id=m.plan_id
           JOIN entities c
             ON c.workspace_id=m.workspace_id AND c.id=m.contact_id
           LEFT JOIN association_membership_source_imports s
             ON s.workspace_id=m.workspace_id AND s.membership_id=m.id
          WHERE m.workspace_id=$1
            AND ($2::uuid IS NULL OR m.contact_id=$2)
            AND ($3::uuid IS NULL OR m.plan_id=$3)
            AND ($4::text IS NULL OR m.status=$4) AND ($5::uuid[] IS NULL OR m.plan_id=ANY($5::uuid[]))
            AND c.valid_to IS NULL AND c.retracted_at IS NULL
            AND (NOT $6::boolean OR association_membership_is_effective(m.workspace_id,m.id,m.status,m.starts_at,m.ends_at,${at}))`,
        [workspaceId, filters.contactId ?? null, filters.planId ?? null,
          filters.status ?? null, select(workspaceId, 'crm.entitlements.read', 'planIds'),
          effective.activeOnly ?? false, effective.effectiveAt ? crmPageInstant(effective.effectiveAt) : null],
      )
    },

    async listEvents(workspaceId, filters = {}) {
      return page('events', workspaceId, filters,
        `SELECT e.id, e.slug, e.programme_key AS "programmeKey", e.title,
                e.description, e.starts_at AS "startsAt", e.ends_at AS "endsAt",
                e.timezone, e.mode, e.venue, e.online_url AS "onlineUrl",
                e.registration_opens_at AS "registrationOpensAt",
                e.registration_closes_at AS "registrationClosesAt",
                e.capacity, e.status, e.canonical_url AS "canonicalUrl", e.metadata,
                EXISTS(SELECT 1 FROM association_ticket_types t
                  WHERE t.workspace_id=e.workspace_id AND t.event_id=e.id) AS "commerceManaged",
                e.created_at AS "createdAt", e.updated_at AS "updatedAt"
           FROM association_events e
          WHERE e.workspace_id=$1 AND ($2::text IS NULL OR e.status=$2) AND ($3::uuid[] IS NULL OR e.id=ANY($3::uuid[]))
            AND ($4::text IS NULL OR ($4='upcoming' AND e.ends_at >= now()) OR ($4='past' AND e.ends_at < now()))
            AND ($5::uuid IS NULL OR e.id=$5::uuid) AND ($6::text IS NULL OR e.slug=$6)
            AND ($7::text IS NULL OR ($7='visible' AND e.status <> 'draft') OR ($7='drafts' AND e.status = 'draft'))`,
        [workspaceId, filters.status ?? null, select(workspaceId, 'crm.catalog.read', 'eventIds'), filters.when ?? null, filters.id ?? null, filters.slug ?? null, filters.website ?? null],
      )
    },

    async listParticipation(workspaceId, filters = {}) {
      return page('participation', workspaceId, filters,
        `SELECT p.* FROM (
           SELECT r.id, r.event_id AS "eventId", e.slug AS "eventKey",
                  e.title AS "eventTitle", r.attendee_contact_id AS "contactId",
                  c.display_name AS "contactName", r.attendee_name AS "attendeeName",
                  r.attendee_email AS "attendeeEmail", r.attendee_metadata AS metadata,
                  CASE r.status
                    WHEN 'reserved' THEN 'registered'
                    WHEN 'confirmed' THEN 'registered'
                    WHEN 'checked_in' THEN 'attended'
                    WHEN 'refunded' THEN 'cancelled'
                    ELSE r.status
                  END AS status,
                  r.status AS "sourceStatus", r.source_kind AS "sourceKind",
                  r.source_id AS "sourceId",r.historical_import AS "historicalImport", (r.source_kind IN('commerce','source_order')) AS "commerceManaged",
                  r.created_at AS "createdAt", r.updated_at AS "updatedAt"
             FROM association_registrations r
             JOIN association_events e
               ON e.workspace_id=r.workspace_id AND e.id=r.event_id
             LEFT JOIN entities c
               ON c.workspace_id=r.workspace_id AND c.id=r.attendee_contact_id
              AND c.valid_to IS NULL AND c.retracted_at IS NULL
            WHERE r.workspace_id=$1
              AND ($2::uuid IS NULL OR r.attendee_contact_id=$2)
              AND ($3::uuid IS NULL OR r.event_id=$3)
              AND ($4::text IS NULL OR r.source_kind=$4) AND ($6::uuid[] IS NULL OR r.event_id=ANY($6::uuid[]))
         ) p
         WHERE ($5::text IS NULL OR p.status=$5)`,
        [workspaceId, filters.contactId ?? null, filters.eventId ?? null,
          filters.sourceKind ?? null, filters.status ?? null, select(workspaceId, 'crm.participation.read', 'eventIds')],
      )
    },

    async listRecordFields(workspaceId, filters = {}) {
      authorize(workspaceId, 'crm.records.read')
      return readCrmFieldCatalog(workspaceId, filters)
    },

    async listPipelines(workspaceId, filters = {}) {
      authorize(workspaceId, 'crm.records.read')
      const includeArchived = filters.includeArchived ?? false
      return page('pipelines', workspaceId, filters,
        `SELECT p.id, p.id::text AS "pipelineKey", 'deal'::text AS "entityKind",
                p.name, p.is_default AS "isDefault", p.position,
                p.archived_at AS "archivedAt", p.created_at AS "createdAt", p.updated_at AS "updatedAt",
                COALESCE(jsonb_agg(jsonb_build_object(
                  'id', s.id, 'pipelineId', s.pipeline_id,
                  'stageKey', COALESCE(s.legacy_key, s.id::text),
                  'name', s.name, 'category', s.category, 'position', s.position,
                  'probability', s.probability, 'requiredFields', s.required_fields,
                  'archivedAt', s.archived_at
                ) ORDER BY s.archived_at NULLS FIRST, s.position, s.id)
                  FILTER (WHERE s.id IS NOT NULL), '[]'::jsonb) AS stages
           FROM crm_pipelines p
           LEFT JOIN crm_pipeline_stages s
             ON s.workspace_id=p.workspace_id AND s.pipeline_id=p.id
            AND ($2::boolean OR s.archived_at IS NULL)
          WHERE p.workspace_id=$1 AND ($2::boolean OR p.archived_at IS NULL)
          GROUP BY p.id`,
        [workspaceId, includeArchived],
      )
    },

    async checkSendability(workspaceId, contactId, channel, purposeKey) {
      authorize(workspaceId, 'crm.consent.read')
      if (integration) requireCrmIntegrationResources(integration, 'crm.consent.read', { purposeKeys: purposeKey })
      const purpose = await query<{
        id: string
        archivedAt: Date | null
        requiresConsent: boolean
        applicableChannels: CrmDeliveryChannel[]
      }>(
        `SELECT id, archived_at AS "archivedAt", requires_consent AS "requiresConsent",
                applicable_channels AS "applicableChannels"
           FROM crm_consent_purposes WHERE workspace_id=$1 AND purpose_key=$2`,
        [workspaceId, purposeKey],
      )
      if (!purpose.rows[0]) {
        const valid: Record<string, unknown>[] = []
        let cursor: string | undefined
        do {
          const page = await listConsentPurposes(workspaceId, true, { limit: 100, cursor }, 'crm.consent.read')
          valid.push(...page.purposes)
          cursor = page.nextCursor ?? undefined
        } while (cursor)
        throw new CrmOperationsError('catalog_key_invalid', 'Consent purpose is unavailable.', {
          purposeKey,
          validValues: valid.map((row) => row.purposeKey),
        })
      }
      const contact = await query<{
        email: string | null
        phone: string | null
        providerIdentity: boolean
        providerSubjects: string[]
      }>(
        `SELECT COALESCE(NULLIF(e.attributes->>'email',''), e.canonical_id) AS email,
                NULLIF(e.attributes->>'phone','') AS phone,
                EXISTS(SELECT 1 FROM association_external_identities i
                  WHERE i.workspace_id=e.workspace_id AND i.contact_id=e.id
                    AND i.provider=$3) AS "providerIdentity",
                ARRAY(SELECT i.provider_subject FROM association_external_identities i
                  WHERE i.workspace_id=e.workspace_id AND i.contact_id=e.id AND i.provider=$3) AS "providerSubjects"
           FROM entities e
          WHERE e.workspace_id=$1 AND e.id=$2 AND e.kind='person'
            AND e.valid_to IS NULL AND e.retracted_at IS NULL`,
        [workspaceId, contactId, channel],
      )
      const contactRow = contact.rows[0]
      if (!contactRow) throw new CrmOperationsError('not_found', 'CRM contact was not found.')
      const [consent, suppressions] = await Promise.all([
        query<{ id: string; action: 'granted' | 'withdrawn'; occurredAt: string; createdAt: string }>(
          `SELECT id, action,
                  to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt",
                  to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
             FROM association_consent_events
            WHERE workspace_id=$1 AND contact_id=$2 AND purpose=$3
            ORDER BY occurred_at DESC,created_at DESC,id DESC LIMIT 1`,
          [workspaceId, contactId, purposeKey],
        ),
        query<{ id: string; channel: 'all' | CrmDeliveryChannel; action: 'suppressed' | 'released'; occurredAt: string; createdAt: string }>(
          `SELECT DISTINCT ON (channel) id, channel, action,
                  to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt",
                  to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
             FROM crm_suppression_events
            WHERE workspace_id=$1 AND contact_id=$2 AND channel IN ('all',$3)
            ORDER BY channel,occurred_at DESC,created_at DESC,id DESC`,
          [workspaceId, contactId, channel],
        ),
      ])
      const hasContactMethod = channel === 'email' ? Boolean(contactRow.email)
        : channel === 'sms' || channel === 'phone' || channel === 'whatsapp'
          ? Boolean(contactRow.phone) : contactRow.providerIdentity
      const verdict = evaluateCrmSendability({
        channel,
        hasContactMethod,
        purpose: {
          archived: Boolean(purpose.rows[0].archivedAt),
          requiresConsent: purpose.rows[0].requiresConsent,
          applicableChannels: purpose.rows[0].applicableChannels,
        },
        consentEvents: consent.rows,
        suppressionEvents: suppressions.rows,
      })
      const destinations = channel === 'email' ? [contactRow.email] : ['phone','sms','whatsapp'].includes(channel)
        ? [contactRow.phone] : contactRow.providerSubjects ?? []
      const retained = (await Promise.all(destinations.filter((value): value is string => Boolean(value))
        .map((address) => readCrmAddressSuppressions({ query },workspaceId,channel,address,purposeKey)))).flat()
      if (retained.length) { verdict.verdict = 'blocked'; verdict.reasons.push('address_suppression'); verdict.effectiveSuppressionEventIds.push(...retained.map((row) => row.id)) }
      return verdict
    },
  }
}
