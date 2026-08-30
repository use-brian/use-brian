/**
 * Read/authentication store for CRM intake definitions and credentials.
 * Authentication is deliberately separate from Brain/API keys: an intake
 * principal resolves only a workspace and one bound definition.
 *
 * [COMP:api/crm-intake-route]
 */

import {
  CrmOperationsError,
  evaluateCrmSendability,
  type CrmDeliveryChannel,
  type CrmOperationsReadPort,
} from '@use-brian/core'
import { query } from './client.js'
import { verifySecret } from './api-key-store.js'
import { createDbCrmSegmentStore } from './crm-segment-store.js'

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
  listDefinitions(workspaceId: string): Promise<Array<Record<string, unknown>>>
  listCredentials(workspaceId: string): Promise<Array<Record<string, unknown>>>
}

export type DbCrmOperationsReadStore = CrmIntakeReadStore & CrmOperationsReadPort & {
  resolveLegacyPipelineStage(workspaceId: string, stageKey: string): Promise<{
    pipelineId: string
    stageId: string
  } | null>
  listCrmEventFilterCatalog(workspaceId: string): Promise<{
    eventTypes: string[]
    stableKeys: Array<{ kind: string; key: string; label: string }>
  }>
}

export function createDbCrmIntakeReadStore(): DbCrmOperationsReadStore {
  const segmentStore = createDbCrmSegmentStore()
  const listDefinitions = async (workspaceId: string) => {
    const result = await query<Record<string, unknown>>(
      `SELECT d.id, d.definition_key AS "definitionKey", d.label, d.active,
              d.current_version AS "currentVersion", v.field_catalog AS fields,
              v.identity_policy AS "identityPolicy",
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
        WHERE d.workspace_id = $1
        ORDER BY d.label, d.id
        LIMIT 200`,
      [workspaceId],
    )
    return result.rows
  }

  const listConsentPurposes = async (workspaceId: string, includeArchived = false) => {
    const result = await query<Record<string, unknown>>(
      `SELECT id, purpose_key AS "purposeKey", label, description,
              requires_consent AS "requiresConsent",
              applicable_channels AS "applicableChannels",
              active_wording_version AS "wordingVersion",
              wording_snapshot AS wording, wording_hash AS "wordingHash",
              archived_at AS "archivedAt", created_at AS "createdAt",
              updated_at AS "updatedAt"
         FROM crm_consent_purposes
        WHERE workspace_id=$1 AND ($2::boolean OR archived_at IS NULL)
        ORDER BY label, id
        LIMIT 200`,
      [workspaceId, includeArchived],
    )
    return result.rows
  }

  return {
    ...segmentStore,
    async authenticate(token, definitionKey) {
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

    async listCredentials(workspaceId) {
      const result = await query<Record<string, unknown>>(
        `SELECT c.id, c.label, c.secret_prefix AS prefix,
                c.revoked_at AS "revokedAt", c.last_used_at AS "lastUsedAt",
                c.created_at AS "createdAt",
                COALESCE(array_agg(b.definition_id ORDER BY b.definition_id)
                  FILTER (WHERE b.definition_id IS NOT NULL), '{}') AS "definitionIds"
           FROM crm_intake_credentials c
           LEFT JOIN crm_intake_credential_definitions b
             ON b.workspace_id = c.workspace_id AND b.credential_id = c.id
          WHERE c.workspace_id = $1
          GROUP BY c.id
          ORDER BY c.created_at DESC, c.id DESC
          LIMIT 200`,
        [workspaceId],
      )
      return result.rows
    },

    async listSubmissions(workspaceId, filters = {}) {
      const limit = Math.min(100, Math.max(1, filters.limit ?? 50))
      const result = await query<Record<string, unknown>>(
        `SELECT e.id, e.contact_id AS "contactId", c.display_name AS "contactName",
                e.definition_id AS "definitionId", d.definition_key AS "definitionKey",
                d.label AS "definitionLabel", e.status, e.queue_key AS "queueKey",
                e.owner_user_id AS "ownerUserId", e.follow_up_task_id AS "followUpTaskId",
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
          ORDER BY e.submitted_at DESC, e.id DESC
          LIMIT $5`,
        [workspaceId, filters.status ?? null, filters.definitionKey ?? null,
          filters.ownerUserId ?? null, limit],
      )
      return result.rows
    },

    async getSubmission(workspaceId, submissionId) {
      const result = await query<Record<string, unknown>>(
        `SELECT e.id, e.contact_id AS "contactId", c.display_name AS "contactName",
                e.definition_id AS "definitionId", d.definition_key AS "definitionKey",
                d.label AS "definitionLabel", e.definition_version_id AS "definitionVersionId",
                e.definition_schema_hash AS "definitionSchemaHash",
                e.definition_schema_snapshot AS "definitionSchemaSnapshot",
                e.submitted_data AS fields, e.status, e.queue_key AS "queueKey",
                e.owner_user_id AS "ownerUserId", e.follow_up_task_id AS "followUpTaskId",
                e.submitted_at AS "submittedAt", e.created_at AS "createdAt",
                e.updated_at AS "updatedAt",
                COALESCE((SELECT jsonb_agg(jsonb_build_object(
                  'id', n.id, 'body', n.body, 'actorKind', n.actor_kind,
                  'actingUserId', n.acting_user_id, 'createdAt', n.created_at
                ) ORDER BY n.created_at, n.id)
                FROM association_enquiry_notes n
                WHERE n.workspace_id=e.workspace_id AND n.enquiry_id=e.id), '[]'::jsonb) AS notes
           FROM association_enquiries e
           JOIN entities c ON c.workspace_id=e.workspace_id AND c.id=e.contact_id
           LEFT JOIN crm_intake_definitions d
             ON d.workspace_id=e.workspace_id AND d.id=e.definition_id
          WHERE e.workspace_id=$1 AND e.id=$2`,
        [workspaceId, submissionId],
      )
      return result.rows[0] ?? null
    },

    listConsentPurposes,

    async getConsent(workspaceId, contactId) {
      const contact = await query(`SELECT 1 FROM entities WHERE workspace_id=$1 AND id=$2 AND kind='person'`, [workspaceId, contactId])
      if (contact.rowCount !== 1) throw new CrmOperationsError('not_found', 'CRM contact was not found.')
      const [purposes, events, suppressions] = await Promise.all([
        listConsentPurposes(workspaceId, true),
        query<Record<string, unknown>>(
          `SELECT e.id, e.purpose_id AS "purposeId", e.purpose AS "purposeKey",
                  e.action, e.wording_version AS "wordingVersion",
                  e.wording_hash AS "wordingHash", e.wording_snapshot AS wording,
                  e.source, e.occurred_at AS "occurredAt", e.provider,
                  e.provider_event_id AS "providerEventId", e.actor_kind AS "actorKind",
                  e.acting_user_id AS "actingUserId", e.created_at AS "createdAt"
             FROM association_consent_events e
            WHERE e.workspace_id=$1 AND e.contact_id=$2
            ORDER BY e.occurred_at DESC, e.created_at DESC, e.id DESC
            LIMIT 500`,
          [workspaceId, contactId],
        ).then((rows) => rows.rows),
        query<Record<string, unknown>>(
          `SELECT id, channel, action, reason_code AS "reasonCode", source,
                  occurred_at AS "occurredAt", provider,
                  provider_event_id AS "providerEventId", actor_kind AS "actorKind",
                  acting_user_id AS "actingUserId", created_at AS "createdAt"
             FROM crm_suppression_events
            WHERE workspace_id=$1 AND contact_id=$2
            ORDER BY occurred_at DESC, created_at DESC, id DESC
            LIMIT 500`,
          [workspaceId, contactId],
        ).then((rows) => rows.rows),
      ])
      return { purposes, events, suppressions }
    },

    async listEntitlementPlans(workspaceId, filters = {}) {
      const limit = Math.min(100, Math.max(1, filters.limit ?? 50))
      const result = await query<Record<string, unknown>>(
        `SELECT p.id, p.plan_key AS "planKey", p.name, p.currency,
                p.fee_minor::text AS "feeMinor", p.billing_period AS "billingPeriod",
                p.benefits, p.eligibility_note AS "eligibilityNote",
                p.active_from AS "activeFrom", p.active_to AS "activeTo",
                p.published, p.provider, p.provider_plan_id AS "providerPlanId",
                (p.fee_minor > 0 OR p.provider IS NOT NULL) AS "commerceManaged",
                p.created_at AS "createdAt", p.updated_at AS "updatedAt"
           FROM association_membership_plans p
          WHERE p.workspace_id=$1
            AND ($2::boolean IS NULL OR p.published=$2)
          ORDER BY p.name, p.id LIMIT $3`,
        [workspaceId, filters.published ?? null, limit],
      )
      return result.rows
    },

    async listEntitlements(workspaceId, filters = {}) {
      const limit = Math.min(100, Math.max(1, filters.limit ?? 50))
      const result = await query<Record<string, unknown>>(
        `SELECT m.id, m.contact_id AS "contactId", c.display_name AS "contactName",
                m.plan_id AS "planId", p.plan_key AS "planKey", p.name AS "planName",
                m.status, m.starts_at AS "startsAt", m.ends_at AS "endsAt",
                m.renewal_mode AS "renewalMode", m.provider,
                m.provider_membership_id AS "providerEntitlementId",
                m.created_at AS "createdAt", m.updated_at AS "updatedAt"
           FROM association_memberships m
           JOIN association_membership_plans p
             ON p.workspace_id=m.workspace_id AND p.id=m.plan_id
           JOIN entities c
             ON c.workspace_id=m.workspace_id AND c.id=m.contact_id
          WHERE m.workspace_id=$1
            AND ($2::uuid IS NULL OR m.contact_id=$2)
            AND ($3::uuid IS NULL OR m.plan_id=$3)
            AND ($4::text IS NULL OR m.status=$4)
            AND c.valid_to IS NULL AND c.retracted_at IS NULL
          ORDER BY m.created_at DESC, m.id DESC LIMIT $5`,
        [workspaceId, filters.contactId ?? null, filters.planId ?? null,
          filters.status ?? null, limit],
      )
      return result.rows
    },

    async listEvents(workspaceId, filters = {}) {
      const limit = Math.min(100, Math.max(1, filters.limit ?? 50))
      const result = await query<Record<string, unknown>>(
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
          WHERE e.workspace_id=$1 AND ($2::text IS NULL OR e.status=$2)
          ORDER BY e.starts_at DESC, e.id DESC LIMIT $3`,
        [workspaceId, filters.status ?? null, limit],
      )
      return result.rows
    },

    async listParticipation(workspaceId, filters = {}) {
      const limit = Math.min(100, Math.max(1, filters.limit ?? 50))
      const result = await query<Record<string, unknown>>(
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
                  r.source_id AS "sourceId", (r.source_kind='commerce') AS "commerceManaged",
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
              AND ($4::text IS NULL OR r.source_kind=$4)
         ) p
         WHERE ($5::text IS NULL OR p.status=$5)
         ORDER BY p."createdAt" DESC, p.id DESC LIMIT $6`,
        [workspaceId, filters.contactId ?? null, filters.eventId ?? null,
          filters.sourceKind ?? null, filters.status ?? null, limit],
      )
      return result.rows
    },

    async listPipelines(workspaceId, filters = {}) {
      const includeArchived = filters.includeArchived ?? false
      const result = await query<Record<string, unknown>>(
        `SELECT p.id, p.id::text AS "pipelineKey", 'deal'::text AS "entityKind",
                p.name, p.is_default AS "isDefault", p.position,
                p.archived_at AS "archivedAt",
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
          GROUP BY p.id
          ORDER BY p.archived_at NULLS FIRST, p.position, p.id
          LIMIT 100`,
        [workspaceId, includeArchived],
      )
      return result.rows
    },

    async checkSendability(workspaceId, contactId, channel, purposeKey) {
      const purpose = await query<{
        id: string
        archivedAt: Date | null
        requiresConsent: boolean
      }>(
        `SELECT id, archived_at AS "archivedAt", requires_consent AS "requiresConsent"
           FROM crm_consent_purposes WHERE workspace_id=$1 AND purpose_key=$2`,
        [workspaceId, purposeKey],
      )
      if (!purpose.rows[0]) {
        const valid = await query<{ purposeKey: string }>(
          `SELECT purpose_key AS "purposeKey" FROM crm_consent_purposes
            WHERE workspace_id=$1 ORDER BY purpose_key LIMIT 100`,
          [workspaceId],
        )
        throw new CrmOperationsError('catalog_key_invalid', 'Consent purpose is unavailable.', {
          purposeKey,
          validValues: valid.rows.map((row) => row.purposeKey),
        })
      }
      const contact = await query<{
        email: string | null
        phone: string | null
        providerIdentity: boolean
      }>(
        `SELECT COALESCE(NULLIF(e.attributes->>'email',''), e.canonical_id) AS email,
                NULLIF(e.attributes->>'phone','') AS phone,
                EXISTS(SELECT 1 FROM association_external_identities i
                  WHERE i.workspace_id=e.workspace_id AND i.contact_id=e.id
                    AND i.provider=$3) AS "providerIdentity"
           FROM entities e
          WHERE e.workspace_id=$1 AND e.id=$2 AND e.kind='person'
            AND e.valid_to IS NULL AND e.retracted_at IS NULL`,
        [workspaceId, contactId, channel],
      )
      const contactRow = contact.rows[0]
      if (!contactRow) throw new CrmOperationsError('not_found', 'CRM contact was not found.')
      const [consent, suppressions] = await Promise.all([
        query<{ id: string; action: 'granted' | 'withdrawn'; occurredAt: Date; createdAt: Date }>(
          `SELECT id, action, occurred_at AS "occurredAt", created_at AS "createdAt"
             FROM association_consent_events
            WHERE workspace_id=$1 AND contact_id=$2 AND purpose=$3`,
          [workspaceId, contactId, purposeKey],
        ),
        query<{ id: string; channel: 'all' | CrmDeliveryChannel; action: 'suppressed' | 'released'; occurredAt: Date; createdAt: Date }>(
          `SELECT id, channel, action, occurred_at AS "occurredAt", created_at AS "createdAt"
             FROM crm_suppression_events
            WHERE workspace_id=$1 AND contact_id=$2 AND channel IN ('all',$3)`,
          [workspaceId, contactId, channel],
        ),
      ])
      const hasContactMethod = channel === 'email' ? Boolean(contactRow.email)
        : channel === 'sms' || channel === 'phone' || channel === 'whatsapp'
          ? Boolean(contactRow.phone) : contactRow.providerIdentity
      return evaluateCrmSendability({
        channel,
        hasContactMethod,
        purpose: {
          archived: Boolean(purpose.rows[0].archivedAt),
          requiresConsent: purpose.rows[0].requiresConsent,
        },
        consentEvents: consent.rows,
        suppressionEvents: suppressions.rows,
      })
    },
  }
}
