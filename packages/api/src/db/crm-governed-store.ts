/**
 * Scoped reads for governed client/engagement operations: the change-request
 * queue and history, engagements (deal plus typed tracking), billing requests,
 * the per-currency unbilled balance and the recurring-successor preview. Every
 * row passes its own protection: change requests, billing requests and
 * commercial values carry their own scope envelopes, engagements follow the
 * canonical deal. Protected values appear only when asked for and visible.
 * Spec: docs/architecture/features/crm-commercial-operations.md -> Governed engagement and billing
 *
 * [COMP:crm/governed-records]
 */

import type { QueryResultRow } from 'pg'
import {
  DEFAULT_CRM_REVIEW_POLICIES,
  CRM_GOVERNANCE_SUBJECTS,
  crmDecimalAdd,
  type CrmGovernedReadPort,
} from '@use-brian/core'
import { query } from './client.js'
import { commercialVisibility } from './crm-commercial-context-store.js'
import { queryCrmPage } from '../crm-operations/pagination.js'

type Row = QueryResultRow & Record<string, unknown>
type Run = <T extends QueryResultRow>(sql: string, values: unknown[]) => Promise<{ rows: T[] }>

function entityVisibility(userId: string, workspaceId: string, alias: string, startIdx: number) {
  const scope = commercialVisibility(userId, workspaceId, alias, startIdx)
  return { ...scope, sql: `${alias}.valid_to IS NULL AND ${alias}.retracted_at IS NULL AND NOT ${alias}.scope_held AND ${scope.sql}` }
}

const REQUEST_COLUMNS = `r.id,r.target_kind AS "targetKind",r.target_id AS "targetId",r.applied_target_id AS "appliedTargetId",r.policy_subject AS "policySubject",
  r.state,r.revision,r.draft_changes AS "draftChanges",r.note,r.author_kind AS "authorKind",r.author_user_id AS "authorUserId",r.version,
  r.sensitivity,r.compartments,r.project_ids AS "projectIds",r.created_at AS "createdAt",r.updated_at AS "updatedAt"`
const ENGAGEMENT_COLUMNS = `e.id,e.display_name AS "displayName",e.attributes->>'company_id' AS "companyId",e.attributes->>'stage' AS "pipelineStage",
  e.attributes->>'pipeline_stage_id' AS "pipelineStageId",x.service_category AS "serviceCategory",to_char(x.period_start,'YYYY-MM-DD') AS "periodStart",
  to_char(x.period_end,'YYYY-MM-DD') AS "periodEnd",x.financial_period AS "financialPeriod",x.work_status AS "workStatus",to_char(x.deadline,'YYYY-MM-DD') AS deadline,
  x.owner_user_id AS "ownerUserId",coalesce(x.participant_ids,'{}') AS "participantIds",x.recurrence_parent_deal_id AS "recurrenceParentDealId",
  x.recurrence_period_key AS "recurrencePeriodKey",coalesce(x.version,0) AS "trackingVersion",coalesce(x.created_at,e.created_at) AS "createdAt"`
const BILLING_COLUMNS = `b.id,b.deal_id AS "dealId",b.state,b.review_step AS "reviewStep",b.amount::text AS amount,b.currency,b.description,b.reviewed_values AS "reviewedValues",
  b.author_kind AS "authorKind",b.author_user_id AS "authorUserId",b.reviewed_by_user_id AS "reviewedByUserId",b.reviewed_at AS "reviewedAt",
  b.finance_by_user_id AS "financeByUserId",b.finance_at AS "financeAt",b.invoice_id AS "invoiceId",b.return_reason AS "returnReason",b.version,
  b.created_at AS "createdAt",b.updated_at AS "updatedAt"`
const VALUE_COLUMNS = `v.id,v.deal_id AS "dealId",v.value_kind AS "valueKind",v.version,v.amount::text AS amount,v.currency,v.rate,v.evidence,
  v.actor_kind AS "actorKind",v.actor_user_id AS "actorUserId",v.created_at AS "createdAt"`

/**
 * Historical rows keep the envelope they were created with; a reader must
 * also see the canonical record they concern now, so raising a deal's
 * protection hides its requests and values too.
 */
function currentTarget(userId: string, workspaceId: string, column: string, startIdx: number) {
  const scope = entityVisibility(userId, workspaceId, 't', startIdx)
  return { ...scope, sql: `EXISTS(SELECT 1 FROM entities t WHERE t.workspace_id=$1 AND t.id=${column} AND ${scope.sql})` }
}

const BILLED_STATES = `('issue_pending','issue_failed','issued')`

/** Strip insignificant trailing zeros from a NUMERIC text without changing its value. */
function decimal(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value)
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
}

export function createCrmGovernedReadStore(run: Run = query as unknown as Run): CrmGovernedReadPort {
  async function visibleValues(workspaceId: string, userId: string, dealIds: string[]): Promise<Row[]> {
    if (!dealIds.length) return []
    const scope = commercialVisibility(userId, workspaceId, 'v', 3)
    const target = currentTarget(userId, workspaceId, 'v.deal_id', scope.nextIdx)
    return (await run<Row>(`SELECT ${VALUE_COLUMNS} FROM crm_commercial_values v WHERE v.workspace_id=$1 AND v.deal_id=ANY($2::uuid[]) AND v.status='current' AND ${scope.sql}
      AND ${target.sql} ORDER BY v.deal_id,v.value_kind`, [workspaceId, dealIds, ...scope.params, ...target.params])).rows.map((row) => ({ ...row, amount: decimal(row.amount) }))
  }

  return {
    async listChangeRequests(workspaceId, viewer, input) {
      const scope = commercialVisibility(viewer.userId, workspaceId, 'r', 2)
      const target = currentTarget(viewer.userId, workspaceId, 'coalesce(r.applied_target_id,r.target_id)', scope.nextIdx)
      const params: unknown[] = [workspaceId, ...scope.params, ...target.params]
      const add = (value: unknown) => { params.push(value); return `$${params.length}` }
      const filters: string[] = []
      if (input.state) filters.push(`r.state=${add(input.state)}`)
      if (input.reviewable) filters.push(`r.state='submitted'`)
      if (input.targetId) filters.push(`(r.target_id=${add(input.targetId)} OR r.applied_target_id=$${params.length})`)
      const sql = `SELECT ${REQUEST_COLUMNS} FROM crm_change_requests r WHERE r.workspace_id=$1 AND ${scope.sql}
        AND (coalesce(r.applied_target_id,r.target_id) IS NULL OR ${target.sql})${filters.length ? ` AND ${filters.join(' AND ')}` : ''}`
      const page = await queryCrmPage<'requests', Row>(run, { workspaceId, resource: 'crm_change_requests', key: 'requests', sql, params,
        query: { limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}) } })
      return { schemaVersion: 1, requests: page.requests, nextCursor: page.nextCursor }
    },

    async getChangeRequest(workspaceId, viewer, requestId) {
      const scope = commercialVisibility(viewer.userId, workspaceId, 'r', 3)
      const target = currentTarget(viewer.userId, workspaceId, 'coalesce(r.applied_target_id,r.target_id)', scope.nextIdx)
      const found = (await run<Row>(`SELECT ${REQUEST_COLUMNS} FROM crm_change_requests r WHERE r.workspace_id=$1 AND r.id=$2 AND ${scope.sql}
        AND (coalesce(r.applied_target_id,r.target_id) IS NULL OR ${target.sql})`, [workspaceId, requestId, ...scope.params, ...target.params])).rows[0]
      if (!found) return null
      const [revisions, decisions] = await Promise.all([
        run<Row>(`SELECT revision,changes,current_snapshot AS "currentSnapshot",base_versions AS "baseVersions",policy,policy_version AS "policyVersion",
            payload_hash AS "payloadHash",actor_kind AS "actorKind",actor_user_id AS "actorUserId",created_at AS "createdAt"
          FROM crm_change_request_revisions WHERE workspace_id=$1 AND request_id=$2 ORDER BY revision`, [workspaceId, requestId]),
        run<Row>(`SELECT revision,decision,reason,actor_kind AS "actorKind",actor_user_id AS "actorUserId",created_at AS "createdAt"
          FROM crm_change_request_decisions WHERE workspace_id=$1 AND request_id=$2 ORDER BY created_at,id`, [workspaceId, requestId]),
      ])
      return { schemaVersion: 1, request: found, revisions: revisions.rows, decisions: decisions.rows }
    },

    async listEngagements(workspaceId, viewer, input) {
      const scope = entityVisibility(viewer.userId, workspaceId, 'e', 2)
      const params: unknown[] = [workspaceId, ...scope.params]
      const add = (value: unknown) => { params.push(value); return `$${params.length}` }
      const filters: string[] = [input.dealId ? `e.id=${add(input.dealId)}` : 'x.deal_id IS NOT NULL']
      if (input.companyId) filters.push(`e.attributes->>'company_id'=${add(input.companyId)}`)
      if (input.workStatus) filters.push(`x.work_status=${add(input.workStatus)}`)
      if (input.serviceCategory) filters.push(`x.service_category=${add(input.serviceCategory)}`)
      if (input.financialPeriod) filters.push(`x.financial_period=${add(input.financialPeriod)}`)
      const sql = `SELECT ${ENGAGEMENT_COLUMNS} FROM entities e
        LEFT JOIN crm_engagement_extensions x ON x.workspace_id=e.workspace_id AND x.deal_id=e.id
        WHERE e.workspace_id=$1 AND e.kind='deal' AND ${scope.sql} AND ${filters.join(' AND ')}`
      const page = await queryCrmPage<'engagements', Row>(run, { workspaceId, resource: 'crm_engagements', key: 'engagements', sql, params,
        query: { limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}) } })
      let engagements = page.engagements
      if (input.includeCommercialValues) {
        const values = await visibleValues(workspaceId, viewer.userId, engagements.map((row) => String(row.id)))
        engagements = engagements.map((row) => ({ ...row, commercialValues: values.filter((value) => value.dealId === row.id) }))
      }
      return { schemaVersion: 1, engagements, nextCursor: page.nextCursor }
    },

    async listBillingRequests(workspaceId, viewer, input) {
      const scope = commercialVisibility(viewer.userId, workspaceId, 'b', 2)
      const target = currentTarget(viewer.userId, workspaceId, 'b.deal_id', scope.nextIdx)
      const params: unknown[] = [workspaceId, ...scope.params, ...target.params]
      const add = (value: unknown) => { params.push(value); return `$${params.length}` }
      const filters: string[] = []
      if (input.state) filters.push(`b.state=${add(input.state)}`)
      if (input.dealId) filters.push(`b.deal_id=${add(input.dealId)}`)
      const sql = `SELECT ${BILLING_COLUMNS} FROM crm_billing_requests b WHERE b.workspace_id=$1 AND ${scope.sql} AND ${target.sql}${filters.length ? ` AND ${filters.join(' AND ')}` : ''}`
      const page = await queryCrmPage<'requests', Row>(run, { workspaceId, resource: 'crm_billing_requests', key: 'requests', sql, params,
        query: { limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}) } })
      return { schemaVersion: 1, requests: page.requests.map((row) => ({ ...row, amount: decimal(row.amount) })), nextCursor: page.nextCursor }
    },

    async billingBalance(workspaceId, viewer, input) {
      const deals = entityVisibility(viewer.userId, workspaceId, 'e', 3)
      const dealRows = (await run<Row>(`SELECT e.id,e.display_name AS "displayName" FROM entities e WHERE e.workspace_id=$1 AND e.kind='deal' AND ${deals.sql}
          AND ${input.dealId ? 'e.id=$2' : `e.attributes->>'company_id'=$2::text`} ORDER BY e.created_at,e.id LIMIT 500`,
      [workspaceId, input.dealId ?? input.companyId, ...deals.params])).rows
      const dealIds = dealRows.map((row) => String(row.id))
      const confirmed = (await visibleValues(workspaceId, viewer.userId, dealIds)).filter((value) => value.valueKind === 'confirmed')
      const invoices = commercialVisibility(viewer.userId, workspaceId, 'i', 3)
      const billed = dealIds.length ? (await run<Row>(`SELECT a.deal_id AS "dealId",a.currency,sum(a.amount)::text AS amount FROM crm_invoice_allocations a
          JOIN crm_invoices i ON i.workspace_id=a.workspace_id AND i.id=a.invoice_id
        WHERE a.workspace_id=$1 AND a.deal_id=ANY($2::uuid[]) AND (i.origin='external' OR i.state IN ${BILLED_STATES}) AND i.state<>'voided' AND ${invoices.sql}
        GROUP BY a.deal_id,a.currency ORDER BY a.deal_id,a.currency`, [workspaceId, dealIds, ...invoices.params])).rows : []
      const totals = new Map<string, string[]>()
      const rows = dealRows.map((deal) => {
        const fee = confirmed.find((value) => value.dealId === deal.id) ?? null
        const invoiced = billed.filter((row) => row.dealId === deal.id).map((row) => ({ currency: String(row.currency), amount: decimal(row.amount)! }))
        // A missing confirmed fee is absent, never zero: there is no unbilled figure without one.
        const sameCurrency = fee?.amount != null ? invoiced.find((row) => row.currency === fee.currency) : undefined
        const unbilled = fee?.amount != null ? { currency: String(fee.currency), amount: subtract(String(fee.amount), sameCurrency?.amount ?? '0') } : null
        return { dealId: deal.id, displayName: deal.displayName, confirmedFee: fee && fee.amount != null ? { amount: fee.amount, currency: fee.currency, version: fee.version } : null, billed: invoiced, unbilled }
      })
      for (const row of rows) {
        if (!row.unbilled) continue
        totals.set(row.unbilled.currency, [...(totals.get(row.unbilled.currency) ?? []), row.unbilled.amount])
      }
      const byCurrency = [...totals.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, amounts]) => ({ currency, unbilled: amounts.reduce((sum, value) => add(sum, value), '0') }))
      return { schemaVersion: 1, deals: rows, unbilledByCurrency: byCurrency }
    },

    async previewRecurringSuccessors(workspaceId, viewer, input) {
      const scope = entityVisibility(viewer.userId, workspaceId, 'e', 4)
      const sources = (await run<Row>(`SELECT e.id,e.display_name AS "displayName",e.attributes->>'company_id' AS "companyId",x.deal_id IS NOT NULL AS engagement,
          x.service_category AS "serviceCategory",x.owner_user_id AS "ownerUserId",x.participant_ids AS "participantIds",
          (SELECT s.deal_id FROM crm_engagement_extensions s WHERE s.workspace_id=e.workspace_id AND s.recurrence_parent_deal_id=e.id AND s.recurrence_period_key=$3) AS "existingSuccessorId"
        FROM entities e LEFT JOIN crm_engagement_extensions x ON x.workspace_id=e.workspace_id AND x.deal_id=e.id
        WHERE e.workspace_id=$1 AND e.id=ANY($2::uuid[]) AND e.kind='deal' AND ${scope.sql}`,
      [workspaceId, input.sourceDealIds, input.periodKey, ...scope.params])).rows
      const candidates = [...new Set(input.sourceDealIds)].sort().map((id) => {
        const source = sources.find((row) => row.id === id)
        if (!source) return { sourceDealId: id, outcome: 'stale', reason: 'source_unavailable' }
        if (source.existingSuccessorId) return { sourceDealId: id, outcome: 'existing', dealId: source.existingSuccessorId }
        if (!source.engagement) return { sourceDealId: id, outcome: 'stale', reason: 'source_not_an_engagement' }
        if (!source.companyId) return { sourceDealId: id, outcome: 'stale', reason: 'source_without_company' }
        return { sourceDealId: id, outcome: 'create', proposedName: `${String(source.displayName).replace(/ \([^)]*\)$/, '')} (${input.periodKey})`,
          carryForward: { serviceCategory: source.serviceCategory ?? null, ownerUserId: source.ownerUserId ?? null, participantIds: source.participantIds ?? [] } }
      })
      return { schemaVersion: 1, periodKey: input.periodKey, candidates }
    },

    async listCatalogs(workspaceId) {
      const [catalogs, policies] = await Promise.all([
        run<Row>(`SELECT catalog,entries,version,updated_at AS "updatedAt" FROM crm_engagement_catalogs WHERE workspace_id=$1 ORDER BY catalog`, [workspaceId]),
        run<Row>(`SELECT subject,policy,version,updated_at AS "updatedAt" FROM crm_governance_policies WHERE workspace_id=$1 ORDER BY subject`, [workspaceId]),
      ])
      return {
        schemaVersion: 1,
        catalogs: (['service_category', 'work_status'] as const).map((catalog) => catalogs.rows.find((row) => row.catalog === catalog) ?? { catalog, entries: [], version: 0 }),
        policies: CRM_GOVERNANCE_SUBJECTS.map((subject) => policies.rows.find((row) => row.subject === subject)
          ?? { subject, policy: DEFAULT_CRM_REVIEW_POLICIES[subject], version: 0, default: true }),
      }
    },
  }
}

function add(left: string, right: string): string { return decimal(crmDecimalAdd(left, right, 6))! }
function subtract(left: string, right: string): string { return add(left, right.startsWith('-') ? right.slice(1) : `-${right}`) }
