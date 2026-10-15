/**
 * ERP bridge commands. A provider binding owns writer state for the migrated
 * record classes. Imports are a dry-run report first and are confirmed only
 * against that exact report; confirmation writes through the canonical CRM
 * writers, reference import/replace and protected-value versioning in one
 * transaction, mapping each legacy identity to exactly one canonical target.
 * Projection receipts advance one version at a time. A cutover freezes legacy
 * writes, reconciles counts and the export hash, and commits once.
 * Spec: docs/architecture/features/crm-commercial-operations.md -> ERP bridge
 *
 * [COMP:crm/erp-bridge]
 */

import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import {
  CrmErpImportRecordsSchema,
  crmDecimalAdd,
  crmDecimalCompare,
  crmErpCanonicalRecords,
  crmOperationsSha256,
  crmProjectionReceiptOutcome,
  normalizeCrmBusinessReference,
  type CrmErpCommand,
  type CrmErpImportRecords,
  type CrmOperationsContext,
  type EntityRecord,
} from '@use-brian/core'
import type { CrmOperationsTransaction } from '../db/crm-operations-store.js'
import { createCompany, createDeal, readCrmReference, updateCompany } from '../db/crm.js'
import { updateEntity } from '../db/entities-store.js'
import { readActiveReference, readDefinitionByKey, type CrmReferenceDefinitionRow } from '../db/crm-business-reference-store.js'
import { executeCrmBusinessReferenceCommand, importReferences } from './business-references.js'
import { readEngagement, upsertEngagement, writeCommercialValue } from './governed-records.js'
import { actorColumns, commercialAudit, commercialResult, refuse, withOperationReceipt, type CommercialResult } from './commercial-transaction.js'

type Command<K extends CrmErpCommand['kind']> = Extract<CrmErpCommand, { kind: K }>
type Binding = { id: string; bindingKey: string; integrationCredentialId: string | null; writerState: 'legacy' | 'frozen' | 'brian'; recordClasses: string[]
  referenceDefinitions: { client?: string; engagement?: string }; version: number }
const BINDING_COLUMNS = `id,binding_key AS "bindingKey",integration_credential_id AS "integrationCredentialId",writer_state AS "writerState",
  record_classes AS "recordClasses",reference_definitions AS "referenceDefinitions",version`

async function lockBinding(tx: CrmOperationsTransaction, bindingKey: string): Promise<Binding> {
  const { client, context } = tx.commercial()
  const binding = (await client.query<Binding>(`SELECT ${BINDING_COLUMNS} FROM crm_provider_bindings WHERE workspace_id=$1 AND binding_key=$2 FOR UPDATE`,
    [context.workspaceId, bindingKey])).rows[0]
  if (!binding) refuse('not_found', 'The ERP binding is not configured in this workspace.', { reason: 'binding_unknown' })
  assertBindingCaller(context, binding)
  return binding
}

/** A binding created by one integration credential is used only by that credential (or by members). */
function assertBindingCaller(context: CrmOperationsContext, binding: Binding) {
  const credential = context.authority.integration?.credentialId ?? context.authority.viaCredentialId
  if (credential && binding.integrationCredentialId && binding.integrationCredentialId !== credential) {
    refuse('not_authorized', 'This integration credential does not own the ERP binding.')
  }
}

async function mapping(client: PoolClient, bindingId: string, legacyType: 'client' | 'engagement', legacyId: string) {
  return (await client.query<{ id: string; targetId: string; status: string }>(`SELECT id,target_id AS "targetId",status FROM crm_legacy_id_mappings
    WHERE binding_id=$1 AND legacy_type=$2 AND legacy_id=$3`, [bindingId, legacyType, legacyId])).rows[0] ?? null
}

async function referenceHolder(client: PoolClient, workspaceId: string, definitionId: string, value: string): Promise<string | null> {
  return (await client.query<{ target_id: string }>('SELECT target_id FROM crm_business_references WHERE workspace_id=$1 AND definition_id=$2 AND normalized_value=$3 LIMIT 1',
    [workspaceId, definitionId, normalizeCrmBusinessReference(value)])).rows[0]?.target_id ?? null
}

type PlanRow = { legacyType: 'client' | 'engagement'; legacyId: string; action: 'create' | 'update' | 'unchanged'; targetId: string | null; changes: string[]; recode: boolean }
type Report = {
  schemaVersion: 1
  counts: { client: Record<'create' | 'update' | 'unchanged', number>; engagement: Record<'create' | 'update' | 'unchanged', number> }
  fees: Array<{ kind: 'quoted' | 'confirmed'; currency: string; total: string; engagements: number }>
  conflicts: Array<{ legacyType: string; legacyId: string; reason: string; detail?: string }>
  possibleDuplicates: Array<{ legacyType: string; legacyId: string; existingTargetId: string }>
  rows: PlanRow[]
}

/**
 * The dry run. Identity comes only from explicit legacy ids: an existing
 * record with the same name or code is reported, never merged. Every value a
 * confirmation would write is compared with the canonical record now.
 */
async function planImport(tx: CrmOperationsTransaction, binding: Binding, records: CrmErpImportRecords, definitions: { client?: string; engagement?: string }): Promise<Report> {
  const { client, context } = tx.commercial()
  const access = await tx.commercial().actorAccess()
  const report: Report = { schemaVersion: 1, counts: { client: { create: 0, update: 0, unchanged: 0 }, engagement: { create: 0, update: 0, unchanged: 0 } },
    fees: [], conflicts: [], possibleDuplicates: [], rows: [] }
  const conflict = (legacyType: string, legacyId: string, reason: string, detail?: string) => report.conflicts.push({ legacyType, legacyId, reason, ...(detail ? { detail } : {}) })
  const definitionRows: Partial<Record<'client' | 'engagement', CrmReferenceDefinitionRow | null>> = {}
  for (const kind of ['client', 'engagement'] as const) {
    const key = definitions[kind]
    definitionRows[kind] = key ? await readDefinitionByKey(client, context.workspaceId, key) : null
    if (key && (!definitionRows[kind] || definitionRows[kind]!.status !== 'active')) conflict(kind, '*', 'reference_definition_missing', key)
  }
  const catalog = async (name: 'service_category' | 'work_status') => (await client.query<{ entries: Array<{ key: string; archived?: boolean }> }>(
    'SELECT entries FROM crm_engagement_catalogs WHERE workspace_id=$1 AND catalog=$2', [context.workspaceId, name])).rows[0]?.entries.filter((entry) => !entry.archived).map((entry) => entry.key) ?? []
  const services = await catalog('service_category'), statuses = await catalog('work_status')
  const seenCodes = new Map<string, string>()

  async function codes(kind: 'client' | 'engagement', legacyId: string, targetId: string | null, code: string | null, former: string[]): Promise<boolean> {
    const definition = definitionRows[kind]
    if (!code && !former.length) return false
    if (!definition) { conflict(kind, legacyId, 'reference_definition_missing'); return false }
    let recode = false
    for (const value of [...(code ? [code] : []), ...former]) {
      const normalized = `${definition.id}:${normalizeCrmBusinessReference(value)}`
      if (seenCodes.has(normalized) && seenCodes.get(normalized) !== legacyId) conflict(kind, legacyId, 'code_duplicate_in_import', value)
      seenCodes.set(normalized, legacyId)
      const holder = await referenceHolder(client, context.workspaceId, definition.id, value)
      if (holder && holder !== targetId) conflict(kind, legacyId, 'code_reserved', value)
    }
    if (targetId && code) {
      const active = await readActiveReference(client, context.workspaceId, definition.id, targetId)
      if (active && active.normalizedValue !== normalizeCrmBusinessReference(code)) {
        recode = true
        if (definition.changePolicy !== 'correctable') conflict(kind, legacyId, 'reference_immutable', code)
      }
    }
    return recode
  }

  const clientIds = new Set<string>()
  for (const row of records.clients) {
    if (clientIds.has(row.legacyId)) { conflict('client', row.legacyId, 'duplicate_legacy_id'); continue }
    clientIds.add(row.legacyId)
    const mapped = await mapping(client, binding.id, 'client', row.legacyId)
    let target: EntityRecord | null = null
    if (mapped) {
      target = mapped.status === 'active' ? await readCrmReference(access.userId, context.workspaceId, mapped.targetId, ['company'], access, client).catch(() => null) : null
      if (!target) { conflict('client', row.legacyId, 'mapped_target_unavailable'); continue }
    } else {
      const same = (await client.query<{ id: string }>(`SELECT id FROM entities WHERE workspace_id=$1 AND kind='company' AND valid_to IS NULL AND retracted_at IS NULL
        AND lower(display_name)=lower($2) LIMIT 1`, [context.workspaceId, row.name])).rows[0]
      if (same) report.possibleDuplicates.push({ legacyType: 'client', legacyId: row.legacyId, existingTargetId: same.id })
    }
    const changes: string[] = []
    if (target) {
      if (target.displayName !== row.name) changes.push('name')
      if ((target.attributes.domain ?? null) !== row.domain) changes.push('domain')
    }
    const recode = await codes('client', row.legacyId, target?.id ?? null, row.code, row.formerCodes)
    if (recode) changes.push('code')
    const action = !target ? 'create' : changes.length ? 'update' : 'unchanged'
    report.counts.client[action]++
    report.rows.push({ legacyType: 'client', legacyId: row.legacyId, action, targetId: target?.id ?? null, changes, recode })
  }

  const engagementIds = new Set<string>()
  const fees = new Map<string, { kind: 'quoted' | 'confirmed'; currency: string; total: string; engagements: number }>()
  for (const row of records.engagements) {
    if (engagementIds.has(row.legacyId)) { conflict('engagement', row.legacyId, 'duplicate_legacy_id'); continue }
    engagementIds.add(row.legacyId)
    if (!clientIds.has(row.clientLegacyId) && !(await mapping(client, binding.id, 'client', row.clientLegacyId))) conflict('engagement', row.legacyId, 'client_missing', row.clientLegacyId)
    if (row.serviceCategory && !services.includes(row.serviceCategory)) conflict('engagement', row.legacyId, 'catalog_key_invalid', row.serviceCategory)
    if (row.workStatus && !statuses.includes(row.workStatus)) conflict('engagement', row.legacyId, 'catalog_key_invalid', row.workStatus)
    const mapped = await mapping(client, binding.id, 'engagement', row.legacyId)
    let target: EntityRecord | null = null
    if (mapped) {
      target = mapped.status === 'active' ? await readCrmReference(access.userId, context.workspaceId, mapped.targetId, ['deal'], access, client).catch(() => null) : null
      if (!target) { conflict('engagement', row.legacyId, 'mapped_target_unavailable'); continue }
    }
    const changes: string[] = []
    if (target) {
      if (target.displayName !== row.name) changes.push('name')
      const engagement = await readEngagement(client, context.workspaceId, target.id)
      for (const key of ['serviceCategory', 'workStatus', 'periodStart', 'periodEnd', 'financialPeriod'] as const) {
        if ((engagement?.[key] ?? null) !== row[key]) changes.push(key)
      }
      for (const kind of ['quoted', 'confirmed'] as const) {
        const wanted = row[`${kind}Fee`]
        const current = (await client.query<{ amount: string | null; currency: string }>(`SELECT amount::text AS amount,currency FROM crm_commercial_values
          WHERE workspace_id=$1 AND deal_id=$2 AND value_kind=$3 AND status='current'`, [context.workspaceId, target.id, kind])).rows[0]
        const same = !wanted ? !current : !!current && current.amount !== null && current.currency === wanted.currency && crmDecimalCompare(current.amount, wanted.amount) === 0
        if (!same) changes.push(`${kind}Fee`)
      }
    }
    const recode = await codes('engagement', row.legacyId, target?.id ?? null, row.code, row.formerCodes)
    if (recode) changes.push('code')
    for (const kind of ['quoted', 'confirmed'] as const) {
      const fee = row[`${kind}Fee`]
      if (!fee) continue
      const key = `${kind}:${fee.currency}`
      const entry = fees.get(key) ?? { kind, currency: fee.currency, total: '0', engagements: 0 }
      fees.set(key, { ...entry, total: crmDecimalAdd(entry.total, fee.amount, 6), engagements: entry.engagements + 1 })
    }
    const action = !target ? 'create' : changes.length ? 'update' : 'unchanged'
    report.counts.engagement[action]++
    report.rows.push({ legacyType: 'engagement', legacyId: row.legacyId, action, targetId: target?.id ?? null, changes, recode })
  }
  report.fees = [...fees.values()].sort((a, b) => `${a.kind}:${a.currency}`.localeCompare(`${b.kind}:${b.currency}`))
  return report
}

const reportHash = (report: Report) => crmOperationsSha256(report)
const recordsHash = (records: CrmErpImportRecords) => crmOperationsSha256(crmErpCanonicalRecords(records))

async function stageImport(tx: CrmOperationsTransaction, command: Command<'stage_erp_import'>): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  const actor = actorColumns(context)
  let binding = (await client.query<Binding>(`SELECT ${BINDING_COLUMNS} FROM crm_provider_bindings WHERE workspace_id=$1 AND binding_key=$2 FOR UPDATE`,
    [context.workspaceId, command.bindingKey])).rows[0]
  if (!binding) {
    binding = (await client.query<Binding>(`INSERT INTO crm_provider_bindings(workspace_id,binding_key,label,integration_credential_id,reference_definitions,created_by_kind,created_by_id,created_by_user_id)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8) RETURNING ${BINDING_COLUMNS}`, [context.workspaceId, command.bindingKey, command.label ?? command.bindingKey,
      context.authority.integration?.credentialId ?? context.authority.viaCredentialId ?? null, JSON.stringify(command.referenceDefinitions), actor.kind, actor.id, actor.userId])).rows[0]!
    await commercialAudit(tx, context, { action: 'crm.erp_binding.created', subjectKind: 'crm_provider_binding', subjectId: binding.id, details: { bindingKey: command.bindingKey } })
  } else {
    assertBindingCaller(context, binding)
    if (Object.keys(command.referenceDefinitions).length && JSON.stringify(command.referenceDefinitions) !== JSON.stringify(binding.referenceDefinitions)) {
      await client.query(`UPDATE crm_provider_bindings SET reference_definitions=$3::jsonb,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`,
        [context.workspaceId, binding.id, JSON.stringify(command.referenceDefinitions)])
      binding = { ...binding, referenceDefinitions: command.referenceDefinitions }
    }
  }
  // After cutover the CRM is the only writer of the migrated classes.
  if (binding.writerState === 'brian') refuse('invalid_transition', 'The ERP writer for these records was retired at cutover; change them in the CRM.', { reason: 'writer_retired' })
  const records = crmErpCanonicalRecords(CrmErpImportRecordsSchema.parse(command.records))
  const report = await planImport(tx, binding, records, binding.referenceDefinitions)
  await client.query(`UPDATE crm_erp_imports SET state='superseded',version=version+1 WHERE workspace_id=$1 AND binding_id=$2 AND state='staged'`, [context.workspaceId, binding.id])
  const id = (await client.query<{ id: string }>(`INSERT INTO crm_erp_imports(workspace_id,binding_id,records,records_hash,report,report_hash,staged_by_kind,staged_by_id,staged_by_user_id)
    VALUES($1,$2,$3::jsonb,$4,$5::jsonb,$6,$7,$8,$9) RETURNING id`, [context.workspaceId, binding.id, JSON.stringify(records), recordsHash(records),
    JSON.stringify(report), reportHash(report), actor.kind, actor.id, actor.userId])).rows[0]!.id
  await commercialAudit(tx, context, { action: 'crm.erp_import.staged', subjectKind: 'crm_erp_import', subjectId: id,
    details: { bindingKey: binding.bindingKey, counts: report.counts, conflicts: report.conflicts.length } })
  return commercialResult(command.kind, { importId: id, bindingKey: binding.bindingKey, recordsHash: recordsHash(records), reportHash: reportHash(report), report }, { created: true })
}

async function confirmImport(tx: CrmOperationsTransaction, command: Command<'confirm_erp_import'>): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  const staged = (await client.query<{ id: string; bindingId: string; state: string; records: CrmErpImportRecords; reportHash: string }>(
    `SELECT id,binding_id AS "bindingId",state,records,report_hash AS "reportHash" FROM crm_erp_imports WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
    [context.workspaceId, command.importId])).rows[0]
  if (!staged) refuse('not_found', 'The staged import is unavailable.')
  if (staged.state !== 'staged') refuse('invalid_transition', 'Only the latest staged import can be confirmed.', { state: staged.state })
  const key = (await client.query<{ key: string }>('SELECT binding_key AS key FROM crm_provider_bindings WHERE workspace_id=$1 AND id=$2', [context.workspaceId, staged.bindingId])).rows[0]!.key
  const binding = await lockBinding(tx, key)
  if (binding.writerState === 'brian') refuse('invalid_transition', 'The ERP writer for these records was retired at cutover.', { reason: 'writer_retired' })
  if (staged.reportHash !== command.expectedReportHash) refuse('conflict', 'Confirm the report you reviewed.', { reason: 'stale_import', reportHash: staged.reportHash })
  // The canonical records may have changed since the dry run: the confirmation is valid only for the same plan.
  const report = await planImport(tx, binding, staged.records, binding.referenceDefinitions)
  if (reportHash(report) !== staged.reportHash) refuse('conflict', 'The CRM changed since this import was staged. Stage it again and review the new report.', { reason: 'stale_import' })
  if (report.conflicts.length) refuse('conflict', 'The import has conflicts that need review. Nothing was imported.', { reason: 'import_conflicts', conflicts: report.conflicts.slice(0, 100) })

  const access = await tx.commercial().actorAccess()
  const transaction = { client, afterCommit: (effect: () => void) => tx.commercial().afterCommit(effect) }
  const actor = actorColumns(context)
  const plan = new Map(report.rows.map((row) => [`${row.legacyType}:${row.legacyId}`, row]))
  const targets = new Map<string, string>()
  const addMapping = async (legacyType: 'client' | 'engagement', legacyId: string, targetKind: 'company' | 'deal', targetId: string) => {
    await client.query(`INSERT INTO crm_legacy_id_mappings(workspace_id,binding_id,legacy_type,legacy_id,target_kind,target_id,import_id,created_by_kind,created_by_id,created_by_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [context.workspaceId, binding.id, legacyType, legacyId, targetKind, targetId, staged.id, actor.kind, actor.id, actor.userId])
  }
  const applyCodes = async (kind: 'client' | 'engagement', targetKind: 'company' | 'deal', targetId: string, code: string | null, former: string[], recode: boolean) => {
    const definitionKey = binding.referenceDefinitions[kind]
    if (!definitionKey || (!code && !former.length)) return
    const definition = (await readDefinitionByKey(client, context.workspaceId, definitionKey))!
    if (recode && code) {
      const active = (await readActiveReference(client, context.workspaceId, definition.id, targetId))!
      await executeCrmBusinessReferenceCommand(tx, { kind: 'replace_business_reference', operationId: randomUUID(), referenceId: active.id,
        expectedVersion: active.version, reason: `Recoded by ERP import ${staged.id}`, value: code }, new Date())
      return
    }
    const rows: Array<{ target: { kind: 'company' | 'deal'; id: string }; value: string; status: 'active' | 'retired' }> = []
    for (const value of former) if (!await referenceHolder(client, context.workspaceId, definition.id, value)) rows.push({ target: { kind: targetKind, id: targetId }, value, status: 'retired' })
    if (code && !await readActiveReference(client, context.workspaceId, definition.id, targetId)) rows.push({ target: { kind: targetKind, id: targetId }, value: code, status: 'active' })
    if (rows.length) await importReferences(tx, { kind: 'import_business_references', operationId: randomUUID(), definitionKey, rows, partitionCounters: [] })
  }

  for (const row of staged.records.clients) {
    const step = plan.get(`client:${row.legacyId}`)!
    let targetId = step.targetId
    if (step.action === 'create') {
      targetId = (await createCompany(access.userId, { workspaceId: context.workspaceId, name: row.name, domain: row.domain, access, mergeByName: false }, transaction)).id
      await addMapping('client', row.legacyId, 'company', targetId)
    } else if (step.changes.some((change) => change === 'name' || change === 'domain')) {
      await updateCompany(access.userId, targetId!, { name: row.name, domain: row.domain }, access, client)
    }
    targets.set(`client:${row.legacyId}`, targetId!)
    await applyCodes('client', 'company', targetId!, row.code, row.formerCodes, step.recode)
  }
  const evidence = { source: `erp-import:${binding.bindingKey}`, reason: `Imported by ${staged.id}` }
  const confirmedTotals = new Map<string, string>()
  for (const row of staged.records.engagements) {
    const step = plan.get(`engagement:${row.legacyId}`)!
    const companyId = targets.get(`client:${row.clientLegacyId}`) ?? (await mapping(client, binding.id, 'client', row.clientLegacyId))!.targetId
    let targetId = step.targetId
    if (step.action === 'create') {
      targetId = (await createDeal(access.userId, { workspaceId: context.workspaceId, companyId, access }, undefined, transaction)).id
      await addMapping('engagement', row.legacyId, 'deal', targetId)
    }
    if (step.action === 'create' || step.changes.includes('name')) await updateEntity(access.userId, targetId!, { displayName: row.name }, access, client)
    if (step.action === 'create' || step.changes.some((change) => ['serviceCategory', 'workStatus', 'periodStart', 'periodEnd', 'financialPeriod'].includes(change))) {
      await upsertEngagement(client, context.workspaceId, targetId!, { serviceCategory: row.serviceCategory, workStatus: row.workStatus,
        periodStart: row.periodStart, periodEnd: row.periodEnd, financialPeriod: row.financialPeriod })
    }
    const deal = (await readCrmReference(access.userId, context.workspaceId, targetId!, ['deal'], access, client))!
    for (const kind of ['quoted', 'confirmed'] as const) {
      const fee = row[`${kind}Fee`]
      if (step.action === 'create' ? !fee : !step.changes.includes(`${kind}Fee`)) continue
      const current = (await client.query<{ version: number; currency: string }>(`SELECT version,currency FROM crm_commercial_values WHERE workspace_id=$1 AND deal_id=$2 AND value_kind=$3 AND status='current'`,
        [context.workspaceId, targetId, kind])).rows[0]
      // A fee removed in the source becomes an explicit absence in its last currency, never zero.
      await writeCommercialValue(client, context, { dealId: targetId!, valueKind: kind, expectedVersion: current?.version ?? 0, amount: fee?.amount ?? null,
        currency: fee?.currency ?? current!.currency, evidence, operationId: command.operationId,
        envelope: { sensitivity: 'confidential', compartments: deal.compartments ?? [], projectIds: deal.projectIds ?? [] } })
    }
    if (row.confirmedFee) confirmedTotals.set(row.confirmedFee.currency, crmDecimalAdd(confirmedTotals.get(row.confirmedFee.currency) ?? '0', row.confirmedFee.amount, 6))
    targets.set(`engagement:${row.legacyId}`, targetId!)
    await applyCodes('engagement', 'deal', targetId!, row.code, row.formerCodes, step.recode)
  }

  // Reconcile what the transaction now holds against the reviewed report before it can commit.
  const mappedDeals = staged.records.engagements.map((row) => targets.get(`engagement:${row.legacyId}`)!)
  const stored = mappedDeals.length ? (await client.query<{ currency: string; total: string }>(`SELECT currency,sum(amount)::text AS total FROM crm_commercial_values
    WHERE workspace_id=$1 AND deal_id=ANY($2::uuid[]) AND value_kind='confirmed' AND status='current' AND amount IS NOT NULL GROUP BY currency`, [context.workspaceId, mappedDeals])).rows : []
  for (const [currency, total] of confirmedTotals) {
    const found = stored.find((row) => row.currency === currency)
    if (!found || crmDecimalCompare(found.total, total) !== 0) refuse('conflict', 'Imported fees do not reconcile with the staged report. Nothing was imported.', { reason: 'reconciliation_failed', currency })
  }
  const mapped = (await client.query<{ legacy_type: string; n: number }>(`SELECT legacy_type,count(*)::int AS n FROM crm_legacy_id_mappings
    WHERE binding_id=$1 AND status='active' AND legacy_type IN('client','engagement') GROUP BY legacy_type`, [binding.id])).rows
  const outcome = { counts: report.counts, mappedTotals: Object.fromEntries(mapped.map((row) => [row.legacy_type, row.n])),
    confirmedFees: [...confirmedTotals.entries()].map(([currency, total]) => ({ currency, total })) }
  await client.query(`UPDATE crm_erp_imports SET state='confirmed',outcome=$3::jsonb,confirmed_by_kind=$4,confirmed_by_id=$5,confirmed_by_user_id=$6,confirmed_at=now(),version=version+1
    WHERE workspace_id=$1 AND id=$2`, [context.workspaceId, staged.id, JSON.stringify(outcome), actor.kind, actor.id, actor.userId])
  await commercialAudit(tx, context, { action: 'crm.erp_import.confirmed', subjectKind: 'crm_erp_import', subjectId: staged.id, details: { bindingKey: binding.bindingKey, counts: report.counts } })
  return commercialResult(command.kind, { importId: staged.id, outcome, targets: Object.fromEntries(targets) }, { created: true })
}

async function recordReceipts(tx: CrmOperationsTransaction, command: Command<'record_projection_receipt'>): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  const binding = await lockBinding(tx, command.bindingKey)
  const last = async (subjectId: string) => (await client.query<{ v: number | null }>(`SELECT max(version) AS v FROM crm_projection_receipts WHERE binding_id=$1 AND subject_id=$2`,
    [binding.id, subjectId])).rows[0]?.v ?? 0
  const outcomes: Array<Record<string, unknown>> = []
  for (const receipt of command.receipts) {
    const event = (await client.query<{ subject_id: string; version: number }>('SELECT subject_id,version FROM crm_projection_events WHERE workspace_id=$1 AND seq=$2',
      [context.workspaceId, receipt.eventSeq])).rows[0]
    if (!event || event.subject_id !== receipt.subjectId || event.version !== receipt.version) refuse('invalid_input', 'The receipt does not match a projection event.', { eventSeq: receipt.eventSeq })
    const recorded = await client.query('SELECT 1 FROM crm_projection_receipts WHERE binding_id=$1 AND event_seq=$2', [binding.id, receipt.eventSeq])
    const applied = await last(receipt.subjectId)
    const outcome = recorded.rowCount ? 'duplicate' : crmProjectionReceiptOutcome(applied, receipt.version)
    if (outcome === 'applied') {
      await client.query(`INSERT INTO crm_projection_receipts(workspace_id,binding_id,event_seq,subject_id,version,outcome) VALUES($1,$2,$3,$4,$5,'applied')`,
        [context.workspaceId, binding.id, receipt.eventSeq, receipt.subjectId, receipt.version])
    }
    outcomes.push({ eventSeq: receipt.eventSeq, subjectId: receipt.subjectId, version: receipt.version, outcome,
      ...(outcome === 'resync_required' ? { expectedVersion: applied + 1 } : {}) })
  }
  for (const resync of command.resynced) {
    const latest = (await client.query<{ v: number | null }>('SELECT max(version) AS v FROM crm_projection_events WHERE workspace_id=$1 AND subject_id=$2',
      [context.workspaceId, resync.subjectId])).rows[0]?.v ?? 0
    if (resync.version > latest) refuse('invalid_input', 'A resync cannot claim a version that does not exist yet.', { subjectId: resync.subjectId, latestVersion: latest })
    const applied = await last(resync.subjectId)
    if (resync.version <= applied) { outcomes.push({ subjectId: resync.subjectId, version: resync.version, outcome: 'duplicate' }); continue }
    await client.query(`INSERT INTO crm_projection_receipts(workspace_id,binding_id,subject_id,version,outcome) VALUES($1,$2,$3,$4,'resynced')`,
      [context.workspaceId, binding.id, resync.subjectId, resync.version])
    outcomes.push({ subjectId: resync.subjectId, version: resync.version, outcome: 'resynced' })
  }
  return commercialResult(command.kind, { bindingKey: binding.bindingKey, outcomes }, { created: outcomes.some((row) => row.outcome === 'applied' || row.outcome === 'resynced') })
}

async function reconcile(client: PoolClient, bindingId: string, classes: string[], source: { counts: Record<string, number>; exportHash: string }) {
  const mapped = (await client.query<{ legacy_type: string; n: number }>(`SELECT legacy_type,count(*)::int AS n FROM crm_legacy_id_mappings
    WHERE binding_id=$1 AND status='active' AND legacy_type=ANY($2::text[]) GROUP BY legacy_type`, [bindingId, classes])).rows
  const latest = (await client.query<{ id: string; records_hash: string }>(`SELECT id,records_hash FROM crm_erp_imports WHERE binding_id=$1 AND state='confirmed'
    ORDER BY confirmed_at DESC,id DESC LIMIT 1`, [bindingId])).rows[0] ?? null
  const pending = (await client.query(`SELECT 1 FROM crm_erp_imports WHERE binding_id=$1 AND state='staged'`, [bindingId])).rowCount ?? 0
  const counts = Object.fromEntries(classes.map((kind) => [kind, mapped.find((row) => row.legacy_type === kind)?.n ?? 0]))
  const mismatches = classes.filter((kind) => counts[kind] !== source.counts[kind])
  return { brianCounts: counts, sourceCounts: Object.fromEntries(classes.map((kind) => [kind, source.counts[kind]])), countMismatches: mismatches,
    lastImportId: latest?.id ?? null, exportHashMatches: latest?.records_hash === source.exportHash, pendingStagedImports: pending,
    reconciled: !mismatches.length && latest?.records_hash === source.exportHash && pending === 0 }
}

async function prepareCutover(tx: CrmOperationsTransaction, command: Command<'prepare_erp_cutover'>): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  const binding = await lockBinding(tx, command.bindingKey)
  if (binding.writerState !== 'legacy') refuse('invalid_transition', 'A cutover is already prepared or committed for this binding.', { reason: 'cutover_open', writerState: binding.writerState })
  const reconciliation = await reconcile(client, binding.id, command.recordClasses, command.source)
  const actor = actorColumns(context)
  const id = (await client.query<{ id: string }>(`INSERT INTO crm_cutover_runs(workspace_id,binding_id,record_classes,source,reconciliation,last_import_id,prepared_by_kind,prepared_by_id,prepared_by_user_id)
    VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9) RETURNING id`, [context.workspaceId, binding.id, command.recordClasses, JSON.stringify(command.source),
    JSON.stringify(reconciliation), reconciliation.lastImportId, actor.kind, actor.id, actor.userId])).rows[0]!.id
  // From here the legacy application refuses new writes to these classes; the final delta arrives as an import.
  await client.query(`UPDATE crm_provider_bindings SET writer_state='frozen',record_classes=$3,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`,
    [context.workspaceId, binding.id, command.recordClasses])
  await commercialAudit(tx, context, { action: 'crm.erp_cutover.prepared', subjectKind: 'crm_cutover_run', subjectId: id, details: { bindingKey: binding.bindingKey, reconciliation } })
  return commercialResult(command.kind, { cutoverId: id, state: 'prepared', version: 1, writerState: 'frozen', reconciliation }, { created: true })
}

async function commitCutover(tx: CrmOperationsTransaction, command: Command<'commit_erp_cutover'>): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  const run = (await client.query<{ id: string; bindingId: string; state: string; version: number; recordClasses: string[] }>(`SELECT id,binding_id AS "bindingId",state,version,
    record_classes AS "recordClasses" FROM crm_cutover_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [context.workspaceId, command.cutoverId])).rows[0]
  if (!run) refuse('not_found', 'The cutover run is unavailable.')
  if (run.state !== 'prepared') refuse('invalid_transition', 'Only a prepared cutover can be committed.', { state: run.state })
  if (run.version !== command.expectedVersion) refuse('conflict', 'The cutover changed. Reread it first.', { reason: 'stale_version', currentVersion: run.version })
  const key = (await client.query<{ key: string }>('SELECT binding_key AS key FROM crm_provider_bindings WHERE workspace_id=$1 AND id=$2', [context.workspaceId, run.bindingId])).rows[0]!.key
  const binding = await lockBinding(tx, key)
  const reconciliation = await reconcile(client, binding.id, run.recordClasses, command.finalSource)
  // A commit is valid only when the CRM holds exactly the frozen legacy snapshot.
  if (!reconciliation.reconciled) refuse('conflict', 'The final legacy snapshot is not reconciled with the CRM. Replay the final delta, then commit.', { reason: 'stale_cutover', reconciliation })
  const actor = actorColumns(context)
  await client.query(`UPDATE crm_cutover_runs SET state='committed',final_delta=$3::jsonb,reconciliation=$4::jsonb,committed_by_kind=$5,committed_by_id=$6,committed_by_user_id=$7,
    committed_at=now(),version=version+1 WHERE workspace_id=$1 AND id=$2`, [context.workspaceId, run.id, JSON.stringify(command.finalSource), JSON.stringify(reconciliation),
    actor.kind, actor.id, actor.userId])
  await client.query(`UPDATE crm_provider_bindings SET writer_state='brian',version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`, [context.workspaceId, binding.id])
  await commercialAudit(tx, context, { action: 'crm.erp_cutover.committed', subjectKind: 'crm_cutover_run', subjectId: run.id, details: { bindingKey: binding.bindingKey, reconciliation } })
  return commercialResult(command.kind, { cutoverId: run.id, state: 'committed', version: run.version + 1, writerState: 'brian', reconciliation })
}

async function enrollViewer(tx: CrmOperationsTransaction, command: Command<'enroll_erp_viewer'>): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  if (context.actor.kind !== 'user') refuse('not_authorized', 'A viewer enrolls their own legacy identity while signed in.')
  const binding = await lockBinding(tx, command.bindingKey)
  const existing = (await client.query<{ target_id: string; status: string }>(`SELECT target_id,status FROM crm_legacy_id_mappings WHERE binding_id=$1 AND legacy_type='viewer' AND legacy_id=$2`,
    [binding.id, command.legacyUserId])).rows[0]
  if (existing && existing.target_id === context.actor.userId && existing.status === 'active') return commercialResult(command.kind, { bindingKey: binding.bindingKey, legacyUserId: command.legacyUserId })
  if (existing) refuse('conflict', 'That legacy user is enrolled to someone else.', { reason: 'viewer_taken' })
  const actor = actorColumns(context)
  try {
    await client.query(`INSERT INTO crm_legacy_id_mappings(workspace_id,binding_id,legacy_type,legacy_id,target_kind,target_id,created_by_kind,created_by_id,created_by_user_id)
      VALUES($1,$2,'viewer',$3,'user',$4,$5,$6,$7)`, [context.workspaceId, binding.id, command.legacyUserId, context.actor.userId, actor.kind, actor.id, actor.userId])
  } catch (error) {
    if ((error as { code?: string }).code === '23505') refuse('conflict', 'You are already enrolled with a different legacy user on this binding.', { reason: 'viewer_already_enrolled' })
    throw error
  }
  await commercialAudit(tx, context, { action: 'crm.erp_viewer.enrolled', subjectKind: 'crm_provider_binding', subjectId: binding.id, details: { bindingKey: binding.bindingKey } })
  return commercialResult(command.kind, { bindingKey: binding.bindingKey, legacyUserId: command.legacyUserId }, { created: true })
}

export async function executeCrmErpCommand(tx: CrmOperationsTransaction, command: CrmErpCommand): Promise<CommercialResult> {
  return withOperationReceipt(tx, command, async () => {
    switch (command.kind) {
      case 'stage_erp_import': return stageImport(tx, command)
      case 'confirm_erp_import': return confirmImport(tx, command)
      case 'record_projection_receipt': return recordReceipts(tx, command)
      case 'prepare_erp_cutover': return prepareCutover(tx, command)
      case 'commit_erp_cutover': return commitCutover(tx, command)
      case 'enroll_erp_viewer': return enrollViewer(tx, command)
    }
  })
}

