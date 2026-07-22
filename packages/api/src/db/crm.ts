import type {
  AccessContext,
  CompanyListFilters, CompanyListRow, CompanyRecord, CompanyUpdateFields,
  ContactListFilters, ContactListRow, ContactRecord, ContactUpdateFields,
  CrmExternalRef,
  DealListFilters, DealListRow, DealRecord, DealStage, DealUpdateFields,
  EntityLinksStore,
  EntityRecord,
  Sensitivity,
} from '@use-brian/core'
import { buildAccessPredicate } from './access-predicate.js'
import { assertAuthorshipPresent } from './authorship-guard.js'
import { query, queryGated, queryWithRLS } from './client.js'
import { emitCrmRelationEdge, emitEdgeFireAndForget, superseedCrmRelationEdge } from './edge-hooks.js'
import { createEntity, getEntityById, getEntityByIdSystem, updateEntity } from './entities-store.js'

/**
 * CRM SQL layer — post CRM→entity unification
 * (docs/architecture/features/crm.md).
 *
 * A contact / company / deal IS an `entities` row: `kind` ∈
 * {person, company, deal}, name → `display_name`, email/domain →
 * `canonical_id` (for dedup) + `attributes`, and the remaining typed
 * fields (phone, tags, external_ref, stage, amount, close_date) live in
 * `attributes`. The relationship FK (`company_id` / `contact_id`, each
 * holding the referenced entity id) is the record's source of truth and
 * also lives in `attributes`; the graph `works_at` / `engagement_of` /
 * `represents` edges are emitted alongside as a best-effort projection
 * for graph traversal, but the record never depends on an edge being
 * present. The record `id` is the entity id; `entityId` aliases it for
 * one release.
 *
 * Updates are IN PLACE (`updateEntity`) so the entity id — and therefore
 * every inbound and outbound edge — stays valid. CRM field history is not
 * preserved (plan decision D5). Frozen-v1 constraints that used to live in
 * DB CHECKs / triggers (stage enum, amount ≥ 0, same-workspace FK) are now
 * enforced here; their error messages keep the old `deals_stage_check` /
 * `deals_amount_check` / "same workspace" tokens so callers and tests that
 * matched them still match.
 */

const VALID_STAGES: readonly DealStage[] = [
  'lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost',
]

// ── Shared helpers ───────────────────────────────────────────────────

function attrTags(a: Record<string, unknown>): string[] {
  return Array.isArray(a.tags) ? (a.tags as string[]) : []
}
function attrRef(a: Record<string, unknown>): CrmExternalRef {
  const r = a.external_ref
  return r && typeof r === 'object' ? (r as CrmExternalRef) : {}
}
function attrStr(a: Record<string, unknown>, key: string): string | null {
  const v = a[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** Reject a cross-workspace relationship reference (replaces the
 *  `contacts_company_workspace_match_trg` / `deals_links_workspace_match_trg`
 *  triggers). A ref in another workspace throws; a non-existent ref is
 *  left to the caller (the old FK would have rejected it, but v1 CRM
 *  relationships are best-effort). Message keeps the "same workspace" token. */
async function assertSameWorkspace(
  refId: string | null | undefined,
  workspaceId: string,
  label: string,
): Promise<void> {
  if (!refId) return
  const r = await query<{ workspaceId: string | null }>(
    `SELECT workspace_id AS "workspaceId" FROM entities WHERE id = $1 AND valid_to IS NULL`,
    [refId],
  )
  const ws = r.rows[0]?.workspaceId
  if (ws && ws !== workspaceId) {
    throw new Error(`${label} must reference a row in the same workspace`)
  }
}

/**
 * Viewer projection for the upsert-dedupe candidate scan. The dedupe must
 * never select a row the writer cannot read back — merging into an invisible
 * row breaks read-your-write (the tool reports success, every subsequent
 * list/get hides the row) and mutates another principal's private record.
 * See docs/architecture/features/crm.md → "Upsert dedupe is access-scoped"
 * (2026-07-05 incident: saveContact merged into another user's private
 * person entity; Brain → People never showed it).
 *
 * Chat tools pass their full viewer context via `params.access`. Writers
 * that only hold a user id (ingest pipeline-B, classification composer)
 * fall back to the primary-reflector shape for that user — workspace +
 * user axes only — which still excludes other users' private rows.
 * `assistantId` is unread for kind='primary' (the reflector drops the
 * assistant axis); the empty string is never bound into SQL.
 */
function dedupeAccessContext(
  userId: string,
  workspaceId: string,
  access?: AccessContext,
): AccessContext {
  if (access) return access
  return { workspaceId, userId, assistantId: '', assistantKind: 'primary' }
}

/** Db-layer list cap. 500 (not 100) so the CRM operator surface's flat
 *  route can read the whole working set in one shot — the model-facing
 *  `list*` chat tools keep their own zod clamp at 100, so model payloads
 *  are unchanged (the same split the tasks `listTasks` clamp uses). */
function clampListLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 25, 1), 500)
}

function assertValidStage(stage: DealStage | undefined): void {
  if (stage !== undefined && !VALID_STAGES.includes(stage)) {
    throw new Error(`deals_stage_check: invalid deal stage "${stage}"`)
  }
}
function assertNonNegativeAmount(amount: number | null | undefined): void {
  if (amount != null && amount < 0) {
    throw new Error('deals_amount_check: amount must be greater than or equal to 0')
  }
}

/** Emit / re-point the best-effort graph edge for a CRM relationship.
 *  Fire-and-forget; a missing entityLinks store or edge failure never
 *  affects the record write (the FK already lives in `attributes`). */
function repointGraphEdge(
  entityLinks: EntityLinksStore | undefined,
  userId: string,
  params: {
    sourceEntityId: string; targetEntityId: string | null
    edgeType: 'works_at' | 'engagement_of'; workspaceId: string
  },
): void {
  if (!entityLinks) return
  void superseedCrmRelationEdge(entityLinks, userId, {
    sourceEntityId: params.sourceEntityId, targetEntityId: params.targetEntityId,
    edgeType: params.edgeType, workspaceId: params.workspaceId, source: 'user', userId,
  })
}

// ── Projections from a fetched entity row (create / update return) ────

function companyFromEntity(e: EntityRecord): CompanyRecord {
  const a = e.attributes
  return {
    id: e.id, workspaceId: e.workspaceId, entityId: e.id,
    name: e.displayName,
    domain: attrStr(a, 'domain') ?? e.canonicalId ?? null,
    tags: attrTags(a), externalRef: attrRef(a),
    createdAt: e.createdAt, updatedAt: e.updatedAt,
  }
}
function contactFromEntity(e: EntityRecord): ContactRecord {
  const a = e.attributes
  return {
    id: e.id, workspaceId: e.workspaceId, entityId: e.id,
    name: e.displayName,
    email: attrStr(a, 'email') ?? e.canonicalId ?? null,
    phone: attrStr(a, 'phone'),
    companyId: attrStr(a, 'company_id'),
    tags: attrTags(a), externalRef: attrRef(a),
    createdAt: e.createdAt, updatedAt: e.updatedAt,
  }
}
function dealFromEntity(e: EntityRecord): DealRecord {
  const a = e.attributes
  const amount = a.amount
  const closeDate = a.close_date
  return {
    id: e.id, workspaceId: e.workspaceId, entityId: e.id,
    name: e.displayName,
    contactId: attrStr(a, 'contact_id'),
    companyId: attrStr(a, 'company_id'),
    stage: (attrStr(a, 'stage') as DealStage) ?? 'lead',
    amount: typeof amount === 'number' ? amount : amount != null ? Number(amount) : null,
    closeDate: typeof closeDate === 'string' ? new Date(closeDate) : null,
    externalRef: attrRef(a),
    createdAt: e.createdAt, updatedAt: e.updatedAt,
  }
}

// ── Companies ────────────────────────────────────────────────────────

type CompanyRow = Omit<CompanyRecord, 'tags' | 'externalRef'> & {
  tags: string[] | null; externalRef: CrmExternalRef | null
}
const COMPANY_SELECT = `
  e.id, e.id AS "entityId", e.workspace_id AS "workspaceId",
  e.display_name AS name,
  COALESCE(e.attributes->>'domain', e.canonical_id) AS domain,
  e.attributes->'tags' AS tags,
  e.attributes->'external_ref' AS "externalRef",
  e.created_at AS "createdAt", e.updated_at AS "updatedAt"`

function toCompanyRow(row: CompanyRow): CompanyRecord {
  return { ...row, tags: row.tags ?? [], externalRef: row.externalRef ?? {} }
}

function companyAttributes(p: {
  domain?: string | null; tags?: string[]; externalRef?: CrmExternalRef
}): Record<string, unknown> {
  const a: Record<string, unknown> = { tags: p.tags ?? [] }
  if (p.domain) a.domain = p.domain
  if (p.externalRef && Object.keys(p.externalRef).length) a.external_ref = p.externalRef
  return a
}

export async function createCompany(
  userId: string,
  params: {
    workspaceId: string
    name: string
    domain?: string | null
    tags?: string[]
    externalRef?: CrmExternalRef
    sensitivity?: Sensitivity
    compartments?: string[]
    source?: 'user' | 'extracted'
    /** Extraction provenance anchor — the Episode this company derives from (Pipeline B / compose / synthesis). */
    sourceEpisodeId?: string | null
    /** Interactive-write provenance anchor (mig 316) — the creating conversation's session (chat saveCompany). */
    sourceSessionId?: string | null
    /** The assistant that mediated the write. */
    createdByAssistantId?: string | null
    access?: AccessContext
  },
): Promise<CompanyRecord> {
  assertAuthorshipPresent('createCompany', userId)

  // Upsert-by-name: dedupe against a live company entity in the workspace
  // — but only among rows the caller can read (see dedupeAccessContext).
  const ap = buildAccessPredicate(
    dedupeAccessContext(userId, params.workspaceId, params.access),
    { startIdx: 3 },
  )
  const existing = await queryWithRLS<{ id: string }>(
    userId,
    `SELECT id FROM entities
      WHERE workspace_id = $1 AND kind = 'company'
        AND lower(display_name) = lower($2)
        AND valid_to IS NULL AND retracted_at IS NULL
        AND ${ap.sql}
      ORDER BY created_at ASC LIMIT 1`,
    [params.workspaceId, params.name, ...ap.params],
  )
  if (existing.rows[0]) {
    const merged = await mergeCompanyFields(userId, existing.rows[0].id, {
      domain: params.domain ?? null, tags: params.tags, externalRef: params.externalRef,
    })
    if (merged) return merged
  }

  const entity = await createEntity({
    kind: 'company',
    displayName: params.name,
    canonicalId: params.domain ?? null,
    attributes: companyAttributes(params),
    sensitivity: params.sensitivity ?? 'internal',
    workspaceId: params.workspaceId,
    userId,
    createdByUserId: userId,
    createdByAssistantId: params.createdByAssistantId ?? null,
    source: params.source ?? 'user',
    sourceEpisodeId: params.sourceEpisodeId ?? null,
    sourceSessionId: params.sourceSessionId ?? null,
    compartments: params.compartments ?? [],
  })
  return companyFromEntity(entity)
}

async function mergeCompanyFields(
  userId: string,
  id: string,
  incoming: { domain?: string | null; tags?: string[]; externalRef?: CrmExternalRef },
): Promise<CompanyRecord | null> {
  const cur = await getCompanyByIdSystem(userId, id)
  if (!cur) return null
  const fields: CompanyUpdateFields = {}
  if (incoming.domain && incoming.domain !== cur.domain) fields.domain = incoming.domain
  if (incoming.tags && incoming.tags.length > 0) {
    const merged = Array.from(new Set([...cur.tags, ...incoming.tags]))
    if (merged.length !== cur.tags.length) fields.tags = merged
  }
  if (incoming.externalRef && Object.keys(incoming.externalRef).length > 0) {
    fields.externalRef = { ...cur.externalRef, ...incoming.externalRef }
  }
  if (Object.keys(fields).length === 0) return cur
  return updateCompany(userId, id, fields)
}

async function getCompanyByIdSystem(userId: string, id: string): Promise<CompanyRecord | null> {
  const e = await getEntityByIdSystem(userId, id)
  if (!e || e.kind !== 'company') return null
  return companyFromEntity(e)
}

export async function getCompanyById(ctx: AccessContext, id: string): Promise<CompanyRecord | null> {
  const ap = buildAccessPredicate(ctx, { alias: 'e', startIdx: 1 })
  const result = await queryWithRLS<CompanyRow>(
    ctx.userId,
    `SELECT ${COMPANY_SELECT} FROM entities e
      WHERE ${ap.sql} AND e.kind = 'company'
        AND e.id = $${ap.nextIdx} AND e.valid_to IS NULL`,
    [...ap.params, id],
  )
  if (result.rows.length === 0) return null
  return toCompanyRow(result.rows[0])
}

export async function listCompanies(ctx: AccessContext, filters: CompanyListFilters): Promise<CompanyListRow[]> {
  const ap = buildAccessPredicate(ctx, { alias: 'e', startIdx: 1 })
  const wheres: string[] = [ap.sql, `e.kind = 'company'`, 'e.valid_to IS NULL']
  const values: unknown[] = [...ap.params]
  let idx = ap.nextIdx

  if (filters.query) {
    wheres.push(`(e.display_name ILIKE $${idx} OR e.attributes->>'domain' ILIKE $${idx})`)
    values.push(`%${filters.query}%`); idx++
  }
  if (filters.tag) {
    wheres.push(`e.attributes->'tags' ? $${idx}`)
    values.push(filters.tag); idx++
  }
  const limit = clampListLimit(filters.limit)
  values.push(limit)

  const result = await queryGated<CompanyRow>(
    ctx,
    `SELECT ${COMPANY_SELECT} FROM entities e
      WHERE ${wheres.join(' AND ')}
      ORDER BY e.updated_at DESC LIMIT $${idx}`,
    values,
  )
  return result.rows.map(toCompanyRow)
}

/**
 * Update-by-id writes are access-scoped (the write-path half of the
 * "Upsert dedupe is access-scoped" rule — see `crm.md`): the target row
 * is read AND written under the caller's viewer projection when the tool
 * passes `access`; writers holding only a user id fall back to the
 * user-axis projection built from the row's own workspace, which still
 * refuses another principal's private row.
 */
export async function updateCompany(
  userId: string,
  id: string,
  fields: CompanyUpdateFields,
  access?: AccessContext,
): Promise<CompanyRecord | null> {
  const old = access ? await getEntityById(access, id) : await getEntityByIdSystem(userId, id)
  if (!old || old.kind !== 'company') return null
  const a = { ...old.attributes }
  if (fields.domain !== undefined) {
    if (fields.domain) a.domain = fields.domain; else delete a.domain
  }
  if (fields.tags !== undefined) a.tags = fields.tags
  if (fields.externalRef !== undefined) a.external_ref = fields.externalRef

  const e = await updateEntity(userId, id, {
    displayName: fields.name,
    canonicalId: fields.domain !== undefined ? (fields.domain ?? null) : undefined,
    attributes: a,
  }, dedupeAccessContext(userId, old.workspaceId, access))
  if (!e) return null
  return companyFromEntity(e)
}

// ── Contacts ─────────────────────────────────────────────────────────

type ContactRow = Omit<ContactRecord, 'tags' | 'externalRef'> & {
  tags: string[] | null; externalRef: CrmExternalRef | null
}
const CONTACT_SELECT = `
  e.id, e.id AS "entityId", e.workspace_id AS "workspaceId",
  e.display_name AS name,
  COALESCE(e.attributes->>'email', e.canonical_id) AS email,
  e.attributes->>'phone' AS phone,
  e.attributes->>'company_id' AS "companyId",
  e.attributes->'tags' AS tags,
  e.attributes->'external_ref' AS "externalRef",
  e.created_at AS "createdAt", e.updated_at AS "updatedAt"`

function toContactRow(row: ContactRow): ContactRecord {
  return { ...row, tags: row.tags ?? [], externalRef: row.externalRef ?? {} }
}

function contactAttributes(p: {
  email?: string | null; phone?: string | null; companyId?: string | null
  tags?: string[]; externalRef?: CrmExternalRef
}): Record<string, unknown> {
  const a: Record<string, unknown> = { tags: p.tags ?? [] }
  if (p.email) a.email = p.email
  if (p.phone) a.phone = p.phone
  if (p.companyId) a.company_id = p.companyId
  if (p.externalRef && Object.keys(p.externalRef).length) a.external_ref = p.externalRef
  return a
}

export async function createContact(
  userId: string,
  params: {
    workspaceId: string
    name: string
    email?: string | null
    phone?: string | null
    companyId?: string | null
    tags?: string[]
    externalRef?: CrmExternalRef
    sensitivity?: Sensitivity
    compartments?: string[]
    source?: 'user' | 'extracted'
    /** Extraction provenance anchor — the Episode this contact derives from (Pipeline B / compose / synthesis). */
    sourceEpisodeId?: string | null
    /** Interactive-write provenance anchor (mig 316) — the creating conversation's session (chat saveContact). */
    sourceSessionId?: string | null
    /** The assistant that mediated the write. */
    createdByAssistantId?: string | null
    access?: AccessContext
  },
  entityLinks?: EntityLinksStore,
): Promise<ContactRecord> {
  assertAuthorshipPresent('createContact', userId)
  await assertSameWorkspace(params.companyId, params.workspaceId, 'company_id')

  // Upsert-by-email (high confidence) then by name, scoped to rows the
  // caller can read (see dedupeAccessContext) — an invisible same-name
  // contact belonging to another principal is NOT a merge target; the
  // caller gets their own visible row instead. Self entities
  // (`attributes.self=true`) are excluded — you are not your own contact.
  const ap = buildAccessPredicate(
    dedupeAccessContext(userId, params.workspaceId, params.access),
    { startIdx: 4 },
  )
  const existing = await queryWithRLS<{ id: string }>(
    userId,
    `(SELECT id, 1 AS pri FROM entities
       WHERE workspace_id = $1 AND kind = 'person'
         AND $2::text IS NOT NULL AND lower(canonical_id) = lower($2)
         AND valid_to IS NULL AND retracted_at IS NULL
         AND NOT COALESCE((attributes->>'self')::boolean, false)
         AND ${ap.sql}
       ORDER BY created_at ASC LIMIT 1)
     UNION ALL
     (SELECT id, 2 AS pri FROM entities
       WHERE workspace_id = $1 AND kind = 'person'
         AND lower(display_name) = lower($3)
         AND valid_to IS NULL AND retracted_at IS NULL
         AND NOT COALESCE((attributes->>'self')::boolean, false)
         AND ${ap.sql}
       ORDER BY created_at ASC LIMIT 1)
     ORDER BY pri ASC LIMIT 1`,
    [params.workspaceId, params.email ?? null, params.name, ...ap.params],
  )
  if (existing.rows[0]) {
    const merged = await mergeContactFields(userId, existing.rows[0].id, {
      email: params.email ?? null, phone: params.phone ?? null,
      companyId: params.companyId ?? null, tags: params.tags, externalRef: params.externalRef,
    }, entityLinks)
    if (merged) return merged
  }

  const entity = await createEntity({
    kind: 'person',
    displayName: params.name,
    canonicalId: params.email ?? null,
    attributes: contactAttributes(params),
    sensitivity: params.sensitivity ?? 'internal',
    workspaceId: params.workspaceId,
    userId,
    createdByUserId: userId,
    createdByAssistantId: params.createdByAssistantId ?? null,
    source: params.source ?? 'user',
    sourceEpisodeId: params.sourceEpisodeId ?? null,
    sourceSessionId: params.sourceSessionId ?? null,
    compartments: params.compartments ?? [],
  })

  if (params.companyId) {
    if (entityLinks) {
      void emitCrmRelationEdge(entityLinks, userId, {
        sourceEntityId: entity.id, targetEntityId: params.companyId,
        edgeType: 'works_at', workspaceId: params.workspaceId, source: 'user', userId,
      })
    }
  }
  return contactFromEntity(entity)
}

async function mergeContactFields(
  userId: string,
  id: string,
  incoming: {
    email?: string | null; phone?: string | null; companyId?: string | null
    tags?: string[]; externalRef?: CrmExternalRef
  },
  entityLinks?: EntityLinksStore,
): Promise<ContactRecord | null> {
  const cur = await getContactByIdSystem(userId, id)
  if (!cur) return null
  const fields: ContactUpdateFields = {}
  if (incoming.email && incoming.email !== cur.email) fields.email = incoming.email
  if (incoming.phone && incoming.phone !== cur.phone) fields.phone = incoming.phone
  if (incoming.companyId && incoming.companyId !== cur.companyId) fields.companyId = incoming.companyId
  if (incoming.tags && incoming.tags.length > 0) {
    const merged = Array.from(new Set([...cur.tags, ...incoming.tags]))
    if (merged.length !== cur.tags.length) fields.tags = merged
  }
  if (incoming.externalRef && Object.keys(incoming.externalRef).length > 0) {
    fields.externalRef = { ...cur.externalRef, ...incoming.externalRef }
  }
  if (Object.keys(fields).length === 0) return cur
  return updateContact(userId, id, fields, entityLinks)
}

async function getContactByIdSystem(userId: string, id: string): Promise<ContactRecord | null> {
  const e = await getEntityByIdSystem(userId, id)
  if (!e || e.kind !== 'person') return null
  return contactFromEntity(e)
}

export async function getContactById(ctx: AccessContext, id: string): Promise<ContactRecord | null> {
  const ap = buildAccessPredicate(ctx, { alias: 'e', startIdx: 1 })
  const result = await queryWithRLS<ContactRow>(
    ctx.userId,
    `SELECT ${CONTACT_SELECT} FROM entities e
      WHERE ${ap.sql} AND e.kind = 'person'
        AND e.id = $${ap.nextIdx} AND e.valid_to IS NULL`,
    [...ap.params, id],
  )
  if (result.rows.length === 0) return null
  return toContactRow(result.rows[0])
}

export async function listContacts(ctx: AccessContext, filters: ContactListFilters): Promise<ContactListRow[]> {
  const ap = buildAccessPredicate(ctx, { alias: 'e', startIdx: 1 })
  const wheres: string[] = [
    ap.sql, `e.kind = 'person'`, 'e.valid_to IS NULL',
    `NOT COALESCE((e.attributes->>'self')::boolean, false)`,
  ]
  const values: unknown[] = [...ap.params]
  let idx = ap.nextIdx

  if (filters.query) {
    wheres.push(`(e.display_name ILIKE $${idx} OR e.attributes->>'email' ILIKE $${idx})`)
    values.push(`%${filters.query}%`); idx++
  }
  if (filters.tag) {
    wheres.push(`e.attributes->'tags' ? $${idx}`)
    values.push(filters.tag); idx++
  }
  if (filters.companyId) {
    wheres.push(`e.attributes->>'company_id' = $${idx}`)
    values.push(filters.companyId); idx++
  }
  const limit = clampListLimit(filters.limit)
  values.push(limit)

  const result = await queryGated<ContactRow>(
    ctx,
    `SELECT ${CONTACT_SELECT} FROM entities e
      WHERE ${wheres.join(' AND ')}
      ORDER BY e.updated_at DESC LIMIT $${idx}`,
    values,
  )
  return result.rows.map(toContactRow)
}

/** `access`: see `updateCompany` — write-path viewer projection. */
export async function updateContact(
  userId: string,
  id: string,
  fields: ContactUpdateFields,
  entityLinks?: EntityLinksStore,
  access?: AccessContext,
): Promise<ContactRecord | null> {
  const old = access ? await getEntityById(access, id) : await getEntityByIdSystem(userId, id)
  if (!old || old.kind !== 'person') return null
  if (fields.companyId !== undefined) {
    await assertSameWorkspace(fields.companyId, old.workspaceId, 'company_id')
  }
  const a = { ...old.attributes }
  if (fields.email !== undefined) { if (fields.email) a.email = fields.email; else delete a.email }
  if (fields.phone !== undefined) { if (fields.phone) a.phone = fields.phone; else delete a.phone }
  if (fields.companyId !== undefined) { if (fields.companyId) a.company_id = fields.companyId; else delete a.company_id }
  if (fields.tags !== undefined) a.tags = fields.tags
  if (fields.externalRef !== undefined) a.external_ref = fields.externalRef

  const e = await updateEntity(userId, id, {
    displayName: fields.name,
    canonicalId: fields.email !== undefined ? (fields.email ?? null) : undefined,
    attributes: a,
  }, dedupeAccessContext(userId, old.workspaceId, access))
  if (!e) return null
  if (fields.companyId !== undefined) {
    repointGraphEdge(entityLinks, userId, {
      sourceEntityId: id, targetEntityId: fields.companyId ?? null,
      edgeType: 'works_at', workspaceId: old.workspaceId,
    })
  }
  return contactFromEntity(e)
}

// ── Deals ────────────────────────────────────────────────────────────

type DealRow = Omit<DealRecord, 'amount' | 'externalRef'> & {
  amount: string | number | null; externalRef: CrmExternalRef | null
}
const DEAL_SELECT = `
  e.id, e.id AS "entityId", e.workspace_id AS "workspaceId",
  e.display_name AS name,
  e.attributes->>'contact_id' AS "contactId",
  e.attributes->>'company_id' AS "companyId",
  COALESCE(e.attributes->>'stage', 'lead') AS stage,
  e.attributes->>'amount' AS amount,
  (e.attributes->>'close_date')::date AS "closeDate",
  e.attributes->'external_ref' AS "externalRef",
  e.created_at AS "createdAt", e.updated_at AS "updatedAt"`

function toDealRow(row: DealRow): DealRecord {
  return {
    ...row,
    amount: row.amount === null ? null : Number(row.amount),
    externalRef: row.externalRef ?? {},
  }
}

function dealAttributes(p: {
  contactId?: string | null; companyId?: string | null
  stage?: DealStage; amount?: number | null; closeDate?: Date | null; externalRef?: CrmExternalRef
}): Record<string, unknown> {
  const a: Record<string, unknown> = { stage: p.stage ?? 'lead' }
  if (p.contactId) a.contact_id = p.contactId
  if (p.companyId) a.company_id = p.companyId
  if (p.amount != null) a.amount = p.amount
  if (p.closeDate) a.close_date = p.closeDate.toISOString().slice(0, 10)
  if (p.externalRef && Object.keys(p.externalRef).length) a.external_ref = p.externalRef
  return a
}

export async function createDeal(
  userId: string,
  params: {
    workspaceId: string
    contactId?: string | null
    companyId?: string | null
    stage?: DealStage
    amount?: number | null
    closeDate?: Date | null
    externalRef?: CrmExternalRef
    sensitivity?: Sensitivity
    compartments?: string[]
    source?: 'user' | 'extracted'
    /** Extraction provenance anchor — the Episode this deal derives from (Pipeline B / compose / synthesis). */
    sourceEpisodeId?: string | null
    /** Interactive-write provenance anchor (mig 316) — the creating conversation's session (chat saveDeal). */
    sourceSessionId?: string | null
    /** The assistant that mediated the write. */
    createdByAssistantId?: string | null
  },
  entityLinks?: EntityLinksStore,
): Promise<DealRecord> {
  assertAuthorshipPresent('createDeal', userId)
  assertValidStage(params.stage)
  assertNonNegativeAmount(params.amount)
  await assertSameWorkspace(params.contactId, params.workspaceId, 'contact_id')
  await assertSameWorkspace(params.companyId, params.workspaceId, 'company_id')

  let displayName = 'Deal'
  if (params.companyId) {
    const c = await query<{ name: string }>(
      `SELECT display_name AS name FROM entities WHERE id = $1 AND valid_to IS NULL`,
      [params.companyId],
    )
    if (c.rows[0]) displayName = `Deal - ${c.rows[0].name}`
  }

  const entity = await createEntity({
    kind: 'deal',
    displayName,
    attributes: dealAttributes(params),
    sensitivity: params.sensitivity ?? 'internal',
    workspaceId: params.workspaceId,
    userId,
    createdByUserId: userId,
    createdByAssistantId: params.createdByAssistantId ?? null,
    source: params.source ?? 'user',
    sourceEpisodeId: params.sourceEpisodeId ?? null,
    sourceSessionId: params.sourceSessionId ?? null,
    compartments: params.compartments ?? [],
  })

  if (entityLinks && params.companyId) {
    void emitCrmRelationEdge(entityLinks, userId, {
      sourceEntityId: entity.id, targetEntityId: params.companyId,
      edgeType: 'engagement_of', workspaceId: params.workspaceId, source: 'user', userId,
    })
  }
  if (entityLinks && params.contactId) {
    void emitEdgeFireAndForget(entityLinks, userId, {
      sourceKind: 'entity', sourceId: params.contactId,
      targetKind: 'entity', targetId: entity.id,
      edgeType: 'represents', workspaceId: params.workspaceId, source: 'user', userId,
    })
  }
  return dealFromEntity(entity)
}

export async function getDealById(ctx: AccessContext, id: string): Promise<DealRecord | null> {
  const ap = buildAccessPredicate(ctx, { alias: 'e', startIdx: 1 })
  const result = await queryWithRLS<DealRow>(
    ctx.userId,
    `SELECT ${DEAL_SELECT} FROM entities e
      WHERE ${ap.sql} AND e.kind = 'deal'
        AND e.id = $${ap.nextIdx} AND e.valid_to IS NULL`,
    [...ap.params, id],
  )
  if (result.rows.length === 0) return null
  return toDealRow(result.rows[0])
}

export async function listDeals(ctx: AccessContext, filters: DealListFilters): Promise<DealListRow[]> {
  const ap = buildAccessPredicate(ctx, { alias: 'e', startIdx: 1 })
  const wheres: string[] = [ap.sql, `e.kind = 'deal'`, 'e.valid_to IS NULL']
  const values: unknown[] = [...ap.params]
  let idx = ap.nextIdx

  if (filters.stage) {
    if (Array.isArray(filters.stage)) {
      wheres.push(`e.attributes->>'stage' = ANY($${idx})`); values.push(filters.stage)
    } else {
      wheres.push(`e.attributes->>'stage' = $${idx}`); values.push(filters.stage)
    }
    idx++
  }
  if (filters.contactId) {
    wheres.push(`e.attributes->>'contact_id' = $${idx}`); values.push(filters.contactId); idx++
  }
  if (filters.companyId) {
    wheres.push(`e.attributes->>'company_id' = $${idx}`); values.push(filters.companyId); idx++
  }
  const limit = clampListLimit(filters.limit)
  values.push(limit)

  const result = await queryGated<DealRow>(
    ctx,
    `SELECT ${DEAL_SELECT} FROM entities e
      WHERE ${wheres.join(' AND ')}
      ORDER BY e.updated_at DESC LIMIT $${idx}`,
    values,
  )
  return result.rows.map(toDealRow)
}

/** `access`: see `updateCompany` — write-path viewer projection. */
export async function updateDeal(
  userId: string,
  id: string,
  fields: DealUpdateFields,
  entityLinks?: EntityLinksStore,
  access?: AccessContext,
): Promise<DealRecord | null> {
  assertNonNegativeAmount(fields.amount)
  const old = access ? await getEntityById(access, id) : await getEntityByIdSystem(userId, id)
  if (!old || old.kind !== 'deal') return null
  if (fields.companyId !== undefined) await assertSameWorkspace(fields.companyId, old.workspaceId, 'company_id')
  if (fields.contactId !== undefined) await assertSameWorkspace(fields.contactId, old.workspaceId, 'contact_id')

  const a = { ...old.attributes }
  if (fields.contactId !== undefined) { if (fields.contactId) a.contact_id = fields.contactId; else delete a.contact_id }
  if (fields.companyId !== undefined) { if (fields.companyId) a.company_id = fields.companyId; else delete a.company_id }
  if (fields.amount !== undefined) { if (fields.amount != null) a.amount = fields.amount; else delete a.amount }
  if (fields.closeDate !== undefined) {
    if (fields.closeDate) a.close_date = fields.closeDate.toISOString().slice(0, 10); else delete a.close_date
  }
  if (fields.externalRef !== undefined) a.external_ref = fields.externalRef

  const e = await updateEntity(
    userId, id, { attributes: a }, dedupeAccessContext(userId, old.workspaceId, access),
  )
  if (!e) return null

  if (fields.companyId !== undefined) {
    repointGraphEdge(entityLinks, userId, {
      sourceEntityId: id, targetEntityId: fields.companyId ?? null,
      edgeType: 'engagement_of', workspaceId: old.workspaceId,
    })
  }
  if (entityLinks && fields.contactId !== undefined && fields.contactId) {
    // represents is inbound (contact → deal); append a fresh edge (the
    // FK truth lives in attributes, so the edge is graph-only).
    void emitEdgeFireAndForget(entityLinks, userId, {
      sourceKind: 'entity', sourceId: fields.contactId,
      targetKind: 'entity', targetId: id,
      edgeType: 'represents', workspaceId: old.workspaceId, source: 'user', userId,
    })
  }
  return dealFromEntity(e)
}

/** `access`: see `updateCompany` — write-path viewer projection. */
export async function setDealStage(
  userId: string,
  id: string,
  stage: DealStage,
  access?: AccessContext,
): Promise<DealRecord | null> {
  assertValidStage(stage)
  const old = access ? await getEntityById(access, id) : await getEntityByIdSystem(userId, id)
  if (!old || old.kind !== 'deal') return null
  const a = { ...old.attributes, stage }
  const e = await updateEntity(
    userId, id, { attributes: a }, dedupeAccessContext(userId, old.workspaceId, access),
  )
  if (!e) return null
  return dealFromEntity(e)
}

// ── Relation label resolution (Phase 1 — Notion-feel) ────────────────
//
// View bindings emit `RelationWidget` cells for company/contact/deal
// references (now all entity ids). Resolve a mixed set to display labels
// in one pass, scoped by the caller's access context.

export async function batchLabels(
  ctx: AccessContext,
  requests: { entity: 'company' | 'contact' | 'deal'; ids: string[] }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  await Promise.all(requests.map((req) => resolveLabels(ctx, req.entity, req.ids, out)))
  return out
}

async function resolveLabels(
  ctx: AccessContext,
  entity: 'company' | 'contact' | 'deal',
  ids: string[],
  out: Map<string, string>,
): Promise<void> {
  if (ids.length === 0) return
  const kind = entity === 'company' ? 'company' : entity === 'contact' ? 'person' : 'deal'
  const ap = buildAccessPredicate(ctx, { alias: 'e', startIdx: 1 })
  const result = await queryGated<{ id: string; name: string }>(
    ctx,
    `SELECT e.id, e.display_name AS name FROM entities e
      WHERE ${ap.sql} AND e.kind = $${ap.nextIdx}
        AND e.valid_to IS NULL AND e.id = ANY($${ap.nextIdx + 1}::uuid[])`,
    [...ap.params, kind, ids],
  )
  for (const row of result.rows) {
    out.set(`${entity}:${row.id}`, entity === 'deal' ? `Deal #${row.id.slice(0, 8)}` : row.name)
  }
}
