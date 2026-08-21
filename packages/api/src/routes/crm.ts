/**
 * CRM R2 HTTP surface. Mounted at `/api/crm` behind `requireAuth`.
 *
 * The router keeps decisions deterministic: it operates entity-backed records,
 * bounded pipeline/custom-field configuration, activity/history, duplicate
 * review, import/export, saved filters, participants, and reports. It does not
 * rank follow-ups or create automation.
 *
 * Spec: docs/architecture/features/crm.md -> "CRM R2 product contract".
 * [COMP:api/crm-r2-route]
 */

import { Router } from 'express'
import type { Response } from 'express'
import type { AccessContext, DealStage, EntityLinksStore } from '@use-brian/core'
import { EntityMergeError, UndoMergeError, mergeEntities, undoMerge } from '@use-brian/core'
import type { WorkspaceStore } from '../db/workspace-store.js'
import { resolveWorkspaceViewpoint } from '../db/workspace-viewpoint.js'
import {
  createCompany,
  createContact,
  createDeal,
} from '../db/crm.js'
import { getEntityById, updateEntity } from '../db/entities-store.js'
import { createEntityMergeStore } from '../db/entity-merge-store.js'
import {
  CRM_FIELD_TYPES,
  addCrmDealParticipant,
  appendCrmActivity,
  archiveCrmFieldDefinition,
  createCrmFieldDefinition,
  createCrmPipeline,
  createCrmSavedView,
  createCrmStage,
  crmRowsToCsv,
  deleteCrmSavedView,
  findCrmDuplicateGroups,
  getCrmConfig,
  getCrmReport,
  listCrmDealParticipants,
  listCrmR2Records,
  listCrmSavedViews,
  listCrmTimeline,
  removeCrmDealParticipant,
  setCrmArchived,
  setCrmDealPipelineStage,
  updateCrmCustomFields,
  updateCrmStage,
  validateCustomFieldValue,
  type CrmEntityKind,
  type CrmFieldType,
  type CrmStageCategory,
} from '../db/crm-r2.js'
import { notifyBrainInboxChange } from '../brain-stream/notify.js'

type RouteOptions = {
  workspaceStore: WorkspaceStore
  entityLinks?: EntityLinksStore
}

const CRM_KINDS = new Set<CrmEntityKind>(['person', 'company', 'deal'])
const STAGE_CATEGORIES = new Set<CrmStageCategory>(['open', 'won', 'lost'])
const LEGACY_STAGES = new Set<DealStage>([
  'lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost',
])

function text(value: unknown, max = 200): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim().slice(0, max)
    : null
}

function nullableText(value: unknown, max = 500): string | null | undefined {
  if (value === null || value === '') return null
  return text(value, max) ?? undefined
}

function finiteNumber(value: unknown): number | null | undefined {
  if (value === null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : undefined
}

function stringArray(value: unknown, max = 50): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim()).filter(Boolean).slice(0, max)
    : []
}

function publicRecord(row: Awaited<ReturnType<typeof listCrmR2Records>>[number]) {
  const a = row.attributes
  const common = {
    id: row.id,
    name: row.name,
    ownerId: typeof a.owner_id === 'string' ? a.owner_id : null,
    customFields: a.custom_fields && typeof a.custom_fields === 'object'
      ? a.custom_fields
      : {},
    archivedAt: row.archivedAt,
    updatedAt: row.updatedAt,
  }
  if (row.kind === 'person') {
    return {
      ...common,
      kind: 'contact' as const,
      email: typeof a.email === 'string' ? a.email : null,
      phone: typeof a.phone === 'string' ? a.phone : null,
      companyId: typeof a.company_id === 'string' ? a.company_id : null,
      tags: stringArray(a.tags),
    }
  }
  if (row.kind === 'company') {
    return {
      ...common,
      kind: 'company' as const,
      domain: typeof a.domain === 'string' ? a.domain : null,
      tags: stringArray(a.tags),
    }
  }
  return {
    ...common,
    kind: 'deal' as const,
    stage: LEGACY_STAGES.has(a.stage as DealStage) ? a.stage as DealStage : 'lead',
    amount: finiteNumber(a.amount) ?? null,
    closeDate: typeof a.close_date === 'string' ? a.close_date : null,
    contactId: typeof a.contact_id === 'string' ? a.contact_id : null,
    companyId: typeof a.company_id === 'string' ? a.company_id : null,
    pipelineId: typeof a.pipeline_id === 'string' ? a.pipeline_id : null,
    pipelineStageId: typeof a.pipeline_stage_id === 'string' ? a.pipeline_stage_id : null,
    currencyCode: typeof a.currency_code === 'string' ? a.currency_code : 'USD',
    probability: finiteNumber(a.probability) ?? null,
    source: typeof a.source === 'string' ? a.source : null,
    winLossReason: typeof a.win_loss_reason === 'string' ? a.win_loss_reason : null,
  }
}

export function crmRoutes({ workspaceStore, entityLinks }: RouteOptions): Router {
  const router = Router()
  const mergeRepo = createEntityMergeStore()

  async function memberContext(
    req: { userId?: string; params: { workspaceId: string } },
    res: Response,
  ): Promise<{ ctx: AccessContext; role: string } | null> {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return null
    }
    const role = await workspaceStore.getRole(userId, req.params.workspaceId)
    if (!role) {
      res.status(403).json({ error: 'Not a member of this workspace' })
      return null
    }
    const ctx = await resolveWorkspaceViewpoint(userId, req.params.workspaceId, null)
    if (!ctx) {
      res.status(404).json({ error: 'Workspace not found' })
      return null
    }
    return { ctx, role }
  }

  function requireAdmin(role: string, res: Response): boolean {
    if (role === 'owner' || role === 'admin') return true
    res.status(403).json({ error: 'Owner or admin role required' })
    return false
  }

  async function createRecord(
    ctx: AccessContext,
    body: Record<string, unknown>,
  ): Promise<{ id: string; kind: CrmEntityKind }> {
    const rawKind = body.kind
    const kind: CrmEntityKind | null = rawKind === 'contact'
      ? 'person'
      : CRM_KINDS.has(rawKind as CrmEntityKind) ? rawKind as CrmEntityKind : null
    const name = text(body.name, 256)
    if (!kind || !name) throw new Error('kind and name are required')
    const customFields = body.customFields && typeof body.customFields === 'object'
      && !Array.isArray(body.customFields)
      ? body.customFields as Record<string, unknown>
      : null
    const config = await getCrmConfig(ctx.userId, ctx.workspaceId)
    const definitions = config.fields.filter((field) => field.entityKind === kind)
    if (customFields) {
      const definitionsByKey = new Map(definitions.map((field) => [field.fieldKey, field]))
      for (const [key, value] of Object.entries(customFields)) {
        const definition = definitionsByKey.get(key)
        if (!definition || !validateCustomFieldValue(definition, value)) {
          throw new Error(`Invalid custom field value for '${key}'`)
        }
      }
    }
    for (const definition of definitions.filter((field) => field.isRequired)) {
      if (!validateCustomFieldValue(definition, customFields?.[definition.fieldKey])) {
        throw new Error(`Required custom field is missing: '${definition.fieldKey}'`)
      }
    }

    let id: string
    if (kind === 'person') {
      const record = await createContact(ctx.userId, {
        workspaceId: ctx.workspaceId,
        name,
        email: nullableText(body.email, 320),
        phone: nullableText(body.phone, 100),
        companyId: nullableText(body.companyId, 100),
        tags: stringArray(body.tags, 20),
        access: ctx,
      }, entityLinks)
      id = record.id
    } else if (kind === 'company') {
      const record = await createCompany(ctx.userId, {
        workspaceId: ctx.workspaceId,
        name,
        domain: nullableText(body.domain, 320),
        tags: stringArray(body.tags, 20),
        access: ctx,
      })
      id = record.id
    } else {
      const defaultPipeline = config.pipelines.find((p) => p.isDefault) ?? config.pipelines[0]
      const requestedStage = text(body.pipelineStageId, 100)
      const requestedPipeline = requestedStage
        ? config.pipelines.find((pipeline) => pipeline.stages.some((stage) => stage.id === requestedStage))
        : undefined
      const selectedPipeline = requestedPipeline ?? defaultPipeline
      const stageConfig = selectedPipeline?.stages.find((s) => s.id === requestedStage)
        ?? selectedPipeline?.stages[0]
      const legacyStage = stageConfig?.legacyKey && LEGACY_STAGES.has(stageConfig.legacyKey as DealStage)
        ? stageConfig.legacyKey as DealStage
        : stageConfig?.category === 'won' ? 'won'
          : stageConfig?.category === 'lost' ? 'lost' : 'lead'
      const amount = finiteNumber(body.amount)
      if (amount !== undefined && amount !== null && amount < 0) {
        throw new Error('amount must be greater than or equal to 0')
      }
      const close = nullableText(body.closeDate, 10)
      const record = await createDeal(ctx.userId, {
        workspaceId: ctx.workspaceId,
        contactId: nullableText(body.contactId, 100),
        companyId: nullableText(body.companyId, 100),
        stage: legacyStage,
        amount,
        closeDate: close ? new Date(`${close}T00:00:00Z`) : null,
      }, entityLinks)
      id = record.id
      const entity = await getEntityById(ctx, id)
      if (entity) {
        const attributes = {
          ...entity.attributes,
          pipeline_id: selectedPipeline?.id,
          pipeline_stage_id: stageConfig?.id,
          currency_code: (text(body.currencyCode, 3) ?? 'USD').toUpperCase(),
          ...(text(body.ownerId, 100) ? { owner_id: text(body.ownerId, 100) } : {}),
          ...(text(body.source, 100) ? { source: text(body.source, 100) } : {}),
        }
        await updateEntity(ctx.userId, id, { displayName: name, attributes }, ctx)
        if (record.contactId) {
          await addCrmDealParticipant({
            ctx, dealId: id, contactId: record.contactId, isPrimary: true,
          })
        }
      }
    }

    const entity = await getEntityById(ctx, id)
    if (entity) {
      const attributes: Record<string, unknown> = {
        ...entity.attributes,
        ...(text(body.ownerId, 100) ? { owner_id: text(body.ownerId, 100) } : {}),
      }
      if (customFields) attributes.custom_fields = customFields
      await updateEntity(ctx.userId, id, { attributes }, ctx)
    }
    await appendCrmActivity({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      entityId: id,
      activityType: 'field_change',
      summary: 'CRM record created',
      metadata: { action: 'create', kind },
    })
    void notifyBrainInboxChange(ctx.workspaceId, kind === 'person' ? 'contact' : kind, id, 'create')
    return { id, kind }
  }

  router.get('/:workspaceId/records', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member) return
    try {
      const rows = await listCrmR2Records(member.ctx, {
        includeArchived: req.query.archived === 'true',
      })
      const records = rows.map(publicRecord)
      res.json({
        deals: records.filter((r) => r.kind === 'deal'),
        contacts: records.filter((r) => r.kind === 'contact'),
        companies: records.filter((r) => r.kind === 'company'),
      })
    } catch (err) {
      console.error('[crm] list failed:', err)
      res.status(500).json({ error: 'Failed to load CRM records' })
    }
  })

  router.post('/:workspaceId/records', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member) return
    try {
      const created = await createRecord(member.ctx, (req.body ?? {}) as Record<string, unknown>)
      res.status(201).json({ ok: true, ...created })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      res.status(400).json({ error: message })
    }
  })

  router.post('/:workspaceId/import', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member) return
    const records = Array.isArray(req.body?.records) ? req.body.records : null
    if (!records || records.length === 0 || records.length > 500) {
      res.status(400).json({ error: 'records must contain between 1 and 500 mapped rows' })
      return
    }
    const results: Array<{ row: number; id?: string; error?: string }> = []
    for (let i = 0; i < records.length; i++) {
      try {
        const created = await createRecord(member.ctx, records[i] as Record<string, unknown>)
        results.push({ row: i + 1, id: created.id })
      } catch (err) {
        results.push({ row: i + 1, error: err instanceof Error ? err.message : String(err) })
      }
    }
    res.status(207).json({
      created: results.filter((r) => r.id).length,
      failed: results.filter((r) => r.error).length,
      results,
    })
  })

  router.get('/:workspaceId/export', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member) return
    const requested = req.query.kind
    const kind: CrmEntityKind | null = requested === 'contacts' || requested === 'person'
      ? 'person'
      : requested === 'companies' || requested === 'company'
        ? 'company'
        : requested === 'deals' || requested === 'deal' ? 'deal' : null
    if (!kind) {
      res.status(400).json({ error: 'kind must be contacts, companies, or deals' })
      return
    }
    const rows = await listCrmR2Records(member.ctx)
    const csv = crmRowsToCsv(rows, kind)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="crm-${kind}.csv"`)
    res.send(`\uFEFF${csv}`)
  })

  for (const action of ['archive', 'restore'] as const) {
    router.post(`/:workspaceId/records/:entityId/${action}`, async (req, res) => {
      const member = await memberContext(req as never, res)
      if (!member) return
      const updated = await setCrmArchived({
        ctx: member.ctx,
        entityId: req.params.entityId,
        archived: action === 'archive',
      })
      if (!updated) {
        res.status(404).json({ error: 'Record not found' })
        return
      }
      await appendCrmActivity({
        userId: member.ctx.userId,
        workspaceId: member.ctx.workspaceId,
        entityId: updated.id,
        activityType: 'field_change',
        summary: action === 'archive' ? 'CRM record archived' : 'CRM record restored',
        metadata: { field: 'crm_archived_at', action },
      })
      void notifyBrainInboxChange(member.ctx.workspaceId,
        updated.kind === 'person' ? 'contact' : updated.kind as 'company' | 'deal',
        updated.id, 'update')
      res.json({ ok: true })
    })
  }

  router.patch('/:workspaceId/records/:entityId/custom-fields', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member) return
    const values = req.body?.values
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      res.status(400).json({ error: 'values must be an object' })
      return
    }
    try {
      const before = await getEntityById(member.ctx, req.params.entityId)
      const updated = await updateCrmCustomFields({
        ctx: member.ctx,
        entityId: req.params.entityId,
        values: values as Record<string, unknown>,
      })
      if (!updated) {
        res.status(404).json({ error: 'Record not found' })
        return
      }
      await appendCrmActivity({
        userId: member.ctx.userId,
        workspaceId: member.ctx.workspaceId,
        entityId: updated.id,
        activityType: 'field_change',
        summary: 'Custom fields updated',
        metadata: {
          fields: Object.keys(values),
          before: before?.attributes.custom_fields ?? {},
          after: updated.attributes.custom_fields ?? {},
        },
      })
      res.json({ ok: true, customFields: updated.attributes.custom_fields ?? {} })
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.patch('/:workspaceId/records/:entityId/pipeline-stage', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member) return
    const stageId = text(req.body?.stageId, 100)
    if (!stageId) {
      res.status(400).json({ error: 'stageId is required' })
      return
    }
    try {
      const changed = await setCrmDealPipelineStage({
        ctx: member.ctx,
        entityId: req.params.entityId,
        stageId,
      })
      if (!changed) {
        res.status(404).json({ error: 'Deal or stage not found' })
        return
      }
      await appendCrmActivity({
        userId: member.ctx.userId,
        workspaceId: member.ctx.workspaceId,
        entityId: changed.entity.id,
        activityType: 'stage_change',
        summary: `Deal moved to ${changed.toStage.name}`,
        metadata: {
          fromStageId: changed.fromStageId,
          toStageId: changed.toStage.id,
          toStageName: changed.toStage.name,
        },
      })
      res.json({ ok: true, stageId: changed.toStage.id })
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.get('/:workspaceId/records/:entityId/timeline', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member) return
    const timeline = await listCrmTimeline({ ctx: member.ctx, entityId: req.params.entityId })
    if (!timeline) {
      res.status(404).json({ error: 'Record not found' })
      return
    }
    res.json({ activities: timeline })
  })

  router.post('/:workspaceId/records/:entityId/activities', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member) return
    const entity = await getEntityById(member.ctx, req.params.entityId)
    if (!entity || !CRM_KINDS.has(entity.kind as CrmEntityKind)) {
      res.status(404).json({ error: 'Record not found' })
      return
    }
    const activityType = req.body?.activityType
    if (!['note', 'call', 'meeting', 'message'].includes(activityType)) {
      res.status(400).json({ error: 'activityType must be note, call, meeting, or message' })
      return
    }
    const summary = text(req.body?.summary, 10_000)
    if (!summary) {
      res.status(400).json({ error: 'summary is required' })
      return
    }
    const occurredAt = req.body?.occurredAt ? new Date(req.body.occurredAt) : new Date()
    if (!Number.isFinite(occurredAt.getTime())) {
      res.status(400).json({ error: 'occurredAt must be a valid date' })
      return
    }
    const activity = await appendCrmActivity({
      userId: member.ctx.userId,
      workspaceId: member.ctx.workspaceId,
      entityId: entity.id,
      activityType,
      direction: ['inbound', 'outbound', 'internal'].includes(req.body?.direction)
        ? req.body.direction
        : 'internal',
      occurredAt,
      subject: nullableText(req.body?.subject, 500),
      summary,
    })
    res.status(201).json({ activity })
  })

  router.get('/:workspaceId/config', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member) return
    res.json(await getCrmConfig(member.ctx.userId, member.ctx.workspaceId))
  })

  router.post('/:workspaceId/pipelines', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member || !requireAdmin(member.role, res)) return
    const name = text(req.body?.name, 100)
    if (!name) {
      res.status(400).json({ error: 'name is required' })
      return
    }
    res.status(201).json(await createCrmPipeline({ ...member.ctx, name }))
  })

  router.post('/:workspaceId/pipelines/:pipelineId/stages', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member || !requireAdmin(member.role, res)) return
    const name = text(req.body?.name, 100)
    const category = req.body?.category as CrmStageCategory
    const probability = finiteNumber(req.body?.probability)
    if (!name || !STAGE_CATEGORIES.has(category) || probability == null
      || probability < 0 || probability > 100) {
      res.status(400).json({ error: 'name, category, and probability 0-100 are required' })
      return
    }
    const stage = await createCrmStage({
      userId: member.ctx.userId,
      workspaceId: member.ctx.workspaceId,
      pipelineId: req.params.pipelineId,
      name,
      category,
      probability,
      requiredFields: stringArray(req.body?.requiredFields),
    })
    if (!stage) res.status(404).json({ error: 'Pipeline not found' })
    else res.status(201).json(stage)
  })

  router.patch('/:workspaceId/stages/:stageId', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member || !requireAdmin(member.role, res)) return
    const category = req.body?.category
    const probability = finiteNumber(req.body?.probability)
    if (category !== undefined && !STAGE_CATEGORIES.has(category)) {
      res.status(400).json({ error: 'Invalid stage category' })
      return
    }
    if (probability !== undefined && probability !== null && (probability < 0 || probability > 100)) {
      res.status(400).json({ error: 'probability must be between 0 and 100' })
      return
    }
    const stage = await updateCrmStage({
      userId: member.ctx.userId,
      workspaceId: member.ctx.workspaceId,
      stageId: req.params.stageId,
      name: text(req.body?.name, 100) ?? undefined,
      category: category as CrmStageCategory | undefined,
      probability: probability ?? undefined,
      requiredFields: Array.isArray(req.body?.requiredFields)
        ? stringArray(req.body.requiredFields)
        : undefined,
    })
    if (!stage) res.status(404).json({ error: 'Stage not found' })
    else res.json(stage)
  })

  router.post('/:workspaceId/fields', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member || !requireAdmin(member.role, res)) return
    const entityKind = req.body?.entityKind as CrmEntityKind
    const fieldType = req.body?.fieldType as CrmFieldType
    const fieldKey = text(req.body?.fieldKey, 63)
    const label = text(req.body?.label, 100)
    if (!CRM_KINDS.has(entityKind) || !CRM_FIELD_TYPES.includes(fieldType)
      || !fieldKey || !/^[a-z][a-z0-9_]{0,62}$/.test(fieldKey) || !label) {
      res.status(400).json({ error: 'Invalid custom field definition' })
      return
    }
    const options = stringArray(req.body?.options)
    if ((fieldType === 'single_select' || fieldType === 'multi_select') && options.length === 0) {
      res.status(400).json({ error: 'Select fields require at least one option' })
      return
    }
    const field = await createCrmFieldDefinition({
      userId: member.ctx.userId,
      workspaceId: member.ctx.workspaceId,
      entityKind,
      fieldKey,
      label,
      fieldType,
      options,
      isRequired: req.body?.isRequired === true,
    })
    if (!field) res.status(409).json({ error: 'Custom field limit reached' })
    else res.status(201).json(field)
  })

  router.delete('/:workspaceId/fields/:fieldId', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member || !requireAdmin(member.role, res)) return
    const ok = await archiveCrmFieldDefinition(
      member.ctx.userId, member.ctx.workspaceId, req.params.fieldId,
    )
    if (!ok) res.status(404).json({ error: 'Field not found' })
    else res.json({ ok: true })
  })

  router.get('/:workspaceId/views', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member) return
    res.json({ views: await listCrmSavedViews(member.ctx.userId, member.ctx.workspaceId) })
  })

  router.post('/:workspaceId/views', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member) return
    const name = text(req.body?.name, 100)
    const section = req.body?.section
    const queryState = req.body?.queryState
    if (!name || !['deals', 'contacts', 'companies', 'reports'].includes(section)
      || !queryState || typeof queryState !== 'object' || Array.isArray(queryState)) {
      res.status(400).json({ error: 'name, section, and queryState are required' })
      return
    }
    res.status(201).json(await createCrmSavedView({
      userId: member.ctx.userId,
      workspaceId: member.ctx.workspaceId,
      name,
      section,
      queryState,
    }))
  })

  router.delete('/:workspaceId/views/:viewId', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member) return
    const ok = await deleteCrmSavedView(
      member.ctx.userId, member.ctx.workspaceId, req.params.viewId,
    )
    if (!ok) res.status(404).json({ error: 'View not found' })
    else res.json({ ok: true })
  })

  router.get('/:workspaceId/records/:entityId/participants', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member) return
    const participants = await listCrmDealParticipants(member.ctx, req.params.entityId)
    if (!participants) res.status(404).json({ error: 'Deal not found' })
    else res.json({ participants })
  })

  router.post('/:workspaceId/records/:entityId/participants', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member) return
    const contactId = text(req.body?.contactId, 100)
    if (!contactId) {
      res.status(400).json({ error: 'contactId is required' })
      return
    }
    const ok = await addCrmDealParticipant({
      ctx: member.ctx,
      dealId: req.params.entityId,
      contactId,
      role: nullableText(req.body?.role, 100),
      isPrimary: req.body?.isPrimary === true,
    })
    if (!ok) res.status(404).json({ error: 'Deal or contact not found' })
    else res.status(201).json({ ok: true })
  })

  router.delete('/:workspaceId/records/:entityId/participants/:contactId', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member) return
    const ok = await removeCrmDealParticipant({
      ctx: member.ctx,
      dealId: req.params.entityId,
      contactId: req.params.contactId,
    })
    if (!ok) res.status(404).json({ error: 'Participant not found' })
    else res.json({ ok: true })
  })

  router.get('/:workspaceId/reports', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member) return
    res.json(await getCrmReport(member.ctx))
  })

  router.get('/:workspaceId/duplicates', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member) return
    const rows = await listCrmR2Records(member.ctx)
    res.json({ groups: findCrmDuplicateGroups(rows) })
  })

  router.post('/:workspaceId/merge', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member) return
    const survivingId = text(req.body?.survivingId, 100)
    const mergedId = text(req.body?.mergedId, 100)
    if (!survivingId || !mergedId) {
      res.status(400).json({ error: 'survivingId and mergedId are required' })
      return
    }
    const [survivor, merged] = await Promise.all([
      getEntityById(member.ctx, survivingId),
      getEntityById(member.ctx, mergedId),
    ])
    if (!survivor || !merged || survivor.kind !== merged.kind
      || !CRM_KINDS.has(survivor.kind as CrmEntityKind)) {
      res.status(404).json({ error: 'Visible CRM records of the same kind are required' })
      return
    }
    try {
      const record = await mergeEntities({
        workspaceId: member.ctx.workspaceId,
        survivingId,
        mergedId,
        actorUserId: member.ctx.userId,
        reason: text(req.body?.reason, 500) ?? 'CRM duplicate review',
        mode: 'survivor-wins',
        cascade: false,
      }, { repo: mergeRepo })
      res.json({
        ok: true,
        mergeId: record.id,
        undoUntil: new Date(record.mergedAt.getTime() + 7 * 86_400_000).toISOString(),
      })
    } catch (err) {
      const status = err instanceof EntityMergeError ? 409 : 500
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  router.post('/:workspaceId/merges/:mergeId/undo', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member) return
    try {
      await undoMerge({
        workspaceId: member.ctx.workspaceId,
        mergeId: req.params.mergeId,
        actorUserId: member.ctx.userId,
        reason: text(req.body?.reason, 500) ?? 'CRM merge undo',
      }, { repo: mergeRepo })
      res.json({ ok: true })
    } catch (err) {
      const status = err instanceof UndoMergeError ? 409 : 500
      res.status(status).json({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  return router
}
