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
  updateCompany,
  updateContact,
  updateDeal,
} from '../db/crm.js'
import { getEntityById, updateEntity } from '../db/entities-store.js'
import { createEntityMergeStore, EntityMergeStoreError } from '../db/entity-merge-store.js'
import {
  CRM_FIELD_TYPES,
  CRM_PRESET_IDS,
  CRM_REFERENCE_KINDS,
  addCrmDealParticipant,
  applyCrmFieldPreset,
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
  getCrmR2Record,
  getCrmReport,
  getCrmSummary,
  listCrmDealParticipants,
  listCrmRecordPage,
  listCrmRecordRelationships,
  listCrmR2Records,
  listCrmSavedViews,
  listCrmTimeline,
  lookupCrmRecords,
  removeCrmDealParticipant,
  reorderCrmFields,
  reorderCrmPipelines,
  reorderCrmStages,
  restoreCrmFieldDefinition,
  setCrmDealPrimaryContact,
  setCrmArchived,
  setCrmDealPipelineStage,
  setCrmStageArchived,
  updateCrmCustomFields,
  updateCrmFieldDefinition,
  updateCrmPipeline,
  updateCrmStage,
  validateCrmCustomFieldValues,
  type CrmEntityKind,
  type CrmFieldType,
  type CrmRecordRelationships,
  type CrmRecordRow,
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
const CRM_PAGE_SORTS = new Set(['updated', 'name', 'amount', 'close'])
const CRM_DIRECTIONS = new Set(['asc', 'desc'])
const CRM_ATTENTION = new Set(['overdue', 'stale', 'noAmount', 'orphaned'])

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

function queryText(value: unknown, max = 500): string | null {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, max) : null
}

function queryArray(value: unknown, max = 50): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  return raw.flatMap((item) => typeof item === 'string' ? item.split(',') : [])
    .map((item) => item.trim()).filter(Boolean).slice(0, max)
}

function queryKind(value: unknown): CrmEntityKind | null {
  const raw = queryText(value, 20)
  if (raw === 'contact' || raw === 'contacts' || raw === 'person') return 'person'
  if (raw === 'company' || raw === 'companies') return 'company'
  if (raw === 'deal' || raw === 'deals') return 'deal'
  return null
}

function publicRecord(row: CrmRecordRow) {
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

function publicRelationships(relationships: CrmRecordRelationships) {
  return {
    contacts: relationships.contacts.map(publicRecord),
    companies: relationships.companies.map(publicRecord),
    deals: relationships.deals.map(publicRecord),
  }
}

function hasOwn(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key)
}

function patchText(
  body: Record<string, unknown>,
  key: string,
  max: number,
): string | null | undefined {
  if (!hasOwn(body, key)) return undefined
  if (body[key] === null || body[key] === '') return null
  if (typeof body[key] !== 'string') throw new Error(`${key} must be text or null`)
  const value = body[key].trim()
  if (!value) return null
  return value.slice(0, max)
}

function patchTags(body: Record<string, unknown>): string[] | undefined {
  if (!hasOwn(body, 'tags')) return undefined
  if (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== 'string')) {
    throw new Error('tags must be an array of text values')
  }
  return stringArray(body.tags, 20)
}

function patchDate(body: Record<string, unknown>, key: string): Date | null | undefined {
  const value = patchText(body, key, 10)
  if (value === undefined || value === null) return value
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${key} must be an ISO calendar date`)
  const parsed = new Date(`${value}T00:00:00Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${key} must be an ISO calendar date`)
  }
  return parsed
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
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
    await validateCrmCustomFieldValues({
      ctx,
      entityKind: kind,
      values: customFields ?? {},
      requireAll: true,
    })

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

  async function readRecordBundle(ctx: AccessContext, entityId: string) {
    const record = await getCrmR2Record(ctx, entityId)
    if (!record) return null
    const [relationships, participants] = await Promise.all([
      listCrmRecordRelationships(ctx, record),
      record.kind === 'deal' ? listCrmDealParticipants(ctx, record.id) : Promise.resolve([]),
    ])
    return {
      record: publicRecord(record),
      relationships: publicRelationships(relationships),
      participants: participants ?? [],
    }
  }

  router.get('/:workspaceId/records', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member) return
    try {
      if (req.query.kind !== undefined) {
        const kind = queryKind(req.query.kind)
        if (!kind) {
          res.status(400).json({ error: 'kind must be deal, contact, or company' })
          return
        }
        const sort = queryText(req.query.sort, 20) ?? 'updated'
        const direction = queryText(req.query.direction, 10) ?? 'desc'
        if (!CRM_PAGE_SORTS.has(sort)
          || ((sort === 'amount' || sort === 'close') && kind !== 'deal')) {
          res.status(400).json({ error: 'sort is not available for this record kind' })
          return
        }
        if (!CRM_DIRECTIONS.has(direction)) {
          res.status(400).json({ error: 'direction must be asc or desc' })
          return
        }
        const requestedLimit = Number(queryText(req.query.limit, 4) ?? '50')
        if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
          res.status(400).json({ error: 'limit must be a positive integer' })
          return
        }
        const attention = queryText(req.query.filter, 20)
        if (attention && !CRM_ATTENTION.has(attention)) {
          res.status(400).json({ error: 'filter is not a supported attention filter' })
          return
        }
        const custom: Record<string, string[]> = {}
        for (const [key, value] of Object.entries(req.query)) {
          if (!key.startsWith('cf.') || key.length <= 3) continue
          custom[key.slice(3)] = queryArray(value)
        }
        const page = await listCrmRecordPage(member.ctx, {
          kind,
          limit: Math.min(requestedLimit, 100),
          cursor: queryText(req.query.cursor, 2_000),
          sort: sort as 'updated' | 'name' | 'amount' | 'close',
          direction: direction as 'asc' | 'desc',
          search: queryText(req.query.q, 500),
          includeArchived: req.query.archived === 'true',
          owners: queryArray(req.query.owner),
          pipelineId: queryText(req.query.pipeline, 100),
          stageIds: queryArray(req.query.stage),
          companyIds: queryArray(req.query.company),
          tags: queryArray(req.query.tag),
          custom,
          attention: attention as 'overdue' | 'stale' | 'noAmount' | 'orphaned' | null,
        })
        res.json({ ...page, items: page.items.map(publicRecord) })
        return
      }
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
      if (req.query.kind !== undefined && err instanceof Error
        && (err.message.includes('cursor') || err.message.includes('sort'))) {
        res.status(400).json({ error: err.message })
        return
      }
      console.error('[crm] list failed:', err)
      res.status(500).json({ error: 'Failed to load CRM records' })
    }
  })

  router.get('/:workspaceId/summary', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member) return
    try {
      const summary = await getCrmSummary(member.ctx, queryText(req.query.pipeline, 100))
      res.json(summary)
    } catch (err) {
      console.error('[crm] summary failed:', err)
      res.status(500).json({ error: 'Failed to load CRM summary' })
    }
  })

  router.get('/:workspaceId/lookup', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member) return
    const kind = queryKind(req.query.kind)
    if (!kind) {
      res.status(400).json({ error: 'kind must be deal, contact, or company' })
      return
    }
    const requestedLimit = Number(queryText(req.query.limit, 4) ?? '25')
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      res.status(400).json({ error: 'limit must be a positive integer' })
      return
    }
    try {
      const items = await lookupCrmRecords({
        ctx: member.ctx,
        kind,
        query: queryText(req.query.q, 500),
        limit: Math.min(requestedLimit, 100),
      })
      res.json({ items })
    } catch (err) {
      console.error('[crm] lookup failed:', err)
      res.status(500).json({ error: 'Failed to load CRM lookup' })
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

  router.get('/:workspaceId/records/:entityId', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member) return
    try {
      const bundle = await readRecordBundle(member.ctx, req.params.entityId)
      if (!bundle) {
        res.status(404).json({ error: 'Record not found' })
        return
      }
      res.json(bundle)
    } catch (err) {
      console.error('[crm] record read failed:', err)
      res.status(500).json({ error: 'Failed to load CRM record' })
    }
  })

  router.patch('/:workspaceId/records/:entityId', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member) return
    try {
      const before = await getCrmR2Record(member.ctx, req.params.entityId)
      if (!before) {
        res.status(404).json({ error: 'Record not found' })
        return
      }
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body as Record<string, unknown>
        : {}
      const common = new Set(['name', 'ownerId'])
      const kindFields = before.kind === 'person'
        ? ['email', 'phone', 'companyId', 'tags']
        : before.kind === 'company'
          ? ['domain', 'tags']
          : ['companyId', 'contactId', 'amount', 'currencyCode', 'closeDate', 'source', 'winLossReason']
      const allowed = new Set([...common, ...kindFields])
      const unknown = Object.keys(body).filter((key) => !allowed.has(key))
      if (unknown.length > 0) throw new Error(`Unsupported fields for this record: ${unknown.join(', ')}`)
      if (Object.keys(body).length === 0) {
        const bundle = await readRecordBundle(member.ctx, before.id)
        if (!bundle) throw new Error('Record is no longer available')
        res.json(bundle)
        return
      }

      const name = patchText(body, 'name', 256)
      if (hasOwn(body, 'name') && !name) throw new Error('name cannot be empty')
      const ownerId = patchText(body, 'ownerId', 100)
      if (ownerId && !await workspaceStore.getRole(ownerId, member.ctx.workspaceId)) {
        throw new Error('ownerId must be an active workspace member')
      }

      if (before.kind === 'person') {
        const companyId = patchText(body, 'companyId', 100)
        if (companyId) {
          const company = await getEntityById(member.ctx, companyId)
          if (!company || company.kind !== 'company') throw new Error('companyId must reference a visible company in this workspace')
        }
        const updated = await updateContact(member.ctx.userId, before.id, {
          ...(name !== undefined ? { name: name as string } : {}),
          ...(hasOwn(body, 'email') ? { email: patchText(body, 'email', 320) } : {}),
          ...(hasOwn(body, 'phone') ? { phone: patchText(body, 'phone', 100) } : {}),
          ...(companyId !== undefined ? { companyId } : {}),
          ...(hasOwn(body, 'tags') ? { tags: patchTags(body) } : {}),
        }, entityLinks, member.ctx)
        if (!updated) throw new Error('Record is no longer available')
      } else if (before.kind === 'company') {
        const updated = await updateCompany(member.ctx.userId, before.id, {
          ...(name !== undefined ? { name: name as string } : {}),
          ...(hasOwn(body, 'domain') ? { domain: patchText(body, 'domain', 320) } : {}),
          ...(hasOwn(body, 'tags') ? { tags: patchTags(body) } : {}),
        }, member.ctx)
        if (!updated) throw new Error('Record is no longer available')
      } else {
        const companyId = patchText(body, 'companyId', 100)
        const contactId = patchText(body, 'contactId', 100)
        if (companyId) {
          const company = await getEntityById(member.ctx, companyId)
          if (!company || company.kind !== 'company') throw new Error('companyId must reference a visible company in this workspace')
        }
        if (contactId) {
          const contact = await getEntityById(member.ctx, contactId)
          if (!contact || contact.kind !== 'person' || contact.attributes.self === true) {
            throw new Error('contactId must reference a visible CRM contact in this workspace')
          }
        }
        const amount = hasOwn(body, 'amount') ? finiteNumber(body.amount) : undefined
        if (hasOwn(body, 'amount') && amount === undefined) throw new Error('amount must be a finite number or null')
        if (amount !== undefined && amount !== null && amount < 0) throw new Error('amount must be greater than or equal to 0')
        const closeDate = patchDate(body, 'closeDate')
        const needsTypedUpdate = companyId !== undefined
          || amount !== undefined || closeDate !== undefined
        if (needsTypedUpdate) {
          const updated = await updateDeal(member.ctx.userId, before.id, {
            ...(companyId !== undefined ? { companyId } : {}),
            ...(amount !== undefined ? { amount } : {}),
            ...(closeDate !== undefined ? { closeDate } : {}),
          }, entityLinks, member.ctx)
          if (!updated) throw new Error('Record is no longer available')
        }
        if (contactId !== undefined) {
          const primaryUpdated = await setCrmDealPrimaryContact({
            ctx: member.ctx,
            dealId: before.id,
            contactId,
          })
          if (!primaryUpdated) throw new Error('Record relationship is no longer available')
          // The transaction above owns relational consistency. The typed
          // helper repairs the graph projection through its existing lane.
          const repaired = await updateDeal(member.ctx.userId, before.id, { contactId }, entityLinks, member.ctx)
          if (!repaired) throw new Error('Record is no longer available')
        }
      }

      const currentEntity = await getEntityById(member.ctx, before.id)
      if (!currentEntity) throw new Error('Record is no longer available')
      const attributes = { ...currentEntity.attributes }
      if (ownerId !== undefined) {
        if (ownerId) attributes.owner_id = ownerId
        else delete attributes.owner_id
      }
      if (before.kind === 'deal') {
        const currencyCode = patchText(body, 'currencyCode', 3)
        if (currencyCode !== undefined) {
          if (currencyCode && !/^[a-z]{3}$/i.test(currencyCode)) throw new Error('currencyCode must contain three letters')
          if (currencyCode) attributes.currency_code = currencyCode.toUpperCase()
          else delete attributes.currency_code
        }
        for (const [inputKey, attributeKey, max] of [
          ['source', 'source', 100],
          ['winLossReason', 'win_loss_reason', 2_000],
        ] as const) {
          const value = patchText(body, inputKey, max)
          if (value === undefined) continue
          if (value) attributes[attributeKey] = value
          else delete attributes[attributeKey]
        }
      }
      const needsFinalUpdate = ownerId !== undefined || (before.kind === 'deal' && (
        name !== undefined || hasOwn(body, 'currencyCode') || hasOwn(body, 'source')
          || hasOwn(body, 'winLossReason')
      ))
      if (needsFinalUpdate) {
        const updated = await updateEntity(member.ctx.userId, before.id, {
          ...(before.kind === 'deal' && name !== undefined ? { displayName: name as string } : {}),
          attributes,
        }, member.ctx)
        if (!updated) throw new Error('Record is no longer available')
      }

      const bundle = await readRecordBundle(member.ctx, before.id)
      if (!bundle) throw new Error('Record is no longer available')
      const beforePublic = publicRecord(before) as unknown as Record<string, unknown>
      const afterPublic = bundle.record as unknown as Record<string, unknown>
      const changedFields = Object.keys(body).filter((field) => !sameValue(beforePublic[field], afterPublic[field]))
      for (const field of changedFields) {
        await appendCrmActivity({
          userId: member.ctx.userId,
          workspaceId: member.ctx.workspaceId,
          entityId: before.id,
          activityType: 'field_change',
          summary: `CRM ${field} updated`,
          metadata: { field, before: beforePublic[field] ?? null, after: afterPublic[field] ?? null },
        })
      }
      if (changedFields.length > 0) {
        void notifyBrainInboxChange(member.ctx.workspaceId,
          before.kind === 'person' ? 'contact' : before.kind, before.id, 'update')
      }
      res.json(bundle)
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
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
    const [rows, config] = await Promise.all([
      listCrmR2Records(member.ctx),
      getCrmConfig(member.ctx.userId, member.ctx.workspaceId),
    ])
    const csv = crmRowsToCsv(rows, kind, config.fields)
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
    if (!entity || entity.attributes.self === true
      || !CRM_KINDS.has(entity.kind as CrmEntityKind)) {
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
    const includeArchived = req.query.archived === 'true'
    if (includeArchived && !requireAdmin(member.role, res)) return
    res.json(await getCrmConfig(member.ctx.userId, member.ctx.workspaceId, includeArchived))
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

  router.patch('/:workspaceId/pipelines/:pipelineId', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member || !requireAdmin(member.role, res)) return
    const name = hasOwn(req.body ?? {}, 'name') ? text(req.body?.name, 100) : undefined
    if (hasOwn(req.body ?? {}, 'name') && !name) {
      res.status(400).json({ error: 'name cannot be empty' })
      return
    }
    try {
      const ok = await updateCrmPipeline({
        userId: member.ctx.userId,
        workspaceId: member.ctx.workspaceId,
        pipelineId: req.params.pipelineId,
        ...(name !== undefined ? { name: name as string } : {}),
        ...(typeof req.body?.isDefault === 'boolean' ? { isDefault: req.body.isDefault } : {}),
        ...(typeof req.body?.archived === 'boolean' ? { archived: req.body.archived } : {}),
      })
      if (!ok) res.status(404).json({ error: 'Pipeline not found' })
      else res.json({ ok: true })
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.post('/:workspaceId/pipelines/reorder', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member || !requireAdmin(member.role, res)) return
    if (!Array.isArray(req.body?.orderedIds) || req.body.orderedIds.some((id: unknown) => typeof id !== 'string')) {
      res.status(400).json({ error: 'orderedIds must be an array of ids' })
      return
    }
    try {
      await reorderCrmPipelines({
        userId: member.ctx.userId,
        workspaceId: member.ctx.workspaceId,
        orderedIds: req.body.orderedIds,
      })
      res.json({ ok: true })
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) })
    }
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
    try {
      const archived = typeof req.body?.archived === 'boolean' ? req.body.archived : undefined
      if (archived === false) {
        const restored = await setCrmStageArchived({
          userId: member.ctx.userId, workspaceId: member.ctx.workspaceId,
          stageId: req.params.stageId, archived: false,
        })
        if (!restored) {
          res.status(404).json({ error: 'Stage not found' })
          return
        }
      }
      const hasMetadata = ['name', 'category', 'probability', 'requiredFields']
        .some((key) => hasOwn(req.body ?? {}, key))
      const stage = hasMetadata ? await updateCrmStage({
        userId: member.ctx.userId,
        workspaceId: member.ctx.workspaceId,
        stageId: req.params.stageId,
        name: text(req.body?.name, 100) ?? undefined,
        category: category as CrmStageCategory | undefined,
        probability: probability ?? undefined,
        requiredFields: Array.isArray(req.body?.requiredFields)
          ? stringArray(req.body.requiredFields)
          : undefined,
      }) : null
      if (hasMetadata && !stage) {
        res.status(404).json({ error: 'Stage not found' })
        return
      }
      if (archived === true) {
        const archivedOk = await setCrmStageArchived({
          userId: member.ctx.userId, workspaceId: member.ctx.workspaceId,
          stageId: req.params.stageId, archived: true,
        })
        if (!archivedOk) {
          res.status(404).json({ error: 'Stage not found' })
          return
        }
      }
      res.json(stage ?? { ok: true })
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.post('/:workspaceId/pipelines/:pipelineId/stages/reorder', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member || !requireAdmin(member.role, res)) return
    if (!Array.isArray(req.body?.orderedIds) || req.body.orderedIds.some((id: unknown) => typeof id !== 'string')) {
      res.status(400).json({ error: 'orderedIds must be an array of ids' })
      return
    }
    try {
      await reorderCrmStages({
        userId: member.ctx.userId, workspaceId: member.ctx.workspaceId,
        pipelineId: req.params.pipelineId, orderedIds: req.body.orderedIds,
      })
      res.json({ ok: true })
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) })
    }
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
    if (fieldType === 'entity_reference'
      && (options.length === 0 || options.some((kind) => !(CRM_REFERENCE_KINDS as readonly string[]).includes(kind)))) {
      res.status(400).json({ error: 'Reference fields require at least one valid target kind' })
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

  router.patch('/:workspaceId/fields/:fieldId', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member || !requireAdmin(member.role, res)) return
    const allowed = new Set(['label', 'options', 'isRequired'])
    const unknown = Object.keys(req.body ?? {}).filter((key) => !allowed.has(key))
    if (unknown.length > 0) {
      res.status(400).json({ error: `Field key and type are immutable; unsupported fields: ${unknown.join(', ')}` })
      return
    }
    const label = hasOwn(req.body ?? {}, 'label') ? text(req.body?.label, 100) : undefined
    if (hasOwn(req.body ?? {}, 'label') && !label) {
      res.status(400).json({ error: 'label cannot be empty' })
      return
    }
    try {
      const field = await updateCrmFieldDefinition({
        userId: member.ctx.userId, workspaceId: member.ctx.workspaceId,
        fieldId: req.params.fieldId,
        ...(label !== undefined ? { label: label as string } : {}),
        ...(Array.isArray(req.body?.options) ? { options: stringArray(req.body.options) } : {}),
        ...(typeof req.body?.isRequired === 'boolean' ? { isRequired: req.body.isRequired } : {}),
      })
      if (!field) res.status(404).json({ error: 'Field not found' })
      else res.json(field)
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.post('/:workspaceId/fields/:fieldId/restore', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member || !requireAdmin(member.role, res)) return
    try {
      const ok = await restoreCrmFieldDefinition(
        member.ctx.userId, member.ctx.workspaceId, req.params.fieldId,
      )
      if (!ok) res.status(404).json({ error: 'Archived field not found' })
      else res.json({ ok: true })
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.post('/:workspaceId/fields/reorder', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member || !requireAdmin(member.role, res)) return
    const entityKind = req.body?.entityKind as CrmEntityKind
    if (!CRM_KINDS.has(entityKind) || !Array.isArray(req.body?.orderedIds)
      || req.body.orderedIds.some((id: unknown) => typeof id !== 'string')) {
      res.status(400).json({ error: 'entityKind and orderedIds are required' })
      return
    }
    try {
      await reorderCrmFields({
        userId: member.ctx.userId, workspaceId: member.ctx.workspaceId,
        entityKind, orderedIds: req.body.orderedIds,
      })
      res.json({ ok: true })
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.post('/:workspaceId/field-presets/:presetId', async (req, res) => {
    const member = await memberContext(req as never, res)
    if (!member || !requireAdmin(member.role, res)) return
    const presetId = req.params.presetId
    if (!(CRM_PRESET_IDS as readonly string[]).includes(presetId)) {
      res.status(404).json({ error: 'CRM field preset not found' })
      return
    }
    const result = await applyCrmFieldPreset({
      userId: member.ctx.userId,
      workspaceId: member.ctx.workspaceId,
      presetId: presetId as (typeof CRM_PRESET_IDS)[number],
    })
    res.json(result)
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
    if (!survivor || !merged || survivor.attributes.self === true || merged.attributes.self === true
      || survivor.kind !== merged.kind
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
      const status = err instanceof EntityMergeError || err instanceof EntityMergeStoreError ? 409 : 500
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
