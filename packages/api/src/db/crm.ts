import type {
  AccessContext,
  CompanyListFilters, CompanyListRow, CompanyRecord, CompanyUpdateFields,
  ContactListFilters, ContactListRow, ContactRecord, ContactUpdateFields,
  CrmExternalRef,
  CrmAmount,
  DealListFilters, DealListRow, DealRecord, DealStage, DealUpdateFields,
  EntityLinksStore,
  EntityRecord,
  Sensitivity,
  StableExternalIdentity,
} from '@use-brian/core'
import { bindScopeSources, boundScopeSources, DEAL_STAGES, validApplicationDate, decodeCrmAmount, crmAmountSchema, maxSensitivity, unionScopeRequirements } from '@use-brian/core'
import type pg from 'pg'
import { z } from 'zod'
import { mapCanonicalCrmRows,queryLegacyCanonicalCrmSql,queryLegacyCanonicalCrmBatch,readLegacyCanonicalCrmPoint } from './crm-reader.js'
import { currentApplicationReadTransaction,getApplicationTransactionBinding } from '../application-platform/execution-context.js'
import { currentAgentAccess } from './agent-access-context.js'
import { canonicalNativeAmountEncoding } from '../application-platform/field-evidence.js'
import { ApplicationPlatformError,applicationJsonSchema,applicationResourceRefSchema } from '@use-brian/shared'
import { assertExecutionResourceScope, buildAccessPredicate, buildCurrentMemberSourcePredicate, mutationActorAccess } from './access-predicate.js'
import { assertAuthorshipPresent } from './authorship-guard.js'
import { applyRLSGucs, getAppPool, query, queryGated, queryWithRLS } from './client.js'
import { emitCrmRelationEdge, emitEdgeFireAndForget, superseedCrmRelationEdge } from './edge-hooks.js'
import { assertNativeEntityFieldWrites, createEntity, updateEntity } from './entities-store.js'
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
 * every inbound and outbound edge — stays valid. Canonical source versions
 * support optimistic edits; historical revision projection is tracked separately.
 * Typed writers validate business values and current relationship authority.
 * Canonical entities additionally enforce known native/custom value constraints
 * below raw and typed writers (migration 8035). Current target authority remains
 * a separate canonical admission check. Legacy typed errors retain their
 * `deals_stage_check` / `deals_amount_check` / "same workspace" tokens.
 */

const VALID_STAGES: readonly DealStage[] = [
  'lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost',
]

// The canonical writer owns the business vocabulary; route parsers only adapt it.
const crmName = z.string().min(1).max(256).refine(value => value.trim().length > 0)
const crmTags = z.array(z.string().max(100)).max(64)
const crmExternalRef = z.record(applicationJsonSchema)
const crmCommonPatch = z.object({
  aliases: z.array(z.string().min(1).max(200)).optional(),
  tags: crmTags.optional(), externalRef: crmExternalRef.optional(),
  ownerId: z.string().uuid().nullable().optional(), archivedAt: z.string().datetime({offset:true}).nullable().optional(),
  customFields: z.record(applicationJsonSchema).optional(),
})
export const crmCompanyPatch = crmCommonPatch.extend({name: crmName.optional(),domain: z.string().max(320).nullable().optional()}).strict()
export const crmContactPatch = crmCommonPatch.extend({name: crmName.optional(),email: z.string().max(320).nullable().optional(),
  phone: z.string().max(100).nullable().optional(),companyId: z.string().uuid().nullable().optional()}).strict()
export const crmDealPatch = crmCommonPatch.extend({name: crmName.optional(),stage:z.enum(DEAL_STAGES).optional(),
  contactId:z.string().uuid().nullable().optional(),companyId:z.string().uuid().nullable().optional(),
  amount:crmAmountSchema.nullable().optional(),closeDate:z.date().nullable().optional(),
  pipelineId:z.string().uuid().nullable().optional(),pipelineStageId:z.string().uuid().nullable().optional(),
  currencyCode:z.string().regex(/^[A-Z]{3}$/).nullable().optional(),source:z.string().max(100).nullable().optional(),
  winLossReason:z.string().max(2000).nullable().optional(),probability:z.number().finite().min(0).max(100).nullable().optional(),
}).strict()
export type CanonicalCrmType = 'company'|'person'|'deal'
export type CanonicalCrmPatch = CompanyUpdateFields|ContactUpdateFields|DealUpdateFields
const canonicalCrmSchema = (type:CanonicalCrmType) => type==='company'?crmCompanyPatch:type==='person'?crmContactPatch:crmDealPatch
function validateCrmBusiness(schema: z.ZodTypeAny,raw: unknown): void {
  if (!schema.safeParse(raw).success) throw new ApplicationPlatformError('invalid_value','The canonical CRM values are invalid.')
}
function validateCrmCreation(schema: z.AnyZodObject,raw: object,extra: readonly string[] = []): void {
  const operational=['workspaceId','access','sensitivity','explicitGeneral','compartments','projectIds','source','sourceEpisodeId','sourceSessionId','createdByAssistantId',...extra]
  const keys=Object.keys(schema.shape)
  if (Object.keys(raw).some(key => !keys.includes(key) && !operational.includes(key))) {
    throw new ApplicationPlatformError('invalid_value','The canonical CRM input contains an unknown field.')
  }
  validateCrmBusiness(schema,Object.fromEntries(keys.map(key => [key,(raw as Record<string,unknown>)[key]])))
}
function crmMutationFieldIntent(fields:object):string[] {
  return Object.entries(fields).flatMap(([key,value])=>value===undefined?[]:key==='customFields'
    ?Object.keys(value as Record<string,unknown>).map(field=>`custom.${field}`):[key])
}
async function initialCrmCustomValues(userId:string,workspaceId:string,entityKind:'company'|'person'|'deal',values:Record<string,unknown>|undefined,
  standardFields:readonly string[],access:AccessContext,client:pg.PoolClient) {
  if(values===undefined) return {values:undefined,references:[] as EntityRecord[]}
  return (await import('./crm-r2.js')).prepareCrmInitialCustomFields({ctx:access,entityKind,values,standardFields},client)
}
async function combinedCrmCustomValues(userId:string,id:string,values:Record<string,unknown>|undefined,access:AccessContext,client:pg.PoolClient) {
  if(values===undefined) return undefined
  return (await import('./crm-r2.js')).prepareCrmCustomFieldPatch({ctx:access,entityId:id,values},client)
}

type CrmMutationOptions = { expectedVersion?: string;afterCommit?: CrmWriteTransaction['afterCommit'] }
async function typedMutationSource(userId: string,id: string,kind: string,access: AccessContext|undefined,client: pg.PoolClient) {
  if (access) return readCrmMutationSource(access,id,[kind],client)
  const initial=await updateEntity(userId,id,{},undefined,client)
  return initial ? readCrmMutationSource(dedupeAccessContext(userId,initial.workspaceId),id,[kind],client) : null
}

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
  await (await import('./crm-r2.js')).lockCrmConfiguration(client,ctx.workspaceId)
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
  if (inherited.sensitivity === deal.sensitivity
    && inherited.compartments.every(value => deal.compartments?.includes(value))
    && inherited.projectIds.every(value => deal.projectIds?.includes(value))) return deal
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
    throw new ApplicationPlatformError('invalid_value',`deals_stage_check: invalid deal stage "${stage}"`)
  }
}
function assertNonNegativeAmount(amount: CrmAmount | null | undefined): void {
  if (amount != null && (!crmAmountSchema.safeParse(amount).success)) {
    throw new ApplicationPlatformError('invalid_value','deals_amount_check: amount must be greater than or equal to 0')
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
    amount: amount == null ? null : crmAmountSchema.parse(amount),
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
  domain?: string | null; tags?: string[]; externalRef?: CrmExternalRef; customFields?: Record<string,unknown>
}): Record<string, unknown> {
  const a: Record<string, unknown> = { tags: p.tags ?? [] }
  if (p.domain) a.domain = p.domain
  if (p.externalRef && Object.keys(p.externalRef).length) a.external_ref = p.externalRef
  if(p.customFields!==undefined) a.custom_fields=p.customFields
  return a
}

export async function createCompany(
  userId: string,
  params: {
    workspaceId: string
    name: string
    domain?: string | null
    tags?: string[]
    externalRef?: CrmExternalRef; customFields?: Record<string,unknown>
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
    /** Default true: a same-named visible company is updated instead of duplicated. Governed and imported
     * creates pass false, because name equality must never merge identities they were asked to keep apart. */
    mergeByName?: boolean
  },
  transaction?: CrmWriteTransaction,
): Promise<CompanyRecord> {
  validateCrmCreation(crmCompanyPatch.pick({name:true,domain:true,tags:true,externalRef:true,customFields:true}).required({name:true}),params,['mergeByName'])
  assertAuthorshipPresent('createCompany', userId)
  const access = dedupeAccessContext(userId, params.workspaceId, params.access)
  const bound=currentApplicationReadTransaction(access)
  if(bound&&transaction?.client!==bound.client)throw new ApplicationPlatformError('access_unavailable','The transaction is unavailable.')
  if(!transaction)return runCrmWriteTransaction(userId,tx=>createCompany(userId,params,tx))
  assertExecutionResourceScope({ workspaceId: params.workspaceId, userId: null, assistantId: null,
    sensitivity: params.sensitivity ?? 'internal', compartments: params.compartments ?? [], projectIds: params.projectIds ?? [] }, 'mutation', access)

  // Consumed names and ordering fields are admitted before any comparison;
  // the candidate evaluator sees captured values in this exact transaction.
  if(params.mergeByName!==false) {
    const ap=buildAccessPredicate(access,{startIdx:3,operation:'mutation'})
    const member=buildCurrentMemberSourcePredicate(userId,{alias:'entities',startIdx:ap.nextIdx})
    await transaction.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['crm-company',params.workspaceId,params.name.toLowerCase()])])
    const existing=await queryLegacyCanonicalCrmSql<{id:string}>(access,[{type:'company',fields:['name','createdAt']}],
      `SELECT id FROM entities WHERE workspace_id=$1 AND kind='company' AND lower(display_name)=lower($2)
        AND valid_to IS NULL AND retracted_at IS NULL AND NOT scope_held AND ${ap.sql} AND ${member.sql}
        ORDER BY created_at ASC LIMIT 1`,[params.workspaceId,params.name,...ap.params,...member.params],transaction.client)
    if(existing.rows[0])return mergeCompanyFields(userId,existing.rows[0].id,{
      domain:params.domain??null,tags:params.tags,externalRef:params.externalRef,customFields:params.customFields,
    },{compartments:params.compartments??[],projectIds:params.projectIds??[],sensitivity:params.sensitivity??'internal'},access,transaction)
  }

  const custom=params.customFields===undefined?{values:undefined,references:[] as EntityRecord[]}:
    await initialCrmCustomValues(userId,params.workspaceId,'company',params.customFields,['name','tags',...(params.domain?['domain']:[]),
      ...(params.externalRef && Object.keys(params.externalRef).length?['externalRef']:[])],access,transaction!.client)
  const destination=crmReferenceScope({userId:null,assistantId:null,sensitivity:params.sensitivity??'internal',
    compartments:params.compartments,projectIds:params.projectIds},custom.references,undefined,true)
  const entity = await createEntity({
    kind: 'company',
    displayName: params.name,
    canonicalId: params.domain ?? null,
    attributes: companyAttributes({...params,customFields:custom.values}),
    sensitivity: destination.sensitivity,
    workspaceId: params.workspaceId,
    // Workspace-scoped: a company is a company-wide fact, not the property of
    // whoever happened to type it. Visibility must NOT copy authorship —
    // `createdByUserId` below carries who wrote it. See migration 423.
    userId: destination.userId,
    assistantId: destination.assistantId,
    createdByUserId: userId,
    createdByAssistantId: params.createdByAssistantId ?? null,
    source: params.source ?? 'user',
    sourceEpisodeId: params.sourceEpisodeId ?? null,
    sourceSessionId: params.sourceSessionId ?? null,
    explicitGeneral: params.explicitGeneral,
    compartments: destination.compartments,
    projectIds: destination.projectIds,
  }, transaction?.client)
  return companyFromEntity(entity)
}

async function mergeCompanyFields(
  userId: string,
  id: string,
  incoming: { domain?: string | null; tags?: string[]; externalRef?: CrmExternalRef; customFields?: Record<string,unknown> },
  scope: { compartments: string[]; projectIds: string[]; sensitivity?: Sensitivity },
  access: AccessContext,
  transaction: CrmWriteTransaction,
): Promise<CompanyRecord> {
  const point=await readLegacyCanonicalCrmPoint(access,'company',id,legacyCompanyFields,transaction.client)
  if(!point)throw new ApplicationPlatformError('access_unavailable','The company result is unavailable.')
  assertExecutionResourceScope(point.scope,'mutation',access)
  const cur=bindScopeSources({...legacyPointRecord(point),domain:z.string().nullable().parse(point.projection.values.domain),tags:legacyCrmTags.parse(point.projection.values.tags)},point.sources)
  const sensitivity=maxSensitivity(point.scope.sensitivity,scope.sensitivity??'public')
  const fields: CompanyUpdateFields = {}
  if (incoming.domain && incoming.domain !== cur.domain) fields.domain = incoming.domain
  if (incoming.tags && incoming.tags.length > 0) {
    const merged = Array.from(new Set([...cur.tags, ...incoming.tags]))
    if (merged.length !== cur.tags.length) fields.tags = merged
  }
  if (incoming.externalRef && Object.keys(incoming.externalRef).length > 0) {
    fields.externalRef = { ...cur.externalRef, ...incoming.externalRef }
  }
  if(incoming.customFields!==undefined) fields.customFields=incoming.customFields
  const scopeAdds = scope.compartments.some((value) => !cur.compartments?.includes(value))
    || scope.projectIds.some((value) => !cur.projectIds?.includes(value))
  if(Object.keys(fields).length===0&&!scopeAdds&&sensitivity===point.scope.sensitivity) {
    const current=await readLegacyCanonicalCrmPoint(access,'company',id,legacyCompanyFields,transaction.client)
    if(!current||current.projection.ref.version!==point.projection.ref.version)throw new ApplicationPlatformError('access_unavailable','The company source changed.')
    assertExecutionResourceScope(current.scope,'mutation',access)
    return bindScopeSources(cur,current.sources)
  }
  const result=await updateCompany(userId,id,fields,access,transaction.client,{...scope,sensitivity},{expectedVersion:point.projection.ref.version,afterCommit:transaction.afterCommit})
  if(!result)throw new ApplicationPlatformError('access_unavailable','The company result is unavailable.')
  return result
}

const legacyCompanyFields=['name','domain','aliases','tags','externalRef','createdAt','updatedAt'] as const
const legacyContactFields=['name','email','phone','companyId','aliases','tags','externalRef','createdAt','updatedAt'] as const
const legacyCrmTags=z.array(z.string()).nullable().transform(value=>value??[])
const legacyCrmCommon=z.object({name:z.string(),aliases:z.array(z.string()),externalRef:z.record(applicationJsonSchema).nullable().transform(value=>value??{}),
  createdAt:z.string().datetime(),updatedAt:z.string().datetime()})
function legacyPointRecord(point:NonNullable<Awaited<ReturnType<typeof readLegacyCanonicalCrmPoint>>>) {
  const values=legacyCrmCommon.parse(point.projection.values),{ref}=point.projection
  return {id:ref.id,entityId:ref.id,workspaceId:ref.workspaceId,name:values.name,aliases:values.aliases,externalRef:values.externalRef,
    createdAt:new Date(values.createdAt),updatedAt:new Date(values.updatedAt),sensitivity:point.scope.sensitivity,
    compartments:point.scope.compartments,projectIds:point.scope.projectIds}
}
export async function getCompanyById(ctx: AccessContext, id: string): Promise<CompanyRecord | null> {
  const point=await readLegacyCanonicalCrmPoint(ctx,'company',id,legacyCompanyFields)
  if(!point)return null
  const domain=z.string().nullable().parse(point.projection.values.domain)
  return bindScopeSources({...legacyPointRecord(point),domain,tags:legacyCrmTags.parse(point.projection.values.tags)},point.sources)
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

  const result = await queryLegacyCanonicalCrmSql<CompanyRow>(
    ctx,[{type:'company',fields:legacyCompanyFields}],
    `SELECT ${COMPANY_SELECT} FROM entities e
      WHERE ${wheres.join(' AND ')}
      ORDER BY e.updated_at DESC LIMIT $${idx}`,
    values,
  )
  return mapCanonicalCrmRows(result.rows,toCompanyRow)
}

/**
 * Update-by-id writes are access-scoped (the write-path half of the
 * "Upsert dedupe is access-scoped" rule — see `crm.md`): the target row
 * is read AND written under the caller's viewer projection when the tool
 * passes `access`; writers holding only a user id fall back to the
 * user-axis projection built from the row's own workspace, which still
 * refuses another principal's private row.
 */
const companyPatchStateSchema=z.object({workspaceId:z.string().uuid(),id:z.string().uuid(),version:z.string().regex(/^[1-9]\d*$/),scope:z.object({
  workspaceId:z.string().uuid(),userId:z.string().uuid().nullable(),assistantId:z.string().uuid().nullable(),sensitivity:z.enum(['public','internal','confidential']),
  compartments:z.array(z.string()),projectIds:z.array(z.string().uuid()),
}).passthrough()}).strict()
/** Metadata admission is shared by precise legacy editing and reference-only commands. */
export async function authorizeCanonicalCrmPatch(userId:string,type:CanonicalCrmType,id:string,fields:CanonicalCrmPatch,client:pg.PoolClient,access?:AccessContext) {
  validateCrmBusiness(canonicalCrmSchema(type),fields)
  const binding=getApplicationTransactionBinding(client),agent=currentAgentAccess()
  const workspace=access?.workspaceId??binding?.workspaceId??agent?.workspaceId
  const viewer=access??(workspace?dedupeAccessContext(userId,workspace):undefined)
  if(access&&access.userId!==userId||binding&&binding.actorUserId!==userId)throw new ApplicationPlatformError('access_unavailable','The actor is unavailable.')
  const bound=viewer?currentApplicationReadTransaction(viewer):undefined
  if(bound&&bound.client!==client)throw new ApplicationPlatformError('access_unavailable','The transaction is unavailable.')
  bound?.assertLive()
  if((await client.query<{actor:string}>("SELECT current_setting('app.current_user_id',true) AS actor")).rows[0]?.actor!==userId)throw new ApplicationPlatformError('access_unavailable','The actor is unavailable.')
  bound?.assertLive()
  const raw=(await client.query<{value:unknown}>('SELECT application_crm_patch_state($1,$2,$3) AS value',[type,id,crmMutationFieldIntent(fields)])).rows[0]?.value
  bound?.assertLive()
  if(raw==null)return null
  const state=companyPatchStateSchema.parse(raw),actor=dedupeAccessContext(userId,state.workspaceId,viewer)
  if(state.id!==id.toLowerCase()||actor.workspaceId!==state.workspaceId)throw new ApplicationPlatformError('access_unavailable','The source is unavailable.')
  assertExecutionResourceScope(state.scope,'mutation',actor)
  const ap=buildAccessPredicate(actor,{operation:'mutation',alias:'entry'})
  const scope={workspace_id:state.workspaceId,user_id:state.scope.userId,assistant_id:state.scope.assistantId,sensitivity:state.scope.sensitivity,
    compartments:state.scope.compartments,project_ids:state.scope.projectIds}
  const checked=await client.query<{admitted:boolean}>(`SELECT ${ap.sql} AS admitted FROM jsonb_to_recordset($${ap.nextIdx}::jsonb)
    AS entry(workspace_id uuid,user_id uuid,assistant_id uuid,sensitivity text,compartments text[],project_ids uuid[])`,[...ap.params,JSON.stringify([scope])])
  bound?.assertLive()
  if(checked.rows[0]?.admitted!==true)throw new ApplicationPlatformError('access_unavailable','The source is unavailable.')
  return state
}
/** One canonical CRM writer; no protected before/after DTO crosses this port. */
export async function patchCanonicalCrmFields(userId:string,type:CanonicalCrmType,id:string,fields:CanonicalCrmPatch,client:pg.PoolClient,access?:AccessContext,
  operation?:CrmMutationOptions,scope?:{compartments:string[];projectIds:string[];sensitivity?:Sensitivity}) {
  const before=await authorizeCanonicalCrmPatch(userId,type,id,fields,client,access)
  if(!before)return null
  let value:unknown
  try{value=(await client.query<{value:unknown}>('SELECT application_patch_canonical_crm($1,$2,$3,$4,$5) AS value',[type,id,{...fields,...('closeDate' in fields&&fields.closeDate instanceof Date?{closeDate:fields.closeDate.toISOString().slice(0,10)}:{})},operation?.expectedVersion??before.version,scope??null])).rows[0]?.value}
  catch(error){
    const code=(error as {code?:string}).code
    if(['40001','40P01','23505'].includes(code??''))throw new ApplicationPlatformError('record_version_conflict','The canonical source version changed.')
    if(['22023','23514','22P02'].includes(code??''))throw new ApplicationPlatformError('invalid_value','The canonical CRM values are invalid.')
    if(code==='42501')throw new ApplicationPlatformError('access_unavailable','The record is unavailable.')
    throw error
  }
  const ref=applicationResourceRefSchema.parse(value),after=await authorizeCanonicalCrmPatch(userId,type,id,fields,client,access)
  if(!after||ref.workspaceId!==after.workspaceId||ref.id!==id.toLowerCase()||ref.typeKey!==type||ref.origin.kind!=='native'||ref.origin.moduleKey!=='native'||ref.version!==after.version)throw new ApplicationPlatformError('access_unavailable','The source changed.')
  return ref
}
/** Backward-compatible company ports use the same canonical writer. */
export function authorizeCanonicalCompanyPatch(userId:string,id:string,fields:CompanyUpdateFields,client:pg.PoolClient,access?:AccessContext) {
  return authorizeCanonicalCrmPatch(userId,'company',id,fields,client,access)
}
export function patchCanonicalCompanyFields(userId:string,id:string,fields:CompanyUpdateFields,client:pg.PoolClient,access?:AccessContext,
 operation?:CrmMutationOptions,scope?:{compartments:string[];projectIds:string[];sensitivity?:Sensitivity}) {
 return patchCanonicalCrmFields(userId,'company',id,fields,client,access,operation,scope)
}
export async function updateCompany(
  userId:string,id:string,fields:CompanyUpdateFields,access?:AccessContext,transactionClient?:pg.PoolClient,
  scope?:{compartments:string[];projectIds:string[];sensitivity?:Sensitivity},operation?:CrmMutationOptions,
):Promise<CompanyRecord|null> {
  validateCrmBusiness(crmCompanyPatch,fields)
  const agent=currentAgentAccess(),viewer=access??(agent?.workspaceId?dedupeAccessContext(userId,agent.workspaceId):undefined)
  if(viewer)mutationActorAccess(userId,viewer.workspaceId,viewer)
  const bound=viewer?currentApplicationReadTransaction(viewer):undefined
  if(bound&&transactionClient&&bound.client!==transactionClient)throw new ApplicationPlatformError('access_unavailable','The transaction is unavailable.')
  if(!transactionClient&&bound)transactionClient=bound.client
  if(!transactionClient)return runCrmWriteTransaction(userId,tx=>updateCompany(userId,id,fields,access,tx.client,scope,{...operation,afterCommit:tx.afterCommit}))
  const before=await authorizeCanonicalCompanyPatch(userId,id,fields,transactionClient,access)
  if(!before)return null
  const actor=dedupeAccessContext(userId,before.workspaceId,access)
  // Full legacy DTO admission precedes effects; write-only commands use the ref port.
  if(!await readLegacyCanonicalCrmPoint(actor,'company',id,legacyCompanyFields,transactionClient))throw new ApplicationPlatformError('access_unavailable','The company result is unavailable.')
  const ref=await patchCanonicalCompanyFields(userId,id,fields,transactionClient,actor,operation,scope)
  if(!ref)return null
  const point=await readLegacyCanonicalCrmPoint(actor,'company',id,legacyCompanyFields,transactionClient)
  if(!point||point.projection.ref.version!==ref.version)throw new ApplicationPlatformError('access_unavailable','The source changed.')
  return bindScopeSources({...legacyPointRecord(point),domain:z.string().nullable().parse(point.projection.values.domain),tags:legacyCrmTags.parse(point.projection.values.tags)},point.sources)
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
  tags?: string[]; externalRef?: CrmExternalRef; customFields?: Record<string,unknown>
}): Record<string, unknown> {
  const a: Record<string, unknown> = { tags: p.tags ?? [] }
  if (p.email) a.email = p.email
  if (p.phone) a.phone = p.phone
  if (p.companyId) a.company_id = p.companyId
  if (p.externalRef && Object.keys(p.externalRef).length) a.external_ref = p.externalRef
  if(p.customFields!==undefined) a.custom_fields=p.customFields
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
    externalRef?: CrmExternalRef; customFields?: Record<string,unknown>
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
  validateCrmCreation(crmContactPatch.pick({name:true,email:true,phone:true,companyId:true,tags:true,externalRef:true,customFields:true}).required({name:true}),params,['stableIdentity'])
  assertAuthorshipPresent('createContact', userId)
  const access = dedupeAccessContext(userId, params.workspaceId, params.access)
  assertExecutionResourceScope({ workspaceId: params.workspaceId, userId: null, assistantId: null,
    sensitivity: params.sensitivity ?? 'internal', compartments: params.compartments ?? [], projectIds: params.projectIds ?? [] }, 'mutation', access)
  const bound=currentApplicationReadTransaction(access)
  if(bound&&transaction?.client!==bound.client)throw new ApplicationPlatformError('access_unavailable','The transaction is unavailable.')
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
      const visible = await Promise.all(resolution.entityIds.map(id => readLegacyCanonicalCrmPoint(access,'person',id,[],transaction.client)))
      if (visible.some(row => !row)) throw Object.assign(new Error('The identity cannot be used in the current scope.'), { code: 'scope_operation_denied' })
      throw new CrmPersonIdentityConflictError(resolution.entityIds)
    }
    if (resolution.status === 'resolved') {
      const merged = await mergeContactFields(userId, resolution.binding.entityId, {
        email: params.email ?? null,
        phone: params.phone ?? null,
        companyId: params.companyId ?? null,
        tags: params.tags,
        externalRef: params.externalRef,customFields:params.customFields,
      }, entityLinks, access, {
        compartments: params.compartments ?? [],
        projectIds: params.projectIds ?? [],
        sensitivity: params.sensitivity ?? 'internal',
      }, transaction)
      if (merged) return merged
      throw Object.assign(new Error('The identity cannot be used in the current scope.'), { code: 'scope_operation_denied' })
    }

  }

  const custom=await initialCrmCustomValues(userId,params.workspaceId,'person',params.customFields,
    ['name','tags',...(params.email?['email']:[]),...(params.phone?['phone']:[]),...(params.companyId?['companyId']:[]),
      ...(params.externalRef && Object.keys(params.externalRef).length?['externalRef']:[])],access,transaction.client)
  const customDestination=crmReferenceScope(destination,custom.references,undefined,true)
  params={...params,...customDestination}
  const entity = await createEntity({
    kind: 'person',
    displayName: params.name,
    canonicalId: params.email ?? null,
    attributes: contactAttributes({...params,customFields:custom.values}),
    sensitivity: customDestination.sensitivity,
    workspaceId: params.workspaceId,
    // Authorship does not determine visibility. Admitted relationship
    // sources can independently require a private destination.
    userId: customDestination.userId,
    assistantId: customDestination.assistantId,
    createdByUserId: userId,
    createdByAssistantId: params.createdByAssistantId ?? null,
    source: params.source ?? 'user',
    sourceEpisodeId: params.sourceEpisodeId ?? null,
    sourceSessionId: params.sourceSessionId ?? null,
    explicitGeneral: params.explicitGeneral,
    compartments: customDestination.compartments,
    projectIds: customDestination.projectIds,
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
    tags?: string[]; externalRef?: CrmExternalRef; customFields?: Record<string,unknown>
  },
  entityLinks: EntityLinksStore | undefined,
  access: AccessContext,
  scope: { compartments: string[]; projectIds: string[]; sensitivity?: Sensitivity },
  transaction: CrmWriteTransaction,
): Promise<ContactRecord> {
  const point=await readLegacyCanonicalCrmPoint(access,'person',id,legacyContactFields,transaction.client)
  if(!point)throw Object.assign(new Error('The identity cannot be used in the current scope.'),{code:'scope_operation_denied'})
  assertExecutionResourceScope(point.scope,'mutation',access)
  const cur=bindScopeSources({...legacyPointRecord(point),email:z.string().nullable().parse(point.projection.values.email),
    phone:z.string().nullable().parse(point.projection.values.phone),companyId:z.string().uuid().nullable().parse(point.projection.values.companyId),
    tags:legacyCrmTags.parse(point.projection.values.tags)},point.sources)
  const sensitivity=maxSensitivity(point.scope.sensitivity,scope.sensitivity??'public')
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
  if(incoming.customFields!==undefined) fields.customFields=incoming.customFields
  const scopeAdds = scope.compartments.some((value) => !cur.compartments?.includes(value))
    || scope.projectIds.some((value) => !cur.projectIds?.includes(value))
  if(Object.keys(fields).length===0&&!scopeAdds&&sensitivity===point.scope.sensitivity) {
    const current=await readLegacyCanonicalCrmPoint(access,'person',id,legacyContactFields,transaction.client)
    if(!current||current.projection.ref.version!==point.projection.ref.version)throw new ApplicationPlatformError('access_unavailable','The contact source changed.')
    assertExecutionResourceScope(current.scope,'mutation',access)
    return bindScopeSources(cur,current.sources)
  }
  const result=await updateContact(userId,id,fields,entityLinks,access,transaction.client,{...scope,sensitivity},transaction.afterCommit,{expectedVersion:point.projection.ref.version})
  if(!result)throw Object.assign(new Error('The identity cannot be used in the current scope.'),{code:'scope_operation_denied'})
  return result
}

export async function getContactById(ctx: AccessContext, id: string): Promise<ContactRecord | null> {
  const point=await readLegacyCanonicalCrmPoint(ctx,'person',id,legacyContactFields)
  if(!point)return null
  const values=z.object({email:z.string().nullable(),phone:z.string().nullable(),companyId:z.string().uuid().nullable()}).parse(point.projection.values)
  return bindScopeSources({...legacyPointRecord(point),...values,tags:legacyCrmTags.parse(point.projection.values.tags)},point.sources)
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

  const result = await queryLegacyCanonicalCrmSql<ContactRow>(
    ctx,[{type:'person',fields:[...legacyContactFields,'self']}],
    `SELECT ${CONTACT_SELECT} FROM entities e
      WHERE ${wheres.join(' AND ')}
      ORDER BY e.updated_at DESC LIMIT $${idx}`,
    values,
  )
  return mapCanonicalCrmRows(result.rows,toContactRow)
}

/** `access`: see `updateCompany` — write-path viewer projection. */
export async function updateContact(
 userId:string,id:string,fields:ContactUpdateFields,entityLinks?:EntityLinksStore,access?:AccessContext,
 transactionClient?:pg.PoolClient,scope?:{compartments:string[];projectIds:string[];sensitivity?:Sensitivity},
 afterCommit?:CrmWriteTransaction['afterCommit'],operation?:CrmMutationOptions,
):Promise<ContactRecord|null> {
 validateCrmBusiness(crmContactPatch,fields)
 if(!transactionClient)return runCrmWriteTransaction(userId,tx=>updateContact(userId,id,fields,entityLinks,access,tx.client,scope,tx.afterCommit,operation))
 const before=await authorizeCanonicalCrmPatch(userId,'person',id,fields,transactionClient,access)
 if(!before)return null
 const actor=dedupeAccessContext(userId,before.workspaceId,access)
 if(!await readLegacyCanonicalCrmPoint(actor,'person',id,legacyContactFields,transactionClient))throw new ApplicationPlatformError('access_unavailable','The contact result is unavailable.')
 const ref=await patchCanonicalCrmFields(userId,'person',id,fields,transactionClient,actor,operation,scope)
 if(!ref)return null
 const point=await readLegacyCanonicalCrmPoint(actor,'person',id,legacyContactFields,transactionClient)
 if(!point||point.projection.ref.version!==ref.version)throw new ApplicationPlatformError('access_unavailable','The source changed.')
 const record=bindScopeSources({...legacyPointRecord(point),email:z.string().nullable().parse(point.projection.values.email),
  phone:z.string().nullable().parse(point.projection.values.phone),companyId:z.string().uuid().nullable().parse(point.projection.values.companyId),
  tags:legacyCrmTags.parse(point.projection.values.tags)},point.sources)
 if(fields.companyId!==undefined){const effect=()=>repointGraphEdge(entityLinks,userId,{sourceEntityId:id,targetEntityId:fields.companyId??null,
  edgeType:'works_at',workspaceId:before.workspaceId,compartments:record.compartments,projectIds:record.projectIds})
  if(afterCommit)afterCommit(effect);else effect()}
 return record
}

// ── Deals ────────────────────────────────────────────────────────────

type DealRow = Omit<DealRecord, 'amount' | 'externalRef'> & {
  amount: string | number | null; amountText?: string | null; externalRef: CrmExternalRef | null
}
const DEAL_SELECT = `
  e.id, e.id AS "entityId", e.workspace_id AS "workspaceId",
  e.display_name AS name, e.aliases,
  e.attributes->>'contact_id' AS "contactId",
  e.attributes->>'company_id' AS "companyId",
  COALESCE(e.attributes->>'stage', 'lead') AS stage,
  e.attributes->'amount' AS amount,
  e.attributes->>'amount' AS "amountText",
  (e.attributes->>'close_date')::date AS "closeDate",
  e.attributes->'external_ref' AS "externalRef",
  e.sensitivity, e.compartments, e.project_ids AS "projectIds",
  e.created_at AS "createdAt", e.updated_at AS "updatedAt"`

function toDealRow(row: DealRow): DealRecord {
  const {amountText,...record}=row
  return {
    ...record,
    aliases: row.aliases ?? [],
    amount: decodeCrmAmount(row.amount,amountText),
    externalRef: row.externalRef ?? {},
  }
}

function dealAttributes(p: {
  contactId?: string | null; companyId?: string | null
  stage?: DealStage; amount?: CrmAmount | null; closeDate?: Date | null; externalRef?: CrmExternalRef; customFields?: Record<string,unknown>
}): Record<string, unknown> {
  const a: Record<string, unknown> = { stage: p.stage ?? 'lead' }
  if (p.contactId) a.contact_id = p.contactId
  if (p.companyId) a.company_id = p.companyId
  if (p.amount != null) a.amount = p.amount
  if (p.closeDate) a.close_date = p.closeDate.toISOString().slice(0, 10)
  if (p.externalRef && Object.keys(p.externalRef).length) a.external_ref = p.externalRef
  if(p.customFields!==undefined) a.custom_fields=p.customFields
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
    amount?: CrmAmount | null
    closeDate?: Date | null
    externalRef?: CrmExternalRef; customFields?: Record<string,unknown>
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
  assertValidStage(params.stage)
  assertNonNegativeAmount(params.amount)
  validateCrmCreation(crmDealPatch.pick({contactId:true,companyId:true,stage:true,amount:true,closeDate:true,externalRef:true,customFields:true}),params)
  assertAuthorshipPresent('createDeal', userId)
  const access = mutationActorAccess(userId, params.workspaceId, params.access)
  if (!transaction) return runCrmWriteTransaction(userId, tx => createDeal(userId, params, entityLinks, tx))
  const contact = await readCrmReference(userId, params.workspaceId, params.contactId, 'person', access, transaction?.client)
  const company = await readCrmReference(userId, params.workspaceId, params.companyId, 'company', access, transaction?.client)
  const custom=await initialCrmCustomValues(userId,params.workspaceId,'deal',params.customFields,
    ['name','stage',...(params.contactId?['contactId']:[]),...(params.companyId?['companyId']:[]),...(params.amount!=null?['amount']:[]),
      ...(params.closeDate?['closeDate']:[]),...(params.externalRef && Object.keys(params.externalRef).length?['externalRef']:[])],access,transaction.client)
  const destination = crmReferenceScope({ userId: null, assistantId: null,
    sensitivity: params.sensitivity ?? 'internal', compartments: params.compartments, projectIds: params.projectIds }, [contact, company,...custom.references], undefined, true)
  params = { ...params, ...destination }
  assertExecutionResourceScope({ workspaceId: params.workspaceId, userId: destination.userId, assistantId: destination.assistantId,
    sensitivity: params.sensitivity!, compartments: params.compartments!, projectIds: params.projectIds! }, 'mutation', access)
  const displayName = company ? `Deal - ${company.displayName}` : 'Deal'

  const entity = await createEntity({
    kind: 'deal',
    displayName,
    attributes: dealAttributes({...params,customFields:custom.values}),
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

const legacyDealFields = ['name','aliases','contactId','companyId','stage','amount','closeDate','externalRef','createdAt','updatedAt'] as const
export async function getDealById(ctx: AccessContext, id: string): Promise<DealRecord | null> {
  const point = await readLegacyCanonicalCrmPoint(ctx, 'deal', id, legacyDealFields)
  if (!point) return null
  return dealFromLegacyPoint(point)
}
function dealFromLegacyPoint(point:NonNullable<Awaited<ReturnType<typeof readLegacyCanonicalCrmPoint>>>):DealRecord {
  const values = z.object({contactId:z.string().uuid().nullable(),companyId:z.string().uuid().nullable(),
    stage:z.enum(DEAL_STAGES).nullable(),amount:z.string().nullable(),closeDate:z.string().nullable()}).parse(point.projection.values)
  const encoding = canonicalNativeAmountEncoding(point.projection)
  if ((values.amount === null) !== (encoding === 'null')) {
    throw new ApplicationPlatformError('access_unavailable', 'The source changed.')
  }
  const amount = values.amount === null ? null : encoding === 'number'
    ? decodeCrmAmount(Number(values.amount), values.amount) : crmAmountSchema.parse(values.amount)
  if (values.closeDate !== null && (values.closeDate.length !== 10 || !validApplicationDate(values.closeDate))) {
    throw new ApplicationPlatformError('invalid_value', 'The canonical close date requires review.')
  }
  return bindScopeSources({...legacyPointRecord(point),contactId:values.contactId,companyId:values.companyId,
    stage:values.stage ?? 'lead',amount,closeDate:values.closeDate === null ? null : new Date(values.closeDate)},point.sources)
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

  const result = await queryLegacyCanonicalCrmSql<DealRow>(
    ctx,[{type:'deal',fields:legacyDealFields}],
    `SELECT ${DEAL_SELECT} FROM entities e
      WHERE ${wheres.join(' AND ')}
      ORDER BY e.updated_at DESC LIMIT $${idx}`,
    values,
  )
  return mapCanonicalCrmRows(result.rows,toDealRow)
}

/** `access`: see `updateCompany` — write-path viewer projection. */
export async function updateDeal(
 userId:string,id:string,fields:DealUpdateFields,entityLinks?:EntityLinksStore,access?:AccessContext,
 transactionClient?:pg.PoolClient,scope?:{compartments:string[];projectIds:string[];sensitivity?:Sensitivity},operation?:CrmMutationOptions,
):Promise<DealRecord|null> {
 assertNonNegativeAmount(fields.amount);validateCrmBusiness(crmDealPatch.omit({stage:true}),fields)
 if(!transactionClient)return runCrmWriteTransaction(userId,tx=>updateDeal(userId,id,fields,entityLinks,access,tx.client,scope,{...operation,afterCommit:tx.afterCommit}))
 const before=await authorizeCanonicalCrmPatch(userId,'deal',id,fields,transactionClient,access)
 if(!before)return null
 const actor=dedupeAccessContext(userId,before.workspaceId,access)
 if(!await readLegacyCanonicalCrmPoint(actor,'deal',id,legacyDealFields,transactionClient))throw new ApplicationPlatformError('access_unavailable','The deal result is unavailable.')
 const ref=await patchCanonicalCrmFields(userId,'deal',id,fields,transactionClient,actor,operation,scope)
 if(!ref)return null
 const point=await readLegacyCanonicalCrmPoint(actor,'deal',id,legacyDealFields,transactionClient)
 if(!point||point.projection.ref.version!==ref.version)throw new ApplicationPlatformError('access_unavailable','The source changed.')
 const record=dealFromLegacyPoint(point)
 const effect=()=>{
  if(fields.companyId!==undefined)repointGraphEdge(entityLinks,userId,{sourceEntityId:id,targetEntityId:fields.companyId??null,
   edgeType:'engagement_of',workspaceId:before.workspaceId,compartments:record.compartments,projectIds:record.projectIds})
  if(entityLinks&&fields.contactId)void emitEdgeFireAndForget(entityLinks,userId,{sourceKind:'entity',sourceId:fields.contactId,targetKind:'entity',targetId:id,
   edgeType:'represents',workspaceId:before.workspaceId,source:'user',userId,compartments:record.compartments,projectIds:record.projectIds})
 }
 if(operation?.afterCommit)operation.afterCommit(effect);else effect()
 return record
}

/** Legacy stage changes compose the same canonical typed deal command. */
export async function setDealStage(userId:string,id:string,stage:DealStage,access?:AccessContext,transactionClient?:pg.PoolClient,
 scope?:{compartments:string[];projectIds:string[];sensitivity?:Sensitivity},operation?:CrmMutationOptions):Promise<DealRecord|null> {
 assertValidStage(stage)
 if(stage===undefined)throw new ApplicationPlatformError('invalid_value','A canonical deal stage is required.')
 if(!transactionClient)return runCrmWriteTransaction(userId,tx=>setDealStage(userId,id,stage,access,tx.client,scope,operation))
 const before=await authorizeCanonicalCrmPatch(userId,'deal',id,{stage},transactionClient,access)
 if(!before)return null
 const actor=dedupeAccessContext(userId,before.workspaceId,access)
 if(!await readLegacyCanonicalCrmPoint(actor,'deal',id,legacyDealFields,transactionClient))throw new ApplicationPlatformError('access_unavailable','The deal result is unavailable.')
 const ref=await patchCanonicalCrmFields(userId,'deal',id,{stage},transactionClient,actor,operation,scope)
 if(!ref)return null
 const point=await readLegacyCanonicalCrmPoint(actor,'deal',id,legacyDealFields,transactionClient)
 if(!point||point.projection.ref.version!==ref.version)throw new ApplicationPlatformError('access_unavailable','The source changed.')
 return dealFromLegacyPoint(point)
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
  const parsed=z.array(z.object({entity:z.enum(['company','contact','deal']),ids:z.array(z.string().uuid()).max(100)}).strict()).max(100).safeParse(requests)
  if(!parsed.success)throw new ApplicationPlatformError('invalid_value','The declared label batch is invalid.')
  const groups=new Map<'company'|'contact'|'deal',Set<string>>()
  for(const request of parsed.data){const ids=groups.get(request.entity)??new Set<string>();for(const id of request.ids)ids.add(id);groups.set(request.entity,ids)}
  if([...groups.values()].reduce((count,ids)=>count+ids.size,0)>100)throw new ApplicationPlatformError('invalid_value','The batch is too large.')
  const out=new Map<string,string>(),entries=[...groups].filter(([,ids])=>ids.size)
  if(!entries.length)return out
  const results=await queryLegacyCanonicalCrmBatch(ctx,entries.map(([entity,ids])=>({type:entity==='contact'?'person':entity,
    input:{fields:entity==='deal'?[]:['name'],filters:[],sort:[],aggregate:[],limit:100},ids:[...ids]})))
  for(const [index,[entity]]of entries.entries())for(const row of results[index].records) {
    out.set(`${entity}:${row.ref.id}`,entity==='deal'?`Deal #${row.ref.id.slice(0,8)}`:z.string().parse(row.values.name))
  }
  return bindScopeSources(out,boundScopeSources(results))
}
