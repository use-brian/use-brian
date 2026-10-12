/**
 * PostgreSQL storage for seller profiles, customer accounts, accepted
 * commercial profile versions and operation versions, plus the
 * permission-scoped read store. Every commercial child record carries its own
 * scope envelope; reads apply it through the canonical access predicate, so a
 * parent's visibility never discloses a stricter account, profile or term.
 * Spec: docs/architecture/features/crm-commercial-operations.md -> Commercial context
 *
 * [COMP:crm/commercial-context]
 */

import type { PoolClient, QueryResultRow } from 'pg'
import {
  CrmCommercialFieldsSchema,
  CrmFieldBindingSchema,
  CrmOperationsError,
  resolveCrmCommercialFields,
  CrmOverrideNotPermittedError,
  type AccessContext,
  type CrmCommercialContextReadPort,
  type CrmCommercialFields,
  type CrmCommercialProfileSnapshot,
  type CrmCommercialViewer,
  type CrmFieldBinding,
} from '@use-brian/core'
import { z } from 'zod'
import { query } from './client.js'
import { buildAccessPredicate, buildCurrentMemberSourcePredicate, mutationActorAccess } from './access-predicate.js'
import { queryCrmPage } from '../crm-operations/pagination.js'

type Row = QueryResultRow & Record<string, unknown>
type Run = <T extends QueryResultRow>(sql: string, values: unknown[]) => Promise<{ rows: T[] }>
type Actor = { kind: string; id: string; userId: string | null }

export type CrmScopeEnvelope = { sensitivity: 'public' | 'internal' | 'confidential'; compartments: string[]; projectIds: string[] }

/** Visibility of a scoped commercial row (alias) for an acting user, including agent and bound-credential ceilings. */
export function commercialVisibility(userId: string, workspaceId: string, alias: string, startIdx: number, operation: 'read' | 'mutation' = 'read', access?: AccessContext) {
  const actor = mutationActorAccess(userId, workspaceId, access)
  const ap = buildAccessPredicate(actor, { alias, startIdx, operation })
  const member = buildCurrentMemberSourcePredicate(userId, { alias, startIdx: ap.nextIdx, operation })
  return { sql: `${ap.sql} AND ${member.sql}`, params: [...ap.params, ...member.params], nextIdx: member.nextIdx }
}

function entityVisibility(userId: string, workspaceId: string, alias: string, startIdx: number) {
  const scope = commercialVisibility(userId, workspaceId, alias, startIdx)
  return { ...scope, sql: `${alias}.valid_to IS NULL AND ${alias}.retracted_at IS NULL AND NOT ${alias}.scope_held AND ${scope.sql}` }
}

export type CrmSellerRow = CrmScopeEnvelope & {
  id: string; sellerKey: string; legalName: string; displayName: string; companyId: string | null
  timezone: string; status: 'active' | 'archived'; version: number; createdAt: string; updatedAt: string
}
export type CrmAccountRow = CrmScopeEnvelope & {
  id: string; sellerId: string; sellerKey: string; companyId: string; label: string; billingContactId: string | null
  billingAddress: string | null; status: 'active' | 'archived'; version: number; createdAt: string; updatedAt: string
}

const SELLER_COLUMNS = `s.id,s.seller_key AS "sellerKey",s.legal_name AS "legalName",s.display_name AS "displayName",
  s.company_id AS "companyId",s.timezone,s.status,s.sensitivity,s.compartments,s.project_ids AS "projectIds",s.version,
  s.created_at AS "createdAt",s.updated_at AS "updatedAt"`
const ACCOUNT_COLUMNS = `a.id,a.seller_id AS "sellerId",s.seller_key AS "sellerKey",a.company_id AS "companyId",a.label,
  a.billing_contact_id AS "billingContactId",a.billing_address AS "billingAddress",a.status,a.sensitivity,a.compartments,
  a.project_ids AS "projectIds",a.version,a.created_at AS "createdAt",a.updated_at AS "updatedAt"`

const iso = (value: unknown) => new Date(value as string).toISOString()
const sellerRow = (row: Row): CrmSellerRow => ({ ...(row as unknown as CrmSellerRow), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) })
const accountRow = (row: Row): CrmAccountRow => ({ ...(row as unknown as CrmAccountRow), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) })

export async function lockSellerByKey(client: PoolClient, workspaceId: string, sellerKey: string, access: AccessContext, mode: 'share' | 'update' = 'share'): Promise<CrmSellerRow | null> {
  const scope = commercialVisibility(access.userId, workspaceId, 's', 3, mode === 'update' ? 'mutation' : 'read', access)
  const result = await client.query<Row>(`SELECT ${SELLER_COLUMNS} FROM crm_seller_profiles s
    WHERE s.workspace_id=$1 AND s.seller_key=$2 AND ${scope.sql} FOR ${mode === 'share' ? 'SHARE' : 'UPDATE'} OF s`,
  [workspaceId, sellerKey, ...scope.params])
  return result.rows[0] ? sellerRow(result.rows[0]) : null
}

export async function sellerKeyTaken(client: PoolClient, workspaceId: string, sellerKey: string): Promise<boolean> {
  return Boolean((await client.query('SELECT 1 FROM crm_seller_profiles WHERE workspace_id=$1 AND seller_key=$2', [workspaceId, sellerKey])).rowCount)
}

export async function lockSellerById(client: PoolClient, workspaceId: string, sellerId: string, access: AccessContext): Promise<CrmSellerRow | null> {
  const scope = commercialVisibility(access.userId, workspaceId, 's', 3, 'mutation', access)
  const result = await client.query<Row>(`SELECT ${SELLER_COLUMNS} FROM crm_seller_profiles s
    WHERE s.workspace_id=$1 AND s.id=$2 AND ${scope.sql} FOR UPDATE OF s`, [workspaceId, sellerId, ...scope.params])
  return result.rows[0] ? sellerRow(result.rows[0]) : null
}

export async function insertSeller(client: PoolClient, workspaceId: string, seller: { sellerKey: string; legalName: string; displayName: string; companyId: string | null; timezone: string; status: string },
  envelope: CrmScopeEnvelope, actor: Actor): Promise<string> {
  return (await client.query<{ id: string }>(`INSERT INTO crm_seller_profiles(workspace_id,seller_key,legal_name,display_name,company_id,timezone,status,
      sensitivity,compartments,project_ids,created_by_kind,created_by_id,created_by_user_id,updated_by_kind,updated_by_id,updated_by_user_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$11,$12,$13) RETURNING id`,
  [workspaceId, seller.sellerKey, seller.legalName, seller.displayName, seller.companyId, seller.timezone, seller.status,
    envelope.sensitivity, envelope.compartments, envelope.projectIds, actor.kind, actor.id, actor.userId])).rows[0]!.id
}

export async function updateSeller(client: PoolClient, workspaceId: string, sellerId: string, seller: { legalName: string; displayName: string; companyId: string | null; timezone: string; status: string },
  envelope: CrmScopeEnvelope, actor: Actor): Promise<void> {
  await client.query(`UPDATE crm_seller_profiles SET legal_name=$3,display_name=$4,company_id=$5,timezone=$6,status=$7,
      sensitivity=$8,compartments=$9,project_ids=$10,version=version+1,updated_by_kind=$11,updated_by_id=$12,updated_by_user_id=$13,updated_at=now()
    WHERE workspace_id=$1 AND id=$2`, [workspaceId, sellerId, seller.legalName, seller.displayName, seller.companyId, seller.timezone,
    seller.status, envelope.sensitivity, envelope.compartments, envelope.projectIds, actor.kind, actor.id, actor.userId])
}

export async function readSellerById(client: PoolClient, workspaceId: string, sellerId: string): Promise<CrmSellerRow | null> {
  const result = await client.query<Row>(`SELECT ${SELLER_COLUMNS} FROM crm_seller_profiles s WHERE s.workspace_id=$1 AND s.id=$2`, [workspaceId, sellerId])
  return result.rows[0] ? sellerRow(result.rows[0]) : null
}

export async function lockAccount(client: PoolClient, workspaceId: string, accountId: string, access: AccessContext, operation: 'read' | 'mutation' = 'mutation'): Promise<CrmAccountRow | null> {
  const scope = commercialVisibility(access.userId, workspaceId, 'a', 3, operation, access)
  const result = await client.query<Row>(`SELECT ${ACCOUNT_COLUMNS} FROM crm_customer_accounts a
      JOIN crm_seller_profiles s ON s.workspace_id=a.workspace_id AND s.id=a.seller_id
    WHERE a.workspace_id=$1 AND a.id=$2 AND ${scope.sql} FOR ${operation === 'mutation' ? 'UPDATE' : 'SHARE'} OF a`,
  [workspaceId, accountId, ...scope.params])
  return result.rows[0] ? accountRow(result.rows[0]) : null
}

export async function insertAccount(client: PoolClient, workspaceId: string, account: { sellerId: string; companyId: string; label: string; billingContactId: string | null; billingAddress: string | null; status: string },
  envelope: CrmScopeEnvelope, actor: Actor): Promise<string> {
  return (await client.query<{ id: string }>(`INSERT INTO crm_customer_accounts(workspace_id,seller_id,company_id,label,billing_contact_id,billing_address,status,
      sensitivity,compartments,project_ids,created_by_kind,created_by_id,created_by_user_id,updated_by_kind,updated_by_id,updated_by_user_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$11,$12,$13) RETURNING id`,
  [workspaceId, account.sellerId, account.companyId, account.label, account.billingContactId, account.billingAddress, account.status,
    envelope.sensitivity, envelope.compartments, envelope.projectIds, actor.kind, actor.id, actor.userId])).rows[0]!.id
}

export async function updateAccount(client: PoolClient, workspaceId: string, accountId: string, account: { label: string; billingContactId: string | null; billingAddress: string | null; status: string },
  envelope: CrmScopeEnvelope, actor: Actor): Promise<void> {
  await client.query(`UPDATE crm_customer_accounts SET label=$3,billing_contact_id=$4,billing_address=$5,status=$6,sensitivity=$7,compartments=$8,
      project_ids=$9,version=version+1,updated_by_kind=$10,updated_by_id=$11,updated_by_user_id=$12,updated_at=now() WHERE workspace_id=$1 AND id=$2`,
  [workspaceId, accountId, account.label, account.billingContactId, account.billingAddress, account.status, envelope.sensitivity,
    envelope.compartments, envelope.projectIds, actor.kind, actor.id, actor.userId])
}

export async function readAccountById(client: PoolClient, workspaceId: string, accountId: string): Promise<CrmAccountRow | null> {
  const result = await client.query<Row>(`SELECT ${ACCOUNT_COLUMNS} FROM crm_customer_accounts a
    JOIN crm_seller_profiles s ON s.workspace_id=a.workspace_id AND s.id=a.seller_id WHERE a.workspace_id=$1 AND a.id=$2`, [workspaceId, accountId])
  return result.rows[0] ? accountRow(result.rows[0]) : null
}

export type CrmProfileRow = CrmScopeEnvelope & {
  id: string; ownerKind: 'seller' | 'account' | 'agreement'; sellerId: string | null; accountId: string | null
  agreementKey: string | null; ownerKey: string; dealIds: string[]; version: number; status: 'accepted' | 'superseded'
  fields: CrmCommercialFields; effectiveFrom: string | null; effectiveTo: string | null; evidence: Record<string, unknown>; createdAt: string
}
const PROFILE_COLUMNS = `p.id,p.owner_kind AS "ownerKind",p.seller_id AS "sellerId",p.account_id AS "accountId",p.agreement_key AS "agreementKey",
  p.owner_key AS "ownerKey",p.deal_ids AS "dealIds",p.version,p.status,p.fields,to_char(p.effective_from,'YYYY-MM-DD') AS "effectiveFrom",
  to_char(p.effective_to,'YYYY-MM-DD') AS "effectiveTo",p.evidence,p.sensitivity,p.compartments,p.project_ids AS "projectIds",p.created_at AS "createdAt"`
const profileRow = (row: Row): CrmProfileRow => ({ ...(row as unknown as CrmProfileRow), createdAt: iso(row.createdAt) })

export function profileOwnerKey(owner: { kind: 'seller'; sellerId: string } | { kind: 'account'; accountId: string } | { kind: 'agreement'; accountId: string; agreementKey: string }): string {
  return owner.kind === 'seller' ? `seller:${owner.sellerId}` : owner.kind === 'account' ? `account:${owner.accountId}` : `agreement:${owner.accountId}:${owner.agreementKey}`
}

export async function lockCurrentProfile(client: PoolClient, workspaceId: string, ownerKey: string): Promise<CrmProfileRow | null> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`crm-commercial-profile:${workspaceId}:${ownerKey}`])
  const result = await client.query<Row>(`SELECT ${PROFILE_COLUMNS} FROM crm_commercial_profile_versions p
    WHERE p.workspace_id=$1 AND p.owner_key=$2 AND p.status='accepted' FOR UPDATE OF p`, [workspaceId, ownerKey])
  return result.rows[0] ? profileRow(result.rows[0]) : null
}

export async function acceptProfile(client: PoolClient, workspaceId: string, params: {
  ownerKind: 'seller' | 'account' | 'agreement'; sellerId: string | null; accountId: string | null; agreementKey: string | null; ownerKey: string
  dealIds: string[]; version: number; fields: CrmCommercialFields; effectiveFrom: string | null; effectiveTo: string | null
  evidence: Record<string, unknown>; envelope: CrmScopeEnvelope; operationId: string; actor: Actor; previousId: string | null
}): Promise<CrmProfileRow> {
  if (params.previousId) {
    await client.query(`UPDATE crm_commercial_profile_versions SET status='superseded',superseded_at=now() WHERE workspace_id=$1 AND id=$2`, [workspaceId, params.previousId])
  }
  const inserted = await client.query<{ id: string }>(`INSERT INTO crm_commercial_profile_versions(workspace_id,owner_kind,seller_id,account_id,agreement_key,owner_key,deal_ids,
      version,fields,effective_from,effective_to,evidence,sensitivity,compartments,project_ids,operation_id,accepted_by_kind,accepted_by_id,accepted_by_user_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::date,$11::date,$12::jsonb,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
  [workspaceId, params.ownerKind, params.sellerId, params.accountId, params.agreementKey, params.ownerKey, params.dealIds, params.version,
    JSON.stringify(params.fields), params.effectiveFrom, params.effectiveTo, JSON.stringify(params.evidence), params.envelope.sensitivity,
    params.envelope.compartments, params.envelope.projectIds, params.operationId, params.actor.kind, params.actor.id, params.actor.userId])
  const row = await client.query<Row>(`SELECT ${PROFILE_COLUMNS} FROM crm_commercial_profile_versions p WHERE p.workspace_id=$1 AND p.id=$2`, [workspaceId, inserted.rows[0]!.id])
  return profileRow(row.rows[0]!)
}

export type CrmOperationDefinitionRow = {
  id: string; operationKey: string; operationKind: 'invoice' | 'proposal'; label: string; currentVersionId: string | null
  status: 'active' | 'archived'; version: number
}
export type CrmOperationVersionRow = {
  id: string; definitionId: string; versionNumber: number; state: 'proposed' | 'accepted' | 'superseded' | 'withdrawn'
  instructions: string; instructionSource: { pageId: string; revision: string } | null; fieldBindings: CrmFieldBinding[]
  templateBinding: { templateId: string; templateVersionId?: string; pdfPreset: 'invoice' | 'worksheet' } | null
  reviewPolicy: 'direct' | 'exact_version_review'; referenceDefinitionKey: string | null; configHash: string
  proposedByKind: string; proposedByUserId: string | null; acceptedByKind: string | null; acceptedByUserId: string | null
  acceptedAt: string | null; createdAt: string
}
const DEFINITION_COLUMNS = `d.id,d.operation_key AS "operationKey",d.operation_kind AS "operationKind",d.label,d.current_version_id AS "currentVersionId",d.status,d.version`
const VERSION_COLUMNS = `v.id,v.definition_id AS "definitionId",v.version_number AS "versionNumber",v.state,v.instructions,v.instruction_source AS "instructionSource",
  v.field_bindings AS "fieldBindings",v.template_binding AS "templateBinding",v.review_policy AS "reviewPolicy",v.reference_definition_key AS "referenceDefinitionKey",
  v.config_hash AS "configHash",v.proposed_by_kind AS "proposedByKind",v.proposed_by_user_id AS "proposedByUserId",v.accepted_by_kind AS "acceptedByKind",
  v.accepted_by_user_id AS "acceptedByUserId",v.accepted_at AS "acceptedAt",v.created_at AS "createdAt"`
const versionRow = (row: Row): CrmOperationVersionRow => ({
  ...(row as unknown as CrmOperationVersionRow),
  fieldBindings: z.array(CrmFieldBindingSchema).parse(row.fieldBindings),
  acceptedAt: row.acceptedAt ? iso(row.acceptedAt) : null, createdAt: iso(row.createdAt),
})

export async function lockOperationDefinition(client: PoolClient, workspaceId: string, operationKey: string, mode: 'share' | 'update' = 'update'): Promise<CrmOperationDefinitionRow | null> {
  const result = await client.query<CrmOperationDefinitionRow>(`SELECT ${DEFINITION_COLUMNS} FROM crm_operation_definitions d
    WHERE d.workspace_id=$1 AND d.operation_key=$2 FOR ${mode === 'share' ? 'SHARE' : 'UPDATE'}`, [workspaceId, operationKey])
  return result.rows[0] ?? null
}

export async function insertOperationDefinition(client: PoolClient, workspaceId: string, def: { operationKey: string; operationKind: string; label: string }, actor: Actor): Promise<CrmOperationDefinitionRow> {
  const result = await client.query<CrmOperationDefinitionRow>(`INSERT INTO crm_operation_definitions(workspace_id,operation_key,operation_kind,label,
      created_by_kind,created_by_id,created_by_user_id,updated_by_kind,updated_by_id,updated_by_user_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$5,$6,$7) RETURNING id,operation_key AS "operationKey",operation_kind AS "operationKind",label,
      current_version_id AS "currentVersionId",status,version`, [workspaceId, def.operationKey, def.operationKind, def.label, actor.kind, actor.id, actor.userId])
  return result.rows[0]!
}

export async function bumpOperationDefinition(client: PoolClient, workspaceId: string, id: string, patch: { label?: string; currentVersionId?: string }, actor: Actor): Promise<number> {
  const result = await client.query<{ version: number }>(`UPDATE crm_operation_definitions SET label=coalesce($3,label),
      current_version_id=coalesce($4::uuid,current_version_id),version=version+1,updated_by_kind=$5,updated_by_id=$6,updated_by_user_id=$7,updated_at=now()
    WHERE workspace_id=$1 AND id=$2 RETURNING version`, [workspaceId, id, patch.label ?? null, patch.currentVersionId ?? null, actor.kind, actor.id, actor.userId])
  return result.rows[0]!.version
}

export async function insertOperationVersion(client: PoolClient, workspaceId: string, definitionId: string, params: {
  instructions: string; instructionSource: unknown; fieldBindings: CrmFieldBinding[]; templateBinding: unknown; reviewPolicy: string
  referenceDefinitionKey: string | null; configHash: string; operationId: string; actor: Actor
}): Promise<CrmOperationVersionRow> {
  const result = await client.query<Row>(`INSERT INTO crm_operation_versions(workspace_id,definition_id,version_number,instructions,instruction_source,field_bindings,
      template_binding,review_policy,reference_definition_key,config_hash,operation_id,proposed_by_kind,proposed_by_id,proposed_by_user_id)
    SELECT $1,$2,coalesce(max(version_number),0)+1,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,$13
      FROM crm_operation_versions WHERE workspace_id=$1 AND definition_id=$2
    RETURNING id`, [workspaceId, definitionId, params.instructions, params.instructionSource ? JSON.stringify(params.instructionSource) : null,
    JSON.stringify(params.fieldBindings), params.templateBinding ? JSON.stringify(params.templateBinding) : null, params.reviewPolicy,
    params.referenceDefinitionKey, params.configHash, params.operationId, params.actor.kind, params.actor.id, params.actor.userId])
  return (await readOperationVersion(client, workspaceId, result.rows[0]!.id as string, true))!
}

export async function readOperationVersion(client: PoolClient | { query: Run }, workspaceId: string, versionId: string, lock = false): Promise<CrmOperationVersionRow | null> {
  const result = await (client as { query: Run }).query<Row>(`SELECT ${VERSION_COLUMNS} FROM crm_operation_versions v WHERE v.workspace_id=$1 AND v.id=$2${lock ? ' FOR UPDATE' : ''}`, [workspaceId, versionId])
  return result.rows[0] ? versionRow(result.rows[0]) : null
}

export async function acceptOperationVersion(client: PoolClient, workspaceId: string, definitionId: string, versionId: string, actor: Actor): Promise<void> {
  await client.query(`UPDATE crm_operation_versions SET state='superseded' WHERE workspace_id=$1 AND definition_id=$2 AND state='accepted'`, [workspaceId, definitionId])
  await client.query(`UPDATE crm_operation_versions SET state='accepted',accepted_by_kind=$4,accepted_by_id=$5,accepted_by_user_id=$6,accepted_at=now()
    WHERE workspace_id=$1 AND definition_id=$2 AND id=$3`, [workspaceId, definitionId, versionId, actor.kind, actor.id, actor.userId])
}

/** The accepted operation version, read for preparation and resolution. */
export async function readAcceptedOperation(run: { query: Run } | PoolClient, workspaceId: string, operationKey: string): Promise<{ definition: CrmOperationDefinitionRow; version: CrmOperationVersionRow } | null> {
  const db = run as { query: Run }
  const definition = (await db.query<CrmOperationDefinitionRow>(`SELECT ${DEFINITION_COLUMNS} FROM crm_operation_definitions d
    WHERE d.workspace_id=$1 AND d.operation_key=$2 AND d.status='active'`, [workspaceId, operationKey])).rows[0]
  if (!definition?.currentVersionId) return null
  const version = await readOperationVersion(db, workspaceId, definition.currentVersionId)
  return version && version.state === 'accepted' ? { definition, version } : null
}

function snapshot(row: CrmProfileRow): CrmCommercialProfileSnapshot {
  return {
    id: row.id, ownerKind: row.ownerKind, ownerId: row.accountId ?? row.sellerId ?? '', agreementKey: row.agreementKey,
    dealIds: row.dealIds, version: row.version, effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo,
    fields: CrmCommercialFieldsSchema.parse(row.fields),
  }
}

/** Permission-scoped profile snapshot for one account: only rows the viewer can read participate. */
export async function readVisibleProfiles(run: Run, workspaceId: string, viewer: { userId: string; access?: AccessContext }, account: { id: string; sellerId: string }) {
  const scope = commercialVisibility(viewer.userId, workspaceId, 'p', 4, 'read', viewer.access)
  const rows = (await run<Row>(`SELECT ${PROFILE_COLUMNS} FROM crm_commercial_profile_versions p
    WHERE p.workspace_id=$1 AND p.status='accepted' AND (p.seller_id=$2 OR p.account_id=$3) AND ${scope.sql}
    ORDER BY p.owner_kind,p.owner_key`, [workspaceId, account.sellerId, account.id, ...scope.params])).rows.map(profileRow)
  return {
    seller: rows.find((row) => row.ownerKind === 'seller') ?? null,
    account: rows.find((row) => row.ownerKind === 'account') ?? null,
    agreements: rows.filter((row) => row.ownerKind === 'agreement'),
  }
}

export function resolveForAccount(params: {
  operationKey: string; version: CrmOperationVersionRow; businessDate: string | null; dealId: string | null
  profiles: Awaited<ReturnType<typeof readVisibleProfiles>>; transaction: CrmCommercialFields
}) {
  try {
    return resolveCrmCommercialFields({
      operationKey: params.operationKey, operationVersionId: params.version.id, bindings: params.version.fieldBindings,
      businessDate: params.businessDate, dealId: params.dealId,
      seller: params.profiles.seller ? snapshot(params.profiles.seller) : null,
      account: params.profiles.account ? snapshot(params.profiles.account) : null,
      agreements: params.profiles.agreements.map(snapshot), transaction: params.transaction,
    })
  } catch (error) {
    if (error instanceof CrmOverrideNotPermittedError) {
      throw new CrmOperationsError('invalid_input', error.message, { reason: 'override_not_permitted', fields: error.fieldKeys })
    }
    throw error
  }
}

// ── Read store ──────────────────────────────────────────────────────

export function createCrmCommercialContextReadStore(run: Run = query as unknown as Run): CrmCommercialContextReadPort {
  async function visibleAccount(workspaceId: string, viewer: CrmCommercialViewer, accountId: string) {
    const scope = commercialVisibility(viewer.userId, workspaceId, 'a', 3)
    const company = entityVisibility(viewer.userId, workspaceId, 'e', scope.nextIdx)
    const row = (await run<Row>(`SELECT ${ACCOUNT_COLUMNS},e.display_name AS "companyName" FROM crm_customer_accounts a
        JOIN crm_seller_profiles s ON s.workspace_id=a.workspace_id AND s.id=a.seller_id
        JOIN entities e ON e.workspace_id=a.workspace_id AND e.id=a.company_id AND e.kind='company'
      WHERE a.workspace_id=$1 AND a.id=$2 AND ${scope.sql} AND ${company.sql}`, [workspaceId, accountId, ...scope.params, ...company.params])).rows[0]
    return row ? { ...accountRow(row), companyName: row.companyName as string } : null
  }
  async function visibleSellers(workspaceId: string, viewer: CrmCommercialViewer) {
    const scope = commercialVisibility(viewer.userId, workspaceId, 's', 2)
    const rows = await run<Row>(`SELECT ${SELLER_COLUMNS} FROM crm_seller_profiles s WHERE s.workspace_id=$1 AND ${scope.sql} ORDER BY s.seller_key LIMIT 200`,
      [workspaceId, ...scope.params])
    return rows.rows.map(sellerRow)
  }
  return {
    async getAccount(workspaceId, viewer, accountId) {
      return visibleAccount(workspaceId, viewer, accountId)
    },
    async listSellers(workspaceId, viewer) {
      return { schemaVersion: 1, sellers: await visibleSellers(workspaceId, viewer) }
    },
    async listAccounts(workspaceId, viewer, input) {
      const scope = commercialVisibility(viewer.userId, workspaceId, 'a', 2)
      const company = entityVisibility(viewer.userId, workspaceId, 'e', scope.nextIdx)
      const params: unknown[] = [workspaceId, ...scope.params, ...company.params]
      const add = (value: unknown) => { params.push(value); return `$${params.length}` }
      const filters: string[] = []
      if (input.companyId) filters.push(`a.company_id=${add(input.companyId)}`)
      if (input.sellerKey) filters.push(`s.seller_key=${add(input.sellerKey)}`)
      if (!input.includeArchived) filters.push(`a.status='active'`)
      const sql = `SELECT ${ACCOUNT_COLUMNS},e.display_name AS "companyName" FROM crm_customer_accounts a
          JOIN crm_seller_profiles s ON s.workspace_id=a.workspace_id AND s.id=a.seller_id
          JOIN entities e ON e.workspace_id=a.workspace_id AND e.id=a.company_id AND e.kind='company'
        WHERE a.workspace_id=$1 AND ${scope.sql} AND ${company.sql}${filters.length ? ` AND ${filters.join(' AND ')}` : ''}`
      const page = await queryCrmPage<'accounts', Row>(run, { workspaceId, resource: 'crm_customer_accounts', key: 'accounts', sql, params,
        query: { limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}) } })
      return { schemaVersion: 1, accounts: page.accounts.map((row) => ({ ...accountRow(row), companyName: row.companyName })), nextCursor: page.nextCursor }
    },
    async listProfiles(workspaceId, viewer, input) {
      const scope = commercialVisibility(viewer.userId, workspaceId, 'p', 4)
      let ownerFilter: string, ownerParams: unknown[]
      if (input.accountId) {
        const account = await visibleAccount(workspaceId, viewer, input.accountId)
        if (!account) throw new CrmOperationsError('not_found', 'The record is unavailable in your current scope.')
        ownerFilter = 'p.account_id=$2'; ownerParams = [account.id]
      } else {
        const seller = (await visibleSellers(workspaceId, viewer)).find((row) => row.sellerKey === input.sellerKey)
        if (!seller) throw new CrmOperationsError('not_found', 'The record is unavailable in your current scope.')
        ownerFilter = 'p.seller_id=$2'; ownerParams = [seller.id]
      }
      const rows = await run<Row>(`SELECT ${PROFILE_COLUMNS} FROM crm_commercial_profile_versions p
        WHERE p.workspace_id=$1 AND ${ownerFilter} AND ($3::boolean OR p.status='accepted') AND ${scope.sql}
        ORDER BY p.owner_key,p.version DESC LIMIT 200`, [workspaceId, ...ownerParams, input.includeSuperseded, ...scope.params])
      return { schemaVersion: 1, profiles: rows.rows.map(profileRow) }
    },
    async listOperationDefinitions(workspaceId) {
      const definitions = (await run<CrmOperationDefinitionRow>(`SELECT ${DEFINITION_COLUMNS} FROM crm_operation_definitions d
        WHERE d.workspace_id=$1 ORDER BY d.operation_key LIMIT 100`, [workspaceId])).rows
      const versions = definitions.length ? (await run<Row>(`SELECT ${VERSION_COLUMNS} FROM crm_operation_versions v
        WHERE v.workspace_id=$1 AND v.state IN('proposed','accepted') ORDER BY v.definition_id,v.version_number DESC LIMIT 500`, [workspaceId])).rows.map(versionRow) : []
      return { schemaVersion: 1, operations: definitions.map((definition) => ({ ...definition, versions: versions.filter((version) => version.definitionId === definition.id) })) }
    },
    async resolve(workspaceId, viewer, input) {
      const operation = await readAcceptedOperation({ query: run }, workspaceId, input.operationKey)
      if (!operation) throw new CrmOperationsError('not_found', 'The operation has no accepted version.')
      const account = await visibleAccount(workspaceId, viewer, input.accountId)
      if (!account) throw new CrmOperationsError('not_found', 'The record is unavailable in your current scope.')
      if (input.dealId) {
        const deal = entityVisibility(viewer.userId, workspaceId, 'e', 3)
        const found = await run<{ companyId: string | null }>(`SELECT e.attributes->>'company_id' AS "companyId" FROM entities e
          WHERE e.workspace_id=$1 AND e.id=$2 AND e.kind='deal' AND ${deal.sql}`, [workspaceId, input.dealId, ...deal.params])
        if (!found.rows[0] || found.rows[0].companyId !== account.companyId) throw new CrmOperationsError('not_found', 'The record is unavailable in your current scope.')
      }
      const profiles = await readVisibleProfiles(run, workspaceId, { userId: viewer.userId }, account)
      return resolveForAccount({ operationKey: input.operationKey, version: operation.version, businessDate: input.businessDate ?? null,
        dealId: input.dealId ?? null, profiles, transaction: input.transaction ?? {} })
    },
  }
}
