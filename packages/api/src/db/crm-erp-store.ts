/**
 * ERP bridge reads: the binding with its explicit capability catalog, staged
 * import reports, cutover runs, legacy-id lookup and the versioned projection
 * feed. Projections are built live under the reader's current access and never
 * carry fees or billing; a subject the reader cannot see is skipped, and a
 * removed one is a tombstone that keeps only identity. Also resolves an
 * enrolled ERP viewer to the member it was enrolled by.
 * Spec: docs/architecture/features/crm-commercial-operations.md -> ERP bridge
 *
 * [COMP:crm/erp-bridge]
 */

import type { QueryResultRow } from 'pg'
import { CRM_ERP_CAPABILITIES, CrmOperationsError, type CrmErpReadPort } from '@use-brian/core'
import { query } from './client.js'
import { commercialVisibility } from './crm-commercial-context-store.js'

type Row = QueryResultRow & Record<string, unknown>
type Run = <T extends QueryResultRow>(sql: string, values: unknown[]) => Promise<{ rows: T[] }>

function entityVisibility(userId: string, workspaceId: string, alias: string, startIdx: number) {
  const scope = commercialVisibility(userId, workspaceId, alias, startIdx)
  return { ...scope, sql: `${alias}.valid_to IS NULL AND ${alias}.retracted_at IS NULL AND NOT ${alias}.scope_held AND ${scope.sql}` }
}

const BRIDGE_COMMANDS = ['stage_erp_import', 'confirm_erp_import', 'record_projection_receipt', 'prepare_erp_cutover', 'commit_erp_cutover', 'enroll_erp_viewer',
  'save_change_request', 'submit_change_request', 'decide_change_request', 'update_engagement_tracking', 'commit_recurring_successors',
  'create_billing_request', 'decide_billing_request', 'record_external_invoice', 'correct_external_invoice_reference'] as const
const BRIDGE_READS = ['/erp-bindings/:bindingKey', '/erp-imports/:importId', '/cutovers/:cutoverId', '/legacy-mappings', '/projection-events',
  '/change-requests', '/engagements', '/billing-requests', '/billing-balance', '/recurring-successors/preview'] as const

/** Build fee-free projections for visible subjects; invisible subjects are absent from the map. */
export async function buildCrmProjections(run: Run, workspaceId: string, userId: string, bindingId: string | null, subjectIds: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>()
  if (!subjectIds.length) return out
  const scope = entityVisibility(userId, workspaceId, 'e', 3)
  const subjects = (await run<Row>(`SELECT e.id,e.kind,e.display_name AS name,e.attributes->>'company_id' AS "companyId",
      x.work_status AS "workStatus",x.service_category AS "serviceCategory",to_char(x.period_start,'YYYY-MM-DD') AS "periodStart",
      to_char(x.period_end,'YYYY-MM-DD') AS "periodEnd",x.financial_period AS "financialPeriod",x.owner_user_id AS "ownerUserId",
      coalesce(x.participant_ids,'{}') AS "participantIds",x.recurrence_parent_deal_id AS "recurrenceParentDealId",x.recurrence_period_key AS "recurrencePeriodKey"
    FROM entities e LEFT JOIN crm_engagement_extensions x ON x.workspace_id=e.workspace_id AND x.deal_id=e.id
    WHERE e.workspace_id=$1 AND e.id=ANY($2::uuid[]) AND e.kind IN('company','deal') AND ${scope.sql}`, [workspaceId, subjectIds, ...scope.params])).rows
  const ids = [...new Set([...subjects.map((row) => String(row.id)), ...subjects.map((row) => row.companyId).filter(Boolean).map(String)])]
  const clientScope = entityVisibility(userId, workspaceId, 'e', 3)
  const companies = (await run<Row>(`SELECT e.id,e.display_name AS name FROM entities e WHERE e.workspace_id=$1 AND e.id=ANY($2::uuid[]) AND e.kind='company' AND ${clientScope.sql}`,
    [workspaceId, ids, ...clientScope.params])).rows
  const references = (await run<Row>(`SELECT r.target_id AS "targetId",d.definition_key AS "definitionKey",r.printable_value AS value,r.status
    FROM crm_business_references r JOIN crm_reference_definitions d ON d.workspace_id=r.workspace_id AND d.id=r.definition_id
    WHERE r.workspace_id=$1 AND r.target_id=ANY($2::uuid[]) ORDER BY r.created_at,r.id`, [workspaceId, ids])).rows
  const legacy = bindingId ? (await run<Row>(`SELECT target_id AS "targetId",legacy_id AS "legacyId" FROM crm_legacy_id_mappings
    WHERE binding_id=$1 AND target_id=ANY($2::uuid[]) AND legacy_type IN('client','engagement') ORDER BY legacy_id`, [bindingId, ids])).rows : []
  const codes = (targetId: string) => ({
    current: references.filter((row) => row.targetId === targetId && row.status === 'active').map((row) => ({ definitionKey: row.definitionKey, value: row.value })),
    former: references.filter((row) => row.targetId === targetId && row.status !== 'active').map((row) => ({ definitionKey: row.definitionKey, value: row.value })),
  })
  const legacyIds = (targetId: string) => legacy.filter((row) => row.targetId === targetId).map((row) => String(row.legacyId))
  for (const subject of subjects) {
    const id = String(subject.id)
    if (subject.kind === 'company') {
      out.set(id, { subjectKind: 'company', subjectId: id, name: subject.name, codes: codes(id), legacyIds: legacyIds(id) })
      continue
    }
    const company = companies.find((row) => row.id === subject.companyId)
    out.set(id, { subjectKind: 'deal', subjectId: id, name: subject.name, codes: codes(id), legacyIds: legacyIds(id),
      client: company ? { id: company.id, name: company.name, codes: codes(String(company.id)), legacyIds: legacyIds(String(company.id)) } : null,
      workStatus: subject.workStatus ?? null, serviceCategory: subject.serviceCategory ?? null, periodStart: subject.periodStart ?? null, periodEnd: subject.periodEnd ?? null,
      financialPeriod: subject.financialPeriod ?? null, ownerUserId: subject.ownerUserId ?? null, participantIds: subject.participantIds ?? [],
      recurrenceParentDealId: subject.recurrenceParentDealId ?? null, recurrencePeriodKey: subject.recurrencePeriodKey ?? null })
  }
  return out
}

export function createCrmErpReadStore(run: Run = query as unknown as Run): CrmErpReadPort & {
  /** Resolve a viewer enrolled on a binding owned by this credential to the member that enrolled it. */
  resolveViewer(workspaceId: string, credentialId: string, bindingKey: string, legacyUserId: string): Promise<{ userId: string; role: 'owner' | 'admin' | 'member' }>
} {
  async function binding(workspaceId: string, bindingKey: string) {
    return (await run<Row>(`SELECT id,binding_key AS "bindingKey",label,integration_credential_id AS "integrationCredentialId",writer_state AS "writerState",
      record_classes AS "recordClasses",reference_definitions AS "referenceDefinitions",version,created_at AS "createdAt",updated_at AS "updatedAt"
      FROM crm_provider_bindings WHERE workspace_id=$1 AND binding_key=$2`, [workspaceId, bindingKey])).rows[0] ?? null
  }
  async function member(workspaceId: string, userId: string) {
    return (await run<{ role: 'owner' | 'admin' | 'member' }>('SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId])).rows[0] ?? null
  }

  return {
    async getBinding(workspaceId, viewer, bindingKey) {
      if (!await member(workspaceId, viewer.userId)) return null
      const found = await binding(workspaceId, bindingKey)
      if (!found) return null
      const [mapped, cutovers, imports, enrolled] = await Promise.all([
        run<Row>(`SELECT legacy_type AS "legacyType",count(*)::int AS count FROM crm_legacy_id_mappings WHERE binding_id=$1 AND status='active' GROUP BY legacy_type ORDER BY legacy_type`, [found.id]),
        run<Row>(`SELECT id,state,version,created_at AS "createdAt",committed_at AS "committedAt" FROM crm_cutover_runs WHERE binding_id=$1 ORDER BY created_at DESC LIMIT 5`, [found.id]),
        run<Row>(`SELECT id,state,report_hash AS "reportHash",created_at AS "createdAt",confirmed_at AS "confirmedAt" FROM crm_erp_imports WHERE binding_id=$1 ORDER BY created_at DESC LIMIT 5`, [found.id]),
        run<Row>(`SELECT legacy_id AS "legacyUserId" FROM crm_legacy_id_mappings WHERE binding_id=$1 AND legacy_type='viewer' AND target_id=$2 AND status='active'`, [found.id, viewer.userId]),
      ])
      return { schemaVersion: 1, binding: found, capabilities: { journeys: CRM_ERP_CAPABILITIES, commands: BRIDGE_COMMANDS, reads: BRIDGE_READS,
        legacyWritesAllowed: found.writerState === 'legacy' }, mapped: mapped.rows, recentCutovers: cutovers.rows, recentImports: imports.rows,
        viewerEnrollment: enrolled.rows[0] ?? null }
    },

    async getImport(workspaceId, viewer, importId) {
      if (!await member(workspaceId, viewer.userId)) return null
      return (await run<Row>(`SELECT i.id,b.binding_key AS "bindingKey",i.state,i.records_hash AS "recordsHash",i.report,i.report_hash AS "reportHash",i.outcome,
        i.version,i.staged_by_kind AS "stagedByKind",i.created_at AS "createdAt",i.confirmed_at AS "confirmedAt"
        FROM crm_erp_imports i JOIN crm_provider_bindings b ON b.id=i.binding_id WHERE i.workspace_id=$1 AND i.id=$2`, [workspaceId, importId])).rows[0] ?? null
    },

    async getCutover(workspaceId, viewer, cutoverId) {
      if (!await member(workspaceId, viewer.userId)) return null
      return (await run<Row>(`SELECT c.id,b.binding_key AS "bindingKey",c.state,c.record_classes AS "recordClasses",c.source,c.reconciliation,c.final_delta AS "finalSource",
        c.version,c.created_at AS "createdAt",c.committed_at AS "committedAt" FROM crm_cutover_runs c JOIN crm_provider_bindings b ON b.id=c.binding_id
        WHERE c.workspace_id=$1 AND c.id=$2`, [workspaceId, cutoverId])).rows[0] ?? null
    },

    async lookupMapping(workspaceId, viewer, input) {
      const found = await binding(workspaceId, input.bindingKey)
      if (!found) return null
      const row = (await run<Row>(`SELECT legacy_type AS "legacyType",legacy_id AS "legacyId",target_kind AS "targetKind",target_id AS "targetId",status
        FROM crm_legacy_id_mappings WHERE binding_id=$1 AND legacy_type=$2 AND ${input.legacyId !== undefined ? 'legacy_id=$3' : 'target_id=$3::uuid'}`,
      [found.id, input.legacyType, input.legacyId ?? input.targetId])).rows[0]
      if (!row) return null
      // A mapping is only as visible as its canonical record.
      const projection = (await buildCrmProjections(run, workspaceId, viewer.userId, String(found.id), [String(row.targetId)])).get(String(row.targetId))
      if (!projection) return null
      const version = (await run<{ v: number | null }>('SELECT max(version) AS v FROM crm_projection_events WHERE workspace_id=$1 AND subject_id=$2',
        [workspaceId, row.targetId])).rows[0]?.v ?? 0
      return { schemaVersion: 1, mapping: row, projection, version }
    },

    async listProjectionEvents(workspaceId, viewer, input) {
      const found = await binding(workspaceId, input.bindingKey)
      if (!found) throw new CrmOperationsError('not_found', 'The ERP binding is not configured in this workspace.')
      const rows = (await run<Row>(`SELECT seq::text AS seq,subject_kind AS "subjectKind",subject_id AS "subjectId",version,tombstone,created_at AS "createdAt",
        (SELECT max(version) FROM crm_projection_events v WHERE v.workspace_id=p.workspace_id AND v.subject_id=p.subject_id) AS "currentVersion"
        FROM crm_projection_events p WHERE p.workspace_id=$1 AND p.seq>$2::bigint ORDER BY p.seq LIMIT $3`, [workspaceId, input.cursor ?? '0', input.limit])).rows
      const projections = await buildCrmProjections(run, workspaceId, viewer.userId, String(found.id), [...new Set(rows.map((row) => String(row.subjectId)))])
      const legacy = (await run<Row>(`SELECT target_id AS "targetId",legacy_id AS "legacyId" FROM crm_legacy_id_mappings WHERE binding_id=$1 AND target_id=ANY($2::uuid[])`,
        [found.id, rows.map((row) => row.subjectId)])).rows
      const events = rows.flatMap((row): Array<Record<string, unknown>> => {
        const projection = projections.get(String(row.subjectId))
        // Tombstones keep identity so local history can still resolve; everything else needs current access.
        if (row.tombstone) return [{ seq: row.seq, subjectKind: row.subjectKind, subjectId: row.subjectId, version: row.version, currentVersion: row.currentVersion,
          tombstone: true, legacyIds: legacy.filter((item) => item.targetId === row.subjectId).map((item) => item.legacyId) }]
        if (!projection) return []
        return [{ seq: row.seq, subjectKind: row.subjectKind, subjectId: row.subjectId, version: row.version, currentVersion: row.currentVersion, tombstone: false, projection }]
      })
      return { schemaVersion: 1, events, nextCursor: rows.length === input.limit ? String(rows[rows.length - 1]!.seq) : null }
    },

    async resolveViewer(workspaceId, credentialId, bindingKey, legacyUserId) {
      const found = await binding(workspaceId, bindingKey)
      if (!found || found.integrationCredentialId !== credentialId) throw new CrmOperationsError('not_authorized', 'This credential does not own the ERP binding.')
      const row = (await run<{ userId: string }>(`SELECT target_id AS "userId" FROM crm_legacy_id_mappings WHERE binding_id=$1 AND legacy_type='viewer' AND legacy_id=$2 AND status='active'`,
        [found.id, legacyUserId])).rows[0]
      if (!row) throw new CrmOperationsError('not_authorized', 'This ERP user is not enrolled. Ask them to enroll from the CRM while signed in.')
      const current = await member(workspaceId, row.userId)
      if (!current) throw new CrmOperationsError('not_authorized', 'The enrolled member is no longer in this workspace.')
      return { userId: row.userId, role: current.role }
    },
  }
}
