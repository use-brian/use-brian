/**
 * Canonical governed client/engagement commands. Change requests freeze base
 * versions and a reviewed payload; approval applies through the canonical CRM
 * writers, assigns approval-time references and records the decision in one
 * transaction. Protected fees live apart from deal metadata; recurring
 * successors are claimed once per source and period; billing requests move
 * through the configured review and close exactly once on an invoice.
 * Spec: docs/architecture/features/crm-commercial-operations.md -> Governed engagement and billing
 *
 * [COMP:crm/governed-records]
 */

import {
  CrmChangeSetSchema,
  CrmReviewPolicySchema,
  DEFAULT_CRM_REVIEW_POLICIES,
  crmDecimalAdd,
  crmDecimalCompare,
  crmOperationsSha256,
  maxSensitivity,
  unionScopeRequirements,
  type AccessContext,
  type CrmChangeSet,
  type CrmGovernedCommand,
  type CrmGovernanceSubject,
  type CrmOperationsContext,
  type CrmReviewPolicy,
  type EntityRecord,
} from '@use-brian/core'
import type { PoolClient } from 'pg'
import type { CrmOperationsTransaction } from '../db/crm-operations-store.js'
import { createCompany, createDeal, readCrmMutationSource, readCrmReference, updateCompany, updateDeal } from '../db/crm.js'
import { updateEntity } from '../db/entities-store.js'
import { commercialVisibility, lockAccount } from '../db/crm-commercial-context-store.js'
import { assignCrmReferenceAtEvent } from './business-references.js'
import { actorColumns, commercialAudit, commercialEmit, commercialResult, refuse, unavailable, withOperationReceipt, type CommercialResult } from './commercial-transaction.js'

type Command<K extends CrmGovernedCommand['kind']> = Extract<CrmGovernedCommand, { kind: K }>

async function readGovernancePolicy(client: PoolClient, workspaceId: string, subject: CrmGovernanceSubject): Promise<{ policy: CrmReviewPolicy; version: number }> {
  const row = (await client.query<{ policy: unknown; version: number }>('SELECT policy,version FROM crm_governance_policies WHERE workspace_id=$1 AND subject=$2 FOR SHARE',
    [workspaceId, subject])).rows[0]
  if (!row) return { policy: DEFAULT_CRM_REVIEW_POLICIES[subject], version: 0 }
  return { policy: CrmReviewPolicySchema.parse(row.policy), version: row.version }
}

async function catalogKeys(client: PoolClient, workspaceId: string, catalog: 'service_category' | 'work_status'): Promise<string[] | null> {
  const row = (await client.query<{ entries: Array<{ key: string; archived?: boolean }> }>('SELECT entries FROM crm_engagement_catalogs WHERE workspace_id=$1 AND catalog=$2',
    [workspaceId, catalog])).rows[0]
  return row ? row.entries.filter((entry) => !entry.archived).map((entry) => entry.key) : null
}

async function assertCatalog(client: PoolClient, workspaceId: string, catalog: 'service_category' | 'work_status', key: string | null | undefined) {
  if (!key) return
  const keys = await catalogKeys(client, workspaceId, catalog)
  if (!keys || !keys.includes(key)) refuse('catalog_key_invalid', `Unknown ${catalog.replace('_', ' ')}.`, { catalog, value: key, validValues: keys ?? [] })
}

/**
 * Is this actor a human reviewer under the policy: an owner/admin, or a member of the
 * named department. Assistants, workflows and keys never review: a tool confirmation or
 * workflow completion does not establish business approval.
 */
async function isReviewer(client: PoolClient, context: CrmOperationsContext, departmentId: string | null): Promise<boolean> {
  if (context.actor.kind !== 'user') return false
  if (['owner', 'admin'].includes(context.authority.role)) return true
  if (!departmentId) return false
  const edge = await client.query(`SELECT 1 FROM department_edges WHERE workspace_id=$1 AND department_id=$2 AND user_id=$3 AND (expires_at IS NULL OR expires_at>clock_timestamp())`,
    [context.workspaceId, departmentId, context.actor.userId])
  return Boolean(edge.rowCount)
}

/** Direct application is an explicit policy exception for member or assistant actors with a listed role; it is recorded as evidence. */
function mayApplyDirect(context: CrmOperationsContext, policy: CrmReviewPolicy): boolean {
  return (context.actor.kind === 'user' || context.actor.kind === 'assistant') && policy.directRoles.includes(context.authority.role as never)
}

function assertMayPropose(context: CrmOperationsContext, policy: CrmReviewPolicy): void {
  if (policy.mode === 'direct' && !mayApplyDirect(context, policy)) refuse('not_authorized', 'This workspace lets only its direct-application roles change these records.')
}

function selfReview(context: CrmOperationsContext, policy: CrmReviewPolicy, authorUserId: string | null): boolean {
  return !policy.allowSelfReview && context.actor.kind === 'user' && authorUserId !== null && authorUserId === context.actor.userId
}

// ── Change requests ─────────────────────────────────────────────────

type ChangeRequestRow = { id: string; targetKind: 'company' | 'deal'; targetId: string | null; appliedTargetId: string | null; policySubject: CrmGovernanceSubject
  state: string; revision: number; draftChanges: CrmChangeSet; authorUserId: string | null; authorId: string; version: number
  sensitivity: 'public' | 'internal' | 'confidential'; compartments: string[]; projectIds: string[] }
const REQUEST_COLUMNS = `r.id,r.target_kind AS "targetKind",r.target_id AS "targetId",r.applied_target_id AS "appliedTargetId",r.policy_subject AS "policySubject",
  r.state,r.revision,r.draft_changes AS "draftChanges",r.author_user_id AS "authorUserId",r.author_id AS "authorId",r.version,r.sensitivity,r.compartments,r.project_ids AS "projectIds"`

async function lockRequest(tx: CrmOperationsTransaction, requestId: string, access: AccessContext): Promise<ChangeRequestRow> {
  const { client, context } = tx.commercial()
  const scope = commercialVisibility(access.userId, context.workspaceId, 'r', 3, 'read', access)
  const row = (await client.query<ChangeRequestRow>(`SELECT ${REQUEST_COLUMNS} FROM crm_change_requests r WHERE r.workspace_id=$1 AND r.id=$2 AND ${scope.sql} FOR UPDATE OF r`,
    [context.workspaceId, requestId, ...scope.params])).rows[0]
  if (!row) unavailable()
  return row
}

async function readTarget(tx: CrmOperationsTransaction, kind: 'company' | 'deal', id: string, operation: 'read' | 'mutation'): Promise<EntityRecord> {
  const { client, context } = tx.commercial()
  const access = await tx.commercial().actorAccess()
  const target = operation === 'mutation'
    ? await readCrmMutationSource(access, id, [kind], client).catch(() => null)
    : await readCrmReference(access.userId, context.workspaceId, id, [kind], access, client).catch(() => null)
  if (!target) unavailable()
  return target
}

async function readEngagement(client: PoolClient, workspaceId: string, dealId: string) {
  return (await client.query<Record<string, unknown> & { version: number }>(`SELECT service_category AS "serviceCategory",to_char(period_start,'YYYY-MM-DD') AS "periodStart",
      to_char(period_end,'YYYY-MM-DD') AS "periodEnd",financial_period AS "financialPeriod",work_status AS "workStatus",to_char(deadline,'YYYY-MM-DD') AS deadline,
      owner_user_id AS "ownerUserId",participant_ids AS "participantIds",recurrence_parent_deal_id AS "recurrenceParentDealId",recurrence_period_key AS "recurrencePeriodKey",version
    FROM crm_engagement_extensions WHERE workspace_id=$1 AND deal_id=$2 FOR UPDATE`, [workspaceId, dealId])).rows[0] ?? null
}

/** The current values of exactly the fields a change set touches, plus the versions they were read at. */
async function snapshotTarget(tx: CrmOperationsTransaction, request: { targetKind: 'company' | 'deal'; targetId: string | null }, changes: CrmChangeSet) {
  const { client, context } = tx.commercial()
  if (!request.targetId) return { current: {}, base: { target: null, engagement: null } as Record<string, unknown> }
  const target = await readTarget(tx, request.targetKind, request.targetId, 'read')
  const current: Record<string, unknown> = {}
  if (changes.name !== undefined) current.name = target.displayName
  if (changes.domain !== undefined) current.domain = target.attributes.domain ?? null
  if (changes.companyId !== undefined) current.companyId = target.attributes.company_id ?? null
  let engagementVersion: number | null = null
  if (changes.engagement && request.targetKind === 'deal') {
    const engagement = await readEngagement(client, context.workspaceId, request.targetId)
    engagementVersion = engagement?.version ?? 0
    for (const key of Object.keys(changes.engagement)) current[`engagement.${key}`] = engagement?.[key] ?? null
  }
  return { current, base: { target: new Date(target.updatedAt).toISOString(), engagement: engagementVersion } }
}

async function validateChanges(tx: CrmOperationsTransaction, request: { targetKind: 'company' | 'deal'; targetId: string | null }, changes: CrmChangeSet) {
  const { client, context } = tx.commercial()
  if (request.targetKind === 'company' && (changes.companyId !== undefined || changes.engagement)) refuse('invalid_input', 'Company changes cannot carry deal or engagement fields.')
  if (request.targetKind === 'deal' && changes.domain !== undefined) refuse('invalid_input', 'A deal has no domain.')
  if (!request.targetId && !changes.name) refuse('invalid_input', 'A new record needs a name.')
  if (request.targetKind === 'deal' && !request.targetId && !changes.companyId) refuse('invalid_input', 'A new engagement needs its client company.')
  if (changes.companyId) await readTarget(tx, 'company', changes.companyId, 'read')
  await assertCatalog(client, context.workspaceId, 'service_category', changes.engagement?.serviceCategory)
  await assertCatalog(client, context.workspaceId, 'work_status', changes.engagement?.workStatus)
  for (const reference of changes.assignReferences) {
    const definition = (await client.query<{ assignmentEvent: string; targetKinds: string[] }>(`SELECT assignment_event AS "assignmentEvent",target_kinds AS "targetKinds"
      FROM crm_reference_definitions WHERE workspace_id=$1 AND definition_key=$2 AND status='active'`, [context.workspaceId, reference.definitionKey])).rows[0]
    if (!definition || definition.assignmentEvent !== 'approval' || !definition.targetKinds.includes(request.targetKind)) {
      refuse('catalog_key_invalid', 'Approval-time references need an active definition with assignment event approval for this record kind.', { definitionKey: reference.definitionKey })
    }
  }
}

async function upsertEngagement(client: PoolClient, workspaceId: string, dealId: string, fields: Record<string, unknown>, recurrence?: { parentDealId: string; periodKey: string }) {
  const current = await readEngagement(client, workspaceId, dealId)
  const merged = { ...(current ?? {}), ...fields }
  await client.query(`INSERT INTO crm_engagement_extensions(workspace_id,deal_id,service_category,period_start,period_end,financial_period,work_status,deadline,owner_user_id,
      participant_ids,recurrence_parent_deal_id,recurrence_period_key)
    VALUES($1,$2,$3,$4::date,$5::date,$6,$7,$8::date,$9,$10,$11,$12)
    ON CONFLICT(workspace_id,deal_id) DO UPDATE SET service_category=EXCLUDED.service_category,period_start=EXCLUDED.period_start,period_end=EXCLUDED.period_end,
      financial_period=EXCLUDED.financial_period,work_status=EXCLUDED.work_status,deadline=EXCLUDED.deadline,owner_user_id=EXCLUDED.owner_user_id,
      participant_ids=EXCLUDED.participant_ids,version=crm_engagement_extensions.version+1,updated_at=now()`,
  [workspaceId, dealId, merged.serviceCategory ?? null, merged.periodStart ?? null, merged.periodEnd ?? null, merged.financialPeriod ?? null, merged.workStatus ?? null,
    merged.deadline ?? null, merged.ownerUserId ?? null, (merged.participantIds as string[] | undefined) ?? [], recurrence?.parentDealId ?? current?.recurrenceParentDealId ?? null,
    recurrence?.periodKey ?? current?.recurrencePeriodKey ?? null])
}

/** Apply an approved change set through the canonical CRM writers inside this transaction. */
async function applyChanges(tx: CrmOperationsTransaction, request: ChangeRequestRow, changes: CrmChangeSet, operationId: string): Promise<string> {
  const { client, context } = tx.commercial()
  const access = await tx.commercial().actorAccess()
  const transaction = { client, afterCommit: (effect: () => void) => tx.commercial().afterCommit(effect) }
  const scope = { sensitivity: request.sensitivity, compartments: request.compartments, projectIds: request.projectIds }
  let targetId = request.targetId
  if (request.targetKind === 'company') {
    if (!targetId) {
      targetId = (await createCompany(access.userId, { workspaceId: context.workspaceId, name: changes.name!, domain: changes.domain ?? null, access, mergeByName: false,
        sensitivity: scope.sensitivity, compartments: scope.compartments, projectIds: scope.projectIds }, transaction)).id
    } else if (changes.name !== undefined || changes.domain !== undefined) {
      await updateCompany(access.userId, targetId, { ...(changes.name !== undefined ? { name: changes.name } : {}), ...(changes.domain !== undefined ? { domain: changes.domain } : {}) }, access, client)
    }
  } else {
    if (!targetId) {
      targetId = (await createDeal(access.userId, { workspaceId: context.workspaceId, companyId: changes.companyId!, access,
        sensitivity: scope.sensitivity, compartments: scope.compartments, projectIds: scope.projectIds }, undefined, transaction)).id
    } else if (changes.companyId !== undefined) {
      await updateDeal(access.userId, targetId, { companyId: changes.companyId }, undefined, access, client)
    }
    if (changes.name !== undefined) await updateEntity(access.userId, targetId, { displayName: changes.name }, access, client)
    if (changes.engagement) await upsertEngagement(client, context.workspaceId, targetId, changes.engagement)
  }
  for (const reference of changes.assignReferences) {
    const target = await readTarget(tx, request.targetKind, targetId, 'read')
    await assignCrmReferenceAtEvent(tx, { definitionKey: reference.definitionKey, event: 'approval', operationId, categoryKey: reference.categoryKey,
      businessDate: reference.businessDate, target: { id: targetId, kind: request.targetKind, displayName: target.displayName, updatedAt: new Date(target.updatedAt).toISOString(),
        parentCompanyId: request.targetKind === 'deal' && typeof target.attributes.company_id === 'string' ? target.attributes.company_id : null } })
  }
  await client.query('UPDATE crm_change_requests SET applied_target_id=$3 WHERE workspace_id=$1 AND id=$2', [context.workspaceId, request.id, targetId])
  return targetId
}

async function insertDecision(client: PoolClient, workspaceId: string, requestId: string, revision: number, decision: string, reason: string | null, actor: ReturnType<typeof actorColumns>) {
  await client.query(`INSERT INTO crm_change_request_decisions(workspace_id,request_id,revision,decision,reason,actor_kind,actor_id,actor_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [workspaceId, requestId, revision, decision, reason, actor.kind, actor.id, actor.userId])
}

async function setRequestState(client: PoolClient, workspaceId: string, requestId: string, state: string, extra: { revision?: number; draftChanges?: CrmChangeSet } = {}) {
  await client.query(`UPDATE crm_change_requests SET state=$3,revision=coalesce($4,revision),draft_changes=coalesce($5::jsonb,draft_changes),version=version+1,updated_at=now()
    WHERE workspace_id=$1 AND id=$2`, [workspaceId, requestId, state, extra.revision ?? null, extra.draftChanges ? JSON.stringify(extra.draftChanges) : null])
}

async function readRequest(client: PoolClient, workspaceId: string, requestId: string) {
  return (await client.query<ChangeRequestRow>(`SELECT ${REQUEST_COLUMNS} FROM crm_change_requests r WHERE r.workspace_id=$1 AND r.id=$2`, [workspaceId, requestId])).rows[0]!
}

async function emitDecision(tx: CrmOperationsTransaction, request: ChangeRequestRow, targetId: string | null, eventType: 'crm.change_request.submitted' | 'crm.change_request.decided', decision: string, occurredAt: string) {
  if (!targetId) return []
  const { context } = tx.commercial()
  return [await commercialEmit(tx, context, { eventType, eventKey: `${eventType}:${request.id}:${request.revision}:${decision}`, subjectKind: request.targetKind, subjectId: targetId,
    occurredAt, payload: { requestId: request.id, revision: request.revision, decision, targetKind: request.targetKind, targetId, actorKind: context.actor.kind, occurredAt } })]
}

async function saveChangeRequest(tx: CrmOperationsTransaction, command: Command<'save_change_request'>): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  const access = await tx.commercial().actorAccess()
  const target = { targetKind: command.target.kind, targetId: command.target.id ?? null }
  await validateChanges(tx, target, command.changes)
  if (command.requestId) {
    const request = await lockRequest(tx, command.requestId, access)
    if (request.version !== command.expectedVersion) refuse('conflict', 'The request changed. Reread it first.', { reason: 'stale_version', currentVersion: request.version })
    if (!['draft', 'returned'].includes(request.state)) refuse('invalid_transition', 'Only a draft or returned request can be edited.', { state: request.state })
    if (request.targetKind !== target.targetKind || request.targetId !== target.targetId) refuse('invalid_input', 'A request keeps its target.')
    await client.query(`UPDATE crm_change_requests SET draft_changes=$3::jsonb,note=coalesce($4,note),version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`,
      [context.workspaceId, request.id, JSON.stringify(command.changes), command.note ?? null])
    return commercialResult(command.kind, { request: await readRequest(client, context.workspaceId, request.id) })
  }
  // A request is at least as restricted as its target (or the client company of a new engagement).
  let envelope = { sensitivity: 'internal' as 'public' | 'internal' | 'confidential', compartments: [] as string[], projectIds: [] as string[] }
  const parentId = target.targetId ?? (target.targetKind === 'deal' ? command.changes.companyId ?? null : null)
  if (parentId) {
    const parent = await readTarget(tx, target.targetId ? target.targetKind : 'company', parentId, 'read')
    envelope = { sensitivity: maxSensitivity(envelope.sensitivity, parent.sensitivity), compartments: unionScopeRequirements(envelope.compartments, parent.compartments ?? []) ?? [],
      projectIds: unionScopeRequirements(envelope.projectIds, parent.projectIds ?? []) ?? [] }
  }
  const actor = actorColumns(context)
  const id = (await client.query<{ id: string }>(`INSERT INTO crm_change_requests(workspace_id,target_kind,target_id,policy_subject,draft_changes,note,sensitivity,compartments,project_ids,
      author_kind,author_id,author_user_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
  [context.workspaceId, target.targetKind, target.targetId, target.targetKind === 'company' ? 'client_change' : 'engagement_change', JSON.stringify(command.changes), command.note ?? null,
    envelope.sensitivity, envelope.compartments, envelope.projectIds, actor.kind, actor.id, actor.userId])).rows[0]!.id
  void access
  await commercialAudit(tx, context, { action: 'crm.change_request.created', subjectKind: 'crm_change_request', subjectId: id, details: { targetKind: target.targetKind } })
  return commercialResult(command.kind, { request: await readRequest(client, context.workspaceId, id) }, { created: true })
}

async function submitChangeRequest(tx: CrmOperationsTransaction, command: Command<'submit_change_request'>, occurredAt: string, operationId: string): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  const access = await tx.commercial().actorAccess()
  const request = await lockRequest(tx, command.requestId, access)
  if (request.version !== command.expectedVersion) refuse('conflict', 'The request changed. Reread it first.', { reason: 'stale_version', currentVersion: request.version })
  if (!['draft', 'returned'].includes(request.state)) refuse('invalid_transition', 'Only a draft or returned request can be submitted.', { state: request.state })
  const changes = CrmChangeSetSchema.parse(request.draftChanges)
  await validateChanges(tx, request, changes)
  const { policy, version: policyVersion } = await readGovernancePolicy(client, context.workspaceId, request.policySubject)
  assertMayPropose(context, policy)
  const snapshot = await snapshotTarget(tx, request, changes)
  const revision = request.revision + 1
  const actor = actorColumns(context)
  const payload = { changes, current: snapshot.current, base: snapshot.base, policy, policyVersion }
  await client.query(`INSERT INTO crm_change_request_revisions(workspace_id,request_id,revision,changes,current_snapshot,base_versions,policy,policy_version,payload_hash,actor_kind,actor_id,actor_user_id)
    VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12)`, [context.workspaceId, request.id, revision, JSON.stringify(changes), JSON.stringify(snapshot.current),
    JSON.stringify(snapshot.base), JSON.stringify(policy), policyVersion, crmOperationsSha256(payload), actor.kind, actor.id, actor.userId])
  if (mayApplyDirect(context, policy)) {
    // Direct application still records the revision and an approved decision with the exact actor.
    const targetId = await applyChanges(tx, { ...request, revision }, changes, operationId)
    await insertDecision(client, context.workspaceId, request.id, revision, 'applied_direct', null, actor)
    await setRequestState(client, context.workspaceId, request.id, 'approved', { revision })
    await commercialAudit(tx, context, { action: 'crm.change_request.applied_direct', subjectKind: 'crm_change_request', subjectId: request.id, details: { revision, policyVersion } })
    const events = await emitDecision(tx, { ...request, revision }, targetId, 'crm.change_request.decided', 'applied_direct', occurredAt)
    return commercialResult(command.kind, { request: await readRequest(client, context.workspaceId, request.id), applied: true, targetId }, { emittedEventIds: events })
  }
  await setRequestState(client, context.workspaceId, request.id, 'submitted', { revision })
  await commercialAudit(tx, context, { action: 'crm.change_request.submitted', subjectKind: 'crm_change_request', subjectId: request.id, details: { revision, policyVersion } })
  const events = await emitDecision(tx, { ...request, revision }, request.targetId, 'crm.change_request.submitted', 'submitted', occurredAt)
  return commercialResult(command.kind, { request: await readRequest(client, context.workspaceId, request.id), applied: false }, { emittedEventIds: events })
}

async function decideChangeRequest(tx: CrmOperationsTransaction, command: Command<'decide_change_request'>, occurredAt: string): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  const access = await tx.commercial().actorAccess()
  const request = await lockRequest(tx, command.requestId, access)
  if (request.state !== 'submitted') refuse('invalid_transition', 'Only a submitted request can be decided.', { state: request.state })
  if (request.revision !== command.expectedRevision) refuse('conflict', 'A newer revision was submitted. Review it instead.', { reason: 'stale_version', currentRevision: request.revision })
  const revision = (await client.query<{ changes: CrmChangeSet; base_versions: { target: string | null; engagement: number | null }; policy: CrmReviewPolicy }>(
    'SELECT changes,base_versions,policy FROM crm_change_request_revisions WHERE workspace_id=$1 AND request_id=$2 AND revision=$3', [context.workspaceId, request.id, request.revision])).rows[0]!
  const policy = CrmReviewPolicySchema.parse(revision.policy)
  if (!await isReviewer(client, context, policy.reviewerDepartmentId)) refuse('not_authorized', 'Only a configured reviewer can decide this request.')
  if (selfReview(context, policy, request.authorUserId)) refuse('not_authorized', 'The author cannot review their own request.', { reason: 'self_review' })
  const actor = actorColumns(context)
  if (command.decision !== 'approve') {
    const decision = command.decision === 'return' ? 'returned' : 'rejected'
    await insertDecision(client, context.workspaceId, request.id, request.revision, decision, command.reason ?? null, actor)
    await setRequestState(client, context.workspaceId, request.id, decision)
    await commercialAudit(tx, context, { action: `crm.change_request.${decision}`, subjectKind: 'crm_change_request', subjectId: request.id, details: { revision: request.revision } })
    const events = await emitDecision(tx, request, request.targetId, 'crm.change_request.decided', decision, occurredAt)
    return commercialResult(command.kind, { request: await readRequest(client, context.workspaceId, request.id) }, { emittedEventIds: events })
  }
  // Drift since submission fails closed with a recoverable outcome; nothing is applied.
  if (request.targetId) {
    const target = await readTarget(tx, request.targetKind, request.targetId, 'mutation')
    const engagement = request.targetKind === 'deal' && revision.changes.engagement ? (await readEngagement(client, context.workspaceId, request.targetId))?.version ?? 0 : null
    if (new Date(target.updatedAt).toISOString() !== revision.base_versions.target || (revision.base_versions.engagement !== null && engagement !== revision.base_versions.engagement)) {
      refuse('conflict', 'The record changed after this request was submitted. Return it so the author can resubmit against the current values.', { reason: 'stale_review' })
    }
  }
  const targetId = await applyChanges(tx, request, CrmChangeSetSchema.parse(revision.changes), command.operationId)
  await insertDecision(client, context.workspaceId, request.id, request.revision, 'approved', command.reason ?? null, actor)
  await setRequestState(client, context.workspaceId, request.id, 'approved')
  await commercialAudit(tx, context, { action: 'crm.change_request.approved', subjectKind: 'crm_change_request', subjectId: request.id, details: { revision: request.revision } })
  const events = await emitDecision(tx, request, targetId, 'crm.change_request.decided', 'approved', occurredAt)
  return commercialResult(command.kind, { request: await readRequest(client, context.workspaceId, request.id), targetId }, { emittedEventIds: events })
}

async function withdrawChangeRequest(tx: CrmOperationsTransaction, command: Command<'withdraw_change_request'>): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  const request = await lockRequest(tx, command.requestId, await tx.commercial().actorAccess())
  if (request.version !== command.expectedVersion) refuse('conflict', 'The request changed. Reread it first.', { reason: 'stale_version', currentVersion: request.version })
  if (!['draft', 'submitted', 'returned'].includes(request.state)) refuse('invalid_transition', 'This request is already decided.', { state: request.state })
  const actor = actorColumns(context)
  if (actor.id !== request.authorId) refuse('not_authorized', 'Only the author can withdraw a request.')
  await insertDecision(client, context.workspaceId, request.id, request.revision, 'withdrawn', command.reason, actor)
  await setRequestState(client, context.workspaceId, request.id, 'withdrawn')
  await commercialAudit(tx, context, { action: 'crm.change_request.withdrawn', subjectKind: 'crm_change_request', subjectId: request.id })
  return commercialResult(command.kind, { request: await readRequest(client, context.workspaceId, request.id) })
}

// ── Engagement tracking and protected values ────────────────────────

async function updateTracking(tx: CrmOperationsTransaction, command: Command<'update_engagement_tracking'>): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  await readTarget(tx, 'deal', command.dealId, 'mutation')
  const current = await readEngagement(client, context.workspaceId, command.dealId)
  if ((current?.version ?? 0) !== command.expectedVersion) refuse('conflict', 'The engagement changed. Reread it first.', { reason: 'stale_version', currentVersion: current?.version ?? 0 })
  await assertCatalog(client, context.workspaceId, 'work_status', command.tracking.workStatus)
  // Only tracking fields move; protected commercial values live elsewhere and are untouched.
  await upsertEngagement(client, context.workspaceId, command.dealId, command.tracking)
  await commercialAudit(tx, context, { action: 'crm.engagement.tracking_updated', subjectKind: 'deal', subjectId: command.dealId, details: { fields: Object.keys(command.tracking) } })
  return commercialResult(command.kind, { engagement: await readEngagement(client, context.workspaceId, command.dealId) })
}

/** Version one protected value: supersede the current row and insert the next, refusing a stale expected version. */
async function writeCommercialValue(client: PoolClient, context: CrmOperationsContext, value: {
  dealId: string; valueKind: 'quoted' | 'confirmed' | 'outsource'; expectedVersion: number; amount: string | null; currency: string
  rate?: Record<string, unknown> | null; evidence: Record<string, unknown>; operationId: string
  envelope: { sensitivity: 'public' | 'internal' | 'confidential'; compartments: string[]; projectIds: string[] }
}): Promise<Record<string, unknown>> {
  const actor = actorColumns(context)
  const current = (await client.query<{ id: string; version: number }>(`SELECT id,version FROM crm_commercial_values WHERE workspace_id=$1 AND deal_id=$2 AND value_kind=$3 AND status='current' FOR UPDATE`,
    [context.workspaceId, value.dealId, value.valueKind])).rows[0]
  if ((current?.version ?? 0) !== value.expectedVersion) refuse('conflict', 'A commercial value changed. Reread it first.', { reason: 'stale_version', valueKind: value.valueKind, currentVersion: current?.version ?? 0 })
  if (current) await client.query(`UPDATE crm_commercial_values SET status='superseded' WHERE workspace_id=$1 AND id=$2`, [context.workspaceId, current.id])
  return (await client.query<Record<string, unknown>>(`INSERT INTO crm_commercial_values(workspace_id,deal_id,value_kind,version,amount,currency,rate,evidence,operation_id,actor_kind,actor_id,actor_user_id,
      sensitivity,compartments,project_ids) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,$15)
    RETURNING id,value_kind AS "valueKind",version,amount::text AS amount,currency,rate,evidence`,
  [context.workspaceId, value.dealId, value.valueKind, (current?.version ?? 0) + 1, value.amount, value.currency, value.rate ? JSON.stringify(value.rate) : null,
    JSON.stringify(value.evidence), value.operationId, actor.kind, actor.id, actor.userId, value.envelope.sensitivity, value.envelope.compartments, value.envelope.projectIds])).rows[0]!
}

async function setCommercialValues(tx: CrmOperationsTransaction, command: Command<'set_commercial_values'>): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  const deal = await readTarget(tx, 'deal', command.dealId, 'mutation')
  const { policy } = await readGovernancePolicy(client, context.workspaceId, 'commercial_values')
  if (!mayApplyDirect(context, policy) && !await isReviewer(client, context, policy.reviewerDepartmentId)) {
    refuse('not_authorized', 'Commercial values are set by a configured reviewer or direct-application role.')
  }
  const sensitivity = maxSensitivity(command.sensitivity ?? 'confidential', deal.sensitivity)
  const saved: Array<Record<string, unknown>> = []
  for (const value of command.values) {
    saved.push(await writeCommercialValue(client, context, { dealId: command.dealId, ...value, evidence: command.evidence, operationId: command.operationId,
      envelope: { sensitivity, compartments: deal.compartments ?? [], projectIds: deal.projectIds ?? [] } }))
  }
  await commercialAudit(tx, context, { action: 'crm.commercial_values.set', subjectKind: 'crm_commercial_values', subjectId: command.dealId,
    details: { kinds: command.values.map((value) => value.valueKind), source: command.evidence.source } })
  return commercialResult(command.kind, { dealId: command.dealId, values: saved }, { created: true })
}

// ── Recurrence ──────────────────────────────────────────────────────

async function commitSuccessors(tx: CrmOperationsTransaction, command: Command<'commit_recurring_successors'>): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  const access = await tx.commercial().actorAccess()
  const transaction = { client, afterCommit: (effect: () => void) => tx.commercial().afterCommit(effect) }
  const outcomes: Array<Record<string, unknown>> = []
  for (const sourceId of [...new Set(command.sourceDealIds)].sort()) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`crm-successor:${context.workspaceId}:${sourceId}:${command.period.key}`])
    const existing = (await client.query<{ dealId: string }>(`SELECT deal_id AS "dealId" FROM crm_engagement_extensions WHERE workspace_id=$1 AND recurrence_parent_deal_id=$2 AND recurrence_period_key=$3`,
      [context.workspaceId, sourceId, command.period.key])).rows[0]
    if (existing) { outcomes.push({ sourceDealId: sourceId, outcome: 'existing', dealId: existing.dealId }); continue }
    const source = await readCrmReference(access.userId, context.workspaceId, sourceId, ['deal'], access, client).catch(() => null)
    const engagement = source ? await readEngagement(client, context.workspaceId, sourceId) : null
    if (!source || !engagement || typeof source.attributes.company_id !== 'string') {
      outcomes.push({ sourceDealId: sourceId, outcome: 'stale', reason: !source ? 'source_unavailable' : !engagement ? 'source_not_an_engagement' : 'source_without_company' })
      continue
    }
    const deal = await createDeal(access.userId, { workspaceId: context.workspaceId, companyId: source.attributes.company_id, access, sensitivity: source.sensitivity,
      compartments: source.compartments ?? [], projectIds: source.projectIds ?? [] }, undefined, transaction)
    await updateEntity(access.userId, deal.id, { displayName: `${source.displayName.replace(/ \([^)]*\)$/, '')} (${command.period.key})` }, access, client)
    // Only declared fields carry forward; invoice state, receipts and financial assumptions never do.
    const carry = new Set(command.carryForward)
    await upsertEngagement(client, context.workspaceId, deal.id, {
      serviceCategory: carry.has('serviceCategory') ? engagement.serviceCategory : null, ownerUserId: carry.has('owner') ? engagement.ownerUserId : null,
      participantIds: carry.has('participants') ? engagement.participantIds : [], periodStart: command.period.periodStart, periodEnd: command.period.periodEnd,
      financialPeriod: command.period.financialPeriod, deadline: command.period.deadline, workStatus: null,
    }, { parentDealId: sourceId, periodKey: command.period.key })
    if (carry.has('quotedFee')) {
      const quoted = (await client.query<Record<string, unknown>>(`SELECT amount::text AS amount,currency,sensitivity,compartments,project_ids FROM crm_commercial_values
        WHERE workspace_id=$1 AND deal_id=$2 AND value_kind='quoted' AND status='current'`, [context.workspaceId, sourceId])).rows[0]
      if (quoted) {
        const actor = actorColumns(context)
        await client.query(`INSERT INTO crm_commercial_values(workspace_id,deal_id,value_kind,version,amount,currency,evidence,operation_id,actor_kind,actor_id,actor_user_id,sensitivity,compartments,project_ids)
          VALUES($1,$2,'quoted',1,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12)`, [context.workspaceId, deal.id, quoted.amount, quoted.currency,
          JSON.stringify({ source: 'recurrence', reason: `Carried from ${sourceId}` }), command.operationId, actor.kind, actor.id, actor.userId, quoted.sensitivity, quoted.compartments, quoted.project_ids])
      }
    }
    outcomes.push({ sourceDealId: sourceId, outcome: 'created', dealId: deal.id })
  }
  await commercialAudit(tx, context, { action: 'crm.engagement.successors_committed', subjectKind: 'crm_engagements', subjectId: context.workspaceId,
    details: { periodKey: command.period.key, created: outcomes.filter((outcome) => outcome.outcome === 'created').length } })
  return commercialResult(command.kind, { periodKey: command.period.key, outcomes }, { created: outcomes.some((outcome) => outcome.outcome === 'created') })
}

// ── Configuration ───────────────────────────────────────────────────

async function savePolicy(tx: CrmOperationsTransaction, command: Command<'save_governance_policy'>): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  if (command.subject !== 'billing_request' && command.policy.mode === 'reviewer_then_finance') refuse('invalid_input', 'Only billing requests use the reviewer-then-finance policy.')
  const current = await readGovernancePolicy(client, context.workspaceId, command.subject)
  if (current.version !== command.expectedVersion) refuse('conflict', 'The policy changed. Reread it first.', { reason: 'stale_version', currentVersion: current.version })
  const actor = actorColumns(context)
  await client.query(`INSERT INTO crm_governance_policies(workspace_id,subject,policy,updated_by_kind,updated_by_id,updated_by_user_id) VALUES($1,$2,$3::jsonb,$4,$5,$6)
    ON CONFLICT(workspace_id,subject) DO UPDATE SET policy=EXCLUDED.policy,version=crm_governance_policies.version+1,updated_by_kind=EXCLUDED.updated_by_kind,
      updated_by_id=EXCLUDED.updated_by_id,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=now()`,
  [context.workspaceId, command.subject, JSON.stringify(command.policy), actor.kind, actor.id, actor.userId])
  await commercialAudit(tx, context, { action: 'crm.governance_policy.saved', subjectKind: 'crm_governance_policy', subjectId: context.workspaceId, details: { subject: command.subject, mode: command.policy.mode } })
  return commercialResult(command.kind, { subject: command.subject, ...(await readGovernancePolicy(client, context.workspaceId, command.subject)) })
}

async function saveCatalog(tx: CrmOperationsTransaction, command: Command<'save_engagement_catalog'>): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  const current = (await client.query<{ version: number; entries: Array<{ key: string }> }>('SELECT version,entries FROM crm_engagement_catalogs WHERE workspace_id=$1 AND catalog=$2 FOR UPDATE',
    [context.workspaceId, command.catalog])).rows[0]
  if ((current?.version ?? 0) !== command.expectedVersion) refuse('conflict', 'The catalog changed. Reread it first.', { reason: 'stale_version', currentVersion: current?.version ?? 0 })
  const removed = (current?.entries ?? []).filter((entry) => !command.entries.some((next) => next.key === entry.key)).map((entry) => entry.key)
  if (removed.length) refuse('conflict', 'Catalog keys are stable. Archive an entry instead of removing it.', { reason: 'catalog_key_removed', keys: removed })
  if (new Set(command.entries.map((entry) => entry.key)).size !== command.entries.length) refuse('invalid_input', 'Catalog keys must be unique.')
  const actor = actorColumns(context)
  await client.query(`INSERT INTO crm_engagement_catalogs(workspace_id,catalog,entries,updated_by_kind,updated_by_id,updated_by_user_id) VALUES($1,$2,$3::jsonb,$4,$5,$6)
    ON CONFLICT(workspace_id,catalog) DO UPDATE SET entries=EXCLUDED.entries,version=crm_engagement_catalogs.version+1,updated_by_kind=EXCLUDED.updated_by_kind,
      updated_by_id=EXCLUDED.updated_by_id,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=now()`,
  [context.workspaceId, command.catalog, JSON.stringify(command.entries), actor.kind, actor.id, actor.userId])
  await commercialAudit(tx, context, { action: 'crm.engagement_catalog.saved', subjectKind: 'crm_engagement_catalog', subjectId: context.workspaceId, details: { catalog: command.catalog } })
  return commercialResult(command.kind, { catalog: command.catalog, entries: command.entries })
}

// ── Billing ─────────────────────────────────────────────────────────

type BillingRow = { id: string; dealId: string; state: string; reviewStep: 'reviewer' | 'finance' | null; amount: string; currency: string; description: string; version: number
  authorUserId: string | null; authorId: string; reviewedByUserId: string | null; financeByUserId: string | null; invoiceId: string | null; returnReason: string | null }
const BILLING_COLUMNS = `b.id,b.deal_id AS "dealId",b.state,b.review_step AS "reviewStep",b.amount::text AS amount,b.currency,b.description,b.version,
  b.author_user_id AS "authorUserId",b.author_id AS "authorId",b.reviewed_by_user_id AS "reviewedByUserId",b.finance_by_user_id AS "financeByUserId",
  b.invoice_id AS "invoiceId",b.return_reason AS "returnReason"`

async function lockBilling(tx: CrmOperationsTransaction, requestId: string): Promise<BillingRow> {
  const { client, context } = tx.commercial()
  const access = await tx.commercial().actorAccess()
  const scope = commercialVisibility(access.userId, context.workspaceId, 'b', 3, 'read', access)
  const row = (await client.query<BillingRow>(`SELECT ${BILLING_COLUMNS} FROM crm_billing_requests b WHERE b.workspace_id=$1 AND b.id=$2 AND ${scope.sql} FOR UPDATE OF b`,
    [context.workspaceId, requestId, ...scope.params])).rows[0]
  if (!row) unavailable()
  return row
}
async function readBilling(client: PoolClient, workspaceId: string, id: string) {
  return (await client.query<BillingRow>(`SELECT ${BILLING_COLUMNS} FROM crm_billing_requests b WHERE b.workspace_id=$1 AND b.id=$2`, [workspaceId, id])).rows[0]!
}

/** Where a submitted billing request goes under the policy: straight to ready (direct exception) or into its first review step. */
function submittedBillingState(context: CrmOperationsContext, policy: CrmReviewPolicy): { state: 'ready_to_bill' | 'review'; reviewStep: 'reviewer' | null } {
  return mayApplyDirect(context, policy) ? { state: 'ready_to_bill', reviewStep: null } : { state: 'review', reviewStep: 'reviewer' }
}

async function createBilling(tx: CrmOperationsTransaction, command: Command<'create_billing_request'>): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  const deal = await readTarget(tx, 'deal', command.dealId, 'mutation')
  const { policy } = await readGovernancePolicy(client, context.workspaceId, 'billing_request')
  if (command.submit) assertMayPropose(context, policy)
  const next = command.submit ? submittedBillingState(context, policy) : { state: 'draft' as const, reviewStep: null }
  const reviewed = JSON.stringify({ amount: command.amount, currency: command.currency, description: command.description })
  const actor = actorColumns(context)
  if (command.requestId) {
    const request = await lockBilling(tx, command.requestId)
    if (request.version !== command.expectedVersion) refuse('conflict', 'The billing request changed. Reread it first.', { reason: 'stale_version', currentVersion: request.version })
    if (!['draft', 'returned'].includes(request.state)) refuse('invalid_transition', 'Only a draft or returned billing request can be revised.', { state: request.state })
    if (request.dealId !== command.dealId) refuse('invalid_input', 'A billing request keeps its engagement.')
    await client.query(`UPDATE crm_billing_requests SET state=$3,review_step=$4,amount=$5,currency=$6,description=$7,reviewed_values=$8::jsonb,return_reason=NULL,
        reviewed_by_user_id=NULL,reviewed_at=NULL,finance_by_user_id=NULL,finance_at=NULL,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`,
    [context.workspaceId, request.id, next.state, next.reviewStep, command.amount, command.currency, command.description, reviewed])
    await commercialAudit(tx, context, { action: 'crm.billing_request.revised', subjectKind: 'crm_billing_request', subjectId: request.id, details: { state: next.state } })
    return commercialResult(command.kind, { request: await readBilling(client, context.workspaceId, request.id) })
  }
  const id = (await client.query<{ id: string }>(`INSERT INTO crm_billing_requests(workspace_id,deal_id,state,review_step,amount,currency,description,reviewed_values,author_kind,author_id,author_user_id,
      sensitivity,compartments,project_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14) RETURNING id`,
  [context.workspaceId, command.dealId, next.state, next.reviewStep, command.amount, command.currency, command.description, reviewed, actor.kind, actor.id, actor.userId,
    deal.sensitivity, deal.compartments ?? [], deal.projectIds ?? []])).rows[0]!.id
  await commercialAudit(tx, context, { action: 'crm.billing_request.created', subjectKind: 'crm_billing_request', subjectId: id,
    details: { state: next.state, ...(next.state === 'ready_to_bill' ? { appliedDirect: true, role: context.authority.role } : {}) } })
  return commercialResult(command.kind, { request: await readBilling(client, context.workspaceId, id) }, { created: true })
}

async function decideBilling(tx: CrmOperationsTransaction, command: Command<'decide_billing_request'>): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  const request = await lockBilling(tx, command.requestId)
  if (request.version !== command.expectedVersion) refuse('conflict', 'The billing request changed. Reread it first.', { reason: 'stale_version', currentVersion: request.version })
  if (request.state !== 'review') refuse('invalid_transition', 'Only a request in review can be decided.', { state: request.state })
  const { policy } = await readGovernancePolicy(client, context.workspaceId, 'billing_request')
  const finance = request.reviewStep === 'finance'
  if (!await isReviewer(client, context, finance ? policy.financeDepartmentId : policy.reviewerDepartmentId)) {
    refuse('not_authorized', finance ? 'Only a configured finance reviewer can complete this billing request.' : 'Only a configured reviewer can decide this billing request.')
  }
  if (selfReview(context, policy, request.authorUserId)) refuse('not_authorized', 'The author cannot review their own request.', { reason: 'self_review' })
  const reviewer = context.actor.kind === 'user' ? context.actor.userId : null
  // Sequential means two people: the finance step is never the same person as the review step.
  if (finance && reviewer !== null && reviewer === request.reviewedByUserId) refuse('not_authorized', 'The finance step needs a different reviewer.', { reason: 'same_reviewer' })
  let action: string
  if (command.decision === 'return') {
    await client.query(`UPDATE crm_billing_requests SET state='returned',review_step=NULL,return_reason=$3,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`,
      [context.workspaceId, request.id, command.reason])
    action = 'returned'
  } else if (!finance && policy.mode === 'reviewer_then_finance') {
    await client.query(`UPDATE crm_billing_requests SET review_step='finance',reviewed_by_user_id=$3,reviewed_at=now(),version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`,
      [context.workspaceId, request.id, reviewer])
    action = 'reviewed'
  } else {
    // The pinned reviewed values are what finance invoices.
    await client.query(`UPDATE crm_billing_requests SET state='ready_to_bill',review_step=NULL,
        reviewed_by_user_id=CASE WHEN $4 THEN reviewed_by_user_id ELSE $3 END,reviewed_at=CASE WHEN $4 THEN reviewed_at ELSE now() END,
        finance_by_user_id=CASE WHEN $4 THEN $3 ELSE NULL END,finance_at=CASE WHEN $4 THEN now() ELSE NULL END,version=version+1,updated_at=now()
      WHERE workspace_id=$1 AND id=$2`, [context.workspaceId, request.id, reviewer, finance])
    action = 'ready'
  }
  await commercialAudit(tx, context, { action: `crm.billing_request.${action}`, subjectKind: 'crm_billing_request', subjectId: request.id, details: { step: finance ? 'finance' : 'reviewer' } })
  return commercialResult(command.kind, { request: await readBilling(client, context.workspaceId, request.id) })
}

async function cancelBilling(tx: CrmOperationsTransaction, command: Command<'cancel_billing_request'>): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  const request = await lockBilling(tx, command.requestId)
  if (request.version !== command.expectedVersion) refuse('conflict', 'The billing request changed. Reread it first.', { reason: 'stale_version', currentVersion: request.version })
  if (['invoiced', 'cancelled'].includes(request.state)) refuse('invalid_transition', 'This billing request can no longer be cancelled.', { state: request.state })
  await client.query(`UPDATE crm_billing_requests SET state='cancelled',review_step=NULL,return_reason=$3,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`, [context.workspaceId, request.id, command.reason])
  await commercialAudit(tx, context, { action: 'crm.billing_request.cancelled', subjectKind: 'crm_billing_request', subjectId: request.id })
  return commercialResult(command.kind, { request: await readBilling(client, context.workspaceId, request.id) })
}

/** Close a ready billing request against an invoice allocation, exactly once. */
export async function closeBillingRequest(client: PoolClient, workspaceId: string, requestId: string, invoiceId: string, dealId: string, amount: string, currency: string): Promise<void> {
  const request = (await client.query<BillingRow>(`SELECT ${BILLING_COLUMNS} FROM crm_billing_requests b WHERE b.workspace_id=$1 AND b.id=$2 FOR UPDATE`, [workspaceId, requestId])).rows[0]
  if (!request || request.dealId !== dealId) refuse('invalid_input', 'The billing request does not belong to this deal.', { reason: 'billing_request_mismatch' })
  if (request.state !== 'ready_to_bill') refuse('invalid_transition', 'Only a ready-to-bill request can be invoiced.', { reason: 'billing_request_not_ready', state: request.state })
  if (request.currency !== currency || crmDecimalCompare(request.amount, amount) !== 0) {
    refuse('conflict', 'The allocation does not match the reviewed billing amount.', { reason: 'billing_amount_mismatch', expected: { amount: request.amount, currency: request.currency } })
  }
  await client.query(`UPDATE crm_billing_requests SET state='invoiced',invoice_id=$3,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`, [workspaceId, requestId, invoiceId])
}

/** A voided invoice no longer bills its requests: they return to ready to bill and the allocation keeps its history without the link. */
export async function reopenBillingRequestsForInvoice(client: PoolClient, workspaceId: string, invoiceId: string): Promise<number> {
  const reopened = await client.query(`UPDATE crm_billing_requests SET state='ready_to_bill',invoice_id=NULL,version=version+1,updated_at=now()
    WHERE workspace_id=$1 AND invoice_id=$2 AND state='invoiced'`, [workspaceId, invoiceId])
  await client.query('UPDATE crm_invoice_allocations SET billing_request_id=NULL WHERE workspace_id=$1 AND invoice_id=$2 AND billing_request_id IS NOT NULL', [workspaceId, invoiceId])
  return reopened.rowCount ?? 0
}

async function recordExternalInvoice(tx: CrmOperationsTransaction, command: Command<'record_external_invoice'>): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  const access = await tx.commercial().actorAccess()
  const account = await lockAccount(client, context.workspaceId, command.accountId, access)
  if (!account) unavailable()
  const existing = (await client.query<{ id: string }>(`SELECT id FROM crm_invoices WHERE workspace_id=$1 AND origin='external' AND external_provider=$2 AND external_remote_id=$3`,
    [context.workspaceId, command.provider, command.remoteId])).rows[0]
  if (existing) return commercialResult(command.kind, { invoiceId: existing.id }, { duplicate: true })
  let envelope = { sensitivity: account.sensitivity, compartments: account.compartments, projectIds: account.projectIds }
  let sum = '0'
  for (const allocation of command.allocations) {
    const deal = await readTarget(tx, 'deal', allocation.dealId, 'read')
    if (deal.attributes.company_id !== account.companyId) refuse('invalid_input', 'Every allocated deal must belong to the account company.', { reason: 'deal_outside_account' })
    envelope = { sensitivity: maxSensitivity(envelope.sensitivity, deal.sensitivity), compartments: unionScopeRequirements(envelope.compartments, deal.compartments ?? []) ?? [],
      projectIds: unionScopeRequirements(envelope.projectIds, deal.projectIds ?? []) ?? [] }
    sum = crmDecimalAdd(sum, allocation.amount, 6)
  }
  if (crmDecimalCompare(sum, command.total) !== 0) refuse('invalid_input', 'Allocations must add up to the invoice total.', { reason: 'allocation_total_mismatch' })
  const invoiceId = (await client.query<{ id: string }>(`INSERT INTO crm_invoices(workspace_id,origin,seller_id,account_id,state,number,issue_date,currency,total,subtotal,
      external_provider,external_remote_id,issued_at,sensitivity,compartments,project_ids)
    VALUES($1,'external',$2,$3,'issued',$4,$5::date,$6,$7,$7,$8,$9,now(),$10,$11,$12) RETURNING id`,
  [context.workspaceId, account.sellerId, account.id, command.number, command.issueDate, command.currency, command.total, command.provider, command.remoteId,
    envelope.sensitivity, envelope.compartments, envelope.projectIds])).rows[0]!.id
  for (const allocation of command.allocations) {
    if (allocation.billingRequestId) await closeBillingRequest(client, context.workspaceId, allocation.billingRequestId, invoiceId, allocation.dealId, allocation.amount, command.currency)
    await client.query(`INSERT INTO crm_invoice_allocations(workspace_id,invoice_id,deal_id,amount,currency,billing_request_id) VALUES($1,$2,$3,$4,$5,$6)`,
      [context.workspaceId, invoiceId, allocation.dealId, allocation.amount, command.currency, allocation.billingRequestId ?? null])
  }
  await commercialAudit(tx, context, { action: 'crm.invoice.external_recorded', subjectKind: 'crm_invoice', subjectId: invoiceId, details: { provider: command.provider } })
  return commercialResult(command.kind, { invoiceId }, { created: true })
}

async function correctExternalInvoice(tx: CrmOperationsTransaction, command: Command<'correct_external_invoice_reference'>): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  const access = await tx.commercial().actorAccess()
  const scope = commercialVisibility(access.userId, context.workspaceId, 'i', 3, 'mutation', access)
  const invoice = (await client.query<{ id: string; origin: string; version: number; number: string }>(`SELECT id,origin,version,number FROM crm_invoices i
    WHERE i.workspace_id=$1 AND i.id=$2 AND ${scope.sql} FOR UPDATE OF i`, [context.workspaceId, command.invoiceId, ...scope.params])).rows[0]
  if (!invoice) unavailable()
  if (invoice.origin !== 'external') refuse('invalid_transition', 'Issued native invoices keep their own immutable history; void and reissue instead.')
  if (invoice.version !== command.expectedVersion) refuse('conflict', 'The invoice changed. Reread it first.', { reason: 'stale_version', currentVersion: invoice.version })
  for (const requestId of command.reopenBillingRequestIds) {
    const moved = await client.query(`UPDATE crm_invoice_allocations SET billing_request_id=NULL WHERE workspace_id=$1 AND invoice_id=$2 AND billing_request_id=$3`,
      [context.workspaceId, invoice.id, requestId])
    if (!moved.rowCount) refuse('invalid_input', 'That billing request is not allocated to this invoice.', { reason: 'billing_request_mismatch' })
    await client.query(`UPDATE crm_billing_requests SET state='ready_to_bill',invoice_id=NULL,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`, [context.workspaceId, requestId])
  }
  if (command.number) await client.query(`UPDATE crm_invoices SET number=$3,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`, [context.workspaceId, invoice.id, command.number])
  else await client.query(`UPDATE crm_invoices SET version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`, [context.workspaceId, invoice.id])
  await commercialAudit(tx, context, { action: 'crm.invoice.external_corrected', subjectKind: 'crm_invoice', subjectId: invoice.id,
    details: { formerNumber: invoice.number, number: command.number ?? invoice.number, reopened: command.reopenBillingRequestIds.length, reason: command.reason } })
  return commercialResult(command.kind, { invoiceId: invoice.id })
}

export async function executeCrmGovernedCommand(tx: CrmOperationsTransaction, command: CrmGovernedCommand, now: Date): Promise<CommercialResult> {
  const occurredAt = now.toISOString()
  return withOperationReceipt(tx, command, async () => {
    switch (command.kind) {
      case 'save_change_request': return saveChangeRequest(tx, command)
      case 'submit_change_request': return submitChangeRequest(tx, command, occurredAt, command.operationId)
      case 'decide_change_request': return decideChangeRequest(tx, command, occurredAt)
      case 'withdraw_change_request': return withdrawChangeRequest(tx, command)
      case 'update_engagement_tracking': return updateTracking(tx, command)
      case 'set_commercial_values': return setCommercialValues(tx, command)
      case 'commit_recurring_successors': return commitSuccessors(tx, command)
      case 'save_governance_policy': return savePolicy(tx, command)
      case 'save_engagement_catalog': return saveCatalog(tx, command)
      case 'create_billing_request': return createBilling(tx, command)
      case 'decide_billing_request': return decideBilling(tx, command)
      case 'cancel_billing_request': return cancelBilling(tx, command)
      case 'record_external_invoice': return recordExternalInvoice(tx, command)
      case 'correct_external_invoice_reference': return correctExternalInvoice(tx, command)
    }
  })
}
