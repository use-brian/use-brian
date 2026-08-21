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

import type { AccessContext, EntityRecord } from '@use-brian/core'
import { buildAccessPredicate } from './access-predicate.js'
import { getPool, query, queryGated, queryWithRLS } from './client.js'
import { getEntityById, updateEntity } from './entities-store.js'

export const CRM_FIELD_TYPES = [
  'text', 'number', 'date', 'boolean', 'single_select', 'multi_select',
] as const
export type CrmFieldType = (typeof CRM_FIELD_TYPES)[number]
export type CrmEntityKind = 'person' | 'company' | 'deal'
export type CrmStageCategory = 'open' | 'won' | 'lost'

export type CrmPipelineStage = {
  id: string
  pipelineId: string
  name: string
  legacyKey: string | null
  category: CrmStageCategory
  position: number
  probability: number
  requiredFields: string[]
}

export type CrmPipeline = {
  id: string
  name: string
  isDefault: boolean
  position: number
  stages: CrmPipelineStage[]
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
}

export type CrmConfig = {
  pipelines: CrmPipeline[]
  fields: CrmFieldDefinition[]
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
    `SELECT id FROM crm_pipelines WHERE workspace_id = $1 AND is_default LIMIT 1`,
    [workspaceId],
  )
  if (existing.rows[0]) return existing.rows[0].id

  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const pipeline = await client.query<{ id: string }>(
      `INSERT INTO crm_pipelines (workspace_id, name, is_default, position)
       VALUES ($1, 'Sales', true, 0)
       ON CONFLICT (workspace_id) WHERE is_default DO UPDATE
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

type ConfigStageRow = Omit<CrmPipelineStage, 'requiredFields'> & { requiredFields: string[] | null }
type ConfigFieldRow = Omit<CrmFieldDefinition, 'options'> & { options: unknown }

export async function getCrmConfig(userId: string, workspaceId: string): Promise<CrmConfig> {
  await ensureCrmDefaultPipeline(workspaceId)
  const [pipelineRows, stageRows, fieldRows] = await Promise.all([
    queryWithRLS<{ id: string; name: string; isDefault: boolean; position: number }>(
      userId,
      `SELECT id, name, is_default AS "isDefault", position
         FROM crm_pipelines WHERE workspace_id = $1
        ORDER BY position, created_at`,
      [workspaceId],
    ),
    queryWithRLS<ConfigStageRow>(
      userId,
      `SELECT id, pipeline_id AS "pipelineId", name, legacy_key AS "legacyKey",
              category, position, probability, required_fields AS "requiredFields"
         FROM crm_pipeline_stages WHERE workspace_id = $1
        ORDER BY pipeline_id, position`,
      [workspaceId],
    ),
    queryWithRLS<ConfigFieldRow>(
      userId,
      `SELECT id, entity_kind AS "entityKind", field_key AS "fieldKey", label,
              field_type AS "fieldType", options, is_required AS "isRequired", position
         FROM crm_field_definitions
        WHERE workspace_id = $1 AND archived_at IS NULL
        ORDER BY entity_kind, position, created_at`,
      [workspaceId],
    ),
  ])
  const stagesByPipeline = new Map<string, CrmPipelineStage[]>()
  for (const row of stageRows.rows) {
    const stages = stagesByPipeline.get(row.pipelineId) ?? []
    stages.push({ ...row, requiredFields: row.requiredFields ?? [] })
    stagesByPipeline.set(row.pipelineId, stages)
  }
  return {
    pipelines: pipelineRows.rows.map((p) => ({
      ...p,
      stages: stagesByPipeline.get(p.id) ?? [],
    })),
    fields: fieldRows.rows.map((f) => ({
      ...f,
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
       COALESCE((SELECT MAX(position) + 1 FROM crm_pipelines WHERE workspace_id = $1), 0),$3)
     RETURNING id, name, is_default AS "isDefault", position`,
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
       COALESCE((SELECT MAX(position) + 1 FROM crm_pipeline_stages WHERE pipeline_id = $2),0),
       $5,$6
     WHERE EXISTS (SELECT 1 FROM crm_pipelines WHERE id = $2 AND workspace_id = $1)
     RETURNING id, pipeline_id AS "pipelineId", name, legacy_key AS "legacyKey",
       category, position, probability, required_fields AS "requiredFields"`,
    [input.workspaceId, input.pipelineId, input.name, input.category, input.probability, input.requiredFields ?? []],
  )
  const row = inserted.rows[0]
  return row ? { ...row, requiredFields: row.requiredFields ?? [] } : null
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
     WHERE id = $2 AND workspace_id = $1
     RETURNING id, pipeline_id AS "pipelineId", name, legacy_key AS "legacyKey",
       category, position, probability, required_fields AS "requiredFields"`,
    [input.workspaceId, input.stageId, input.userId, input.name ?? null,
      input.category ?? null, input.probability ?? null, input.requiredFields ?? null],
  )
  const row = updated.rows[0]
  return row ? { ...row, requiredFields: row.requiredFields ?? [] } : null
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
       field_type AS "fieldType", options, is_required AS "isRequired", position`,
    [input.workspaceId, input.entityKind, input.fieldKey, input.label, input.fieldType,
      JSON.stringify(input.options ?? []), input.isRequired ?? false, input.userId],
  )
  const row = inserted.rows[0]
  return row ? {
    ...row,
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
  const result = await queryWithRLS(
    userId,
    `UPDATE crm_field_definitions SET archived_at = now()
      WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL`,
    [fieldId, workspaceId],
  )
  return (result.rowCount ?? 0) > 0
}

export type CrmRecordRow = {
  id: string
  kind: CrmEntityKind
  name: string
  attributes: Record<string, unknown>
  archivedAt: string | null
  updatedAt: string
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
    archivedAt: Date | null
    updatedAt: Date
  }>(
    ctx,
    `SELECT e.id, e.kind, e.display_name AS name, e.attributes,
            NULLIF(e.attributes->>'crm_archived_at','')::timestamptz AS "archivedAt",
            e.updated_at AS "updatedAt"
       FROM entities e
      WHERE ${ap.sql}
        AND e.kind = ANY($${ap.nextIdx}::text[])
        AND e.valid_to IS NULL AND e.retracted_at IS NULL
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
    archivedAt: r.archivedAt?.toISOString() ?? null,
    updatedAt: r.updatedAt.toISOString(),
  }))
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
  }
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
  const byKey = new Map(definitions.map((f) => [f.fieldKey, f]))
  for (const [key, value] of Object.entries(input.values)) {
    const definition = byKey.get(key)
    if (!definition || !validateCustomFieldValue(definition, value)) {
      throw new Error(`Invalid custom field value for '${key}'`)
    }
  }
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
        AND e.kind = 'person' AND e.valid_to IS NULL AND ${ap.sql}
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
  const [deal, contact] = await Promise.all([
    getEntityById(input.ctx, input.dealId),
    getEntityById(input.ctx, input.contactId),
  ])
  if (!deal || deal.kind !== 'deal' || !contact || contact.kind !== 'person') return false
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    if (input.isPrimary) {
      await client.query(
        `UPDATE crm_deal_contacts SET is_primary = false WHERE deal_id = $1`,
        [input.dealId],
      )
    }
    await client.query(
      `INSERT INTO crm_deal_contacts
         (workspace_id, deal_id, contact_id, role, is_primary, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (deal_id, contact_id) DO UPDATE
         SET role = EXCLUDED.role, is_primary = EXCLUDED.is_primary`,
      [input.ctx.workspaceId, input.dealId, input.contactId, input.role ?? null,
        input.isPrimary ?? false, input.ctx.userId],
    )
    if (input.isPrimary) {
      await client.query(
        `UPDATE entities SET
           attributes = jsonb_set(COALESCE(attributes, '{}'::jsonb),
             '{contact_id}', to_jsonb($2::text), true),
           updated_at = now()
         WHERE id = $1 AND workspace_id = $3`,
        [input.dealId, input.contactId, input.ctx.workspaceId],
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
  reason: 'email' | 'domain' | 'name'
  value: string
  records: Array<{ id: string; name: string }>
}

function normalizedName(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '')
}

export function findCrmDuplicateGroups(rows: readonly CrmRecordRow[]): CrmDuplicateGroup[] {
  const buckets = new Map<string, CrmDuplicateGroup>()
  for (const row of rows) {
    const candidates: Array<{ reason: CrmDuplicateGroup['reason']; value: string }> = []
    if (row.kind === 'person') {
      const email = typeof row.attributes.email === 'string' ? bareAddress(row.attributes.email) : ''
      if (email) candidates.push({ reason: 'email', value: email })
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
      group.records.push({ id: row.id, name: row.name })
      buckets.set(key, group)
    }
  }
  return [...buckets.values()].filter((g) => g.records.length > 1)
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

export function crmRowsToCsv(rows: readonly CrmRecordRow[], kind: CrmEntityKind): string {
  const escape = (value: unknown) => {
    const raw = value == null ? '' : String(value)
    return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw
  }
  const selected = rows.filter((r) => r.kind === kind)
  if (kind === 'person') {
    return [
      ['name', 'email', 'phone', 'company_id', 'tags'].join(','),
      ...selected.map((r) => [r.name, r.attributes.email, r.attributes.phone,
        r.attributes.company_id, Array.isArray(r.attributes.tags) ? r.attributes.tags.join('|') : '']
        .map(escape).join(',')),
    ].join('\n')
  }
  if (kind === 'company') {
    return [
      ['name', 'domain', 'tags'].join(','),
      ...selected.map((r) => [r.name, r.attributes.domain,
        Array.isArray(r.attributes.tags) ? r.attributes.tags.join('|') : '']
        .map(escape).join(',')),
    ].join('\n')
  }
  return [
    ['name', 'stage', 'amount', 'currency_code', 'close_date', 'contact_id', 'company_id', 'source'].join(','),
    ...selected.map((r) => [r.name, r.attributes.stage, r.attributes.amount,
      r.attributes.currency_code, r.attributes.close_date, r.attributes.contact_id,
      r.attributes.company_id, r.attributes.source].map(escape).join(',')),
  ].join('\n')
}
