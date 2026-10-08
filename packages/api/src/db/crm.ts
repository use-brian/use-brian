import type {
  AccessContext,
  CompanyListFilters, CompanyListRow, CompanyRecord, CompanyUpdateFields,
  ContactListFilters, ContactListRow, ContactRecord, ContactUpdateFields,
  CrmExternalRef,
  DealListFilters, DealListRow, DealRecord, DealStage, DealUpdateFields,
  EntityLinksStore,
  EntityRecord,
  Sensitivity,
  StableExternalIdentity,
} from '@use-brian/core'
import { maxSensitivity, unionScopeRequirements } from '@use-brian/core'
import type pg from 'pg'
import { assertExecutionResourceScope, buildAccessPredicate, buildCurrentMemberSourcePredicate, mutationActorAccess } from './access-predicate.js'
import { assertAuthorshipPresent } from './authorship-guard.js'
import { applyRLSGucs, getAppPool, query, queryGated, queryWithRLS } from './client.js'
import { emitCrmRelationEdge, emitEdgeFireAndForget, superseedCrmRelationEdge } from './edge-hooks.js'
import { createEntity, updateEntity } from './entities-store.js'
import {
  bindImportedCrmIdentity,
  resolveCrmPersonIdentity,
} from './crm-identity-store.js'

// Explicit composition for imports; projections run only after their owning commit.
export type CrmWriteTransaction = { client: pg.PoolClient; afterCommit(effect: () => void): void }

function projectAfterCommit(transaction: CrmWriteTransaction | undefined, effect: () => void): void {
  if (transaction) transaction.afterCommit(effect)
  else effect()
}

/** Own a standalone CRM commit; a composer supplies its own transaction. */
export async function runCrmWriteTransaction<T>(
  userId: string, write: (transaction: CrmWriteTransaction) => Promise<T>,
): Promise<T> {
  const client = await getAppPool().connect(), effects: Array<() => void> = []
  let result: T
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client, userId)
    result = await write({ client, afterCommit: effect => effects.push(effect) })
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
  finally { client.release() }
  for (const effect of effects) effect()
  return result
}

export class CrmPersonIdentityConflictError extends Error {
  readonly code = 'person_identity_conflict'
  constructor(readonly entityIds: readonly string[]) {
    super('The stable provider identity is bound ambiguously; review duplicates before writing')
    this.name = 'CrmPersonIdentityConflictError'
  }
}

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

/** Reference lookup shares the canonical current-member gate, even on owner clients. */
export async function readCrmReference(
  userId: string, workspaceId: string, id: string | null | undefined,
  kind: 'company' | 'person' | readonly string[], access?: AccessContext, client?: pg.PoolClient,
): Promise<EntityRecord | null> {
  if (!id) return null
  const actor = mutationActorAccess(userId, workspaceId, access)
  if (client) {
    const ap = buildAccessPredicate(actor, { startIdx: 2, operation: 'read' })
    const member = buildCurrentMemberSourcePredicate(userId, { alias: 'entities', startIdx: ap.nextIdx, operation: 'read' })
    const locked = await client.query<{ id: string }>(
      `SELECT id FROM entities WHERE id=$1 AND valid_to IS NULL AND retracted_at IS NULL
        AND NOT scope_held AND ${ap.sql} AND ${member.sql} FOR SHARE`,
      [id, ...ap.params, ...member.params],
    )
    if (!locked.rows[0]) throw Object.assign(new Error('The relationship cannot be used in the current scope.'), { code: 'scope_operation_denied' })
  }
  const target = await updateEntity(userId, id, {}, actor, client)
  if (!target) throw Object.assign(new Error('The relationship cannot be used in the current scope.'), { code: 'scope_operation_denied' })
  const kinds = typeof kind === 'string' ? [kind] : kind
  if (!kinds.includes(target.kind) || (target.kind === 'person' && target.attributes.self)) {
    throw new Error(kind === 'person' ? 'contact_id must reference a non-self CRM person'
      : kind === 'company' ? 'company_id must reference a CRM company' : 'Reference must identify an allowed CRM record')
  }
  return target
}

/** A relationship must not publish a target's audience into a broader source. */
export function crmReferenceScope(
  destination: Pick<EntityRecord, 'userId' | 'assistantId' | 'sensitivity' | 'compartments' | 'projectIds'>,
  references: Array<EntityRecord | null>,
  inherited?: { sensitivity?: Sensitivity; compartments?: string[]; projectIds?: string[] },
  fresh = false,
): { sensitivity: Sensitivity; compartments: string[]; projectIds: string[]; userId: string | null; assistantId: string | null } {
  let userId = destination.userId, assistantId = destination.assistantId
  let sensitivity = maxSensitivity(destination.sensitivity, inherited?.sensitivity ?? 'public')
  let compartments = unionScopeRequirements(destination.compartments, inherited?.compartments)
  let projectIds = unionScopeRequirements(destination.projectIds, inherited?.projectIds)
  for (const target of references) {
    if (!target) continue
    if (fresh) {
      userId ??= target.userId
      assistantId ??= target.assistantId
    }
    if ((target.userId !== null && target.userId !== userId)
      || (target.assistantId !== null && target.assistantId !== assistantId)) {
      throw Object.assign(new Error('The relationship cannot be published in this scope.'), { code: 'scope_operation_denied' })
    }
    sensitivity = maxSensitivity(sensitivity, target.sensitivity)
    compartments = unionScopeRequirements(compartments, target.compartments)
    projectIds = unionScopeRequirements(projectIds, target.projectIds)
  }
  return { sensitivity, compartments, projectIds, userId, assistantId }
}

/** Lock and reread a CRM source before assembling a semantic mutation. */
export async function readCrmMutationSource(
  ctx: AccessContext, entityId: string, kinds: readonly string[], client: pg.PoolClient,
): Promise<EntityRecord | null> {
  const actor = mutationActorAccess(ctx.userId, ctx.workspaceId, ctx)
  const initial = await updateEntity(ctx.userId, entityId, {}, actor, client)
  if (!initial || !kinds.includes(initial.kind)) return null
  assertExecutionResourceScope({ ...initial, compartments: initial.compartments ?? [], projectIds: initial.projectIds ?? [] }, 'mutation', actor)
  const ap = buildAccessPredicate(actor, { startIdx: 3, operation: 'mutation' })
  const member = buildCurrentMemberSourcePredicate(ctx.userId, { alias: 'entities', startIdx: ap.nextIdx })
  const locked = await client.query<{ id: string }>(
    `SELECT id FROM entities WHERE id=$1 AND kind=ANY($2::text[]) AND valid_to IS NULL
      AND retracted_at IS NULL AND NOT scope_held AND ${ap.sql} AND ${member.sql} FOR UPDATE`,
    [entityId, [...kinds], ...ap.params, ...member.params],
  )
  if (!locked.rows[0]) return null
  // Read again after a competing writer, rather than patching the pre-lock snapshot.
  return updateEntity(ctx.userId, entityId, {}, actor, client)
}

/** Admit a participant command and keep its source/reference snapshots locked. */
export async function prepareCrmParticipantMutation(
  ctx: AccessContext, dealId: string, contactId: string | null, client: pg.PoolClient,
): Promise<EntityRecord | null> {
  const actor = mutationActorAccess(ctx.userId, ctx.workspaceId, ctx)
  const deal = await readCrmMutationSource(actor, dealId, ['deal'], client)
  if (!deal) return null
  const contact = await readCrmReference(ctx.userId, ctx.workspaceId, contactId, 'person', actor, client)
  const inherited = crmReferenceScope(deal, [contact])
  return updateEntity(ctx.userId, dealId, {
    sensitivity: inherited.sensitivity,
    inheritCompartments: inherited.compartments,
    inheritProjectIds: inherited.projectIds,
  }, actor, client)
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
  return mutationActorAccess(userId, workspaceId, access)
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
    assistantId?: string | null
    compartments?: string[]; projectIds?: string[]
  },
): void {
  if (!entityLinks) return
  void superseedCrmRelationEdge(entityLinks, userId, {
    sourceEntityId: params.sourceEntityId, targetEntityId: params.targetEntityId,
    edgeType: params.edgeType, workspaceId: params.workspaceId, source: 'user', userId,
    compartments: params.compartments, projectIds: params.projectIds, assistantId: params.assistantId,
  })
}

// ── Projections from a fetched entity row (create / update return) ────

function companyFromEntity(e: EntityRecord): CompanyRecord {
  const a = e.attributes
  return {
    id: e.id, workspaceId: e.workspaceId, entityId: e.id,
    name: e.displayName, aliases: e.aliases,
    domain: attrStr(a, 'domain') ?? e.canonicalId ?? null,
    tags: attrTags(a), externalRef: attrRef(a),
    sensitivity: e.sensitivity, compartments: e.compartments, projectIds: e.projectIds,
    createdAt: e.createdAt, updatedAt: e.updatedAt,
  }
}
function contactFromEntity(e: EntityRecord): ContactRecord {
  const a = e.attributes
  return {
    id: e.id, workspaceId: e.workspaceId, entityId: e.id,
    name: e.displayName, aliases: e.aliases,
    email: attrStr(a, 'email') ?? e.canonicalId ?? null,
    phone: attrStr(a, 'phone'),
    companyId: attrStr(a, 'company_id'),
    tags: attrTags(a), externalRef: attrRef(a),
    sensitivity: e.sensitivity, compartments: e.compartments, projectIds: e.projectIds,
    createdAt: e.createdAt, updatedAt: e.updatedAt,
  }
}
function dealFromEntity(e: EntityRecord): DealRecord {
  const a = e.attributes
  const amount = a.amount
  const closeDate = a.close_date
  return {
    id: e.id, workspaceId: e.workspaceId, entityId: e.id,
    name: e.displayName, aliases: e.aliases,
    contactId: attrStr(a, 'contact_id'),
    companyId: attrStr(a, 'company_id'),
    stage: (attrStr(a, 'stage') as DealStage) ?? 'lead',
    amount: typeof amount === 'number' ? amount : amount != null ? Number(amount) : null,
    closeDate: typeof closeDate === 'string' ? new Date(closeDate) : null,
    externalRef: attrRef(a),
    sensitivity: e.sensitivity, compartments: e.compartments, projectIds: e.projectIds,
    createdAt: e.createdAt, updatedAt: e.updatedAt,
  }
}

// ── Companies ────────────────────────────────────────────────────────

type CompanyRow = Omit<CompanyRecord, 'tags' | 'externalRef'> & {
  tags: string[] | null; externalRef: CrmExternalRef | null
}
const COMPANY_SELECT = `
  e.id, e.id AS "entityId", e.workspace_id AS "workspaceId",
  e.display_name AS name, e.aliases,
  COALESCE(e.attributes->>'domain', e.canonical_id) AS domain,
  e.attributes->'tags' AS tags,
  e.attributes->'external_ref' AS "externalRef",
  e.sensitivity, e.compartments, e.project_ids AS "projectIds",
  e.created_at AS "createdAt", e.updated_at AS "updatedAt"`

function toCompanyRow(row: CompanyRow): CompanyRecord {
  return { ...row, aliases: row.aliases ?? [], tags: row.tags ?? [], externalRef: row.externalRef ?? {} }
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
    explicitGeneral?: boolean
    compartments?: string[]
    projectIds?: string[]
    source?: 'user' | 'extracted'
    /** Extraction provenance anchor — the Episode this company derives from (Pipeline B / compose / synthesis). */
    sourceEpisodeId?: string | null
    /** Interactive-write provenance anchor (mig 316) — the creating conversation's session (chat saveCompany). */
    sourceSessionId?: string | null
    /** The assistant that mediated the write. */
    createdByAssistantId?: string | null
    access?: AccessContext
  },
  transaction?: CrmWriteTransaction,
): Promise<CompanyRecord> {
  assertAuthorshipPresent('createCompany', userId)
  const access = dedupeAccessContext(userId, params.workspaceId, params.access)
  assertExecutionResourceScope({ workspaceId: params.workspaceId, userId: null, assistantId: null,
    sensitivity: params.sensitivity ?? 'internal', compartments: params.compartments ?? [], projectIds: params.projectIds ?? [] }, 'mutation', access)

  // Upsert-by-name: dedupe against a live company entity in the workspace
  // — but only among rows the caller can read (see dedupeAccessContext).
  const ap = buildAccessPredicate(
    access,
    { startIdx: 3, operation: 'mutation' },
  )
  const member = buildCurrentMemberSourcePredicate(userId, { alias: 'entities', startIdx: ap.nextIdx })
  if (transaction) await transaction.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['crm-company', params.workspaceId, params.name.toLowerCase()])])
  const run = transaction ? transaction.client.query.bind(transaction.client) : <T extends pg.QueryResultRow>(sql: string, values: unknown[]) => queryWithRLS<T>(userId, sql, values)
  const existing = await run<{ id: string }>(
    `SELECT id FROM entities
      WHERE workspace_id = $1 AND kind = 'company'
        AND lower(display_name) = lower($2)
        AND valid_to IS NULL AND retracted_at IS NULL AND NOT scope_held
        AND ${ap.sql} AND ${member.sql}
      ORDER BY created_at ASC LIMIT 1`,
    [params.workspaceId, params.name, ...ap.params, ...member.params],
  )
  if (existing.rows[0]) {
    const merged = await mergeCompanyFields(userId, existing.rows[0].id, {
      domain: params.domain ?? null, tags: params.tags, externalRef: params.externalRef,
    }, { compartments: params.compartments ?? [], projectIds: params.projectIds ?? [], sensitivity: params.sensitivity ?? 'internal' }, access, transaction)
    if (merged) return merged
  }

  const entity = await createEntity({
    kind: 'company',
    displayName: params.name,
    canonicalId: params.domain ?? null,
    attributes: companyAttributes(params),
    sensitivity: params.sensitivity ?? 'internal',
    workspaceId: params.workspaceId,
    // Workspace-scoped: a company is a company-wide fact, not the property of
    // whoever happened to type it. Visibility must NOT copy authorship —
    // `createdByUserId` below carries who wrote it. See migration 423.
    userId: null,
    createdByUserId: userId,
    createdByAssistantId: params.createdByAssistantId ?? null,
    source: params.source ?? 'user',
    sourceEpisodeId: params.sourceEpisodeId ?? null,
    sourceSessionId: params.sourceSessionId ?? null,
    explicitGeneral: params.explicitGeneral,
    compartments: params.compartments ?? [],
    projectIds: params.projectIds ?? [],
  }, transaction?.client)
  return companyFromEntity(entity)
}

async function mergeCompanyFields(
  userId: string,
  id: string,
  incoming: { domain?: string | null; tags?: string[]; externalRef?: CrmExternalRef },
  scope: { compartments: string[]; projectIds: string[]; sensitivity?: Sensitivity },
  access?: AccessContext,
  transaction?: CrmWriteTransaction,
): Promise<CompanyRecord | null> {
  const entity = await updateEntity(userId, id, {}, access, transaction?.client)
  if (!entity || entity.kind !== 'company') return null
  assertExecutionResourceScope({ ...entity, compartments: entity.compartments ?? [], projectIds: entity.projectIds ?? [] }, 'mutation', access)
  const cur = companyFromEntity(entity)
  const sensitivity = maxSensitivity(entity.sensitivity, scope.sensitivity ?? 'public')
  const fields: CompanyUpdateFields = {}
  if (incoming.domain && incoming.domain !== cur.domain) fields.domain = incoming.domain
  if (incoming.tags && incoming.tags.length > 0) {
    const merged = Array.from(new Set([...cur.tags, ...incoming.tags]))
    if (merged.length !== cur.tags.length) fields.tags = merged
  }
  if (incoming.externalRef && Object.keys(incoming.externalRef).length > 0) {
    fields.externalRef = { ...cur.externalRef, ...incoming.externalRef }
  }
  const scopeAdds = scope.compartments.some((value) => !cur.compartments?.includes(value))
    || scope.projectIds.some((value) => !cur.projectIds?.includes(value))
  if (Object.keys(fields).length === 0 && !scopeAdds && sensitivity === entity.sensitivity) return cur
  return updateCompany(userId, id, fields, access, transaction?.client, { ...scope, sensitivity })
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
    wheres.push(`(e.display_name ILIKE $${idx} OR COALESCE(e.attributes->>'domain', e.canonical_id) ILIKE $${idx} OR EXISTS (SELECT 1 FROM unnest(e.aliases) alias WHERE alias ILIKE $${idx}))`)
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
  transactionClient?: pg.PoolClient,
  scope?: { compartments: string[]; projectIds: string[]; sensitivity?: Sensitivity },
): Promise<CompanyRecord | null> {
  // The canonical no-op read binds the actor and current member scope even
  // when this adapter is composed into an owner-pool transaction.
  const old = await updateEntity(userId, id, {}, access, transactionClient)
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
    sensitivity: scope?.sensitivity === undefined ? undefined : maxSensitivity(old.sensitivity, scope.sensitivity),
    inheritCompartments: scope?.compartments,
    inheritProjectIds: scope?.projectIds,
  }, dedupeAccessContext(userId, old.workspaceId, access), transactionClient)
  if (!e) return null
  return companyFromEntity(e)
}

// ── Contacts ─────────────────────────────────────────────────────────

type ContactRow = Omit<ContactRecord, 'tags' | 'externalRef'> & {
  tags: string[] | null; externalRef: CrmExternalRef | null
}
const CONTACT_SELECT = `
  e.id, e.id AS "entityId", e.workspace_id AS "workspaceId",
  e.display_name AS name, e.aliases,
  COALESCE(e.attributes->>'email', e.canonical_id) AS email,
  e.attributes->>'phone' AS phone,
  e.attributes->>'company_id' AS "companyId",
  e.attributes->'tags' AS tags,
  e.attributes->'external_ref' AS "externalRef",
  e.sensitivity, e.compartments, e.project_ids AS "projectIds",
  e.created_at AS "createdAt", e.updated_at AS "updatedAt"`

function toContactRow(row: ContactRow): ContactRecord {
  return { ...row, aliases: row.aliases ?? [], tags: row.tags ?? [], externalRef: row.externalRef ?? {} }
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
    stableIdentity?: StableExternalIdentity
    sensitivity?: Sensitivity
    explicitGeneral?: boolean
    compartments?: string[]
    projectIds?: string[]
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
  transaction?: CrmWriteTransaction,
): Promise<ContactRecord> {
  assertAuthorshipPresent('createContact', userId)
  const access = dedupeAccessContext(userId, params.workspaceId, params.access)
  assertExecutionResourceScope({ workspaceId: params.workspaceId, userId: null, assistantId: null,
    sensitivity: params.sensitivity ?? 'internal', compartments: params.compartments ?? [], projectIds: params.projectIds ?? [] }, 'mutation', access)
  if (!transaction) return runCrmWriteTransaction(userId, tx => createContact(userId, params, entityLinks, tx))
  const company = await readCrmReference(userId, params.workspaceId, params.companyId, 'company', access, transaction?.client)
  const destination = crmReferenceScope({ userId: null, assistantId: null,
    sensitivity: params.sensitivity ?? 'internal', compartments: params.compartments, projectIds: params.projectIds }, [company], undefined, true)
  params = { ...params, ...destination }
  assertExecutionResourceScope({ workspaceId: params.workspaceId, userId: destination.userId, assistantId: destination.assistantId,
    sensitivity: params.sensitivity!, compartments: params.compartments!, projectIds: params.projectIds! }, 'mutation', access)

  // Person writes never resolve by name/email/phone/alias/fuzzy evidence.
  // Only an adapter-verified stable provider identity may select an existing
  // target. Stable-identity lookup and creation share one transaction;
  // a failed lookup never falls through to an unbound duplicate.
  if (params.stableIdentity) {
    if (transaction) await transaction.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`crm-identity:${params.workspaceId}`])
    const resolution = transaction
      ? await resolveCrmPersonIdentity(params.workspaceId, params.stableIdentity, transaction.client)
      : await resolveCrmPersonIdentity(params.workspaceId, params.stableIdentity)
    if (resolution.status === 'conflict') {
      const visible = await Promise.all(resolution.entityIds.map(id => updateEntity(userId, id, {}, access, transaction?.client)))
      if (visible.some(row => !row)) throw Object.assign(new Error('The identity cannot be used in the current scope.'), { code: 'scope_operation_denied' })
      throw new CrmPersonIdentityConflictError(resolution.entityIds)
    }
    if (resolution.status === 'resolved') {
      const merged = await mergeContactFields(userId, resolution.binding.entityId, {
        email: params.email ?? null,
        phone: params.phone ?? null,
        companyId: params.companyId ?? null,
        tags: params.tags,
        externalRef: params.externalRef,
      }, entityLinks, access, {
        compartments: params.compartments ?? [],
        projectIds: params.projectIds ?? [],
        sensitivity: params.sensitivity ?? 'internal',
      }, transaction)
      if (merged) return merged
      throw Object.assign(new Error('The identity cannot be used in the current scope.'), { code: 'scope_operation_denied' })
    }

  }

  const entity = await createEntity({
    kind: 'person',
    displayName: params.name,
    canonicalId: params.email ?? null,
    attributes: contactAttributes(params),
    sensitivity: params.sensitivity ?? 'internal',
    workspaceId: params.workspaceId,
    // Authorship does not determine visibility. Admitted relationship
    // sources can independently require a private destination.
    userId: destination.userId,
    assistantId: destination.assistantId,
    createdByUserId: userId,
    createdByAssistantId: params.createdByAssistantId ?? null,
    source: params.source ?? 'user',
    sourceEpisodeId: params.sourceEpisodeId ?? null,
    sourceSessionId: params.sourceSessionId ?? null,
    explicitGeneral: params.explicitGeneral,
    compartments: params.compartments ?? [],
    projectIds: params.projectIds ?? [],
  }, transaction?.client)

  if (params.companyId) {
    if (entityLinks) {
      const companyId = params.companyId
      projectAfterCommit(transaction, () => { void emitCrmRelationEdge(entityLinks, userId, {
        sourceEntityId: entity.id, targetEntityId: companyId,
        edgeType: 'works_at', workspaceId: params.workspaceId, source: 'user', userId,
        compartments: entity.compartments, projectIds: entity.projectIds, assistantId: entity.assistantId,
      }) })
    }
  }
  if (params.stableIdentity) {
    const binding = await bindImportedCrmIdentity({
      workspaceId: params.workspaceId,
      entityId: entity.id,
      identity: params.stableIdentity,
      sensitivity: params.sensitivity ?? 'internal',
    }, transaction?.client)
    if (binding.status === 'conflict') {
      // Refuse the whole transaction; no speculative retirement or target edit.
      throw Object.assign(new Error('The identity changed. Start a new request with current access.'), { code: 'scope_operation_denied' })
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
  access?: AccessContext,
  scope: { compartments: string[]; projectIds: string[]; sensitivity?: Sensitivity } = { compartments: [], projectIds: [] },
  transaction?: CrmWriteTransaction,
): Promise<ContactRecord | null> {
  const entity = await updateEntity(userId, id, {}, access, transaction?.client)
  if (!entity || entity.kind !== 'person') return null
  assertExecutionResourceScope({ ...entity, compartments: entity.compartments ?? [], projectIds: entity.projectIds ?? [] }, 'mutation', access)
  const cur = contactFromEntity(entity)
  const sensitivity = maxSensitivity(entity.sensitivity, scope.sensitivity ?? 'public')
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
  const scopeAdds = scope.compartments.some((value) => !cur.compartments?.includes(value))
    || scope.projectIds.some((value) => !cur.projectIds?.includes(value))
  if (Object.keys(fields).length === 0 && !scopeAdds && sensitivity === entity.sensitivity) return cur
  return updateContact(userId, id, fields, entityLinks, access, transaction?.client, { ...scope, sensitivity }, transaction?.afterCommit)
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
    // A phone-shaped query ("+852 6698 6281", "85266986281") must find the
    // contact regardless of how the stored number is spaced or prefixed, so
    // both sides compare digits-only. Gated on >= 5 query digits: shorter
    // digit runs ("Suite 21") are not phone searches and would fan out.
    const queryDigits = filters.query.replace(/\D/g, '')
    const phoneArm = queryDigits.length >= 5
      ? ` OR regexp_replace(COALESCE(e.attributes->>'phone', ''), '[^0-9]', '', 'g') LIKE '%' || regexp_replace($${idx}, '[^0-9]', '', 'g') || '%'`
      : ''
    wheres.push(`(e.display_name ILIKE $${idx} OR COALESCE(e.attributes->>'email', e.canonical_id) ILIKE $${idx}${phoneArm} OR EXISTS (SELECT 1 FROM unnest(e.aliases) alias WHERE alias ILIKE $${idx}))`)
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
  transactionClient?: pg.PoolClient,
  scope?: { compartments: string[]; projectIds: string[]; sensitivity?: Sensitivity },
  afterCommit?: CrmWriteTransaction['afterCommit'],
): Promise<ContactRecord | null> {
  // The canonical no-op read binds the actor and current member scope even
  // when this adapter is composed into an owner-pool transaction.
  const old = await updateEntity(userId, id, {}, access, transactionClient)
  if (!old || old.kind !== 'person') return null
  const company = await readCrmReference(userId, old.workspaceId, fields.companyId, 'company', access, transactionClient)
  const inherited = crmReferenceScope(old, [company], scope)
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
    sensitivity: inherited.sensitivity,
    inheritCompartments: inherited.compartments,
    inheritProjectIds: inherited.projectIds,
  }, dedupeAccessContext(userId, old.workspaceId, access), transactionClient)
  if (!e) return null
  if (fields.companyId !== undefined) {
    const project = () => repointGraphEdge(entityLinks, userId, {
      sourceEntityId: id, targetEntityId: fields.companyId ?? null,
      edgeType: 'works_at', workspaceId: old.workspaceId,
      compartments: e.compartments, projectIds: e.projectIds, assistantId: e.assistantId,
    })
    if (afterCommit) afterCommit(project)
    else project()
  }
  return contactFromEntity(e)
}

// ── Deals ────────────────────────────────────────────────────────────

type DealRow = Omit<DealRecord, 'amount' | 'externalRef'> & {
  amount: string | number | null; externalRef: CrmExternalRef | null
}
const DEAL_SELECT = `
  e.id, e.id AS "entityId", e.workspace_id AS "workspaceId",
  e.display_name AS name, e.aliases,
  e.attributes->>'contact_id' AS "contactId",
  e.attributes->>'company_id' AS "companyId",
  COALESCE(e.attributes->>'stage', 'lead') AS stage,
  e.attributes->>'amount' AS amount,
  (e.attributes->>'close_date')::date AS "closeDate",
  e.attributes->'external_ref' AS "externalRef",
  e.sensitivity, e.compartments, e.project_ids AS "projectIds",
  e.created_at AS "createdAt", e.updated_at AS "updatedAt"`

function toDealRow(row: DealRow): DealRecord {
  return {
    ...row,
    aliases: row.aliases ?? [],
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
    access?: AccessContext
    contactId?: string | null
    companyId?: string | null
    stage?: DealStage
    amount?: number | null
    closeDate?: Date | null
    externalRef?: CrmExternalRef
    sensitivity?: Sensitivity
    explicitGeneral?: boolean
    compartments?: string[]
    projectIds?: string[]
    source?: 'user' | 'extracted'
    /** Extraction provenance anchor — the Episode this deal derives from (Pipeline B / compose / synthesis). */
    sourceEpisodeId?: string | null
    /** Interactive-write provenance anchor (mig 316) — the creating conversation's session (chat saveDeal). */
    sourceSessionId?: string | null
    /** The assistant that mediated the write. */
    createdByAssistantId?: string | null
  },
  entityLinks?: EntityLinksStore,
  transaction?: CrmWriteTransaction,
): Promise<DealRecord> {
  assertAuthorshipPresent('createDeal', userId)
  assertValidStage(params.stage)
  assertNonNegativeAmount(params.amount)
  const access = mutationActorAccess(userId, params.workspaceId, params.access)
  if (!transaction) return runCrmWriteTransaction(userId, tx => createDeal(userId, params, entityLinks, tx))
  const contact = await readCrmReference(userId, params.workspaceId, params.contactId, 'person', access, transaction?.client)
  const company = await readCrmReference(userId, params.workspaceId, params.companyId, 'company', access, transaction?.client)
  const destination = crmReferenceScope({ userId: null, assistantId: null,
    sensitivity: params.sensitivity ?? 'internal', compartments: params.compartments, projectIds: params.projectIds }, [contact, company], undefined, true)
  params = { ...params, ...destination }
  assertExecutionResourceScope({ workspaceId: params.workspaceId, userId: destination.userId, assistantId: destination.assistantId,
    sensitivity: params.sensitivity!, compartments: params.compartments!, projectIds: params.projectIds! }, 'mutation', access)
  const displayName = company ? `Deal - ${company.displayName}` : 'Deal'

  const entity = await createEntity({
    kind: 'deal',
    displayName,
    attributes: dealAttributes(params),
    sensitivity: params.sensitivity ?? 'internal',
    workspaceId: params.workspaceId,
    // Preserve reference privacy independently of authorship.
    userId: destination.userId,
    assistantId: destination.assistantId,
    createdByUserId: userId,
    createdByAssistantId: params.createdByAssistantId ?? null,
    source: params.source ?? 'user',
    sourceEpisodeId: params.sourceEpisodeId ?? null,
    sourceSessionId: params.sourceSessionId ?? null,
    explicitGeneral: params.explicitGeneral,
    compartments: params.compartments ?? [],
    projectIds: params.projectIds ?? [],
  }, transaction?.client)

  if (entityLinks && params.companyId) {
    const companyId = params.companyId
    projectAfterCommit(transaction, () => { void emitCrmRelationEdge(entityLinks, userId, {
      sourceEntityId: entity.id, targetEntityId: companyId,
      edgeType: 'engagement_of', workspaceId: params.workspaceId, source: 'user', userId,
      compartments: entity.compartments, projectIds: entity.projectIds, assistantId: entity.assistantId,
    }) })
  }
  if (entityLinks && params.contactId) {
    const contactId = params.contactId
    projectAfterCommit(transaction, () => { void emitEdgeFireAndForget(entityLinks, userId, {
      sourceKind: 'entity', sourceId: contactId,
      targetKind: 'entity', targetId: entity.id,
      edgeType: 'represents', workspaceId: params.workspaceId, source: 'user', userId,
      compartments: entity.compartments, projectIds: entity.projectIds, assistantId: entity.assistantId,
    }) })
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
  transactionClient?: pg.PoolClient,
  scope?: { compartments: string[]; projectIds: string[]; sensitivity?: Sensitivity },
): Promise<DealRecord | null> {
  assertNonNegativeAmount(fields.amount)
  // The canonical no-op read binds the actor and current member scope even
  // when this adapter is composed into an owner-pool transaction.
  const old = await updateEntity(userId, id, {}, access, transactionClient)
  if (!old || old.kind !== 'deal') return null
  const company = await readCrmReference(userId, old.workspaceId, fields.companyId, 'company', access, transactionClient)
  const contact = await readCrmReference(userId, old.workspaceId, fields.contactId, 'person', access, transactionClient)
  const inherited = crmReferenceScope(old, [company, contact], scope)

  const a = { ...old.attributes }
  if (fields.contactId !== undefined) { if (fields.contactId) a.contact_id = fields.contactId; else delete a.contact_id }
  if (fields.companyId !== undefined) { if (fields.companyId) a.company_id = fields.companyId; else delete a.company_id }
  if (fields.amount !== undefined) { if (fields.amount != null) a.amount = fields.amount; else delete a.amount }
  if (fields.closeDate !== undefined) {
    if (fields.closeDate) a.close_date = fields.closeDate.toISOString().slice(0, 10); else delete a.close_date
  }
  if (fields.externalRef !== undefined) a.external_ref = fields.externalRef

  const e = await updateEntity(
    userId,
    id,
    {
      attributes: a,
      sensitivity: inherited.sensitivity,
      inheritCompartments: inherited.compartments,
      inheritProjectIds: inherited.projectIds,
    },
    dedupeAccessContext(userId, old.workspaceId, access),
    transactionClient,
  )
  if (!e) return null

  if (fields.companyId !== undefined) {
    repointGraphEdge(entityLinks, userId, {
      sourceEntityId: id, targetEntityId: fields.companyId ?? null,
      edgeType: 'engagement_of', workspaceId: old.workspaceId,
      compartments: e.compartments, projectIds: e.projectIds, assistantId: e.assistantId,
    })
  }
  if (entityLinks && fields.contactId !== undefined && fields.contactId) {
    // represents is inbound (contact → deal); append a fresh edge (the
    // FK truth lives in attributes, so the edge is graph-only).
    void emitEdgeFireAndForget(entityLinks, userId, {
      sourceKind: 'entity', sourceId: fields.contactId,
      targetKind: 'entity', targetId: id,
      edgeType: 'represents', workspaceId: old.workspaceId, source: 'user', userId,
      compartments: e.compartments, projectIds: e.projectIds, assistantId: e.assistantId,
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
  transactionClient?: pg.PoolClient,
  scope?: { compartments: string[]; projectIds: string[]; sensitivity?: Sensitivity },
): Promise<DealRecord | null> {
  assertValidStage(stage)
  // The canonical no-op read binds the actor and current member scope even
  // when this adapter is composed into an owner-pool transaction.
  const old = await updateEntity(userId, id, {}, access, transactionClient)
  if (!old || old.kind !== 'deal') return null
  const a = { ...old.attributes, stage }
  const e = await updateEntity(
    userId,
    id,
    {
      attributes: a,
      sensitivity: scope?.sensitivity === undefined ? undefined : maxSensitivity(old.sensitivity, scope.sensitivity),
      inheritCompartments: scope?.compartments,
      inheritProjectIds: scope?.projectIds,
    },
    dedupeAccessContext(userId, old.workspaceId, access),
    transactionClient,
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
