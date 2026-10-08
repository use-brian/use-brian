/** Canonical Association operational source evidence. [COMP:crm/association-source-scope] */
import { CrmOperationsError, departmentReadGrantJson, deriveResourceScope, DerivedScopeError, intersectDepartmentReadGrants, intersectScopeGrants, scopeGrantContains,
  type AssociationActor, type DepartmentReadGrant, type ResourceScope, type ScopeSource } from '@use-brian/core'
import type { Pool, PoolClient } from 'pg'
import type { ResourceDestination } from '@use-brian/shared'

import { admitWorkspaceResource } from '../workspace-access/resource-admission.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'
import { currentAgentAccess, runWithAgentAccess } from '../db/agent-access-context.js'
import { loadDepartmentSnapshot, resolveDepartmentReadGrant } from '../context-scope/department-resolver.js'
import type { CrmIntegrationExecutionLimits } from '../crm-operations/integration-department-authority.js'
import { readCrmIntegrationCredential } from '../db/crm-integration-store.js'

type ScopeReader = Pool | PoolClient

type Source = ScopeSource & { held: boolean; validTo: string | null; retractedAt: string | null }

/** Identical guidance for absent, historical and currently inaccessible records.
 * Never offer a new request identity as an automatic retry of a possible effect. */
function operationalSourceDenied(): CrmOperationsError {
  return new CrmOperationsError('not_authorized',
    'The record is unavailable. Review access before retrying a read. Preserve the original request reference and verify any prior outcome before starting a separate operation. Current source access cannot restore missing historical evidence.',
    { recovery: {
      kind: 'operational_access_review',
      readRetry: 'after_access_review',
      mutationRetry: 'never_automatic',
      preserveRequestIdentity: true,
      freshStart: 'only_after_operator_verifies_no_duplicate_effect',
      historicalEvidence: 'original_trustworthy_evidence_required',
    } })
}

/** Acquire before operational/source locks; canonical admission uses this lock too. */
export async function beginAssociationCreation(client: PoolClient, workspaceId: string, nowait = false): Promise<void> {
  await client.query(`SELECT id FROM workspaces WHERE id=$1 AND department_read_v2 FOR UPDATE${nowait ? ' NOWAIT' : ''}`, [workspaceId])
}

/** Source read authority never substitutes for admission of the new destination. */
export async function admitAssociationSourceScope(
  client: PoolClient, workspaceId: string, actor: AssociationActor,
  evidence: { scope: ResourceScope; sources: ScopeSource[] },
  destination?: ResourceDestination,
): Promise<{ scope: ResourceScope; sources: ScopeSource[] }> {
  await assertAssociationSourceAuthority(client, workspaceId, actor, evidence)
  const workspace = (await client.query<{ v2: boolean }>(
    'SELECT department_read_v2 AS v2 FROM workspaces WHERE id=$1', [workspaceId])).rows[0]
  if (!workspace?.v2) return evidence
  const authority = await resolveAssociationReadGrant(client, workspaceId, actor)
  const grant = authority?.grant
  const userId = actor.actingUserId ?? (actor.credentialKind === 'user' ? actor.credentialId : grant?.userId)
  if (!userId) throw new CrmOperationsError('not_authorized', 'The destination is not available to this actor.')
  try {
    const admit = () => admitWorkspaceResource(client, workspaceId, userId, {
      visibility: evidence.scope.userId ? 'private' : 'workspace', sensitivity: evidence.scope.sensitivity,
      inherited: { ...evidence.scope, visibility: evidence.scope.userId ? 'private' : 'workspace' },
      inheritedAuthority: 'read', destination,
    })
    const admission = grant ? await runWithAgentAccess({ workspaceId, userId, clearance: 'confidential', compartments: null, ...authority?.executionLimits,
      departmentRead: grant }, admit) : await admit()
    const admitted = { sources: evidence.sources, scope: { ...evidence.scope,
      sensitivity: admission.envelope.sensitivity, compartments: admission.envelope.compartments,
      projectIds: admission.envelope.projectIds } }
    // Preserve the frozen execution ceiling as well as current destination permission.
    await assertAssociationSourceAuthority(client, workspaceId, actor, admitted)
    return admitted
  } catch (error) {
    if (error instanceof WorkspaceAccessError) throw new CrmOperationsError('not_authorized', 'The destination is not available to this actor.')
    throw error
  }
}

/** Advisory choices use exactly the same source and destination authority as creation. */
export async function previewAssociationDestinations(client: PoolClient, workspaceId: string, actor: AssociationActor, contactIds: string[]) {
  await beginAssociationCreation(client, workspaceId)
  const evidence = await loadAssociationOrderScope(client, workspaceId, contactIds)
  await assertAssociationSourceAuthority(client, workspaceId, actor, evidence)
  const authority = await resolveAssociationReadGrant(client, workspaceId, actor)
  const grant = authority?.grant
  const departments = grant ? (await client.query<{ id: string; name: string }>(
    "SELECT id,name FROM workspace_groups WHERE workspace_id=$1 AND kind='team' AND status='active' AND id=ANY($2::uuid[]) ORDER BY name,id",
    [workspaceId, Object.keys(grant.departments)])).rows : []
  const candidates: (ResourceDestination | undefined)[] = [undefined, { kind: 'general' }, ...departments.map(row => ({ kind: 'department' as const, departmentId: row.id }))]
  const choices = []
  for (const destination of candidates) {
    try {
      const admitted = await admitAssociationSourceScope(client, workspaceId, actor, evidence, destination)
      const ids = admitted.scope.compartments.filter(key => key.startsWith('team:')).map(key => key.slice(5))
      const names = ids.length ? (await client.query<{ id: string; name: string }>(
        'SELECT id,name FROM workspace_groups WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY name,id', [workspaceId, ids])).rows : []
      choices.push({ destination: destination ?? null, scope: admitted.scope, departments: names })
    } catch (error) {
      if (!(error instanceof CrmOperationsError) || error.code !== 'not_authorized') throw error
    }
  }
  return { choices, validForMs: 30_000 }
}

/** Saved protection is a floor, while live sources can further restrict it. */
export async function assertAssociationOrderAuthority(
  client: ScopeReader, workspaceId: string, orderId: string, actor: AssociationActor,
  recordKind: 'order' | 'registration' | 'membership' | 'rescue' | 'allocation' | 'invitation' | 'checkout' | 'submission' | 'consent' | 'suppression' | 'provider_receipt' | 'notification' | 'promotion_usage' = 'order',
): Promise<{ scope: ResourceScope; sources: ScopeSource[] } | null> {
  const workspace = (await client.query<{ v2: boolean }>(
    'SELECT department_read_v2 AS v2 FROM workspaces WHERE id=$1', [workspaceId])).rows[0]
  const deny = operationalSourceDenied
  if (!workspace) throw deny()
  if (!workspace.v2) return null
  const table = recordKind === 'promotion_usage' ? 'association_promotions' : recordKind === 'notification' ? 'association_notification_outbox' : recordKind === 'provider_receipt' ? 'association_integration_events' : recordKind === 'order' ? 'association_orders' : recordKind === 'registration' ? 'association_registrations' : recordKind === 'membership' ? 'association_memberships' : recordKind === 'rescue' ? 'association_membership_offline_rescues' : recordKind === 'allocation' ? 'association_sponsorship_allocations' : recordKind === 'checkout' ? 'association_membership_checkouts' : recordKind === 'submission' ? 'association_enquiries' : recordKind === 'consent' ? 'association_consent_events' : recordKind === 'suppression' ? 'crm_suppression_events' : 'association_sponsorship_invitations'
  if (recordKind === 'notification') {
    const row = (await client.query<{ scope: ResourceScope | null; status: string; minimized: boolean; source_kind: string; source_id: string }>(`
      SELECT scope_snapshot AS scope,status,source_kind,source_id,
        (source_id='00000000-0000-0000-0000-000000000000'::uuid AND recipient_ref='erased:'||id::text
          AND payload='{"erased":true}'::jsonb AND provider_message_id IS NULL AND last_error IS NULL
          AND scope_sources='[]'::jsonb) AS minimized
      FROM association_notification_outbox WHERE workspace_id=$1 AND id=$2 FOR SHARE`, [workspaceId, orderId])).rows[0]
    if (!row?.scope) throw deny()
    if (row.status === 'retired') {
      if (!row.minimized) throw deny()
      const scope = deriveResourceScope({ producer: 'association.notification-retired', sources: [{ ...row.scope, resourceKind: 'notification', resourceId: orderId, version: 'retired' }] })
      await assertAssociationSourceAuthority(client, workspaceId, actor, { scope, sources: [] })
      return { scope, sources: [] }
    }
    if (!['order', 'enquiry'].includes(row.source_kind)) throw deny()
    await assertAssociationOrderAuthority(client, workspaceId, row.source_id, actor, row.source_kind === 'order' ? 'order' : 'submission')
  }
  // Resolve and lock the parent before this record's source contacts.
  const parentColumn=recordKind==='membership'?'membership_checkout_id':recordKind==='registration'?'order_id':recordKind==='rescue'?'membership_id':recordKind==='allocation'?'sponsor_membership_id':recordKind==='invitation'?'allocation_id':null
  const parentKind=recordKind==='membership'?'checkout':recordKind==='registration'?'order':recordKind==='invitation'?'allocation':'membership'
  const parentId=parentColumn?(await client.query<{orderId:string|null}>(`SELECT ${parentColumn} AS "orderId" FROM ${table} WHERE workspace_id=$1 AND id=$2`,[workspaceId,orderId])).rows[0]?.orderId:null
  if(parentId)await assertAssociationOrderAuthority(client,workspaceId,parentId,actor,parentKind)
  if (recordKind === 'provider_receipt') {
    const parents = (await client.query<{ order_id: string | null; entitlement_id: string | null }>(
      'SELECT order_id,entitlement_id FROM association_integration_events WHERE workspace_id=$1 AND id=$2', [workspaceId, orderId])).rows[0]
    if (parents?.order_id) await assertAssociationOrderAuthority(client, workspaceId, parents.order_id, actor)
    if (parents?.entitlement_id) await assertAssociationOrderAuthority(client, workspaceId, parents.entitlement_id, actor, 'membership')
  }
  const saved = (await client.query<{ scope: ResourceScope | null; sources: ScopeSource[] | null; minimized: boolean; orderId: string | null; membershipId: string | null }>(
    `SELECT scope_snapshot AS scope,scope_sources AS sources,${recordKind === 'promotion_usage' ? 'scope_sources_minimized' : 'false'} AS minimized,${parentColumn ?? 'NULL'} AS "orderId",${recordKind === 'invitation' ? 'membership_id' : 'NULL'} AS "membershipId" FROM ${table} WHERE workspace_id=$1 AND id=$2 FOR SHARE`,
    [workspaceId, orderId])).rows[0]
  if (!saved?.scope || !Array.isArray(saved.sources) || (!saved.sources.length && !saved.minimized)
    || saved.sources.some(source => source.resourceKind !== 'entity' || source.workspaceId !== workspaceId)) throw deny()
  if (parentColumn && (saved.orderId ?? null) !== (parentId ?? null)) throw deny()
  try {
    // Validate and preserve the full stored envelope even if live sources have
    // subsequently become less restrictive.
    const floor = deriveResourceScope({ producer: 'association.order', sources: saved.sources.length ? saved.sources : [{ ...saved.scope, resourceKind: recordKind, resourceId: orderId, version: 'minimized' }] }, saved.scope)
    const current = saved.sources.length ? await loadAssociationOrderScope(client, workspaceId, saved.sources.map(source => source.resourceId)) : { scope: floor, sources: [] }
    await assertAssociationSourceAuthority(client, workspaceId, actor, {
      scope: floor, sources: [...saved.sources, ...current.sources],
    })
    if(recordKind==='invitation'&&saved.membershipId)await assertAssociationOrderAuthority(client,workspaceId,saved.membershipId,actor,'membership')
    return { scope: floor, sources: current.sources }
  } catch (error) {
    if (error instanceof DerivedScopeError) throw deny()
    throw error
  }
}

/** Renew current membership/assistant scope while preserving the execution ceiling. */
async function resolveAssociationReadGrant(
  client: ScopeReader, workspaceId: string, actor: AssociationActor,
): Promise<{ grant: DepartmentReadGrant; executionLimits?: CrmIntegrationExecutionLimits } | null> {
  const deny = operationalSourceDenied
  const workspace = (await client.query<{ v2: boolean }>(
    'SELECT department_read_v2 AS v2 FROM workspaces WHERE id=$1', [workspaceId])).rows[0]
  if (!workspace) throw deny()
  if (!workspace.v2) return null
  const ambient = currentAgentAccess()
  let executionLimits: CrmIntegrationExecutionLimits | undefined
  let pin = ambient?.departmentRead
  if (actor.credentialKind === 'integration_key') {
    if (actor.integration?.credentialId !== actor.credentialId) throw deny()
    const credential = await readCrmIntegrationCredential(client, workspaceId, actor.credentialId)
    if (!credential.departmentRead) throw deny()
    executionLimits = credential.executionLimits
    pin = pin ? intersectDepartmentReadGrants(pin, credential.departmentRead) : credential.departmentRead
  }
  const userId = actor.actingUserId ?? (actor.credentialKind === 'user' ? actor.credentialId : pin?.userId)
  if (!userId || (actor.credentialKind === 'user' && actor.credentialId !== userId)
    || (!['user', 'import'].includes(actor.credentialKind) && !pin)
    || (actor.credentialKind === 'assistant' && actor.credentialId !== pin?.assistantId)
    || (ambient?.workspaceId !== undefined && ambient.workspaceId !== workspaceId)
    || (ambient?.userId !== undefined && ambient.userId !== userId)
    || (pin && (pin.workspaceId !== workspaceId || pin.userId !== userId))) throw deny()
  const input = { workspaceId, userId, assistantId: pin?.assistantId ?? null }
  const { snapshot, principal } = await loadDepartmentSnapshot(
    <R>(sql: string, values: unknown[]) => client.query(sql, values) as unknown as Promise<{ rows: R[] }>, input)
  if (principal.kind !== 'user') throw deny()
  let grant = resolveDepartmentReadGrant(snapshot, principal, input, new Date())
  if (pin) grant = intersectDepartmentReadGrants(grant, pin)
  return { grant: { ...grant, departments: Object.fromEntries(Object.entries(grant.departments).sort(([a], [b]) => a.localeCompare(b))) }, executionLimits }
}

/** Internal SQL fragment over a fixed operational table, applied before LIMIT/counts. */
export async function associationOrderReadPredicate(
  client: ScopeReader, workspaceId: string, actor: AssociationActor, parameterIndex: number,
  recordKind: 'order' | 'registration' | 'membership' | 'rescue' | 'allocation' | 'invitation' | 'checkout' | 'submission' | 'consent' | 'suppression' | 'provider_receipt' | 'notification' | 'promotion_usage' = 'order',
): Promise<{ sql: string; params: unknown[] }> {
  const authority = await resolveAssociationReadGrant(client, workspaceId, actor)
  const grant = authority?.grant
  if (!grant) return { sql: 'TRUE', params: [] }
  return associationEvidenceReadSql(grant, parameterIndex, recordKind, authority?.executionLimits)
}

function associationEvidenceReadSql(grant: DepartmentReadGrant, parameterIndex: number, recordKind: 'order' | 'registration' | 'membership' | 'rescue' | 'allocation' | 'invitation' | 'checkout' | 'submission' | 'consent' | 'suppression' | 'provider_receipt' | 'notification' | 'promotion_usage', limits?: CrmIntegrationExecutionLimits): { sql: string; params: unknown[] } {
  const ambient = currentAgentAccess()
  const shared = ambient?.sharedAudience === true || limits?.sharedAudience === true
  const projects = `$${parameterIndex + 1}::text[]`
  const assistants = `$${parameterIndex + 2}::text[]`
  const axes = (projectIds: string, assistantId: string) => `((${projects} IS NULL OR ${projectIds} <@ ${projects})
    AND (${assistants} IS NULL OR ${assistantId} IS NULL OR ${assistantId} = ANY(${assistants})))`
  const map = `$${parameterIndex}::jsonb`
  // Expressions are fixed SQL identifiers below, never request text.
  const table = recordKind === 'promotion_usage' ? 'association_promotions' : recordKind === 'notification' ? 'association_notification_outbox' : recordKind === 'provider_receipt' ? 'association_integration_events' : recordKind === 'order' ? 'association_orders' : recordKind === 'registration' ? 'association_registrations' : recordKind === 'membership' ? 'association_memberships' : recordKind === 'rescue' ? 'association_membership_offline_rescues' : recordKind === 'allocation' ? 'association_sponsorship_allocations' : recordKind === 'checkout' ? 'association_membership_checkouts' : recordKind === 'submission' ? 'association_enquiries' : recordKind === 'consent' ? 'association_consent_events' : recordKind === 'suppression' ? 'crm_suppression_events' : 'association_sponsorship_invitations'
  const allows = (scope: string) => `(${scope}->>'workspaceId' = ${table}.workspace_id::text
    AND public.department_row_allows(${map}, ${table}.workspace_id, ${scope}->>'sensitivity',
      ARRAY(SELECT jsonb_array_elements_text(${scope}->'compartments')), (${scope}->>'userId')::uuid)
    AND ${axes(`ARRAY(SELECT jsonb_array_elements_text(${scope}->'projectIds'))`, `${scope}->>'assistantId'`)}
    ${shared ? `AND ${scope}->>'userId' IS NULL` : ''})`
  const retired = recordKind === 'notification' ? `(${table}.status='retired'
    AND ${table}.source_id='00000000-0000-0000-0000-000000000000'::uuid
    AND ${table}.recipient_ref='erased:'||${table}.id::text AND ${table}.payload='{"erased":true}'::jsonb
    AND ${table}.provider_message_id IS NULL AND ${table}.last_error IS NULL AND ${table}.scope_sources='[]'::jsonb)` : 'FALSE'
  const notificationParents = recordKind === 'notification' ? `AND (${retired} OR (${table}.status<>'retired' AND (${(['order', 'submission'] as const).map(kind => {
    const target = kind === 'order' ? 'association_orders' : 'association_enquiries'
    return `(${table}.source_kind='${kind === 'order' ? 'order' : 'enquiry'}' AND EXISTS(SELECT 1 FROM ${target} WHERE ${target}.workspace_id=${table}.workspace_id AND ${target}.id=${table}.source_id AND ${associationEvidenceReadSql(grant, parameterIndex, kind, limits).sql}))`
  }).join(' OR ')})))` : ''
  const parent = recordKind === 'membership' ? associationEvidenceReadSql(grant, parameterIndex, 'checkout', limits) : recordKind === 'registration'
    ? associationEvidenceReadSql(grant, parameterIndex, 'order', limits) : ['rescue','allocation'].includes(recordKind) ? associationEvidenceReadSql(grant, parameterIndex, 'membership', limits) : recordKind === 'invitation' ? associationEvidenceReadSql(grant, parameterIndex, 'allocation', limits) : null
  const parentColumn = recordKind === 'membership' ? 'membership_checkout_id' : recordKind === 'rescue' ? 'membership_id' : recordKind === 'allocation' ? 'sponsor_membership_id' : recordKind === 'invitation' ? 'allocation_id' : 'order_id'
  const parentTable = recordKind === 'membership' ? 'association_membership_checkouts' : ['rescue','allocation'].includes(recordKind) ? 'association_memberships' : recordKind === 'invitation' ? 'association_sponsorship_allocations' : 'association_orders'
  const redeemed=recordKind==='invitation'?associationEvidenceReadSql(grant,parameterIndex,'membership',limits):null
  const providerParents = recordKind === 'provider_receipt' ? (['order', 'membership'] as const).map(kind => {
    const child = associationEvidenceReadSql(grant, parameterIndex, kind, limits)
    const parentTable = kind === 'order' ? 'association_orders' : 'association_memberships'
    const column = kind === 'order' ? 'order_id' : 'entitlement_id'
    return `AND (${table}.${column} IS NULL OR EXISTS (SELECT 1 FROM ${parentTable} WHERE ${parentTable}.workspace_id=${table}.workspace_id AND ${parentTable}.id=${table}.${column} AND ${child.sql}))`
  }).join('\n') : ''
  return { params: [departmentReadGrantJson(grant), intersectScopeGrants(ambient?.projectIds ?? null, limits?.projectIds ?? null), intersectScopeGrants(ambient?.visibilityAssistantIds ?? null, limits?.visibilityAssistantIds ?? null)], sql: `(
    ${table}.scope_snapshot IS NOT NULL AND ${table}.scope_sources IS NOT NULL AND (jsonb_array_length(${table}.scope_sources)>0 OR ${retired} ${recordKind === 'promotion_usage' ? `OR ${table}.scope_sources_minimized` : ''})
    AND ${allows(`${table}.scope_snapshot`)}
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(${table}.scope_sources) saved(source)
      LEFT JOIN entities e ON e.workspace_id=${table}.workspace_id AND e.id::text=saved.source->>'resourceId'
      WHERE saved.source->>'resourceKind' IS DISTINCT FROM 'entity'
        OR NOT coalesce(${allows('saved.source')},false)
        OR e.id IS NULL OR e.scope_held OR e.valid_to IS NOT NULL OR e.retracted_at IS NOT NULL
        OR NOT public.department_row_allows(${map},e.workspace_id,e.sensitivity,e.compartments,e.user_id)
        OR NOT ${axes('e.project_ids::text[]', 'e.assistant_id::text')}
        ${shared ? 'OR e.user_id IS NOT NULL' : ''}
    )
    ${parent ? `AND (${table}.${parentColumn} IS NULL OR EXISTS (SELECT 1 FROM ${parentTable} WHERE ${parentTable}.workspace_id=${table}.workspace_id AND ${parentTable}.id=${table}.${parentColumn} AND ${parent.sql}))` : ''}
    ${redeemed ? `AND (${table}.membership_id IS NULL OR EXISTS(SELECT 1 FROM association_memberships WHERE association_memberships.workspace_id=${table}.workspace_id AND association_memberships.id=${table}.membership_id AND ${redeemed.sql}))` : ''}
    ${providerParents}
    ${notificationParents}
    )` }
}

/** Checks locked source facts and the output floor, never caller-supplied labels. */
export async function assertAssociationSourceAuthority(
  client: ScopeReader, workspaceId: string, actor: AssociationActor,
  evidence: { scope: ResourceScope; sources: ScopeSource[] },
): Promise<void> {
  const authority = await resolveAssociationReadGrant(client, workspaceId, actor)
  const grant = authority?.grant
  if (!grant) return
  const ambient = currentAgentAccess()
  const deny = operationalSourceDenied
  const scopes = [...evidence.sources, evidence.scope]
  for (const scope of scopes) {
    if (scope.workspaceId !== workspaceId || ((ambient?.sharedAudience || authority?.executionLimits?.sharedAudience) && scope.userId !== null)
      || !scopeGrantContains(intersectScopeGrants(ambient?.projectIds ?? null, authority?.executionLimits?.projectIds ?? null), scope.projectIds)
      || !scopeGrantContains(intersectScopeGrants(ambient?.visibilityAssistantIds ?? null, authority?.executionLimits?.visibilityAssistantIds ?? null), scope.assistantId ? [scope.assistantId] : [])) throw deny()
  }
  const allowed = (await client.query<{ allowed: boolean }>(
    `SELECT bool_and(public.department_row_allows($1::jsonb,s."workspaceId",s.sensitivity,s.compartments,s."userId")) AS allowed
       FROM jsonb_to_recordset($2::jsonb) AS s("workspaceId" uuid,"userId" uuid,sensitivity text,compartments text[])`,
    [departmentReadGrantJson(grant), JSON.stringify(scopes)])).rows[0]?.allowed
  if (allowed !== true) throw deny()
}

/** The caller owns the order transaction; locks survive until its commit.
 * This records lineage, not permission to read or mutate the source. */
export async function loadAssociationOrderScope(
  client: Pick<PoolClient, 'query'>, workspaceId: string, contactIds: readonly string[],
): Promise<{ scope: ResourceScope; sources: ScopeSource[] }> {
  const ids = [...new Set(contactIds.map(id => id.toLowerCase()))].sort()
  if (!ids.length) throw new DerivedScopeError('scope_evidence_missing')
  const { rows } = await client.query<{ snapshot: Source | null }>(
    `SELECT read_scope_source($1, 'entity', source_id) AS snapshot
       FROM unnest($2::uuid[]) AS source_id ORDER BY source_id`, [workspaceId, ids])
  if (rows.length !== ids.length) throw new DerivedScopeError('scope_evidence_missing')
  const sources = rows.map(({ snapshot }, i): ScopeSource => {
    if (!snapshot || snapshot.resourceKind !== 'entity' || snapshot.resourceId !== ids[i]
      || snapshot.workspaceId !== workspaceId || snapshot.held !== false
      || snapshot.validTo !== null || snapshot.retractedAt !== null) {
      throw new DerivedScopeError('scope_source_changed')
    }
    const { held: _held, validTo: _validTo, retractedAt: _retractedAt, ...source } = snapshot
    return source
  })
  const evidence = { producer: 'association.order', sources }
  const inherited = deriveResourceScope(evidence)
  return { sources, scope: deriveResourceScope(evidence, { ...inherited,
    sensitivity: inherited.sensitivity === 'public' ? 'internal' : inherited.sensitivity }) }
}


// Host-only settlement linkage. A transport command cannot install this binding,
// and a different transaction cannot observe it.
const checkoutBindings = new WeakMap<PoolClient, { workspaceId: string; checkoutId: string; contactId: string; planId: string }>()
const waitlistBindings = new WeakMap<PoolClient, { workspaceId: string; submissionId: string; contactId: string }>()
export async function withAssociationWaitlistSubmission<T>(client: PoolClient, workspaceId: string, submissionId: string,
  actor: AssociationActor, operation: () => Promise<T>): Promise<T> {
  await assertAssociationOrderAuthority(client, workspaceId, submissionId, actor, 'submission')
  const row = (await client.query<{ contactId: string }>('SELECT contact_id AS "contactId" FROM association_enquiries WHERE workspace_id=$1 AND id=$2', [workspaceId, submissionId])).rows[0]
  if (!row || waitlistBindings.has(client)) throw new CrmOperationsError('not_authorized', 'Waitlist source authority is unavailable.')
  waitlistBindings.set(client, { workspaceId, submissionId, contactId: row.contactId })
  try { return await operation() } finally { waitlistBindings.delete(client) }
}
export async function associationWaitlistInheritance(client: PoolClient, workspaceId: string, contactId: string, actor: AssociationActor) {
  const bound = waitlistBindings.get(client)
  if (!bound) return null
  if (bound.workspaceId !== workspaceId || bound.contactId !== contactId) throw new CrmOperationsError('not_authorized', 'Waitlist source does not match this order.')
  const evidence = await assertAssociationOrderAuthority(client, workspaceId, bound.submissionId, actor, 'submission')
  return evidence ? { ...evidence, submissionId: bound.submissionId } : null
}
const providerBindings = new WeakMap<PoolClient, { workspaceId: string; receiptId: string; contactId: string; planId: string | null }>()

/** Only inbox application can attach its frozen source to this transaction. */
export async function withAssociationProviderReceipt<T>(client: PoolClient, workspaceId: string, receiptId: string,
  actor: AssociationActor, operation: () => Promise<T>): Promise<T> {
  await assertAssociationOrderAuthority(client, workspaceId, receiptId, actor, 'provider_receipt')
  const row = (await client.query<{ contactId: string; planId: string | null }>(
    'SELECT contact_id AS "contactId",plan_id AS "planId" FROM association_integration_events WHERE workspace_id=$1 AND id=$2',
    [workspaceId, receiptId])).rows[0]
  if (!row || providerBindings.has(client)) throw new CrmOperationsError('not_authorized', 'Provider receipt authority is unavailable.')
  providerBindings.set(client, { workspaceId, receiptId, ...row })
  try { return await operation() } finally { providerBindings.delete(client) }
}

export async function associationProviderInheritance(client: PoolClient, workspaceId: string, contactId: string, planId: string, actor: AssociationActor) {
  const bound = providerBindings.get(client)
  if (!bound) return null
  if (bound.workspaceId !== workspaceId || bound.contactId !== contactId || bound.planId !== planId) {
    throw new CrmOperationsError('not_authorized', 'Provider receipt authority does not match this entitlement.')
  }
  const evidence = await assertAssociationOrderAuthority(client, workspaceId, bound.receiptId, actor, 'provider_receipt')
  return evidence ? { ...evidence, receiptId: bound.receiptId } : null
}
export async function withAssociationCheckout<T>(client: PoolClient, workspaceId: string, checkoutId: string,
  actor: AssociationActor, operation: () => Promise<T>): Promise<T> {
  await assertAssociationOrderAuthority(client, workspaceId, checkoutId, actor, 'checkout')
  const row = (await client.query<{ contactId: string; planId: string }>(
    'SELECT contact_id AS "contactId",plan_id AS "planId" FROM association_membership_checkouts WHERE workspace_id=$1 AND id=$2 FOR SHARE', [workspaceId, checkoutId])).rows[0]
  if (!row || checkoutBindings.has(client)) throw new CrmOperationsError('not_authorized', 'Checkout authority is unavailable.')
  checkoutBindings.set(client, { workspaceId, checkoutId, ...row })
  try { return await operation() } finally { checkoutBindings.delete(client) }
}

export async function associationCheckoutInheritance(client: PoolClient, workspaceId: string, contactId: string, planId: string, actor: AssociationActor) {
  const bound = checkoutBindings.get(client)
  if (!bound) return null
  if (bound.workspaceId !== workspaceId || bound.contactId !== contactId || bound.planId !== planId) {
    throw new CrmOperationsError('not_authorized', 'Checkout authority does not match this entitlement.')
  }
  let evidence = await assertAssociationOrderAuthority(client, workspaceId, bound.checkoutId, actor, 'checkout')
  if (!evidence) {
    const saved = (await client.query<{ scope: ResourceScope | null; sources: ScopeSource[] | null }>(
      'SELECT scope_snapshot AS scope,scope_sources AS sources FROM association_membership_checkouts WHERE workspace_id=$1 AND id=$2', [workspaceId, bound.checkoutId])).rows[0]
    if (saved?.scope && saved.sources?.length) evidence = { scope: deriveResourceScope({ producer: 'association.checkout', sources: saved.sources }, saved.scope), sources: saved.sources }
  }
  return { checkoutId: bound.checkoutId, evidence }
}

export async function assertAssociationCheckoutParent(client: PoolClient, workspaceId: string, membershipId: string, checkoutId: string | undefined) {
  if (!checkoutId) return
  const row = (await client.query<{ id: string | null }>('SELECT membership_checkout_id AS id FROM association_memberships WHERE workspace_id=$1 AND id=$2', [workspaceId, membershipId])).rows[0]
  if (row?.id !== checkoutId) throw new CrmOperationsError('idempotency_conflict', 'The entitlement belongs to different checkout evidence.')
}


/** Evidence reduction must never hide a withdrawal and manufacture permission to send. */
export async function assertAssociationConsentAuthority(
  client: ScopeReader, workspaceId: string, contactId: string, actor: AssociationActor | undefined,
  options: { purposeKeys?: readonly string[] | null; channel?: string } = {},
): Promise<string> {
  const workspace=(await client.query<{v2:boolean}>('SELECT department_read_v2 AS v2 FROM workspaces WHERE id=$1',[workspaceId])).rows[0]
  if(workspace?.v2===false)return 'legacy'
  if(!workspace || !actor)throw new CrmOperationsError('not_authorized','Consent reads require current actor scope.')
  const source=await loadAssociationOrderScope(client,workspaceId,[contactId])
  await assertAssociationSourceAuthority(client,workspaceId,actor,source)
  const consent=await associationOrderReadPredicate(client,workspaceId,actor,5,'consent')
  const suppression=await associationOrderReadPredicate(client,workspaceId,actor,5,'suppression')
  if(JSON.stringify(consent.params)!==JSON.stringify(suppression.params))throw new CrmOperationsError('not_authorized','Consent access changed.')
  const rows=await client.query<{id:string;kind:string;scope:unknown;sources:unknown;allowed:boolean}>(`
    SELECT id,'consent'::text AS kind,scope_snapshot AS scope,scope_sources AS sources,${consent.sql} AS allowed
      FROM association_consent_events
      WHERE workspace_id=$1 AND contact_id=$2 AND ($3::text[] IS NULL OR purpose=ANY($3::text[]))
    UNION ALL SELECT id,'suppression'::text AS kind,scope_snapshot AS scope,scope_sources AS sources,${suppression.sql} AS allowed
      FROM crm_suppression_events
      WHERE workspace_id=$1 AND contact_id=$2 AND ($4::text IS NULL OR channel IN('all',$4))
    ORDER BY kind,id`,[workspaceId,contactId,options.purposeKeys??null,options.channel??null,...consent.params])
  if(rows.rows.some(row=>row.allowed!==true))throw new CrmOperationsError('not_authorized','Consent evidence is not available to this actor.')
  return JSON.stringify({source,evidence:rows.rows,grant:consent.params})
}
