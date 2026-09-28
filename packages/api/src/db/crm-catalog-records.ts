/**
 * Transaction-bound persistence shared by CRM and Association catalog commands.
 * This module owns records only and never begins or completes a transaction.
 *
 * [COMP:crm/provider-entitlement-service]
 */
import type { PoolClient, QueryResultRow } from 'pg'
import { AssociationError } from '@use-brian/core'
import type { EventInput, PlanInput } from '../association/domain.js'
import { lockAssociationInventory, refreshAssociationInventory } from '../association/inventory.js'

type CatalogRecord = QueryResultRow & Record<string, unknown>
export type CatalogMutationResult = { record: Record<string, unknown>; created: boolean }

const PLAN_SELECT = `
  id, workspace_id AS "workspaceId", plan_key AS "key", name, currency,
  fee_minor::text AS "feeMinor", billing_period AS "billingPeriod", benefits,
  eligibility_note AS "eligibilityNote", active_from AS "activeFrom",
  active_to AS "activeTo", published, provider, provider_plan_id AS "providerPlanId",
  created_at AS "createdAt", updated_at AS "updatedAt"`
const EVENT_SELECT = `
  id, workspace_id AS "workspaceId", slug, programme_key AS "programmeKey",
  title, description, starts_at AS "startsAt", ends_at AS "endsAt", timezone,
  mode, venue, online_url AS "onlineUrl",
  registration_opens_at AS "registrationOpensAt",
  registration_closes_at AS "registrationClosesAt", capacity, status,
  canonical_url AS "canonicalUrl", metadata,
  created_at AS "createdAt", updated_at AS "updatedAt"`

export async function saveCrmEntitlementPlanRecord(
  client: PoolClient,
  workspaceId: string,
  input: PlanInput,
  publishing = false,
): Promise<CatalogMutationResult> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('membership-catalogue:'||$1,0))", [workspaceId])
  if (!publishing) {
    const managed = await client.query(`SELECT 1 FROM association_membership_catalogues c
      JOIN association_membership_catalogue_revisions r ON r.workspace_id=c.workspace_id AND r.revision=c.published_revision
      WHERE c.workspace_id=$1 AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.document->'plans') p WHERE p->>'key'=$2)`, [workspaceId, input.key])
    if (managed.rows.length) throw new AssociationError('conflict', 'Edit this website plan in the membership catalogue, then preview and publish it.')
  }
  const before = await client.query<{ id: string }>(
    'SELECT id FROM association_membership_plans WHERE workspace_id = $1 AND plan_key = $2',
    [workspaceId, input.key],
  )
  const result = await client.query<CatalogRecord>(
    `INSERT INTO association_membership_plans
       (workspace_id, plan_key, name, currency, fee_minor, billing_period,
        benefits, eligibility_note, active_from, active_to, published,
        provider, provider_plan_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (workspace_id, plan_key) DO UPDATE SET
       name = EXCLUDED.name, currency = EXCLUDED.currency,
       fee_minor = EXCLUDED.fee_minor, billing_period = EXCLUDED.billing_period,
       benefits = EXCLUDED.benefits, eligibility_note = EXCLUDED.eligibility_note,
       active_from = EXCLUDED.active_from, active_to = EXCLUDED.active_to,
       published = EXCLUDED.published, provider = EXCLUDED.provider,
       provider_plan_id = EXCLUDED.provider_plan_id
     RETURNING ${PLAN_SELECT}`,
    [workspaceId, input.key, input.name, input.currency, input.feeMinor,
      input.billingPeriod, input.benefits, input.eligibilityNote ?? null,
      input.activeFrom ?? null, input.activeTo ?? null, input.published,
      input.provider ?? null, input.providerPlanId ?? null],
  )
  return { record: result.rows[0], created: before.rows.length === 0 }
}

export async function saveCrmEventRecord(
  client: PoolClient,
  workspaceId: string,
  input: EventInput,
  actorKind = 'system_job',
): Promise<CatalogMutationResult> {
  const before = await client.query<{ id: string }>(
    'SELECT id FROM association_events WHERE workspace_id = $1 AND slug = $2',
    [workspaceId, input.slug],
  )
  if (before.rows[0]) await lockAssociationInventory(client, workspaceId, { eventIds: [before.rows[0].id] })
  const result = await client.query<CatalogRecord>(
    `INSERT INTO association_events
       (workspace_id, slug, programme_key, title, description, starts_at,
        ends_at, timezone, mode, venue, online_url, registration_opens_at,
        registration_closes_at, capacity, status, canonical_url, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (workspace_id, slug) DO UPDATE SET
       programme_key = EXCLUDED.programme_key, title = EXCLUDED.title,
       description = EXCLUDED.description, starts_at = EXCLUDED.starts_at,
       ends_at = EXCLUDED.ends_at, timezone = EXCLUDED.timezone,
       mode = EXCLUDED.mode, venue = EXCLUDED.venue,
       online_url = EXCLUDED.online_url,
       registration_opens_at = EXCLUDED.registration_opens_at,
       registration_closes_at = EXCLUDED.registration_closes_at,
       capacity = EXCLUDED.capacity, status = EXCLUDED.status,
       canonical_url = EXCLUDED.canonical_url, metadata = EXCLUDED.metadata
     RETURNING ${EVENT_SELECT}`,
    [workspaceId, input.slug, input.programmeKey ?? null, input.title,
      input.description, input.startsAt, input.endsAt, input.timezone,
      input.mode, input.venue ?? null, input.onlineUrl ?? null,
      input.registrationOpensAt ?? null, input.registrationClosesAt ?? null,
      input.capacity ?? null, input.status, input.canonicalUrl ?? null,
      input.metadata],
  )
  const event = result.rows[0]
  await refreshAssociationInventory(client, workspaceId, [String(event.id)], actorKind)
  return { record: event, created: before.rows.length === 0 }
}
