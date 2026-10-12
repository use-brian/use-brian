/**
 * PostgreSQL storage for commercial preparations, their immutable versions,
 * typed invoices, frozen lines and allocations, and issue attempts; plus the
 * scoped read store. Writers take the caller's canonical transaction client.
 * Spec: docs/architecture/features/crm-commercial-operations.md -> Invoice preparation
 *
 * [COMP:crm/invoice-preparation]
 */

import type { PoolClient, QueryResultRow } from 'pg'
import {
  CrmOperationsError,
  type AccessContext,
  type CrmCommercialDocumentReadPort,
} from '@use-brian/core'
import { query } from './client.js'
import { commercialVisibility, type CrmScopeEnvelope } from './crm-commercial-context-store.js'
import { queryCrmPage } from '../crm-operations/pagination.js'

type Row = QueryResultRow & Record<string, unknown>
type Run = <T extends QueryResultRow>(sql: string, values: unknown[]) => Promise<{ rows: T[] }>
type Actor = { kind: string; id: string; userId: string | null }

export type CrmPreparationRow = CrmScopeEnvelope & {
  id: string; operationDefinitionId: string; operationVersionId: string; operationKind: 'invoice' | 'proposal'
  accountId: string; sellerId: string; title: string
  state: 'draft' | 'ready' | 'issue_pending' | 'issue_failed' | 'issued' | 'voided'
  version: number; readyVersion: number | null; readyByUserId: string | null
  officeArtifactId: string | null; officeVersion: number | null
  officeBinding: { version: number; cells: Array<{ token: string; sheetId: string; cellId: string; address: string }> } | null
  draftRenderError: string | null; createdAt: string; updatedAt: string
}
export type CrmPreparationVersionRow = {
  id: string; preparationId: string; version: number; content: Record<string, unknown>; resolution: Record<string, unknown>
  totals: Record<string, unknown> | null; questions: Array<Record<string, unknown>>; draftReady: boolean; issueReady: boolean
  sourceHash: string; contentHash: string; actorKind: string; actorId: string; actorUserId: string | null; createdAt: string
}
export type CrmInvoiceRow = CrmScopeEnvelope & {
  id: string; origin: 'native' | 'external'; preparationId: string | null; sellerId: string; accountId: string
  state: CrmPreparationRow['state']; number: string | null; referenceId: string | null; issueDate: string | null
  currency: string | null; minorUnits: number | null; subtotal: string | null; taxRate: string | null; taxAmount: string | null; total: string | null
  frozenPayload: Record<string, unknown> | null; frozenHash: string | null; externalProvider: string | null; externalRemoteId: string | null
  officeArtifactId: string | null; officeVersion: number | null; xlsxReleaseId: string | null; xlsxFileId: string | null; xlsxSha256: string | null
  pdfReleaseId: string | null; pdfFileId: string | null; pdfSha256: string | null; pdfPageCount: number | null
  issuedAt: string | null; voidedAt: string | null; voidReason: string | null; version: number; createdAt: string; updatedAt: string
}

const iso = (value: unknown) => value ? new Date(value as string).toISOString() : null
const PREPARATION_COLUMNS = `p.id,p.operation_definition_id AS "operationDefinitionId",p.operation_version_id AS "operationVersionId",
  p.operation_kind AS "operationKind",p.account_id AS "accountId",p.seller_id AS "sellerId",p.title,p.state,p.version,
  p.ready_version AS "readyVersion",p.ready_by_user_id AS "readyByUserId",p.office_artifact_id AS "officeArtifactId",
  p.office_version AS "officeVersion",p.office_binding AS "officeBinding",p.draft_render_error AS "draftRenderError",
  p.sensitivity,p.compartments,p.project_ids AS "projectIds",p.created_at AS "createdAt",p.updated_at AS "updatedAt"`
const VERSION_COLUMNS = `v.id,v.preparation_id AS "preparationId",v.version,v.content,v.resolution,v.totals,v.questions,
  v.draft_ready AS "draftReady",v.issue_ready AS "issueReady",v.source_hash AS "sourceHash",v.content_hash AS "contentHash",
  v.actor_kind AS "actorKind",v.actor_id AS "actorId",v.actor_user_id AS "actorUserId",v.created_at AS "createdAt"`
const INVOICE_COLUMNS = `i.id,i.origin,i.preparation_id AS "preparationId",i.seller_id AS "sellerId",i.account_id AS "accountId",i.state,i.number,
  i.reference_id AS "referenceId",to_char(i.issue_date,'YYYY-MM-DD') AS "issueDate",i.currency,i.minor_units AS "minorUnits",
  i.subtotal::text AS subtotal,i.tax_rate::text AS "taxRate",i.tax_amount::text AS "taxAmount",i.total::text AS total,
  i.frozen_payload AS "frozenPayload",i.frozen_hash AS "frozenHash",i.external_provider AS "externalProvider",i.external_remote_id AS "externalRemoteId",
  i.office_artifact_id AS "officeArtifactId",i.office_version AS "officeVersion",i.xlsx_release_id AS "xlsxReleaseId",i.xlsx_file_id AS "xlsxFileId",
  i.xlsx_sha256 AS "xlsxSha256",i.pdf_release_id AS "pdfReleaseId",i.pdf_file_id AS "pdfFileId",i.pdf_sha256 AS "pdfSha256",
  i.pdf_page_count AS "pdfPageCount",i.issued_at AS "issuedAt",i.voided_at AS "voidedAt",i.void_reason AS "voidReason",
  i.sensitivity,i.compartments,i.project_ids AS "projectIds",i.version,i.created_at AS "createdAt",i.updated_at AS "updatedAt"`

function money(value: unknown, minorUnits: number | null): string | null {
  if (value === null || value === undefined) return null
  const text = String(value)
  if (minorUnits === null) return text
  const [whole, fraction = ''] = text.split('.')
  return minorUnits ? `${whole}.${(fraction + '0'.repeat(minorUnits)).slice(0, minorUnits)}` : whole!
}
const preparationRow = (row: Row): CrmPreparationRow => ({ ...(row as unknown as CrmPreparationRow), createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! })
const versionRow = (row: Row): CrmPreparationVersionRow => ({ ...(row as unknown as CrmPreparationVersionRow), createdAt: iso(row.createdAt)! })
function invoiceRow(row: Row): CrmInvoiceRow {
  const units = row.minorUnits === null ? null : Number(row.minorUnits)
  return {
    ...(row as unknown as CrmInvoiceRow), minorUnits: units,
    subtotal: money(row.subtotal, units), taxAmount: money(row.taxAmount, units), total: money(row.total, units),
    taxRate: row.taxRate === null ? null : String(Number(row.taxRate)),
    issuedAt: iso(row.issuedAt), voidedAt: iso(row.voidedAt), createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)!,
  }
}

export async function insertPreparation(client: PoolClient, workspaceId: string, row: {
  operationDefinitionId: string; operationVersionId: string; operationKind: string; accountId: string; sellerId: string; title: string
  envelope: CrmScopeEnvelope; actor: Actor
}): Promise<string> {
  return (await client.query<{ id: string }>(`INSERT INTO crm_commercial_preparations(workspace_id,operation_definition_id,operation_version_id,operation_kind,
      account_id,seller_id,title,sensitivity,compartments,project_ids,created_by_kind,created_by_id,created_by_user_id,updated_by_kind,updated_by_id,updated_by_user_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$11,$12,$13) RETURNING id`,
  [workspaceId, row.operationDefinitionId, row.operationVersionId, row.operationKind, row.accountId, row.sellerId, row.title,
    row.envelope.sensitivity, row.envelope.compartments, row.envelope.projectIds, row.actor.kind, row.actor.id, row.actor.userId])).rows[0]!.id
}

export async function lockPreparation(client: PoolClient, workspaceId: string, preparationId: string, access: AccessContext | null, operation: 'read' | 'mutation' = 'mutation'): Promise<CrmPreparationRow | null> {
  const scope = access ? commercialVisibility(access.userId, workspaceId, 'p', 3, operation, access) : { sql: 'TRUE', params: [] as unknown[] }
  const result = await client.query<Row>(`SELECT ${PREPARATION_COLUMNS} FROM crm_commercial_preparations p
    WHERE p.workspace_id=$1 AND p.id=$2 AND ${scope.sql} FOR UPDATE OF p`, [workspaceId, preparationId, ...scope.params])
  return result.rows[0] ? preparationRow(result.rows[0]) : null
}

export async function insertPreparationVersion(client: PoolClient, workspaceId: string, row: {
  preparationId: string; version: number; content: unknown; resolution: unknown; totals: unknown; questions: unknown[]
  draftReady: boolean; issueReady: boolean; sourceHash: string; contentHash: string; operationId: string; actor: Actor
}): Promise<CrmPreparationVersionRow> {
  const inserted = await client.query<Row>(`INSERT INTO crm_preparation_versions(workspace_id,preparation_id,version,content,resolution,totals,questions,
      draft_ready,issue_ready,source_hash,content_hash,operation_id,actor_kind,actor_id,actor_user_id)
    VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
  [workspaceId, row.preparationId, row.version, JSON.stringify(row.content), JSON.stringify(row.resolution), row.totals ? JSON.stringify(row.totals) : null,
    JSON.stringify(row.questions), row.draftReady, row.issueReady, row.sourceHash, row.contentHash, row.operationId, row.actor.kind, row.actor.id, row.actor.userId])
  return (await readPreparationVersion(client, workspaceId, row.preparationId, row.version, inserted.rows[0]!.id as string))!
}

export async function readPreparationVersion(client: PoolClient | { query: Run }, workspaceId: string, preparationId: string, version: number, _id?: string): Promise<CrmPreparationVersionRow | null> {
  const result = await (client as { query: Run }).query<Row>(`SELECT ${VERSION_COLUMNS} FROM crm_preparation_versions v
    WHERE v.workspace_id=$1 AND v.preparation_id=$2 AND v.version=$3`, [workspaceId, preparationId, version])
  return result.rows[0] ? versionRow(result.rows[0]) : null
}

export async function updatePreparation(client: PoolClient, workspaceId: string, preparationId: string, patch: {
  version?: number; state?: CrmPreparationRow['state']; readyVersion?: number | null; ready?: Actor | null
  envelope?: CrmScopeEnvelope; operationVersionId?: string; actor: Actor
}): Promise<void> {
  await client.query(`UPDATE crm_commercial_preparations SET
      version=coalesce($3,version),state=coalesce($4,state),
      ready_version=CASE WHEN $5::boolean THEN $6::int ELSE ready_version END,
      ready_by_kind=CASE WHEN $5::boolean THEN $7 ELSE ready_by_kind END,ready_by_id=CASE WHEN $5::boolean THEN $8 ELSE ready_by_id END,
      ready_by_user_id=CASE WHEN $5::boolean THEN $9::uuid ELSE ready_by_user_id END,ready_at=CASE WHEN $5::boolean THEN (CASE WHEN $6::int IS NULL THEN NULL ELSE now() END) ELSE ready_at END,
      sensitivity=coalesce($10,sensitivity),compartments=coalesce($11,compartments),project_ids=coalesce($12,project_ids),
      operation_version_id=coalesce($13::uuid,operation_version_id),
      updated_by_kind=$14,updated_by_id=$15,updated_by_user_id=$16,updated_at=now()
    WHERE workspace_id=$1 AND id=$2`,
  [workspaceId, preparationId, patch.version ?? null, patch.state ?? null, patch.readyVersion !== undefined, patch.readyVersion ?? null,
    patch.ready?.kind ?? null, patch.ready?.id ?? null, patch.ready?.userId ?? null, patch.envelope?.sensitivity ?? null,
    patch.envelope?.compartments ?? null, patch.envelope?.projectIds ?? null, patch.operationVersionId ?? null,
    patch.actor.kind, patch.actor.id, patch.actor.userId])
}

export async function recordDraftRender(client: PoolClient, workspaceId: string, preparationId: string, version: number, outcome:
  { artifactId: string; officeVersion: number; cells: Array<{ token: string; sheetId: string; cellId: string; address: string }> } | { error: string }): Promise<boolean> {
  const result = 'error' in outcome
    ? await client.query(`UPDATE crm_commercial_preparations SET draft_render_error=$4,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND version=$3`,
      [workspaceId, preparationId, version, outcome.error.slice(0, 500)])
    : await client.query(`UPDATE crm_commercial_preparations SET office_artifact_id=$4,office_version=$5,office_binding=$6::jsonb,draft_render_error=NULL,updated_at=now()
        WHERE workspace_id=$1 AND id=$2 AND version=$3 AND (office_artifact_id IS NULL OR office_artifact_id=$4)`,
      [workspaceId, preparationId, version, outcome.artifactId, outcome.officeVersion, JSON.stringify({ version, cells: outcome.cells })])
  return Boolean(result.rowCount)
}

export async function insertInvoice(client: PoolClient, workspaceId: string, row: { preparationId: string; sellerId: string; accountId: string; envelope: CrmScopeEnvelope }): Promise<string> {
  return (await client.query<{ id: string }>(`INSERT INTO crm_invoices(workspace_id,origin,preparation_id,seller_id,account_id,state,sensitivity,compartments,project_ids)
    VALUES($1,'native',$2,$3,$4,'draft',$5,$6,$7) RETURNING id`, [workspaceId, row.preparationId, row.sellerId, row.accountId,
    row.envelope.sensitivity, row.envelope.compartments, row.envelope.projectIds])).rows[0]!.id
}

export async function lockInvoice(client: PoolClient, workspaceId: string, invoiceId: string, access: AccessContext | null, operation: 'read' | 'mutation' = 'mutation'): Promise<CrmInvoiceRow | null> {
  const scope = access ? commercialVisibility(access.userId, workspaceId, 'i', 3, operation, access) : { sql: 'TRUE', params: [] as unknown[] }
  const result = await client.query<Row>(`SELECT ${INVOICE_COLUMNS} FROM crm_invoices i WHERE i.workspace_id=$1 AND i.id=$2 AND ${scope.sql} FOR UPDATE OF i`,
    [workspaceId, invoiceId, ...scope.params])
  return result.rows[0] ? invoiceRow(result.rows[0]) : null
}

export async function invoiceForPreparation(client: PoolClient, workspaceId: string, preparationId: string): Promise<CrmInvoiceRow | null> {
  const result = await client.query<Row>(`SELECT ${INVOICE_COLUMNS} FROM crm_invoices i WHERE i.workspace_id=$1 AND i.preparation_id=$2 FOR UPDATE OF i`, [workspaceId, preparationId])
  return result.rows[0] ? invoiceRow(result.rows[0]) : null
}

export async function updateInvoiceDraft(client: PoolClient, workspaceId: string, invoiceId: string, params: {
  state: CrmPreparationRow['state']; currency: string | null; minorUnits: number | null; subtotal: string | null; taxRate: string | null; taxAmount: string | null; total: string | null
  envelope: CrmScopeEnvelope
}): Promise<void> {
  await client.query(`UPDATE crm_invoices SET state=$3,currency=$4,minor_units=$5,subtotal=$6,tax_rate=$7,tax_amount=$8,total=$9,
      sensitivity=$10,compartments=$11,project_ids=$12,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`,
  [workspaceId, invoiceId, params.state, params.currency, params.minorUnits, params.subtotal, params.taxRate, params.taxAmount, params.total,
    params.envelope.sensitivity, params.envelope.compartments, params.envelope.projectIds])
}

export async function setInvoiceState(client: PoolClient, workspaceId: string, invoiceId: string, state: CrmPreparationRow['state'], patch: Record<string, unknown> = {}): Promise<void> {
  const columns: Record<string, string> = {
    officeArtifactId: 'office_artifact_id', officeVersion: 'office_version', xlsxReleaseId: 'xlsx_release_id', xlsxFileId: 'xlsx_file_id',
    xlsxSha256: 'xlsx_sha256', pdfReleaseId: 'pdf_release_id', pdfFileId: 'pdf_file_id', pdfSha256: 'pdf_sha256', pdfPageCount: 'pdf_page_count',
    voidReason: 'void_reason',
  }
  const sets: string[] = []
  const values: unknown[] = [workspaceId, invoiceId, state]
  for (const [key, value] of Object.entries(patch)) {
    const column = columns[key]
    if (!column) throw new Error(`Unknown invoice column ${key}`)
    values.push(value); sets.push(`${column}=$${values.length}`)
  }
  if (state === 'issued') sets.push('issued_at=coalesce(issued_at,now())')
  if (state === 'voided') sets.push('voided_at=now()')
  await client.query(`UPDATE crm_invoices SET state=$3${sets.length ? ',' + sets.join(',') : ''},version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`, values)
}

export async function freezeInvoice(client: PoolClient, workspaceId: string, invoiceId: string, params: {
  number: string; referenceId: string; issueDate: string; payload: Record<string, unknown>; hash: string
  lines: Array<{ description: string; quantity: string; unitPrice: string; amount: string; dealId: string | null }>
  allocations: Array<{ dealId: string; amount: string; billingRequestId?: string }>; currency: string
}): Promise<void> {
  await client.query(`UPDATE crm_invoices SET state='issue_pending',number=$3,reference_id=$4,issue_date=$5::date,frozen_payload=$6::jsonb,frozen_hash=$7,
      version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`,
  [workspaceId, invoiceId, params.number, params.referenceId, params.issueDate, JSON.stringify(params.payload), params.hash])
  for (const [index, line] of params.lines.entries()) {
    await client.query(`INSERT INTO crm_invoice_lines(workspace_id,invoice_id,position,description,quantity,unit_price,amount,deal_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [workspaceId, invoiceId, index + 1, line.description, line.quantity, line.unitPrice, line.amount, line.dealId])
  }
  for (const allocation of params.allocations) {
    await client.query(`INSERT INTO crm_invoice_allocations(workspace_id,invoice_id,deal_id,amount,currency,billing_request_id) VALUES($1,$2,$3,$4,$5,$6)`,
      [workspaceId, invoiceId, allocation.dealId, allocation.amount, params.currency, allocation.billingRequestId ?? null])
  }
}

export type CrmIssueAttemptRow = {
  id: string; invoiceId: string; attempt: number; state: 'pending' | 'running' | 'failed' | 'succeeded'; renderUserId: string
  errorCode: string | null; errorDetail: string | null; createdAt: string; finishedAt: string | null
}
const ATTEMPT_COLUMNS = `a.id,a.invoice_id AS "invoiceId",a.attempt,a.state,a.render_user_id AS "renderUserId",a.error_code AS "errorCode",
  a.error_detail AS "errorDetail",a.created_at AS "createdAt",a.finished_at AS "finishedAt"`
const attemptRow = (row: Row): CrmIssueAttemptRow => ({ ...(row as unknown as CrmIssueAttemptRow), createdAt: iso(row.createdAt)!, finishedAt: iso(row.finishedAt) })

export async function enqueueIssueAttempt(client: PoolClient, workspaceId: string, invoiceId: string, operationId: string, renderUserId: string): Promise<CrmIssueAttemptRow> {
  const result = await client.query<Row>(`INSERT INTO crm_issue_attempts(workspace_id,invoice_id,attempt,operation_id,render_user_id)
    SELECT $1,$2,coalesce(max(attempt),0)+1,$3,$4 FROM crm_issue_attempts WHERE workspace_id=$1 AND invoice_id=$2
    RETURNING id,invoice_id AS "invoiceId",attempt,state,render_user_id AS "renderUserId",error_code AS "errorCode",error_detail AS "errorDetail",created_at AS "createdAt",finished_at AS "finishedAt"`,
  [workspaceId, invoiceId, operationId, renderUserId])
  return attemptRow(result.rows[0]!)
}

/** Lease one attempt (pending, or running with an expired lease). */
export async function leaseIssueAttempt(client: PoolClient, attemptId: string | null, leaseToken: string, leaseMs: number): Promise<(CrmIssueAttemptRow & { workspaceId: string }) | null> {
  const result = await client.query<Row>(`UPDATE crm_issue_attempts a SET state='running',lease_token=$2,lease_expires_at=clock_timestamp()+($3::int*interval '1 millisecond'),
      started_at=coalesce(started_at,now())
    WHERE a.id=(SELECT id FROM crm_issue_attempts WHERE ($1::uuid IS NULL OR id=$1) AND (state='pending' OR (state='running' AND lease_expires_at<clock_timestamp()))
      ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING ${ATTEMPT_COLUMNS},a.workspace_id AS "workspaceId"`, [attemptId, leaseToken, leaseMs])
  return result.rows[0] ? { ...attemptRow(result.rows[0]), workspaceId: result.rows[0].workspaceId as string } : null
}

export async function finishIssueAttempt(client: PoolClient, workspaceId: string, attemptId: string, leaseToken: string, outcome: { state: 'failed' | 'succeeded'; errorCode?: string; errorDetail?: string; officeVersion?: number }): Promise<boolean> {
  const result = await client.query(`UPDATE crm_issue_attempts SET state=$4,error_code=$5,error_detail=$6,office_version=$7,finished_at=now(),lease_token=NULL,lease_expires_at=NULL
    WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND state='running'`,
  [workspaceId, attemptId, leaseToken, outcome.state, outcome.errorCode ?? null, outcome.errorDetail?.slice(0, 500) ?? null, outcome.officeVersion ?? null])
  return Boolean(result.rowCount)
}

export async function listAttempts(run: { query: Run } | PoolClient, workspaceId: string, invoiceId: string): Promise<CrmIssueAttemptRow[]> {
  return (await (run as { query: Run }).query<Row>(`SELECT ${ATTEMPT_COLUMNS} FROM crm_issue_attempts a WHERE a.workspace_id=$1 AND a.invoice_id=$2 ORDER BY a.attempt`, [workspaceId, invoiceId])).rows.map(attemptRow)
}

// ── Reads ───────────────────────────────────────────────────────────

export function createCrmCommercialDocumentReadStore(run: Run = query as unknown as Run): CrmCommercialDocumentReadPort {
  async function invoiceDetail(workspaceId: string, invoice: CrmInvoiceRow) {
    const [lines, allocations, attempts] = await Promise.all([
      run<Row>(`SELECT position,description,quantity::text AS quantity,unit_price::text AS "unitPrice",amount::text AS amount,deal_id AS "dealId"
        FROM crm_invoice_lines WHERE workspace_id=$1 AND invoice_id=$2 ORDER BY position`, [workspaceId, invoice.id]),
      run<Row>(`SELECT deal_id AS "dealId",amount::text AS amount,currency,billing_request_id AS "billingRequestId" FROM crm_invoice_allocations WHERE workspace_id=$1 AND invoice_id=$2 ORDER BY deal_id`, [workspaceId, invoice.id]),
      listAttempts({ query: run }, workspaceId, invoice.id),
    ])
    return {
      ...invoice,
      lines: lines.rows.map((line) => ({ ...line, amount: money(line.amount, invoice.minorUnits) })),
      allocations: allocations.rows.map((allocation) => ({ ...allocation, amount: money(allocation.amount, invoice.minorUnits) })),
      attempts,
    }
  }
  return {
    async getPreparation(workspaceId, viewer, preparationId) {
      const scope = commercialVisibility(viewer.userId, workspaceId, 'p', 3)
      const found = await run<Row>(`SELECT ${PREPARATION_COLUMNS} FROM crm_commercial_preparations p WHERE p.workspace_id=$1 AND p.id=$2 AND ${scope.sql}`,
        [workspaceId, preparationId, ...scope.params])
      if (!found.rows[0]) return null
      const preparation = preparationRow(found.rows[0])
      const current = await readPreparationVersion({ query: run }, workspaceId, preparation.id, preparation.version)
      const invoice = await run<Row>(`SELECT ${INVOICE_COLUMNS} FROM crm_invoices i WHERE i.workspace_id=$1 AND i.preparation_id=$2`, [workspaceId, preparation.id])
      return { schemaVersion: 1, preparation, current, invoice: invoice.rows[0] ? await invoiceDetail(workspaceId, invoiceRow(invoice.rows[0])) : null }
    },
    async listInvoices(workspaceId, viewer, input) {
      const scope = commercialVisibility(viewer.userId, workspaceId, 'i', 2)
      const params: unknown[] = [workspaceId, ...scope.params]
      const add = (value: unknown) => { params.push(value); return `$${params.length}` }
      const filters: string[] = []
      if (input.accountId) filters.push(`i.account_id=${add(input.accountId)}`)
      if (input.state) filters.push(`i.state=${add(input.state)}`)
      if (input.number) filters.push(`lower(i.number)=lower(${add(input.number)})`)
      if (input.dealId) filters.push(`EXISTS(SELECT 1 FROM crm_invoice_allocations x WHERE x.workspace_id=i.workspace_id AND x.invoice_id=i.id AND x.deal_id=${add(input.dealId)})`)
      const sql = `SELECT ${INVOICE_COLUMNS} FROM crm_invoices i WHERE i.workspace_id=$1 AND ${scope.sql}${filters.length ? ` AND ${filters.join(' AND ')}` : ''}`
      const page = await queryCrmPage<'invoices', Row>(run, { workspaceId, resource: 'crm_invoices', key: 'invoices', sql, params,
        query: { limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}) } })
      return { schemaVersion: 1, invoices: page.invoices.map((row) => {
        const invoice = invoiceRow(row)
        const { frozenPayload: _payload, ...summary } = invoice
        return summary
      }), nextCursor: page.nextCursor }
    },
    async getInvoice(workspaceId, viewer, invoiceId) {
      const scope = commercialVisibility(viewer.userId, workspaceId, 'i', 3)
      const found = await run<Row>(`SELECT ${INVOICE_COLUMNS} FROM crm_invoices i WHERE i.workspace_id=$1 AND i.id=$2 AND ${scope.sql}`, [workspaceId, invoiceId, ...scope.params])
      return found.rows[0] ? invoiceDetail(workspaceId, invoiceRow(found.rows[0])) : null
    },
  }
}

export function unavailableDocument(): never {
  throw new CrmOperationsError('not_found', 'The record is unavailable in your current scope.')
}
