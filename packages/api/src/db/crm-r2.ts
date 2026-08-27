/**
 * CRM R2 persistence and deterministic projections.
 *
 * CRM records remain `entities`; this module owns only the bounded
 * configuration, relationship activity, saved operator views, participants,
 * archive attribute, duplicate candidates, and deterministic reports added by
 * migration 455.
 *
 * Spec: docs/architecture/features/crm.md -> "CRM R2 product contract".
 * [COMP:crm/r2-store]
 */

import {
  stitchMailboxThreads,
  type AccessContext,
  type EntityRecord,
  type MailboxSearchHit,
} from '@use-brian/core'
import type { PoolClient } from 'pg'
import { buildAccessPredicate } from './access-predicate.js'
import { applyRLSGucs, getPool, query, queryGated, queryWithRLS } from './client.js'
import { getEntityById, updateEntity } from './entities-store.js'

export const CRM_FIELD_TYPES = [
  'text', 'number', 'date', 'boolean', 'single_select', 'multi_select',
  'entity_reference',
] as const
export type CrmFieldType = (typeof CRM_FIELD_TYPES)[number]
export type CrmEntityKind = 'person' | 'company' | 'deal'
export type CrmStageCategory = 'open' | 'won' | 'lost'

export const CRM_REFERENCE_KINDS = ['person', 'company', 'deal'] as const
export type CrmReferenceKind = (typeof CRM_REFERENCE_KINDS)[number]

export type CrmPipelineStage = {
  id: string
  pipelineId: string
  name: string
  legacyKey: string | null
  category: CrmStageCategory
  position: number
  probability: number
  requiredFields: string[]
  archivedAt?: string | null
}

export type CrmPipeline = {
  id: string
  name: string
  isDefault: boolean
  position: number
  stages: CrmPipelineStage[]
  archivedAt?: string | null
}

export type CrmFieldDefinition = {
  id: string
  entityKind: CrmEntityKind
  fieldKey: string
  label: string
  fieldType: CrmFieldType
  options: string[]
  isRequired: boolean
  position: number
  archivedAt?: string | null
}

export type CrmConfig = {
  pipelines: CrmPipeline[]
  fields: CrmFieldDefinition[]
}

export const CRM_PRESET_IDS = [
  'services_saas', 'enterprise_sales', 'partnership_referral',
] as const
export type CrmPresetId = (typeof CRM_PRESET_IDS)[number]

type CrmPresetField = Omit<CrmFieldDefinition, 'id' | 'position'>

export const CRM_FIELD_PRESETS: Record<CrmPresetId, readonly CrmPresetField[]> = {
  services_saas: [
    { entityKind: 'deal', fieldKey: 'work_type', label: 'Work type', fieldType: 'single_select', options: ['Consulting / services', 'SaaS', 'On-premise'], isRequired: false },
    { entityKind: 'deal', fieldKey: 'opportunity_type', label: 'Opportunity type', fieldType: 'single_select', options: ['New business', 'Upsell', 'Referral'], isRequired: false },
    { entityKind: 'company', fieldKey: 'upsell_potential', label: 'Upsell potential', fieldType: 'multi_select', options: ['Consulting / services', 'SaaS', 'On-premise'], isRequired: false },
    { entityKind: 'company', fieldKey: 'referral_potential', label: 'Referral potential', fieldType: 'single_select', options: ['None', 'Low', 'Medium', 'High'], isRequired: false },
    { entityKind: 'company', fieldKey: 'referral_audience', label: 'Referral audience', fieldType: 'multi_select', options: ['Partner network', 'Portfolio companies', 'Peer businesses', 'Other'], isRequired: false },
  ],
  enterprise_sales: [
    { entityKind: 'deal', fieldKey: 'deployment_model', label: 'Deployment model', fieldType: 'single_select', options: ['Cloud', 'Hybrid', 'On-premise'], isRequired: false },
    { entityKind: 'deal', fieldKey: 'security_review_status', label: 'Security review', fieldType: 'single_select', options: ['Not started', 'In progress', 'Approved', 'Blocked'], isRequired: false },
    { entityKind: 'deal', fieldKey: 'procurement_status', label: 'Procurement status', fieldType: 'single_select', options: ['Not started', 'In progress', 'Approved', 'Blocked'], isRequired: false },
    { entityKind: 'company', fieldKey: 'account_tier', label: 'Account tier', fieldType: 'single_select', options: ['Strategic', 'Growth', 'Standard'], isRequired: false },
  ],
  partnership_referral: [
    { entityKind: 'deal', fieldKey: 'referral_source', label: 'Referral source', fieldType: 'entity_reference', options: ['person', 'company'], isRequired: false },
    { entityKind: 'deal', fieldKey: 'opportunity_type', label: 'Opportunity type', fieldType: 'single_select', options: ['New business', 'Upsell', 'Referral'], isRequired: false },
    { entityKind: 'company', fieldKey: 'referral_potential', label: 'Referral potential', fieldType: 'single_select', options: ['None', 'Low', 'Medium', 'High'], isRequired: false },
    { entityKind: 'company', fieldKey: 'referral_audience', label: 'Referral audience', fieldType: 'multi_select', options: ['Partner network', 'Portfolio companies', 'Peer businesses', 'Other'], isRequired: false },
  ],
}

const DEFAULT_STAGES = [
  ['Lead', 'lead', 'open', 0, 10],
  ['Qualified', 'qualified', 'open', 1, 30],
  ['Proposal', 'proposal', 'open', 2, 60],
  ['Negotiation', 'negotiation', 'open', 3, 80],
  ['Won', 'won', 'won', 4, 100],
  ['Lost', 'lost', 'lost', 5, 0],
] as const

/** Lazy seed for workspaces created after migration 455. */
export async function ensureCrmDefaultPipeline(workspaceId: string): Promise<string> {
  const existing = await query<{ id: string }>(
    `SELECT id FROM crm_pipelines
      WHERE workspace_id = $1 AND is_default AND archived_at IS NULL LIMIT 1`,
    [workspaceId],
  )
  if (existing.rows[0]) return existing.rows[0].id

  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const pipeline = await client.query<{ id: string }>(
      `INSERT INTO crm_pipelines (workspace_id, name, is_default, position)
       VALUES ($1, 'Sales', true, 0)
       ON CONFLICT (workspace_id) WHERE is_default AND archived_at IS NULL DO UPDATE
         SET is_default = EXCLUDED.is_default
       RETURNING id`,
      [workspaceId],
    )
    const pipelineId = pipeline.rows[0].id
    for (const [name, legacyKey, category, position, probability] of DEFAULT_STAGES) {
      await client.query(
        `INSERT INTO crm_pipeline_stages
           (workspace_id, pipeline_id, name, legacy_key, category, position, probability)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (pipeline_id, name) DO NOTHING`,
        [workspaceId, pipelineId, name, legacyKey, category, position, probability],
      )
    }
    await client.query('COMMIT')
    return pipelineId
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

type ConfigStageRow = Omit<CrmPipelineStage, 'requiredFields' | 'archivedAt'> & {
  requiredFields: string[] | null
  archivedAt: Date | null
}
type ConfigFieldRow = Omit<CrmFieldDefinition, 'options' | 'archivedAt'> & {
  options: unknown
  archivedAt: Date | null
}

export async function getCrmConfig(
  userId: string,
  workspaceId: string,
  includeArchived = false,
): Promise<CrmConfig> {
  await ensureCrmDefaultPipeline(workspaceId)
  const [pipelineRows, stageRows, fieldRows] = await Promise.all([
    queryWithRLS<{ id: string; name: string; isDefault: boolean; position: number; archivedAt: Date | null }>(
      userId,
      `SELECT id, name, is_default AS "isDefault", position, archived_at AS "archivedAt"
         FROM crm_pipelines WHERE workspace_id = $1
           ${includeArchived ? '' : 'AND archived_at IS NULL'}
        ORDER BY archived_at NULLS FIRST, position, created_at`,
      [workspaceId],
    ),
    queryWithRLS<ConfigStageRow>(
      userId,
      `SELECT id, pipeline_id AS "pipelineId", name, legacy_key AS "legacyKey",
              category, position, probability, required_fields AS "requiredFields",
              archived_at AS "archivedAt"
         FROM crm_pipeline_stages WHERE workspace_id = $1
           ${includeArchived ? '' : 'AND archived_at IS NULL'}
        ORDER BY archived_at NULLS FIRST, pipeline_id, position`,
      [workspaceId],
    ),
    queryWithRLS<ConfigFieldRow>(
      userId,
      `SELECT id, entity_kind AS "entityKind", field_key AS "fieldKey", label,
              field_type AS "fieldType", options, is_required AS "isRequired", position,
              archived_at AS "archivedAt"
         FROM crm_field_definitions
        WHERE workspace_id = $1 ${includeArchived ? '' : 'AND archived_at IS NULL'}
        ORDER BY archived_at NULLS FIRST, entity_kind, position, created_at`,
      [workspaceId],
    ),
  ])
  const stagesByPipeline = new Map<string, CrmPipelineStage[]>()
  for (const row of stageRows.rows) {
    const stages = stagesByPipeline.get(row.pipelineId) ?? []
    stages.push({
      ...row,
      requiredFields: row.requiredFields ?? [],
      archivedAt: row.archivedAt?.toISOString() ?? null,
    })
    stagesByPipeline.set(row.pipelineId, stages)
  }
  return {
    pipelines: pipelineRows.rows.map((p) => ({
      ...p,
      archivedAt: p.archivedAt?.toISOString() ?? null,
      stages: stagesByPipeline.get(p.id) ?? [],
    })),
    fields: fieldRows.rows.map((f) => ({
      ...f,
      archivedAt: f.archivedAt?.toISOString() ?? null,
      options: Array.isArray(f.options)
        ? f.options.filter((v): v is string => typeof v === 'string')
        : [],
    })),
  }
}

export async function createCrmPipeline(input: {
  userId: string
  workspaceId: string
  name: string
}): Promise<CrmPipeline> {
  const inserted = await queryWithRLS<{ id: string; name: string; isDefault: boolean; position: number }>(
    input.userId,
    `INSERT INTO crm_pipelines (workspace_id, name, is_default, position, created_by)
     VALUES ($1,$2,false,
       COALESCE((SELECT MAX(position) + 1 FROM crm_pipelines
                  WHERE workspace_id = $1 AND archived_at IS NULL), 0),$3)
     RETURNING id, name, is_default AS "isDefault", position, NULL::timestamptz AS "archivedAt"`,
    [input.workspaceId, input.name, input.userId],
  )
  return { ...inserted.rows[0], stages: [] }
}

export async function createCrmStage(input: {
  userId: string
  workspaceId: string
  pipelineId: string
  name: string
  category: CrmStageCategory
  probability: number
  requiredFields?: string[]
}): Promise<CrmPipelineStage | null> {
  const inserted = await queryWithRLS<ConfigStageRow>(
    input.userId,
    `INSERT INTO crm_pipeline_stages
       (workspace_id, pipeline_id, name, category, position, probability, required_fields)
     SELECT $1,$2,$3,$4,
       COALESCE((SELECT MAX(position) + 1 FROM crm_pipeline_stages
                  WHERE pipeline_id = $2 AND archived_at IS NULL),0),
       $5,$6
     WHERE EXISTS (SELECT 1 FROM crm_pipelines
                    WHERE id = $2 AND workspace_id = $1 AND archived_at IS NULL)
     RETURNING id, pipeline_id AS "pipelineId", name, legacy_key AS "legacyKey",
       category, position, probability, required_fields AS "requiredFields",
       NULL::timestamptz AS "archivedAt"`,
    [input.workspaceId, input.pipelineId, input.name, input.category, input.probability, input.requiredFields ?? []],
  )
  const row = inserted.rows[0]
  return row ? {
    ...row,
    requiredFields: row.requiredFields ?? [],
    archivedAt: row.archivedAt?.toISOString() ?? null,
  } : null
}

export async function updateCrmStage(input: {
  userId: string
  workspaceId: string
  stageId: string
  name?: string
  category?: CrmStageCategory
  probability?: number
  requiredFields?: string[]
}): Promise<CrmPipelineStage | null> {
  const updated = await queryWithRLS<ConfigStageRow>(
    input.userId,
    `UPDATE crm_pipeline_stages SET
       name = COALESCE($4, name),
       category = COALESCE($5, category),
       probability = COALESCE($6, probability),
       required_fields = COALESCE($7, required_fields)
     WHERE id = $2 AND workspace_id = $1 AND archived_at IS NULL
     RETURNING id, pipeline_id AS "pipelineId", name, legacy_key AS "legacyKey",
       category, position, probability, required_fields AS "requiredFields",
       archived_at AS "archivedAt"`,
    [input.workspaceId, input.stageId, input.userId, input.name ?? null,
      input.category ?? null, input.probability ?? null, input.requiredFields ?? null],
  )
  const row = updated.rows[0]
  return row ? {
    ...row,
    requiredFields: row.requiredFields ?? [],
    archivedAt: row.archivedAt?.toISOString() ?? null,
  } : null
}

async function withCrmConfigTransaction<T>(
  userId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client, userId)
    const value = await work(client)
    await client.query('COMMIT')
    return value
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

function assertExactOrder(actual: string[], requested: string[]): void {
  if (actual.length !== requested.length
    || new Set(actual).size !== actual.length
    || new Set(requested).size !== requested.length
    || actual.some((id) => !requested.includes(id))) {
    throw new Error('orderedIds must contain every live row exactly once')
  }
}

export async function updateCrmPipeline(input: {
  userId: string
  workspaceId: string
  pipelineId: string
  name?: string
  isDefault?: boolean
  archived?: boolean
}): Promise<boolean> {
  return withCrmConfigTransaction(input.userId, async (client) => {
    const selected = await client.query<{ isDefault: boolean; archivedAt: Date | null }>(
      `SELECT is_default AS "isDefault", archived_at AS "archivedAt"
         FROM crm_pipelines
        WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
      [input.pipelineId, input.workspaceId],
    )
    const pipeline = selected.rows[0]
    if (!pipeline) return false
    if (input.archived === true) {
      if (pipeline.isDefault) throw new Error('The default pipeline cannot be archived')
      const used = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM entities
          WHERE workspace_id = $1 AND kind = 'deal' AND valid_to IS NULL
            AND retracted_at IS NULL AND NOT (attributes ? 'crm_archived_at')
            AND attributes->>'pipeline_id' = $2`,
        [input.workspaceId, input.pipelineId],
      )
      const count = Number(used.rows[0]?.count ?? 0)
      if (count > 0) throw new Error(`Move ${count} live deal${count === 1 ? '' : 's'} before archiving this pipeline`)
    }
    if (input.isDefault === true && input.archived === true) {
      throw new Error('An archived pipeline cannot be the default')
    }
    if (input.archived === false && pipeline.archivedAt) {
      await client.query(
        `UPDATE crm_pipelines SET archived_at = NULL, is_default = false,
            position = COALESCE((SELECT MAX(position) + 1 FROM crm_pipelines
              WHERE workspace_id = $2 AND archived_at IS NULL), 0)
          WHERE id = $1 AND workspace_id = $2`,
        [input.pipelineId, input.workspaceId],
      )
    }
    if (input.name !== undefined) {
      await client.query(
        `UPDATE crm_pipelines SET name = $3
          WHERE id = $1 AND workspace_id = $2`,
        [input.pipelineId, input.workspaceId, input.name],
      )
    }
    if (input.isDefault === true) {
      await client.query(
        `UPDATE crm_pipelines SET is_default = false
          WHERE workspace_id = $1 AND archived_at IS NULL`,
        [input.workspaceId],
      )
      await client.query(
        `UPDATE crm_pipelines SET is_default = true
          WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL`,
        [input.pipelineId, input.workspaceId],
      )
    }
    if (input.archived === true) {
      await client.query(
        `UPDATE crm_pipelines SET archived_at = now(), is_default = false
          WHERE id = $1 AND workspace_id = $2`,
        [input.pipelineId, input.workspaceId],
      )
      await client.query(
        `UPDATE crm_pipelines SET position = position + 1000000
          WHERE workspace_id = $1 AND archived_at IS NULL`,
        [input.workspaceId],
      )
      await client.query(
        `WITH ranked AS (
           SELECT id, row_number() OVER (ORDER BY position, created_at) - 1 AS next_position
             FROM crm_pipelines WHERE workspace_id = $1 AND archived_at IS NULL
         )
         UPDATE crm_pipelines p SET position = ranked.next_position
           FROM ranked WHERE p.id = ranked.id`,
        [input.workspaceId],
      )
    }
    return true
  })
}

export async function reorderCrmPipelines(input: {
  userId: string
  workspaceId: string
  orderedIds: string[]
}): Promise<void> {
  await withCrmConfigTransaction(input.userId, async (client) => {
    const current = await client.query<{ id: string }>(
      `SELECT id FROM crm_pipelines
        WHERE workspace_id = $1 AND archived_at IS NULL ORDER BY position FOR UPDATE`,
      [input.workspaceId],
    )
    assertExactOrder(current.rows.map((row) => row.id), input.orderedIds)
    await client.query(
      `UPDATE crm_pipelines SET position = position + 1000000
        WHERE workspace_id = $1 AND archived_at IS NULL`,
      [input.workspaceId],
    )
    for (const [position, id] of input.orderedIds.entries()) {
      await client.query(
        `UPDATE crm_pipelines SET position = $3
          WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL`,
        [id, input.workspaceId, position],
      )
    }
  })
}

export async function setCrmStageArchived(input: {
  userId: string
  workspaceId: string
  stageId: string
  archived: boolean
}): Promise<boolean> {
  return withCrmConfigTransaction(input.userId, async (client) => {
    const selected = await client.query<{ pipelineId: string; archivedAt: Date | null }>(
      `SELECT pipeline_id AS "pipelineId", archived_at AS "archivedAt"
         FROM crm_pipeline_stages
        WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
      [input.stageId, input.workspaceId],
    )
    const stage = selected.rows[0]
    if (!stage) return false
    if (input.archived) {
      const used = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM entities
          WHERE workspace_id = $1 AND kind = 'deal' AND valid_to IS NULL
            AND retracted_at IS NULL AND NOT (attributes ? 'crm_archived_at')
            AND attributes->>'pipeline_stage_id' = $2`,
        [input.workspaceId, input.stageId],
      )
      const count = Number(used.rows[0]?.count ?? 0)
      if (count > 0) throw new Error(`Move ${count} live deal${count === 1 ? '' : 's'} before archiving this stage`)
      await client.query(
        `UPDATE crm_pipeline_stages SET archived_at = now()
          WHERE id = $1 AND workspace_id = $2`,
        [input.stageId, input.workspaceId],
      )
    } else if (stage.archivedAt) {
      await client.query(
        `UPDATE crm_pipeline_stages SET archived_at = NULL,
            position = COALESCE((SELECT MAX(position) + 1 FROM crm_pipeline_stages
              WHERE pipeline_id = $3 AND archived_at IS NULL), 0)
          WHERE id = $1 AND workspace_id = $2`,
        [input.stageId, input.workspaceId, stage.pipelineId],
      )
    }
    await client.query(
      `UPDATE crm_pipeline_stages SET position = position + 1000000
        WHERE pipeline_id = $1 AND archived_at IS NULL`,
      [stage.pipelineId],
    )
    await client.query(
      `WITH ranked AS (
         SELECT id, row_number() OVER (ORDER BY position, created_at) - 1 AS next_position
           FROM crm_pipeline_stages WHERE pipeline_id = $1 AND archived_at IS NULL
       )
       UPDATE crm_pipeline_stages s SET position = ranked.next_position
         FROM ranked WHERE s.id = ranked.id`,
      [stage.pipelineId],
    )
    return true
  })
}

export async function reorderCrmStages(input: {
  userId: string
  workspaceId: string
  pipelineId: string
  orderedIds: string[]
}): Promise<void> {
  await withCrmConfigTransaction(input.userId, async (client) => {
    const current = await client.query<{ id: string }>(
      `SELECT id FROM crm_pipeline_stages
        WHERE workspace_id = $1 AND pipeline_id = $2 AND archived_at IS NULL
        ORDER BY position FOR UPDATE`,
      [input.workspaceId, input.pipelineId],
    )
    assertExactOrder(current.rows.map((row) => row.id), input.orderedIds)
    await client.query(
      `UPDATE crm_pipeline_stages SET position = position + 1000000
        WHERE workspace_id = $1 AND pipeline_id = $2 AND archived_at IS NULL`,
      [input.workspaceId, input.pipelineId],
    )
    for (const [position, id] of input.orderedIds.entries()) {
      await client.query(
        `UPDATE crm_pipeline_stages SET position = $4
          WHERE id = $1 AND workspace_id = $2 AND pipeline_id = $3
            AND archived_at IS NULL`,
        [id, input.workspaceId, input.pipelineId, position],
      )
    }
  })
}

export async function createCrmFieldDefinition(input: {
  userId: string
  workspaceId: string
  entityKind: CrmEntityKind
  fieldKey: string
  label: string
  fieldType: CrmFieldType
  options?: string[]
  isRequired?: boolean
}): Promise<CrmFieldDefinition | null> {
  const inserted = await queryWithRLS<ConfigFieldRow>(
    input.userId,
    `INSERT INTO crm_field_definitions
       (workspace_id, entity_kind, field_key, label, field_type, options,
        is_required, position, created_by)
     SELECT $1,$2,$3,$4,$5,$6::jsonb,$7,
       COALESCE((SELECT MAX(position) + 1 FROM crm_field_definitions
                 WHERE workspace_id = $1 AND entity_kind = $2),0),$8
     WHERE (SELECT COUNT(*) FROM crm_field_definitions
             WHERE workspace_id = $1 AND entity_kind = $2 AND archived_at IS NULL) < 50
     RETURNING id, entity_kind AS "entityKind", field_key AS "fieldKey", label,
       field_type AS "fieldType", options, is_required AS "isRequired", position,
       NULL::timestamptz AS "archivedAt"`,
    [input.workspaceId, input.entityKind, input.fieldKey, input.label, input.fieldType,
      JSON.stringify(input.options ?? []), input.isRequired ?? false, input.userId],
  )
  const row = inserted.rows[0]
  return row ? {
    ...row,
    archivedAt: null,
    options: Array.isArray(row.options)
      ? row.options.filter((v): v is string => typeof v === 'string')
      : [],
  } : null
}

export async function archiveCrmFieldDefinition(
  userId: string,
  workspaceId: string,
  fieldId: string,
): Promise<boolean> {
  return withCrmConfigTransaction(userId, async (client) => {
    const result = await client.query<{ entityKind: CrmEntityKind }>(
      `UPDATE crm_field_definitions SET archived_at = now()
        WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL
        RETURNING entity_kind AS "entityKind"`,
      [fieldId, workspaceId],
    )
    const row = result.rows[0]
    if (!row) return false
    await client.query(
      `UPDATE crm_field_definitions SET position = position + 1000000
        WHERE workspace_id = $1 AND entity_kind = $2 AND archived_at IS NULL`,
      [workspaceId, row.entityKind],
    )
    await client.query(
      `WITH ranked AS (
         SELECT id, row_number() OVER (ORDER BY position, created_at) - 1 AS next_position
           FROM crm_field_definitions
          WHERE workspace_id = $1 AND entity_kind = $2 AND archived_at IS NULL
       )
       UPDATE crm_field_definitions f SET position = ranked.next_position
         FROM ranked WHERE f.id = ranked.id`,
      [workspaceId, row.entityKind],
    )
    return true
  })
}

export async function updateCrmFieldDefinition(input: {
  userId: string
  workspaceId: string
  fieldId: string
  label?: string
  options?: string[]
  isRequired?: boolean
}): Promise<CrmFieldDefinition | null> {
  const existing = await queryWithRLS<ConfigFieldRow>(
    input.userId,
    `SELECT id, entity_kind AS "entityKind", field_key AS "fieldKey", label,
            field_type AS "fieldType", options, is_required AS "isRequired", position,
            archived_at AS "archivedAt"
       FROM crm_field_definitions
      WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL`,
    [input.fieldId, input.workspaceId],
  )
  const before = existing.rows[0]
  if (!before) return null
  const currentOptions = Array.isArray(before.options)
    ? before.options.filter((value): value is string => typeof value === 'string')
    : []
  if (input.options && (before.fieldType === 'single_select' || before.fieldType === 'multi_select')
    && input.options.length === 0) {
    throw new Error('Select fields require at least one option')
  }
  if (input.options && before.fieldType === 'entity_reference'
    && (input.options.length === 0
      || input.options.some((kind) => !(CRM_REFERENCE_KINDS as readonly string[]).includes(kind)))) {
    throw new Error('Reference fields require at least one valid target kind')
  }
  if (input.options && (before.fieldType === 'single_select' || before.fieldType === 'multi_select')) {
    const removed = currentOptions.filter((option) => !input.options!.includes(option))
    if (removed.length > 0) {
      const usage = await queryWithRLS<{ count: string }>(
        input.userId,
        before.fieldType === 'single_select'
          ? `SELECT COUNT(*)::text AS count FROM entities
              WHERE workspace_id = $1 AND kind = $2 AND valid_to IS NULL
                AND retracted_at IS NULL AND NOT (attributes ? 'crm_archived_at')
                AND attributes->'custom_fields'->>$3 = ANY($4::text[])`
          : `SELECT COUNT(*)::text AS count FROM entities
              WHERE workspace_id = $1 AND kind = $2 AND valid_to IS NULL
                AND retracted_at IS NULL AND NOT (attributes ? 'crm_archived_at')
                AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements_text(
                    COALESCE(attributes->'custom_fields'->$3, '[]'::jsonb)
                  ) value WHERE value = ANY($4::text[])
                )`,
        [input.workspaceId, before.entityKind, before.fieldKey, removed],
      )
      const count = Number(usage.rows[0]?.count ?? 0)
      if (count > 0) throw new Error(`Cannot remove options used by ${count} live record${count === 1 ? '' : 's'}`)
    }
  }
  const updated = await queryWithRLS<ConfigFieldRow>(
    input.userId,
    `UPDATE crm_field_definitions SET
       label = COALESCE($3, label),
       options = COALESCE($4::jsonb, options),
       is_required = COALESCE($5, is_required)
     WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL
     RETURNING id, entity_kind AS "entityKind", field_key AS "fieldKey", label,
       field_type AS "fieldType", options, is_required AS "isRequired", position,
       archived_at AS "archivedAt"`,
    [input.fieldId, input.workspaceId, input.label ?? null,
      input.options ? JSON.stringify(input.options) : null, input.isRequired ?? null],
  )
  const row = updated.rows[0]
  return row ? {
    ...row,
    options: Array.isArray(row.options)
      ? row.options.filter((value): value is string => typeof value === 'string')
      : [],
    archivedAt: row.archivedAt?.toISOString() ?? null,
  } : null
}

export async function restoreCrmFieldDefinition(
  userId: string,
  workspaceId: string,
  fieldId: string,
): Promise<boolean> {
  return withCrmConfigTransaction(userId, async (client) => {
    const selected = await client.query<{ entityKind: CrmEntityKind }>(
      `SELECT entity_kind AS "entityKind" FROM crm_field_definitions
        WHERE id = $1 AND workspace_id = $2 AND archived_at IS NOT NULL FOR UPDATE`,
      [fieldId, workspaceId],
    )
    const row = selected.rows[0]
    if (!row) return false
    const live = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM crm_field_definitions
        WHERE workspace_id = $1 AND entity_kind = $2 AND archived_at IS NULL`,
      [workspaceId, row.entityKind],
    )
    if (Number(live.rows[0]?.count ?? 0) >= 50) {
      throw new Error('Custom field limit reached')
    }
    await client.query(
      `UPDATE crm_field_definitions SET archived_at = NULL,
          position = COALESCE((SELECT MAX(position) + 1 FROM crm_field_definitions
            WHERE workspace_id = $2 AND entity_kind = $3 AND archived_at IS NULL), 0)
        WHERE id = $1 AND workspace_id = $2`,
      [fieldId, workspaceId, row.entityKind],
    )
    return true
  })
}

export async function reorderCrmFields(input: {
  userId: string
  workspaceId: string
  entityKind: CrmEntityKind
  orderedIds: string[]
}): Promise<void> {
  await withCrmConfigTransaction(input.userId, async (client) => {
    const current = await client.query<{ id: string }>(
      `SELECT id FROM crm_field_definitions
        WHERE workspace_id = $1 AND entity_kind = $2 AND archived_at IS NULL
        ORDER BY position FOR UPDATE`,
      [input.workspaceId, input.entityKind],
    )
    assertExactOrder(current.rows.map((row) => row.id), input.orderedIds)
    await client.query(
      `UPDATE crm_field_definitions SET position = position + 1000000
        WHERE workspace_id = $1 AND entity_kind = $2 AND archived_at IS NULL`,
      [input.workspaceId, input.entityKind],
    )
    for (const [position, id] of input.orderedIds.entries()) {
      await client.query(
        `UPDATE crm_field_definitions SET position = $4
          WHERE id = $1 AND workspace_id = $2 AND entity_kind = $3
            AND archived_at IS NULL`,
        [id, input.workspaceId, input.entityKind, position],
      )
    }
  })
}

function sameFieldShape(existing: Pick<CrmFieldDefinition, 'fieldType' | 'options'>, preset: CrmPresetField): boolean {
  return existing.fieldType === preset.fieldType
    && existing.options.length === preset.options.length
    && existing.options.every((option, index) => option === preset.options[index])
}

export type CrmPresetApplyResult = {
  created: string[]
  skipped: string[]
  revived: string[]
  conflicts: string[]
}

/** Idempotently materialize a reusable preset as ordinary field definitions. */
export async function applyCrmFieldPreset(input: {
  userId: string
  workspaceId: string
  presetId: CrmPresetId
}): Promise<CrmPresetApplyResult> {
  const fields = CRM_FIELD_PRESETS[input.presetId]
  const result: CrmPresetApplyResult = { created: [], skipped: [], revived: [], conflicts: [] }
  for (const field of fields) {
    const existingResult = await queryWithRLS<ConfigFieldRow & { archivedAt: Date | null }>(
      input.userId,
      `SELECT id, entity_kind AS "entityKind", field_key AS "fieldKey", label,
              field_type AS "fieldType", options, is_required AS "isRequired", position,
              archived_at AS "archivedAt"
         FROM crm_field_definitions
        WHERE workspace_id = $1 AND entity_kind = $2 AND field_key = $3
        LIMIT 1`,
      [input.workspaceId, field.entityKind, field.fieldKey],
    )
    const raw = existingResult.rows[0]
    const existing = raw ? {
      ...raw,
      options: Array.isArray(raw.options)
        ? raw.options.filter((value): value is string => typeof value === 'string')
        : [],
    } : null
    if (existing) {
      if (!sameFieldShape(existing, field)) {
        result.conflicts.push(field.fieldKey)
        continue
      }
      if (!existing.archivedAt) {
        result.skipped.push(field.fieldKey)
        continue
      }
      const revived = await queryWithRLS(
        input.userId,
        `UPDATE crm_field_definitions SET archived_at = NULL
          WHERE id = $1 AND workspace_id = $2 AND
            (SELECT COUNT(*) FROM crm_field_definitions
              WHERE workspace_id = $2 AND entity_kind = $3 AND archived_at IS NULL) < 50`,
        [existing.id, input.workspaceId, field.entityKind],
      )
      if ((revived.rowCount ?? 0) > 0) result.revived.push(field.fieldKey)
      else result.conflicts.push(field.fieldKey)
      continue
    }
    try {
      const created = await createCrmFieldDefinition({
        userId: input.userId,
        workspaceId: input.workspaceId,
        ...field,
      })
      if (created) result.created.push(field.fieldKey)
      else result.conflicts.push(field.fieldKey)
    } catch {
      // A concurrent application may have created the key. Report the race as
      // a conflict rather than overwriting or claiming success.
      result.conflicts.push(field.fieldKey)
    }
  }
  return result
}

export type CrmRecordRow = {
  id: string
  kind: CrmEntityKind
  name: string
  attributes: Record<string, unknown>
  aliases?: string[]
  archivedAt: string | null
  updatedAt: string
}

function entityToCrmRecordRow(entity: EntityRecord): CrmRecordRow {
  return {
    id: entity.id,
    kind: entity.kind as CrmEntityKind,
    name: entity.displayName,
    attributes: entity.attributes,
    aliases: entity.aliases,
    archivedAt: typeof entity.attributes.crm_archived_at === 'string'
      ? entity.attributes.crm_archived_at
      : null,
    updatedAt: entity.updatedAt.toISOString(),
  }
}

/** Cold-load one CRM record without depending on a collection page. */
export async function getCrmR2Record(
  ctx: AccessContext,
  entityId: string,
): Promise<CrmRecordRow | null> {
  const entity = await getEntityById(ctx, entityId)
  if (!entity || !['person', 'company', 'deal'].includes(entity.kind)) return null
  return entityToCrmRecordRow(entity)
}

export type CrmRecordRelationships = {
  contacts: CrmRecordRow[]
  companies: CrmRecordRow[]
  deals: CrmRecordRow[]
}

async function listRelatedKind(
  ctx: AccessContext,
  kind: CrmEntityKind,
  relationshipSql: (firstIndex: number) => string,
  relationshipParams: unknown[],
): Promise<CrmRecordRow[]> {
  const ap = buildAccessPredicate(ctx, { alias: 'e', startIdx: 1 })
  const kindIndex = ap.nextIdx
  const firstRelationshipIndex = kindIndex + 1
  const result = await queryGated<{
    id: string
    kind: CrmEntityKind
    name: string
    attributes: Record<string, unknown> | null
    aliases: string[] | null
    archivedAt: Date | null
    updatedAt: Date
  }>(
    ctx,
    `SELECT e.id, e.kind, e.display_name AS name, e.attributes, e.aliases,
            NULLIF(e.attributes->>'crm_archived_at','')::timestamptz AS "archivedAt",
            e.updated_at AS "updatedAt"
       FROM entities e
      WHERE ${ap.sql} AND e.kind = $${kindIndex}
        AND e.valid_to IS NULL AND e.retracted_at IS NULL
        AND NOT (e.attributes ? 'crm_archived_at')
        AND (${relationshipSql(firstRelationshipIndex)})
      ORDER BY e.updated_at DESC, e.id DESC`,
    [...ap.params, kind, ...relationshipParams],
  )
  return result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    attributes: row.attributes ?? {},
    archivedAt: row.archivedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }))
}

/**
 * Direct, access-scoped relationship summaries for a cold record page.
 * Participant-linked deals are included for both people and companies.
 */
export async function listCrmRecordRelationships(
  ctx: AccessContext,
  record: CrmRecordRow,
): Promise<CrmRecordRelationships> {
  if (record.kind === 'person') {
    const companyId = typeof record.attributes.company_id === 'string'
      ? record.attributes.company_id
      : null
    const [companies, deals] = await Promise.all([
      companyId
        ? listRelatedKind(ctx, 'company', (index) => `e.id = $${index}`, [companyId])
        : Promise.resolve([]),
      listRelatedKind(
        ctx,
        'deal',
        (index) => `e.attributes->>'contact_id' = $${index}
          OR EXISTS (
            SELECT 1 FROM crm_deal_contacts dc
             WHERE dc.workspace_id = e.workspace_id
               AND dc.deal_id = e.id AND dc.contact_id = $${index}
          )`,
        [record.id],
      ),
    ])
    return { contacts: [], companies, deals }
  }

  if (record.kind === 'company') {
    const contacts = await listRelatedKind(
      ctx,
      'person',
      (index) => `e.attributes->>'company_id' = $${index}`,
      [record.id],
    )
    const visibleContactIds = contacts.map((contact) => contact.id)
    const deals = await listRelatedKind(
      ctx,
      'deal',
      (index) => `e.attributes->>'company_id' = $${index}
        OR ($${index + 1}::text[] <> '{}'::text[] AND EXISTS (
          SELECT 1 FROM crm_deal_contacts dc
           WHERE dc.workspace_id = e.workspace_id AND dc.deal_id = e.id
             AND dc.contact_id = ANY($${index + 1}::text[])
        ))`,
      [record.id, visibleContactIds],
    )
    return { contacts, companies: [], deals }
  }

  const contactId = typeof record.attributes.contact_id === 'string'
    ? record.attributes.contact_id
    : null
  const companyId = typeof record.attributes.company_id === 'string'
    ? record.attributes.company_id
    : null
  const [contacts, companies] = await Promise.all([
    listRelatedKind(
      ctx,
      'person',
      (index) => `($${index}::text IS NOT NULL AND e.id = $${index})
        OR EXISTS (
          SELECT 1 FROM crm_deal_contacts dc
           WHERE dc.workspace_id = e.workspace_id
             AND dc.deal_id = $${index + 1} AND dc.contact_id = e.id
        )`,
      [contactId, record.id],
    ),
    companyId
      ? listRelatedKind(ctx, 'company', (index) => `e.id = $${index}`, [companyId])
      : Promise.resolve([]),
  ])
  return { contacts, companies, deals: [] }
}

export async function listCrmR2Records(
  ctx: AccessContext,
  options: { includeArchived?: boolean } = {},
): Promise<CrmRecordRow[]> {
  const ap = buildAccessPredicate(ctx, { alias: 'e', startIdx: 1 })
  const result = await queryGated<{
    id: string
    kind: CrmEntityKind
    name: string
    attributes: Record<string, unknown> | null
    aliases: string[] | null
    archivedAt: Date | null
    updatedAt: Date
  }>(
    ctx,
    `SELECT e.id, e.kind, e.display_name AS name, e.attributes, e.aliases,
            NULLIF(e.attributes->>'crm_archived_at','')::timestamptz AS "archivedAt",
            e.updated_at AS "updatedAt"
       FROM entities e
      WHERE ${ap.sql}
        AND e.kind = ANY($${ap.nextIdx}::text[])
        AND e.valid_to IS NULL AND e.retracted_at IS NULL
        AND NOT (
          e.kind = 'person'
          AND COALESCE((e.attributes->>'self')::boolean, false)
        )
        ${options.includeArchived ? '' : `AND NOT (e.attributes ? 'crm_archived_at')`}
      ORDER BY e.updated_at DESC
      LIMIT 1500`,
    [...ap.params, ['person', 'company', 'deal']],
  )
  return result.rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    attributes: r.attributes ?? {},
    aliases: r.aliases ?? [],
    archivedAt: r.archivedAt?.toISOString() ?? null,
    updatedAt: r.updatedAt.toISOString(),
  }))
}

export type CrmPageSort = 'updated' | 'name' | 'amount' | 'close'
export type CrmSortDirection = 'asc' | 'desc'

export type CrmPageOptions = {
  kind: CrmEntityKind
  limit: number
  cursor?: string | null
  sort: CrmPageSort
  direction: CrmSortDirection
  search?: string | null
  includeArchived?: boolean
  owners?: string[]
  pipelineId?: string | null
  stageIds?: string[]
  companyIds?: string[]
  tags?: string[]
  custom?: Record<string, string[]>
  attention?: 'overdue' | 'stale' | 'noAmount' | 'orphaned' | null
}

type CrmCursor = {
  kind: CrmEntityKind
  sort: CrmPageSort
  direction: CrmSortDirection
  value: string | number | null
  id: string
}

export function encodeCrmCursor(cursor: CrmCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeCrmCursor(value: string): CrmCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    throw new Error('Invalid CRM cursor')
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid CRM cursor')
  const cursor = parsed as Partial<CrmCursor>
  if (!CRM_REFERENCE_KINDS.includes(cursor.kind as CrmEntityKind)
    || !['updated', 'name', 'amount', 'close'].includes(String(cursor.sort))
    || !['asc', 'desc'].includes(String(cursor.direction))
    || typeof cursor.id !== 'string'
    || !(cursor.value === null || typeof cursor.value === 'string' || typeof cursor.value === 'number')) {
    throw new Error('Invalid CRM cursor')
  }
  return cursor as CrmCursor
}

function crmSortExpression(kind: CrmEntityKind, sort: CrmPageSort): {
  sql: string
  cursorCast: string
} {
  if (sort === 'name') return { sql: 'lower(e.display_name)', cursorCast: 'text' }
  if (sort === 'amount' && kind === 'deal') {
    return { sql: `NULLIF(e.attributes->>'amount','')::numeric`, cursorCast: 'numeric' }
  }
  if (sort === 'close' && kind === 'deal') {
    return { sql: `NULLIF(e.attributes->>'close_date','')`, cursorCast: 'text' }
  }
  return { sql: 'e.updated_at', cursorCast: 'timestamptz' }
}

export type CrmRecordPage = {
  items: CrmRecordRow[]
  nextCursor: string | null
  hasMore: boolean
}

/** Access-scoped server-authoritative collection query with an opaque keyset. */
export async function listCrmRecordPage(
  ctx: AccessContext,
  options: CrmPageOptions,
): Promise<CrmRecordPage> {
  const limit = Math.max(1, Math.min(100, options.limit))
  if ((options.sort === 'amount' || options.sort === 'close') && options.kind !== 'deal') {
    throw new Error(`${options.sort} sort is only available for deals`)
  }
  const cursor = options.cursor ? decodeCrmCursor(options.cursor) : null
  if (cursor && (cursor.kind !== options.kind || cursor.sort !== options.sort
    || cursor.direction !== options.direction)) {
    throw new Error('CRM cursor does not match this query')
  }
  const ap = buildAccessPredicate(ctx, { alias: 'e', startIdx: 1 })
  const values: unknown[] = [...ap.params]
  const where: string[] = [
    ap.sql,
    `e.kind = $${values.length + 1}`,
    'e.valid_to IS NULL',
    'e.retracted_at IS NULL',
  ]
  values.push(options.kind)
  if (options.includeArchived) where.push(`e.attributes ? 'crm_archived_at'`)
  else where.push(`NOT (e.attributes ? 'crm_archived_at')`)
  const add = (sql: (index: number) => string, value: unknown) => {
    const index = values.length + 1
    where.push(sql(index))
    values.push(value)
  }
  if (options.search?.trim()) {
    const pattern = `%${options.search.trim()}%`
    add((index) => options.kind === 'person'
      ? `(e.display_name ILIKE $${index} OR e.attributes->>'email' ILIKE $${index}
          OR e.attributes->>'phone' ILIKE $${index}
          OR (e.attributes->'tags')::text ILIKE $${index}
          OR EXISTS (
            SELECT 1 FROM crm_field_definitions f
             WHERE f.workspace_id = e.workspace_id AND f.entity_kind = e.kind
               AND f.archived_at IS NULL
               AND f.field_type = ANY(ARRAY['text','single_select','multi_select'])
               AND (e.attributes->'custom_fields'->>f.field_key ILIKE $${index}
                 OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(
                   CASE WHEN jsonb_typeof(e.attributes->'custom_fields'->f.field_key) = 'array'
                     THEN e.attributes->'custom_fields'->f.field_key ELSE '[]'::jsonb END
                 ) item WHERE item ILIKE $${index}))
          ))`
      : options.kind === 'company'
        ? `(e.display_name ILIKE $${index} OR e.attributes->>'domain' ILIKE $${index}
            OR (e.attributes->'tags')::text ILIKE $${index}
            OR EXISTS (
              SELECT 1 FROM crm_field_definitions f
               WHERE f.workspace_id = e.workspace_id AND f.entity_kind = e.kind
                 AND f.archived_at IS NULL
                 AND f.field_type = ANY(ARRAY['text','single_select','multi_select'])
                 AND (e.attributes->'custom_fields'->>f.field_key ILIKE $${index}
                   OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(
                     CASE WHEN jsonb_typeof(e.attributes->'custom_fields'->f.field_key) = 'array'
                       THEN e.attributes->'custom_fields'->f.field_key ELSE '[]'::jsonb END
                   ) item WHERE item ILIKE $${index}))
            ))`
        : `(e.display_name ILIKE $${index} OR e.attributes->>'source' ILIKE $${index}
            OR EXISTS (SELECT 1 FROM entities related
              WHERE related.workspace_id = e.workspace_id
                AND related.valid_to IS NULL AND related.retracted_at IS NULL
                AND related.id::text = ANY(ARRAY[
                  NULLIF(e.attributes->>'contact_id',''),
                  NULLIF(e.attributes->>'company_id','')
                ]) AND related.display_name ILIKE $${index})
            OR EXISTS (
              SELECT 1 FROM crm_field_definitions f
               WHERE f.workspace_id = e.workspace_id AND f.entity_kind = e.kind
                 AND f.archived_at IS NULL
                 AND f.field_type = ANY(ARRAY['text','single_select','multi_select'])
                 AND (e.attributes->'custom_fields'->>f.field_key ILIKE $${index}
                   OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(
                     CASE WHEN jsonb_typeof(e.attributes->'custom_fields'->f.field_key) = 'array'
                       THEN e.attributes->'custom_fields'->f.field_key ELSE '[]'::jsonb END
                   ) item WHERE item ILIKE $${index}))
            ))`, pattern)
  }
  if (options.owners?.length) {
    const ownerIds = options.owners.filter((owner) => owner !== 'none')
    const includeNone = options.owners.includes('none')
    add((index) => `(${ownerIds.length > 0 ? `e.attributes->>'owner_id' = ANY($${index}::text[])` : 'false'}
      ${includeNone ? `OR NULLIF(e.attributes->>'owner_id','') IS NULL` : ''})`, ownerIds)
  }
  if (options.pipelineId && options.kind === 'deal') {
    add((index) => `e.attributes->>'pipeline_id' = $${index}`, options.pipelineId)
  }
  if (options.stageIds?.length && options.kind === 'deal') {
    add((index) => `e.attributes->>'pipeline_stage_id' = ANY($${index}::text[])`, options.stageIds)
  }
  if (options.companyIds?.length && options.kind !== 'company') {
    const ids = options.companyIds.filter((id) => id !== 'none')
    const includeNone = options.companyIds.includes('none')
    add((index) => `(${ids.length > 0 ? `e.attributes->>'company_id' = ANY($${index}::text[])` : 'false'}
      ${includeNone ? `OR NULLIF(e.attributes->>'company_id','') IS NULL` : ''})`, ids)
  }
  if (options.tags?.length && options.kind !== 'deal') {
    add((index) => `COALESCE(e.attributes->'tags','[]'::jsonb) ?| $${index}::text[]`, options.tags)
  }
  if (options.attention === 'orphaned' && options.kind === 'person') {
    where.push(`NULLIF(e.attributes->>'company_id','') IS NULL`)
  }
  if (options.kind === 'deal' && options.attention && options.attention !== 'orphaned') {
    where.push(`(CASE
      WHEN NULLIF(e.attributes->>'pipeline_stage_id','') IS NOT NULL THEN EXISTS (
        SELECT 1 FROM crm_pipeline_stages page_stage
         WHERE page_stage.id::text = e.attributes->>'pipeline_stage_id'
           AND page_stage.workspace_id = e.workspace_id
           AND page_stage.archived_at IS NULL AND page_stage.category = 'open'
      )
      ELSE COALESCE(e.attributes->>'stage','lead') NOT IN ('won','lost')
    END)`)
    if (options.attention === 'overdue') {
      where.push(`NULLIF(e.attributes->>'close_date','')::date < CURRENT_DATE`)
    } else if (options.attention === 'stale') {
      where.push(`e.updated_at < now() - interval '30 days'`)
    } else {
      where.push(`NULLIF(e.attributes->>'amount','') IS NULL`)
    }
  }
  for (const [key, selected] of Object.entries(options.custom ?? {})) {
    if (selected.length === 0) continue
    const emptyTokens = new Set(['__empty__', '__none__'])
    const keyIndex = values.length + 1
    values.push(key)
    const valueIndex = values.length + 1
    values.push(selected.filter((value) => !emptyTokens.has(value)))
    const includeEmpty = selected.some((value) => emptyTokens.has(value))
    where.push(`(
      e.attributes->'custom_fields'->>$${keyIndex} = ANY($${valueIndex}::text[])
      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(e.attributes->'custom_fields'->$${keyIndex}) = 'array'
          THEN e.attributes->'custom_fields'->$${keyIndex} ELSE '[]'::jsonb END
      ) value WHERE value = ANY($${valueIndex}::text[]))
      ${includeEmpty ? `OR e.attributes->'custom_fields'->$${keyIndex} IS NULL` : ''}
    )`)
  }
  const sort = crmSortExpression(options.kind, options.sort)
  const direction = options.direction === 'asc' ? 'ASC' : 'DESC'
  const comparison = options.direction === 'asc' ? '>' : '<'
  if (cursor) {
    const valueIndex = values.length + 1
    values.push(cursor.value)
    const idIndex = values.length + 1
    values.push(cursor.id)
    where.push(cursor.value === null
      ? `(${sort.sql} IS NULL AND e.id ${comparison} $${idIndex}::uuid)`
      : `(${sort.sql} IS NULL OR ${sort.sql} ${comparison} $${valueIndex}::${sort.cursorCast}
          OR (${sort.sql} = $${valueIndex}::${sort.cursorCast} AND e.id ${comparison} $${idIndex}::uuid))`)
  }
  values.push(limit + 1)
  const result = await queryGated<{
    id: string
    kind: CrmEntityKind
    name: string
    attributes: Record<string, unknown> | null
    archivedAt: Date | null
    updatedAt: Date
    sortValue: Date | string | number | null
  }>(ctx,
    `SELECT e.id, e.kind, e.display_name AS name, e.attributes,
            NULLIF(e.attributes->>'crm_archived_at','')::timestamptz AS "archivedAt",
            e.updated_at AS "updatedAt", ${sort.sql} AS "sortValue"
       FROM entities e
      WHERE ${where.join(' AND ')}
      ORDER BY (${sort.sql} IS NULL) ASC, ${sort.sql} ${direction}, e.id ${direction}
      LIMIT $${values.length}`,
    values,
  )
  const hasMore = result.rows.length > limit
  const pageRows = result.rows.slice(0, limit)
  const items = pageRows.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    attributes: row.attributes ?? {},
    archivedAt: row.archivedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }))
  const last = pageRows.at(-1)
  const cursorValue = last?.sortValue instanceof Date
    ? last.sortValue.toISOString()
    : last?.sortValue ?? null
  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? encodeCrmCursor({
      kind: options.kind,
      sort: options.sort,
      direction: options.direction,
      value: cursorValue,
      id: last.id,
    }) : null,
  }
}

export type CrmSummary = {
  totals: { deals: number; contacts: number; companies: number }
  attention: { overdue: number; stale: number; noAmount: number; orphaned: number }
  stages: Array<{ stageId: string; count: number; values: Record<string, number> }>
}

export async function getCrmSummary(
  ctx: AccessContext,
  pipelineId?: string | null,
): Promise<CrmSummary> {
  const ap = buildAccessPredicate(ctx, { alias: 'e', startIdx: 1 })
  const aggregateValues: unknown[] = [...ap.params, ['person', 'company', 'deal']]
  const pipelinePredicate = pipelineId
    ? `AND e.attributes->>'pipeline_id' = $${aggregateValues.push(pipelineId)}`
    : ''
  const openDeal = `(CASE
    WHEN NULLIF(e.attributes->>'pipeline_stage_id','') IS NOT NULL THEN EXISTS (
      SELECT 1 FROM crm_pipeline_stages summary_stage
       WHERE summary_stage.id::text = e.attributes->>'pipeline_stage_id'
         AND summary_stage.workspace_id = e.workspace_id
         AND summary_stage.archived_at IS NULL AND summary_stage.category = 'open'
    )
    ELSE COALESCE(e.attributes->>'stage','lead') NOT IN ('won','lost')
  END)`
  const aggregate = await queryGated<{
    deals: string; contacts: string; companies: string
    overdue: string; stale: string; noAmount: string; orphaned: string
  }>(ctx,
    `SELECT
       COUNT(*) FILTER (WHERE e.kind = 'deal' ${pipelinePredicate})::text AS deals,
       COUNT(*) FILTER (WHERE e.kind = 'person')::text AS contacts,
       COUNT(*) FILTER (WHERE e.kind = 'company')::text AS companies,
       COUNT(*) FILTER (WHERE e.kind = 'deal' ${pipelinePredicate}
         AND ${openDeal}
         AND NULLIF(e.attributes->>'close_date','')::date < CURRENT_DATE)::text AS overdue,
       COUNT(*) FILTER (WHERE e.kind = 'deal' ${pipelinePredicate}
         AND ${openDeal}
         AND e.updated_at < now() - interval '30 days')::text AS stale,
       COUNT(*) FILTER (WHERE e.kind = 'deal' ${pipelinePredicate}
         AND ${openDeal}
         AND NULLIF(e.attributes->>'amount','') IS NULL)::text AS "noAmount",
       COUNT(*) FILTER (WHERE e.kind = 'person'
         AND NULLIF(e.attributes->>'company_id','') IS NULL)::text AS orphaned
     FROM entities e
     WHERE ${ap.sql} AND e.kind = ANY($${ap.nextIdx}::text[])
       AND e.valid_to IS NULL AND e.retracted_at IS NULL
       AND NOT (e.attributes ? 'crm_archived_at')`,
    aggregateValues,
  )
  const stageAp = buildAccessPredicate(ctx, { alias: 'e', startIdx: 1 })
  const stageValues: unknown[] = [...stageAp.params]
  let pipelineSql = ''
  if (pipelineId) {
    stageValues.push(pipelineId)
    pipelineSql = `AND e.attributes->>'pipeline_id' = $${stageValues.length}`
  }
  const stages = await queryGated<{
    stageId: string; currency: string; stageCount: string; value: string | null
  }>(ctx,
    `SELECT e.attributes->>'pipeline_stage_id' AS "stageId",
            COALESCE(NULLIF(upper(e.attributes->>'currency_code'),''),'USD') AS currency,
            SUM(COUNT(*)) OVER (
              PARTITION BY e.attributes->>'pipeline_stage_id'
            )::text AS "stageCount",
            SUM(NULLIF(e.attributes->>'amount','')::numeric)::text AS value
       FROM entities e
      WHERE ${stageAp.sql} AND e.kind = 'deal' AND e.valid_to IS NULL
        AND e.retracted_at IS NULL AND NOT (e.attributes ? 'crm_archived_at')
        AND NULLIF(e.attributes->>'pipeline_stage_id','') IS NOT NULL
        ${pipelineSql}
      GROUP BY e.attributes->>'pipeline_stage_id', currency`,
    stageValues,
  )
  const stageMap = new Map<string, { stageId: string; count: number; values: Record<string, number> }>()
  for (const row of stages.rows) {
    const summary = stageMap.get(row.stageId) ?? { stageId: row.stageId, count: 0, values: {} }
    summary.count = Number(row.stageCount)
    if (row.value !== null) summary.values[row.currency] = Number(row.value)
    stageMap.set(row.stageId, summary)
  }
  const row = aggregate.rows[0]
  return {
    totals: { deals: Number(row?.deals ?? 0), contacts: Number(row?.contacts ?? 0), companies: Number(row?.companies ?? 0) },
    attention: { overdue: Number(row?.overdue ?? 0), stale: Number(row?.stale ?? 0), noAmount: Number(row?.noAmount ?? 0), orphaned: Number(row?.orphaned ?? 0) },
    stages: [...stageMap.values()],
  }
}

export async function lookupCrmRecords(input: {
  ctx: AccessContext
  kind: CrmEntityKind
  query?: string | null
  limit: number
}): Promise<Array<{ id: string; name: string; hint: string | null }>> {
  const ap = buildAccessPredicate(input.ctx, { alias: 'e', startIdx: 1 })
  const limit = Math.max(1, Math.min(100, input.limit))
  const values: unknown[] = [...ap.params, input.kind]
  let search = ''
  if (input.query?.trim()) {
    values.push(`%${input.query.trim()}%`)
    search = `AND (e.display_name ILIKE $${values.length}
      OR COALESCE(e.canonical_id,'') ILIKE $${values.length})`
  }
  values.push(limit)
  const result = await queryGated<{ id: string; name: string; hint: string | null }>(input.ctx,
    `SELECT e.id, e.display_name AS name,
            CASE WHEN e.kind = 'person' THEN COALESCE(e.attributes->>'email', e.canonical_id)
                 WHEN e.kind = 'company' THEN COALESCE(e.attributes->>'domain', e.canonical_id)
                 ELSE e.attributes->>'source' END AS hint
       FROM entities e
      WHERE ${ap.sql} AND e.kind = $${ap.nextIdx}
        AND e.valid_to IS NULL AND e.retracted_at IS NULL
        AND NOT (e.attributes ? 'crm_archived_at') ${search}
      ORDER BY lower(e.display_name), e.id LIMIT $${values.length}`,
    values,
  )
  return result.rows
}

export async function setCrmArchived(input: {
  ctx: AccessContext
  entityId: string
  archived: boolean
}): Promise<EntityRecord | null> {
  const old = await getEntityById(input.ctx, input.entityId)
  if (!old || !['person', 'company', 'deal'].includes(old.kind)) return null
  const attributes = { ...old.attributes }
  if (input.archived) attributes.crm_archived_at = new Date().toISOString()
  else delete attributes.crm_archived_at
  return updateEntity(input.ctx.userId, input.entityId, { attributes }, input.ctx)
}

export async function setCrmDealPipelineStage(input: {
  ctx: AccessContext
  entityId: string
  stageId: string
}): Promise<{ entity: EntityRecord; fromStageId: string | null; toStage: CrmPipelineStage } | null> {
  const entity = await getEntityById(input.ctx, input.entityId)
  if (!entity || entity.kind !== 'deal') return null
  const config = await getCrmConfig(input.ctx.userId, input.ctx.workspaceId)
  const pipeline = config.pipelines.find((p) => p.stages.some((s) => s.id === input.stageId))
  const stage = pipeline?.stages.find((s) => s.id === input.stageId)
  if (!pipeline || !stage) return null
  const custom = entity.attributes.custom_fields
  const customValues = custom && typeof custom === 'object' && !Array.isArray(custom)
    ? custom as Record<string, unknown>
    : {}
  const missing = stage.requiredFields.filter((key) => {
    const value = Object.prototype.hasOwnProperty.call(entity.attributes, key)
      ? entity.attributes[key]
      : customValues[key]
    return value === null || value === undefined || value === ''
  })
  if (missing.length > 0) {
    throw new Error(`Required fields are missing: ${missing.join(', ')}`)
  }
  const fromStageId = typeof entity.attributes.pipeline_stage_id === 'string'
    ? entity.attributes.pipeline_stage_id
    : null
  const legacy = stage.legacyKey
    ?? (stage.category === 'won' ? 'won' : stage.category === 'lost' ? 'lost' : 'lead')
  const attributes = {
    ...entity.attributes,
    pipeline_id: pipeline.id,
    pipeline_stage_id: stage.id,
    stage: legacy,
  }
  const updated = await updateEntity(input.ctx.userId, input.entityId, { attributes }, input.ctx)
  return updated ? { entity: updated, fromStageId, toStage: stage } : null
}

export function validateCustomFieldValue(
  definition: Pick<CrmFieldDefinition, 'fieldType' | 'options' | 'isRequired'>,
  value: unknown,
): boolean {
  if (value === null || value === undefined || value === '') return !definition.isRequired
  switch (definition.fieldType) {
    case 'text': return typeof value === 'string' && value.length <= 10_000
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'date': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
      const [year, month, day] = value.split('-').map(Number)
      const parsed = new Date(Date.UTC(year, month - 1, day))
      return parsed.getUTCFullYear() === year
        && parsed.getUTCMonth() === month - 1
        && parsed.getUTCDate() === day
    }
    case 'boolean': return typeof value === 'boolean'
    case 'single_select': return typeof value === 'string' && definition.options.includes(value)
    case 'multi_select':
      return Array.isArray(value)
        && value.every((v) => typeof v === 'string' && definition.options.includes(v))
    case 'entity_reference':
      return typeof value === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  }
}

export async function validateCrmCustomFieldValues(input: {
  ctx: AccessContext
  entityKind: CrmEntityKind
  values: Record<string, unknown>
  requireAll?: boolean
}): Promise<CrmFieldDefinition[]> {
  const config = await getCrmConfig(input.ctx.userId, input.ctx.workspaceId)
  const definitions = config.fields.filter((field) => field.entityKind === input.entityKind)
  const byKey = new Map(definitions.map((field) => [field.fieldKey, field]))
  for (const [key, value] of Object.entries(input.values)) {
    const definition = byKey.get(key)
    if (!definition) {
      const valid = definitions.map((field) => field.fieldKey).join(', ') || '(none configured)'
      throw new Error(`Unknown custom field '${key}'. Valid fields: ${valid}. Call listCrmFields before retrying.`)
    }
    if (!validateCustomFieldValue(definition, value)) {
      throw new Error(`Invalid ${definition.fieldType} value for custom field '${key}'`)
    }
    if (definition.fieldType === 'entity_reference' && value !== null && value !== undefined && value !== '') {
      const target = await getEntityById(input.ctx, value as string)
      if (!target || target.attributes.crm_archived_at || !definition.options.includes(target.kind)
        || (target.kind === 'person' && target.attributes.self === true)) {
        throw new Error(`Reference for custom field '${key}' must be a visible ${definition.options.join(' or ')}`)
      }
    }
  }
  if (input.requireAll) {
    for (const definition of definitions.filter((field) => field.isRequired)) {
      if (!validateCustomFieldValue(definition, input.values[definition.fieldKey])) {
        throw new Error(`Required custom field is missing: '${definition.fieldKey}'`)
      }
    }
  }
  return definitions
}

export async function updateCrmCustomFields(input: {
  ctx: AccessContext
  entityId: string
  values: Record<string, unknown>
}): Promise<EntityRecord | null> {
  const old = await getEntityById(input.ctx, input.entityId)
  if (!old || !['person', 'company', 'deal'].includes(old.kind)) return null
  const config = await getCrmConfig(input.ctx.userId, input.ctx.workspaceId)
  const definitions = config.fields.filter((f) => f.entityKind === old.kind)
  await validateCrmCustomFieldValues({
    ctx: input.ctx,
    entityKind: old.kind as CrmEntityKind,
    values: input.values,
  })
  const current = old.attributes.custom_fields
  const custom = current && typeof current === 'object' && !Array.isArray(current)
    ? { ...(current as Record<string, unknown>) }
    : {}
  for (const [key, value] of Object.entries(input.values)) {
    if (value === null || value === undefined || value === '') delete custom[key]
    else custom[key] = value
  }
  for (const definition of definitions.filter((field) => field.isRequired)) {
    if (!validateCustomFieldValue(definition, custom[definition.fieldKey])) {
      throw new Error(`Required custom field is missing: '${definition.fieldKey}'`)
    }
  }
  const attributes = { ...old.attributes, custom_fields: custom }
  return updateEntity(input.ctx.userId, input.entityId, { attributes }, input.ctx)
}

export type CrmDealParticipant = {
  contactId: string
  role: string | null
  isPrimary: boolean
  name: string
  email: string | null
}

export async function listCrmDealParticipants(
  ctx: AccessContext,
  dealId: string,
): Promise<CrmDealParticipant[] | null> {
  const deal = await getEntityById(ctx, dealId)
  if (!deal || deal.kind !== 'deal') return null
  const ap = buildAccessPredicate(ctx, { alias: 'e', startIdx: 3 })
  const result = await queryGated<CrmDealParticipant>(
    ctx,
    `SELECT dc.contact_id AS "contactId", dc.role, dc.is_primary AS "isPrimary",
            e.display_name AS name,
            COALESCE(e.attributes->>'email', e.canonical_id) AS email
       FROM crm_deal_contacts dc
       JOIN entities e ON e.id = dc.contact_id
      WHERE dc.workspace_id = $1 AND dc.deal_id = $2
        AND e.kind = 'person' AND e.valid_to IS NULL
        AND NOT COALESCE((e.attributes->>'self')::boolean, false)
        AND ${ap.sql}
      ORDER BY dc.is_primary DESC, dc.created_at`,
    [ctx.workspaceId, dealId, ...ap.params],
  )
  return result.rows
}

export async function addCrmDealParticipant(input: {
  ctx: AccessContext
  dealId: string
  contactId: string
  role?: string | null
  isPrimary?: boolean
}): Promise<boolean> {
  if (input.isPrimary) {
    return setCrmDealPrimaryContact({
      ctx: input.ctx,
      dealId: input.dealId,
      contactId: input.contactId,
      ...(input.role !== undefined ? { role: input.role } : {}),
    })
  }
  const [deal, contact] = await Promise.all([
    getEntityById(input.ctx, input.dealId),
    getEntityById(input.ctx, input.contactId),
  ])
  if (!deal || deal.kind !== 'deal' || !contact || contact.kind !== 'person'
    || contact.attributes.self === true) return false
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client, input.ctx.userId)
    await client.query(
      `INSERT INTO crm_deal_contacts
         (workspace_id, deal_id, contact_id, role, is_primary, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (deal_id, contact_id) DO UPDATE
         SET role = EXCLUDED.role, is_primary = EXCLUDED.is_primary`,
      [input.ctx.workspaceId, input.dealId, input.contactId, input.role ?? null,
        false, input.ctx.userId],
    )
    await client.query('COMMIT')
    return true
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** Keep the participant primary flag and canonical deal contact in one
 * transaction. `contactId: null` clears both representations. */
export async function setCrmDealPrimaryContact(input: {
  ctx: AccessContext
  dealId: string
  contactId: string | null
  role?: string | null
}): Promise<boolean> {
  const deal = await getEntityById(input.ctx, input.dealId)
  if (!deal || deal.kind !== 'deal') return false
  if (input.contactId) {
    const contact = await getEntityById(input.ctx, input.contactId)
    if (!contact || contact.kind !== 'person' || contact.attributes.self === true) return false
  }
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client, input.ctx.userId)
    await client.query(
      `UPDATE crm_deal_contacts
          SET is_primary = false
        WHERE workspace_id = $1 AND deal_id = $2`,
      [input.ctx.workspaceId, input.dealId],
    )
    if (input.contactId) {
      await client.query(
        `INSERT INTO crm_deal_contacts
           (workspace_id, deal_id, contact_id, role, is_primary, created_by)
         VALUES ($1,$2,$3,$4,true,$5)
         ON CONFLICT (deal_id, contact_id) DO UPDATE SET
           is_primary = true,
           role = CASE WHEN $6::boolean THEN EXCLUDED.role ELSE crm_deal_contacts.role END`,
        [input.ctx.workspaceId, input.dealId, input.contactId, input.role ?? null,
          input.ctx.userId, input.role !== undefined],
      )
      await client.query(
        `UPDATE entities SET
           attributes = jsonb_set(COALESCE(attributes, '{}'::jsonb),
             '{contact_id}', to_jsonb($2::text), true),
           updated_at = now()
         WHERE id = $1 AND workspace_id = $3`,
        [input.dealId, input.contactId, input.ctx.workspaceId],
      )
    } else {
      await client.query(
        `UPDATE entities SET attributes = COALESCE(attributes, '{}'::jsonb) - 'contact_id',
            updated_at = now()
          WHERE id = $1 AND workspace_id = $2`,
        [input.dealId, input.ctx.workspaceId],
      )
    }
    await client.query('COMMIT')
    return true
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export async function removeCrmDealParticipant(input: {
  ctx: AccessContext
  dealId: string
  contactId: string
}): Promise<boolean> {
  const deal = await getEntityById(input.ctx, input.dealId)
  if (!deal || deal.kind !== 'deal') return false
  const result = await queryWithRLS<{ isPrimary: boolean }>(
    input.ctx.userId,
    `DELETE FROM crm_deal_contacts
      WHERE workspace_id = $1 AND deal_id = $2 AND contact_id = $3
      RETURNING is_primary AS "isPrimary"`,
    [input.ctx.workspaceId, input.dealId, input.contactId],
  )
  if (!result.rows[0]) return false
  if (result.rows[0].isPrimary) {
    const attributes = { ...deal.attributes }
    delete attributes.contact_id
    await updateEntity(input.ctx.userId, input.dealId, { attributes }, input.ctx)
  }
  return true
}

export type CrmActivity = {
  id: string
  activityType: string
  direction: string
  occurredAt: string
  subject: string | null
  summary: string
  sourceKind: string | null
  metadata: Record<string, unknown>
}

export async function appendCrmActivity(input: {
  userId: string
  workspaceId: string
  entityId: string
  activityType: 'note' | 'call' | 'meeting' | 'message' | 'field_change' | 'stage_change'
  direction?: 'inbound' | 'outbound' | 'internal'
  occurredAt?: Date
  subject?: string | null
  summary?: string
  sourceKind?: string
  sourceId?: string
  metadata?: Record<string, unknown>
}): Promise<CrmActivity | null> {
  const result = await queryWithRLS<{
    id: string; activityType: string; direction: string; occurredAt: Date
    subject: string | null; summary: string; sourceKind: string | null
    metadata: Record<string, unknown>
  }>(
    input.userId,
    `INSERT INTO crm_activities
       (workspace_id, entity_id, activity_type, direction, occurred_at, subject,
        summary, source_kind, source_id, actor_user_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
     ON CONFLICT (workspace_id, entity_id, source_kind, source_id)
       WHERE source_kind IS NOT NULL AND source_id IS NOT NULL DO NOTHING
     RETURNING id, activity_type AS "activityType", direction,
       occurred_at AS "occurredAt", subject, summary,
       source_kind AS "sourceKind", metadata`,
    [input.workspaceId, input.entityId, input.activityType, input.direction ?? 'internal',
      input.occurredAt ?? new Date(), input.subject ?? null, input.summary ?? '',
      input.sourceKind ?? null, input.sourceId ?? null, input.userId,
      JSON.stringify(input.metadata ?? {})],
  )
  const row = result.rows[0]
  return row ? { ...row, occurredAt: row.occurredAt.toISOString() } : null
}

function bareAddress(value: string): string {
  const angle = value.match(/<([^<>\s]+@[^<>\s]+)>/)
  return (angle?.[1] ?? value).trim().toLowerCase()
}

async function contactEmailsForEntity(ctx: AccessContext, entity: EntityRecord): Promise<string[]> {
  const ids = new Set<string>()
  if (entity.kind === 'person') ids.add(entity.id)
  if (entity.kind === 'deal') {
    const primary = entity.attributes.contact_id
    if (typeof primary === 'string') ids.add(primary)
    const participants = await queryWithRLS<{ contactId: string }>(
      ctx.userId,
      `SELECT contact_id AS "contactId" FROM crm_deal_contacts
        WHERE workspace_id = $1 AND deal_id = $2`,
      [ctx.workspaceId, entity.id],
    )
    for (const row of participants.rows) ids.add(row.contactId)
  }
  const ap = buildAccessPredicate(ctx, { alias: 'e', startIdx: 1 })
  const values: unknown[] = [...ap.params]
  let relationshipSql = ''
  if (entity.kind === 'company') {
    relationshipSql = `e.attributes->>'company_id' = $${ap.nextIdx}`
    values.push(entity.id)
  } else {
    relationshipSql = `e.id = ANY($${ap.nextIdx}::uuid[])`
    values.push([...ids])
  }
  const rows = await queryGated<{ email: string }>(
    ctx,
    `SELECT COALESCE(e.attributes->>'email', e.canonical_id) AS email
       FROM entities e
      WHERE ${ap.sql} AND e.kind = 'person' AND e.valid_to IS NULL
        AND ${relationshipSql}
        AND COALESCE(e.attributes->>'email', e.canonical_id) IS NOT NULL`,
    values,
  )
  return [...new Set(rows.rows.map((r) => bareAddress(r.email)).filter(Boolean))]
}

const CRM_EMAIL_THREAD_MESSAGE_LIMIT = 100
const CRM_EMAIL_THREAD_CANDIDATE_LIMIT = 251
const CRM_EMAIL_THREAD_BODY_CHARS = 12_000

type CrmEmailArchiveThreadRow = {
  id: string
  providerMessageId: string
  folder: string
  fromAddr: string
  toAddrs: string[]
  ccAddrs: string[]
  sentAt: Date | string | null
  subject: string
  bodyText: string
  rfcMessageId: string | null
  inReplyTo: string | null
  referencesIds: string[]
}

export type CrmEmailReviewMessage = {
  id: string
  folder: string
  from: string
  to: string[]
  cc: string[]
  sentAt: string | null
  subject: string
  body: string
  bodyTruncated: boolean
}

export type CrmEmailReviewThread = {
  subject: string
  messages: CrmEmailReviewMessage[]
  truncated: boolean
}

export type CrmEmailReviewContext = {
  thread: CrmEmailReviewThread | null
}

/**
 * Convert owner-scoped archive rows into the exact thread containing the
 * frozen reply target. Kept pure so the oldest-first and bounding contract is
 * testable without weakening the store's authority query.
 */
export function buildCrmEmailReviewThread(
  rows: readonly CrmEmailArchiveThreadRow[],
  anchorProviderMessageId: string,
  candidateCapHit = false,
): CrmEmailReviewThread | null {
  const byProviderId = new Map(rows.map((row) => [row.providerMessageId, row]))
  const hits: MailboxSearchHit[] = rows.map((row) => ({
    id: row.providerMessageId,
    folder: row.folder,
    from: row.fromAddr,
    to: row.toAddrs,
    date: row.sentAt instanceof Date ? row.sentAt.toISOString() : row.sentAt,
    subject: row.subject,
    messageId: row.rfcMessageId,
    inReplyTo: row.inReplyTo,
    references: row.referencesIds,
  }))
  const stitched = stitchMailboxThreads(hits)
  const selected = stitched.find((thread) =>
    thread.messages.some((message) => message.id === anchorProviderMessageId),
  )
  if (!selected) return null
  const bounded = selected.messages.slice(-CRM_EMAIL_THREAD_MESSAGE_LIMIT)
  return {
    subject: selected.subject,
    truncated: candidateCapHit || selected.messages.length > bounded.length,
    messages: bounded.flatMap((message) => {
      const row = byProviderId.get(message.id)
      if (!row) return []
      return [{
        id: row.providerMessageId,
        folder: row.folder,
        from: row.fromAddr,
        to: row.toAddrs,
        cc: row.ccAddrs,
        sentAt: row.sentAt instanceof Date ? row.sentAt.toISOString() : row.sentAt,
        subject: row.subject,
        body: row.bodyText.slice(0, CRM_EMAIL_THREAD_BODY_CHARS),
        bodyTruncated: row.bodyText.length > CRM_EMAIL_THREAD_BODY_CHARS,
      }]
    }),
  }
}

function mailboxInstancePrefix(toolName: string): string | null | undefined {
  const separator = toolName.indexOf('__')
  if (separator === -1) return null
  const match = toolName.match(/_([a-f0-9]{8})$/i)
  return match?.[1].toLowerCase()
}

/**
 * Approval-anchored CRM email context. `null` means the record is absent or
 * its linked contact addresses do not include the approval's frozen
 * recipient. `{ thread: null }` means authority was valid but the owner's
 * archive cannot currently supply the frozen reply target.
 */
export async function getCrmEmailReviewContext(input: {
  ctx: AccessContext
  entityId: string
  recipient: string
  replyTo: string
  toolName: string
  account?: string | null
}): Promise<CrmEmailReviewContext | null> {
  const entity = await getEntityById(input.ctx, input.entityId)
  if (!entity || !['person', 'company', 'deal'].includes(entity.kind)) return null
  const addresses = await contactEmailsForEntity(input.ctx, entity)
  if (!addresses.includes(bareAddress(input.recipient))) return null

  const instancePrefix = mailboxInstancePrefix(input.toolName)
  if (instancePrefix === undefined) return { thread: null }
  const instances = await queryWithRLS<{ id: string }>(
    input.ctx.userId,
    `SELECT id
       FROM connector_instance
      WHERE scope = 'user' AND user_id = $1 AND provider = 'imap'
        AND ($2::text IS NULL OR lower(connected_email) = lower($2))
        AND ($3::text IS NULL OR replace(id::text, '-', '') LIKE $3 || '%')
      ORDER BY created_at ASC
      LIMIT $4`,
    [input.ctx.userId, input.account ?? null, instancePrefix,
      instancePrefix === null ? 1 : 2],
  )
  if (instances.rows.length !== 1) return { thread: null }
  const instanceId = instances.rows[0].id

  const anchor = await queryWithRLS<CrmEmailArchiveThreadRow>(
    input.ctx.userId,
    `SELECT id, provider_message_id AS "providerMessageId", folder,
            from_addr AS "fromAddr", to_addrs AS "toAddrs", cc_addrs AS "ccAddrs",
            sent_at AS "sentAt", subject, left(body_text, $5) AS "bodyText",
            rfc_message_id AS "rfcMessageId", in_reply_to AS "inReplyTo",
            references_ids AS "referencesIds"
       FROM email_archive_messages
      WHERE workspace_id = $1 AND owner_user_id = $2
        AND instance_id = $3 AND provider_message_id = $4
      LIMIT 1`,
    [input.ctx.workspaceId, input.ctx.userId, instanceId, input.replyTo,
      CRM_EMAIL_THREAD_BODY_CHARS + 1],
  )
  const anchorRow = anchor.rows[0]
  if (!anchorRow) return { thread: null }
  const referenceIds = [...new Set([
    anchorRow.rfcMessageId,
    anchorRow.inReplyTo,
    ...anchorRow.referencesIds,
  ].filter((value): value is string => Boolean(value)))]

  const candidates = await queryWithRLS<CrmEmailArchiveThreadRow>(
    input.ctx.userId,
    `SELECT id, provider_message_id AS "providerMessageId", folder,
            from_addr AS "fromAddr", to_addrs AS "toAddrs", cc_addrs AS "ccAddrs",
            sent_at AS "sentAt", subject, left(body_text, $7) AS "bodyText",
            rfc_message_id AS "rfcMessageId", in_reply_to AS "inReplyTo",
            references_ids AS "referencesIds"
       FROM email_archive_messages
      WHERE workspace_id = $1 AND owner_user_id = $2 AND instance_id = $3
        AND (
          provider_message_id = $4
          OR rfc_message_id = ANY($5::text[])
          OR in_reply_to = ANY($5::text[])
          OR references_ids && $5::text[]
          OR lower(trim(regexp_replace(subject,
               '^((re|fwd?|aw|回复|回覆|转发|轉發)[[:space:]]*[:：][[:space:]]*)+', '', 'i'))
             = lower(trim(regexp_replace($6,
               '^((re|fwd?|aw|回复|回覆|转发|轉發)[[:space:]]*[:：][[:space:]]*)+', '', 'i'))
        )
      ORDER BY (provider_message_id = $4) DESC, sent_at DESC NULLS LAST, created_at DESC
      LIMIT $8`,
    [input.ctx.workspaceId, input.ctx.userId, instanceId, input.replyTo,
      referenceIds, anchorRow.subject, CRM_EMAIL_THREAD_BODY_CHARS + 1,
      CRM_EMAIL_THREAD_CANDIDATE_LIMIT],
  )
  return {
    thread: buildCrmEmailReviewThread(
      candidates.rows,
      input.replyTo,
      candidates.rows.length === CRM_EMAIL_THREAD_CANDIDATE_LIMIT,
    ),
  }
}

export async function listCrmTimeline(input: {
  ctx: AccessContext
  entityId: string
  limit?: number
}): Promise<CrmActivity[] | null> {
  const entity = await getEntityById(input.ctx, input.entityId)
  if (!entity || !['person', 'company', 'deal'].includes(entity.kind)) return null
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100)
  const addresses = await contactEmailsForEntity(input.ctx, entity)
  const [activities, mail] = await Promise.all([
    queryWithRLS<{
      id: string; activityType: string; direction: string; occurredAt: Date
      subject: string | null; summary: string; sourceKind: string | null
      metadata: Record<string, unknown>
    }>(
      input.ctx.userId,
      `SELECT id, activity_type AS "activityType", direction,
              occurred_at AS "occurredAt", subject, summary,
              source_kind AS "sourceKind", metadata
         FROM crm_activities
        WHERE workspace_id = $1 AND entity_id = $2
        ORDER BY occurred_at DESC, id DESC LIMIT $3`,
      [input.ctx.workspaceId, input.entityId, limit],
    ),
    addresses.length === 0
      ? Promise.resolve({ rows: [] as Array<{
          id: string; folder: string; subject: string; fromAddr: string
          toAddrs: string[]; sentAt: Date | null; summary: string
        }> })
      : queryWithRLS<{
          id: string; folder: string; subject: string; fromAddr: string
          toAddrs: string[]; sentAt: Date | null; summary: string
        }>(
          input.ctx.userId,
          `SELECT id, folder, subject, from_addr AS "fromAddr", to_addrs AS "toAddrs",
                  sent_at AS "sentAt", left(body_text, 280) AS summary
             FROM email_archive_messages
            WHERE workspace_id = $1 AND owner_user_id = $2
              AND (
                lower(from_addr) = ANY($3::text[])
                OR EXISTS (
                  SELECT 1 FROM unnest(to_addrs || cc_addrs) addr
                   WHERE lower(addr) = ANY($3::text[])
                      OR lower(addr) LIKE ANY(
                        SELECT '%<' || address || '>' FROM unnest($3::text[]) address
                      )
                )
                OR lower(from_addr) LIKE ANY(
                  SELECT '%<' || address || '>' FROM unnest($3::text[]) address
                )
              )
            ORDER BY sent_at DESC NULLS LAST, created_at DESC LIMIT $4`,
          [input.ctx.workspaceId, input.ctx.userId, addresses, limit],
        ),
  ])
  const explicit: CrmActivity[] = activities.rows.map((row) => ({
    ...row,
    occurredAt: row.occurredAt.toISOString(),
  }))
  const email: CrmActivity[] = mail.rows.map((row) => {
    const incoming = addresses.includes(bareAddress(row.fromAddr))
    return {
      id: `email:${row.id}`,
      activityType: 'message',
      direction: incoming ? 'inbound' : 'outbound',
      occurredAt: (row.sentAt ?? new Date(0)).toISOString(),
      subject: row.subject || null,
      summary: row.summary,
      sourceKind: 'email_archive',
      metadata: { folder: row.folder, from: row.fromAddr, to: row.toAddrs },
    }
  })
  return [...explicit, ...email]
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, limit)
}

export type CrmSavedView = {
  id: string
  name: string
  section: string
  queryState: Record<string, unknown>
  position: number
}

export async function listCrmSavedViews(userId: string, workspaceId: string): Promise<CrmSavedView[]> {
  const result = await queryWithRLS<CrmSavedView>(
    userId,
    `SELECT id, name, section, query_state AS "queryState", position
       FROM crm_saved_views WHERE workspace_id = $1 AND owner_user_id = $2
      ORDER BY position, created_at`,
    [workspaceId, userId],
  )
  return result.rows
}

export async function createCrmSavedView(input: {
  userId: string
  workspaceId: string
  name: string
  section: string
  queryState: Record<string, unknown>
}): Promise<CrmSavedView> {
  const result = await queryWithRLS<CrmSavedView>(
    input.userId,
    `INSERT INTO crm_saved_views
       (workspace_id, owner_user_id, name, section, query_state, position)
     VALUES ($1,$2,$3,$4,$5::jsonb,
       COALESCE((SELECT MAX(position) + 1 FROM crm_saved_views
                 WHERE workspace_id = $1 AND owner_user_id = $2),0))
     RETURNING id, name, section, query_state AS "queryState", position`,
    [input.workspaceId, input.userId, input.name, input.section,
      JSON.stringify(input.queryState)],
  )
  return result.rows[0]
}

export async function deleteCrmSavedView(
  userId: string,
  workspaceId: string,
  viewId: string,
): Promise<boolean> {
  const result = await queryWithRLS(
    userId,
    `DELETE FROM crm_saved_views
      WHERE id = $1 AND workspace_id = $2 AND owner_user_id = $3`,
    [viewId, workspaceId, userId],
  )
  return (result.rowCount ?? 0) > 0
}

export type CrmDuplicateGroup = {
  kind: CrmEntityKind
  reason: 'email' | 'phone' | 'domain' | 'name' | 'alias'
  value: string
  records: Array<{ id: string; name: string }>
}

function normalizedName(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '')
}

export function findCrmDuplicateGroups(
  rows: readonly CrmRecordRow[],
  options: { separatedPairs?: ReadonlySet<string>; maxGroups?: number; maxGroupSize?: number } = {},
): CrmDuplicateGroup[] {
  const buckets = new Map<string, CrmDuplicateGroup>()
  for (const row of rows) {
    if (row.kind === 'person' && row.attributes.self === true) continue
    const candidates: Array<{ reason: CrmDuplicateGroup['reason']; value: string }> = []
    if (row.kind === 'person') {
      const email = typeof row.attributes.email === 'string' ? bareAddress(row.attributes.email) : ''
      if (email) candidates.push({ reason: 'email', value: email })
      const phone = typeof row.attributes.phone === 'string'
        ? row.attributes.phone.replace(/[^0-9+]+/g, '')
        : ''
      if (phone) candidates.push({ reason: 'phone', value: phone })
    }
    if (row.kind === 'company') {
      const domain = typeof row.attributes.domain === 'string'
        ? row.attributes.domain.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]
        : ''
      if (domain) candidates.push({ reason: 'domain', value: domain })
    }
    const name = normalizedName(row.name)
    if (name) candidates.push({ reason: 'name', value: name })
    for (const candidate of candidates) {
      const key = `${row.kind}:${candidate.reason}:${candidate.value}`
      const group = buckets.get(key) ?? {
        kind: row.kind,
        reason: candidate.reason,
        value: candidate.value,
        records: [],
      }
      if (group.records.length < (options.maxGroupSize ?? 50)) {
        group.records.push({ id: row.id, name: row.name })
      }
      buckets.set(key, group)
    }
  }

  // A confirmed merge alias is useful candidate evidence, but never person
  // mutation authority. Emit bounded pair groups when one live row's alias is
  // another row's normalized display name.
  const byKind = new Map<CrmEntityKind, CrmRecordRow[]>()
  for (const row of rows) byKind.set(row.kind, [...(byKind.get(row.kind) ?? []), row])
  for (const [kind, sameKind] of byKind) {
    for (let i = 0; i < sameKind.length; i++) {
      for (let j = i + 1; j < sameKind.length; j++) {
        const left = sameKind[i]
        const right = sameKind[j]
        const leftAliases = new Set((left.aliases ?? []).map(normalizedName))
        const rightAliases = new Set((right.aliases ?? []).map(normalizedName))
        if (!leftAliases.has(normalizedName(right.name)) && !rightAliases.has(normalizedName(left.name))) continue
        buckets.set(`alias:${kind}:${left.id}:${right.id}`, {
          kind,
          reason: 'alias',
          value: leftAliases.has(normalizedName(right.name)) ? right.name : left.name,
          records: [{ id: left.id, name: left.name }, { id: right.id, name: right.name }],
        })
      }
    }
  }

  const pairKey = (a: string, b: string) => a < b ? `${a}:${b}` : `${b}:${a}`
  const separated = options.separatedPairs ?? new Set<string>()
  return [...buckets.values()]
    .map((group) => ({
      ...group,
      records: group.records.filter((record, index, records) =>
        !records.some((other, otherIndex) =>
          otherIndex < index && separated.has(pairKey(record.id, other.id))),
      ),
    }))
    .filter((group) => group.records.length > 1)
    .sort((a, b) => a.kind.localeCompare(b.kind)
      || a.reason.localeCompare(b.reason)
      || a.value.localeCompare(b.value))
    .slice(0, options.maxGroups ?? 200)
}

export type CrmReport = {
  byStage: Array<{ stageId: string; name: string; category: CrmStageCategory; count: number; values: Record<string, number> }>
  openValue: Record<string, number>
  weightedForecast: Record<string, number>
  wonCount: number
  lostCount: number
  winRate: number | null
  missingOwnerCount: number
  missingAmountCount: number
  bySource: Array<{ source: string; count: number; won: number; values: Record<string, number> }>
  stageVelocityDays: Array<{ stageId: string; medianDays: number | null; samples: number }>
}

function addCurrency(target: Record<string, number>, currency: string, amount: number): void {
  target[currency] = Math.round(((target[currency] ?? 0) + amount) * 100) / 100
}

/** Pure deterministic report reducer; missing history remains null. */
export function buildCrmReport(
  deals: readonly CrmRecordRow[],
  config: CrmConfig,
  transitions: ReadonlyArray<{ entityId: string; occurredAt: string; metadata: Record<string, unknown> }> = [],
): CrmReport {
  const defaultPipeline = config.pipelines.find((p) => p.isDefault) ?? config.pipelines[0]
  const allStages = config.pipelines.flatMap((p) => p.stages)
  const stageById = new Map(allStages.map((s) => [s.id, s]))
  const legacyStage = new Map(allStages.filter((s) => s.legacyKey).map((s) => [s.legacyKey!, s]))
  const stageRows = new Map<string, CrmReport['byStage'][number]>()
  for (const stage of allStages) {
    stageRows.set(stage.id, { stageId: stage.id, name: stage.name, category: stage.category, count: 0, values: {} })
  }
  const openValue: Record<string, number> = {}
  const weightedForecast: Record<string, number> = {}
  let wonCount = 0
  let lostCount = 0
  let missingOwnerCount = 0
  let missingAmountCount = 0
  const sources = new Map<string, { source: string; count: number; won: number; values: Record<string, number> }>()

  for (const deal of deals.filter((r) => r.kind === 'deal' && !r.archivedAt)) {
    const stageId = typeof deal.attributes.pipeline_stage_id === 'string'
      ? deal.attributes.pipeline_stage_id
      : null
    const legacy = typeof deal.attributes.stage === 'string' ? deal.attributes.stage : 'lead'
    const configuredStage = stageId ? stageById.get(stageId) : undefined
    // Legacy CRM tools still write `attributes.stage`. Prefer the stable R2
    // id unless it names a compatibility stage that now disagrees with that
    // legacy value; this keeps reports truthful during the transition while
    // preserving custom (legacyKey=null) stages.
    const stage = (configuredStage
      && (configuredStage.legacyKey === null || configuredStage.legacyKey === legacy)
      ? configuredStage
      : undefined)
      ?? legacyStage.get(legacy)
      ?? defaultPipeline?.stages[0]
    if (!stage) continue
    const currency = typeof deal.attributes.currency_code === 'string'
      ? deal.attributes.currency_code.toUpperCase()
      : 'USD'
    const amount = typeof deal.attributes.amount === 'number'
      ? deal.attributes.amount
      : Number(deal.attributes.amount ?? 0)
    const validAmount = Number.isFinite(amount) && amount >= 0 ? amount : 0
    const stageRow = stageRows.get(stage.id)
    if (stageRow) {
      stageRow.count++
      addCurrency(stageRow.values, currency, validAmount)
    }
    if (stage.category === 'open') {
      addCurrency(openValue, currency, validAmount)
      addCurrency(weightedForecast, currency, validAmount * stage.probability / 100)
    } else if (stage.category === 'won') wonCount++
    else lostCount++
    if (deal.attributes.owner_id == null) missingOwnerCount++
    if (deal.attributes.amount == null) missingAmountCount++
    const source = typeof deal.attributes.source === 'string' && deal.attributes.source.trim()
      ? deal.attributes.source.trim()
      : 'Unspecified'
    const sourceRow = sources.get(source) ?? { source, count: 0, won: 0, values: {} }
    sourceRow.count++
    if (stage.category === 'won') sourceRow.won++
    addCurrency(sourceRow.values, currency, validAmount)
    sources.set(source, sourceRow)
  }

  const samples = new Map<string, number[]>()
  const byEntity = new Map<string, Array<(typeof transitions)[number]>>()
  for (const transition of transitions) {
    const list = byEntity.get(transition.entityId) ?? []
    list.push(transition)
    byEntity.set(transition.entityId, list)
  }
  for (const list of byEntity.values()) {
    const ordered = [...list].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    for (let i = 0; i + 1 < ordered.length; i++) {
      const stageId = typeof ordered[i].metadata.toStageId === 'string'
        ? ordered[i].metadata.toStageId as string
        : null
      if (!stageId) continue
      const days = (Date.parse(ordered[i + 1].occurredAt) - Date.parse(ordered[i].occurredAt)) / 86_400_000
      if (!Number.isFinite(days) || days < 0) continue
      const values = samples.get(stageId) ?? []
      values.push(days)
      samples.set(stageId, values)
    }
  }
  const stageVelocityDays = allStages.map((stage) => {
    const values = [...(samples.get(stage.id) ?? [])].sort((a, b) => a - b)
    if (values.length === 0) return { stageId: stage.id, medianDays: null, samples: 0 }
    const middle = Math.floor(values.length / 2)
    const median = values.length % 2
      ? values[middle]
      : (values[middle - 1] + values[middle]) / 2
    return { stageId: stage.id, medianDays: Math.round(median * 10) / 10, samples: values.length }
  })

  const closed = wonCount + lostCount
  return {
    byStage: [...stageRows.values()],
    openValue,
    weightedForecast,
    wonCount,
    lostCount,
    winRate: closed > 0 ? Math.round((wonCount / closed) * 10_000) / 100 : null,
    missingOwnerCount,
    missingAmountCount,
    bySource: [...sources.values()].sort((a, b) => b.count - a.count),
    stageVelocityDays,
  }
}

export async function getCrmReport(ctx: AccessContext): Promise<CrmReport> {
  const ap = buildAccessPredicate(ctx, { alias: 'e', startIdx: 1 })
  const [records, config, history] = await Promise.all([
    listCrmR2Records(ctx),
    getCrmConfig(ctx.userId, ctx.workspaceId),
    queryGated<{ entityId: string; occurredAt: Date; metadata: Record<string, unknown> }>(
      ctx,
      `SELECT entity_id AS "entityId", occurred_at AS "occurredAt", metadata
         FROM crm_activities a
         JOIN entities e ON e.id = a.entity_id
        WHERE ${ap.sql}
          AND a.workspace_id = $${ap.nextIdx}
          AND e.kind = 'deal' AND e.valid_to IS NULL AND e.retracted_at IS NULL
          AND a.activity_type = 'stage_change'
        ORDER BY a.occurred_at`,
      [...ap.params, ctx.workspaceId],
    ),
  ])
  return buildCrmReport(records, config, history.rows.map((r) => ({
    entityId: r.entityId,
    occurredAt: r.occurredAt.toISOString(),
    metadata: r.metadata ?? {},
  })))
}

export function crmRowsToCsv(
  rows: readonly CrmRecordRow[],
  kind: CrmEntityKind,
  fields: readonly CrmFieldDefinition[] = [],
): string {
  const escape = (value: unknown) => {
    const raw = value == null ? '' : String(value)
    return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw
  }
  const selected = rows.filter((r) => r.kind === kind)
  const customFields = fields.filter((field) => field.entityKind === kind)
  const customValues = (row: CrmRecordRow): unknown[] => {
    const values = row.attributes.custom_fields
    const custom = values && typeof values === 'object' && !Array.isArray(values)
      ? values as Record<string, unknown>
      : {}
    return customFields.map((field) => {
      const value = custom[field.fieldKey]
      return Array.isArray(value) ? value.join('|') : value
    })
  }
  if (kind === 'person') {
    return [
      ['name', 'email', 'phone', 'company_id', 'tags', ...customFields.map((field) => field.label)].map(escape).join(','),
      ...selected.map((r) => [r.name, r.attributes.email, r.attributes.phone,
        r.attributes.company_id, Array.isArray(r.attributes.tags) ? r.attributes.tags.join('|') : '', ...customValues(r)]
        .map(escape).join(',')),
    ].join('\n')
  }
  if (kind === 'company') {
    return [
      ['name', 'domain', 'tags', ...customFields.map((field) => field.label)].map(escape).join(','),
      ...selected.map((r) => [r.name, r.attributes.domain,
        Array.isArray(r.attributes.tags) ? r.attributes.tags.join('|') : '', ...customValues(r)]
        .map(escape).join(',')),
    ].join('\n')
  }
  return [
    ['name', 'stage', 'amount', 'currency_code', 'close_date', 'contact_id', 'company_id', 'source', ...customFields.map((field) => field.label)].map(escape).join(','),
    ...selected.map((r) => [r.name, r.attributes.stage, r.attributes.amount,
      r.attributes.currency_code, r.attributes.close_date, r.attributes.contact_id,
      r.attributes.company_id, r.attributes.source, ...customValues(r)].map(escape).join(',')),
  ].join('\n')
}
