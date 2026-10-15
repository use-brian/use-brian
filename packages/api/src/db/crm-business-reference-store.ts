/**
 * PostgreSQL storage for business reference definitions, number series,
 * partition counters, assigned values and history, plus the permission-scoped
 * read store. Writers take the caller's canonical transaction client; reads
 * join the target record through the canonical access predicate so a hidden
 * target leaks neither its codes nor its existence.
 * Spec: docs/architecture/features/crm-commercial-operations.md
 *
 * [COMP:crm/business-references]
 */

import type { PoolClient, QueryResultRow } from 'pg'
import {
  CrmOperationsError,
  CrmReferenceFormatSchema,
  explainCrmReferenceFormat,
  normalizeCrmBusinessReference,
  crmReferencePartitionKey,
  crmReferenceNeedsBusinessDate,
  crmReferenceNeedsCategory,
  resolveCrmBusinessDate,
  type CrmBusinessReferenceRecord,
  type CrmReferenceCategory,
  type CrmReferenceDefinitionInput,
  type CrmReferenceFormat,
  type CrmReferencePartitionDimension,
  type CrmReferenceReadPort,
  type CrmReferenceTargetKind,
  type CrmReferenceViewer,
} from '@use-brian/core'
import { query } from './client.js'
import { buildAccessPredicate, buildCurrentMemberSourcePredicate, mutationActorAccess } from './access-predicate.js'
import { queryCrmPage } from '../crm-operations/pagination.js'
import { commercialVisibility } from './crm-commercial-context-store.js'

type Row = QueryResultRow & Record<string, unknown>
type Run = <T extends QueryResultRow>(sql: string, values: unknown[]) => Promise<{ rows: T[] }>

export type CrmReferenceDefinitionRow = {
  id: string
  workspaceId: string
  definitionKey: string
  label: string
  targetKinds: CrmReferenceTargetKind[]
  assignmentMode: 'native' | 'manual' | 'external'
  namespaceKey: string
  format: CrmReferenceFormat | null
  partitionDimensions: CrmReferencePartitionDimension[]
  categories: CrmReferenceCategory[]
  timezone: string
  assignmentEvent: 'explicit' | 'approval' | 'issue'
  changePolicy: 'immutable' | 'correctable'
  status: 'draft' | 'active' | 'archived'
  version: number
  seriesId: string | null
  counterStart: number | null
  counterWidth: number | null
  createdAt: string
  updatedAt: string
}

const DEFINITION_COLUMNS = `d.id,d.workspace_id AS "workspaceId",d.definition_key AS "definitionKey",d.label,
  d.target_kinds AS "targetKinds",d.assignment_mode AS "assignmentMode",d.namespace_key AS "namespaceKey",
  d.format,d.partition_dimensions AS "partitionDimensions",d.categories,d.timezone,
  d.assignment_event AS "assignmentEvent",d.change_policy AS "changePolicy",d.status,d.version,
  s.id AS "seriesId",s.counter_start AS "counterStart",s.counter_width AS "counterWidth",
  d.created_at AS "createdAt",d.updated_at AS "updatedAt"`

function definitionRow(row: Row): CrmReferenceDefinitionRow {
  return {
    ...(row as unknown as CrmReferenceDefinitionRow),
    format: row.format ? CrmReferenceFormatSchema.parse(row.format) : null,
    counterStart: row.counterStart === null || row.counterStart === undefined ? null : Number(row.counterStart),
    counterWidth: row.counterWidth === null || row.counterWidth === undefined ? null : Number(row.counterWidth),
    createdAt: new Date(row.createdAt as string).toISOString(),
    updatedAt: new Date(row.updatedAt as string).toISOString(),
  }
}

export async function readDefinitionByKey(client: PoolClient, workspaceId: string, key: string, lock: 'share' | 'update' | null = 'share'): Promise<CrmReferenceDefinitionRow | null> {
  const result = await client.query<Row>(
    `SELECT ${DEFINITION_COLUMNS} FROM crm_reference_definitions d
       LEFT JOIN crm_number_series s ON s.workspace_id=d.workspace_id AND s.definition_id=d.id
      WHERE d.workspace_id=$1 AND d.definition_key=$2${lock ? ` FOR ${lock === 'share' ? 'SHARE' : 'UPDATE'} OF d` : ''}`,
    [workspaceId, key])
  return result.rows[0] ? definitionRow(result.rows[0]) : null
}

export async function readDefinitionById(client: PoolClient, workspaceId: string, id: string, lock: 'share' | 'update' = 'update'): Promise<CrmReferenceDefinitionRow | null> {
  const result = await client.query<Row>(
    `SELECT ${DEFINITION_COLUMNS} FROM crm_reference_definitions d
       LEFT JOIN crm_number_series s ON s.workspace_id=d.workspace_id AND s.definition_id=d.id
      WHERE d.workspace_id=$1 AND d.id=$2 FOR ${lock === 'share' ? 'SHARE' : 'UPDATE'} OF d`, [workspaceId, id])
  return result.rows[0] ? definitionRow(result.rows[0]) : null
}

export async function definitionUsage(client: PoolClient, workspaceId: string, definitionId: string): Promise<{ values: number; categoryKeys: string[] }> {
  const result = await client.query<{ values: string; categoryKeys: string[] | null }>(
    `SELECT count(*)::text AS values,array_remove(array_agg(DISTINCT category_key),NULL) AS "categoryKeys"
       FROM crm_business_references WHERE workspace_id=$1 AND definition_id=$2`, [workspaceId, definitionId])
  return { values: Number(result.rows[0]?.values ?? 0), categoryKeys: result.rows[0]?.categoryKeys ?? [] }
}

type Actor = { kind: string; id: string; userId: string | null }

export async function insertDefinition(client: PoolClient, workspaceId: string, input: CrmReferenceDefinitionInput, actor: Actor): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO crm_reference_definitions(workspace_id,definition_key,label,target_kinds,assignment_mode,namespace_key,format,
       partition_dimensions,categories,timezone,assignment_event,change_policy,status,
       created_by_kind,created_by_id,created_by_user_id,updated_by_kind,updated_by_id,updated_by_user_id)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$14,$15,$16) RETURNING id`,
    [workspaceId, input.definitionKey, input.label, input.targetKinds, input.assignmentMode, input.namespaceKey,
      input.format ? JSON.stringify(input.format) : null, input.partitionDimensions, JSON.stringify(input.categories),
      input.timezone, input.assignmentEvent, input.changePolicy, input.status, actor.kind, actor.id, actor.userId])
  return result.rows[0]!.id
}

export async function updateDefinition(client: PoolClient, workspaceId: string, id: string, input: CrmReferenceDefinitionInput, actor: Actor): Promise<number> {
  const result = await client.query<{ version: number }>(
    `UPDATE crm_reference_definitions SET label=$3,target_kinds=$4,assignment_mode=$5,namespace_key=$6,format=$7::jsonb,
       partition_dimensions=$8,categories=$9::jsonb,timezone=$10,assignment_event=$11,change_policy=$12,status=$13,
       version=version+1,updated_by_kind=$14,updated_by_id=$15,updated_by_user_id=$16,updated_at=now()
     WHERE workspace_id=$1 AND id=$2 RETURNING version`,
    [workspaceId, id, input.label, input.targetKinds, input.assignmentMode, input.namespaceKey,
      input.format ? JSON.stringify(input.format) : null, input.partitionDimensions, JSON.stringify(input.categories),
      input.timezone, input.assignmentEvent, input.changePolicy, input.status, actor.kind, actor.id, actor.userId])
  return result.rows[0]!.version
}

export async function saveSeries(client: PoolClient, workspaceId: string, definitionId: string, params: {
  counterStart: number; counterWidth: number; partitionDimensions: CrmReferencePartitionDimension[]; configVersion: number; active: boolean
}): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO crm_number_series(workspace_id,definition_id,counter_start,counter_width,partition_dimensions,config_version,state)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(workspace_id,definition_id) DO UPDATE SET counter_start=EXCLUDED.counter_start,counter_width=EXCLUDED.counter_width,
       partition_dimensions=EXCLUDED.partition_dimensions,config_version=EXCLUDED.config_version,state=EXCLUDED.state,
       version=crm_number_series.version+1,updated_at=now()
     RETURNING id`,
    [workspaceId, definitionId, params.counterStart, params.counterWidth, params.partitionDimensions, params.configVersion,
      params.active ? 'active' : 'retired'])
  return result.rows[0]!.id
}

/** Allocate the next counter in a partition. The row lock serializes concurrent allocators. */
export async function allocateCounter(client: PoolClient, workspaceId: string, seriesId: string, partitionKey: string, counterStart: number): Promise<number> {
  const result = await client.query<{ allocated: string }>(
    `INSERT INTO crm_number_partitions(workspace_id,series_id,partition_key,next_value,allocated_count)
     VALUES($1,$2,$3,$4::bigint+1,1)
     ON CONFLICT(workspace_id,series_id,partition_key) DO UPDATE
       SET next_value=crm_number_partitions.next_value+1,allocated_count=crm_number_partitions.allocated_count+1,updated_at=now()
     RETURNING (next_value-1)::text AS allocated`,
    [workspaceId, seriesId, partitionKey, counterStart])
  return Number(result.rows[0]!.allocated)
}

export async function readPartitionNext(client: PoolClient, workspaceId: string, seriesId: string, partitionKey: string): Promise<number | null> {
  const result = await client.query<{ next: string }>(
    `SELECT next_value::text AS next FROM crm_number_partitions WHERE workspace_id=$1 AND series_id=$2 AND partition_key=$3 FOR UPDATE`,
    [workspaceId, seriesId, partitionKey])
  return result.rows[0] ? Number(result.rows[0].next) : null
}

export async function raisePartitionCounter(client: PoolClient, workspaceId: string, seriesId: string, partitionKey: string, nextValue: number): Promise<void> {
  await client.query(
    `INSERT INTO crm_number_partitions(workspace_id,series_id,partition_key,next_value) VALUES($1,$2,$3,$4)
     ON CONFLICT(workspace_id,series_id,partition_key) DO UPDATE SET next_value=GREATEST(crm_number_partitions.next_value,EXCLUDED.next_value),updated_at=now()`,
    [workspaceId, seriesId, partitionKey, nextValue])
}

export type CrmReferenceRow = {
  id: string
  definitionId: string
  definitionKey: string
  definitionVersion: number
  targetKind: CrmReferenceTargetKind
  targetId: string
  printableValue: string
  normalizedValue: string
  origin: 'native' | 'manual' | 'external' | 'import'
  status: 'active' | 'replaced' | 'retired'
  seriesId: string | null
  partitionKey: string | null
  counterValue: number | null
  parentSnapshot: CrmBusinessReferenceRecord['parentSnapshot']
  businessDate: string | null
  categoryKey: string | null
  version: number
  createdAt: string
  updatedAt: string
}

const REFERENCE_COLUMNS = `r.id,r.definition_id AS "definitionId",d.definition_key AS "definitionKey",
  r.definition_version AS "definitionVersion",r.target_kind AS "targetKind",r.target_id AS "targetId",
  r.printable_value AS "printableValue",r.normalized_value AS "normalizedValue",r.origin,r.status,
  r.series_id AS "seriesId",r.partition_key AS "partitionKey",r.counter_value::text AS "counterValue",
  r.parent_snapshot AS "parentSnapshot",to_char(r.business_date,'YYYY-MM-DD') AS "businessDate",
  r.category_key AS "categoryKey",r.version,r.created_at AS "createdAt",r.updated_at AS "updatedAt"`

function referenceRow(row: Row): CrmReferenceRow {
  return {
    ...(row as unknown as CrmReferenceRow),
    counterValue: row.counterValue === null || row.counterValue === undefined ? null : Number(row.counterValue),
    createdAt: new Date(row.createdAt as string).toISOString(),
    updatedAt: new Date(row.updatedAt as string).toISOString(),
  }
}

export function referenceRecord(row: CrmReferenceRow, targetName: string | null = null): CrmBusinessReferenceRecord {
  return {
    id: row.id, definitionId: row.definitionId, definitionKey: row.definitionKey, definitionVersion: row.definitionVersion,
    targetKind: row.targetKind, targetId: row.targetId, targetName, value: row.printableValue, origin: row.origin,
    status: row.status, businessDate: row.businessDate, categoryKey: row.categoryKey, counterValue: row.counterValue,
    partitionKey: row.partitionKey, parentSnapshot: row.parentSnapshot, version: row.version,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  }
}

export async function readActiveReference(client: PoolClient, workspaceId: string, definitionId: string, targetId: string): Promise<CrmReferenceRow | null> {
  const result = await client.query<Row>(
    `SELECT ${REFERENCE_COLUMNS} FROM crm_business_references r JOIN crm_reference_definitions d ON d.workspace_id=r.workspace_id AND d.id=r.definition_id
      WHERE r.workspace_id=$1 AND r.definition_id=$2 AND r.target_id=$3 AND r.status='active'`, [workspaceId, definitionId, targetId])
  return result.rows[0] ? referenceRow(result.rows[0]) : null
}

export async function lockReference(client: PoolClient, workspaceId: string, referenceId: string): Promise<CrmReferenceRow | null> {
  const result = await client.query<Row>(
    `SELECT ${REFERENCE_COLUMNS} FROM crm_business_references r JOIN crm_reference_definitions d ON d.workspace_id=r.workspace_id AND d.id=r.definition_id
      WHERE r.workspace_id=$1 AND r.id=$2 FOR UPDATE OF r`, [workspaceId, referenceId])
  return result.rows[0] ? referenceRow(result.rows[0]) : null
}

export async function valueReserved(client: PoolClient, workspaceId: string, definitionId: string, normalized: string): Promise<boolean> {
  const result = await client.query('SELECT 1 FROM crm_business_references WHERE workspace_id=$1 AND definition_id=$2 AND normalized_value=$3',
    [workspaceId, definitionId, normalized])
  return Boolean(result.rowCount)
}

export async function insertReference(client: PoolClient, workspaceId: string, row: {
  definitionId: string; definitionVersion: number; targetKind: string; targetId: string
  printableValue: string; normalizedValue: string; origin: CrmReferenceRow['origin']; status?: CrmReferenceRow['status']
  formatSnapshot: CrmReferenceFormat | null; seriesId: string | null; partitionKey: string | null; counterValue: number | null
  parentReferenceId: string | null; parentSnapshot: Record<string, unknown> | null; businessDate: string | null
  categoryKey: string | null; externalEvidence: Record<string, unknown> | null; operationId: string; actor: Actor; statusReason?: string | null
}): Promise<CrmReferenceRow> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO crm_business_references(workspace_id,definition_id,definition_version,target_kind,target_id,printable_value,
       normalized_value,origin,status,format_snapshot,series_id,partition_key,counter_value,parent_reference_id,parent_snapshot,
       business_date,category_key,external_evidence,operation_id,assigned_by_kind,assigned_by_id,assigned_by_user_id,status_reason)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15::jsonb,$16::date,$17,$18::jsonb,$19,$20,$21,$22,$23) RETURNING id`,
    [workspaceId, row.definitionId, row.definitionVersion, row.targetKind, row.targetId, row.printableValue, row.normalizedValue,
      row.origin, row.status ?? 'active', row.formatSnapshot ? JSON.stringify(row.formatSnapshot) : null, row.seriesId,
      row.partitionKey, row.counterValue, row.parentReferenceId, row.parentSnapshot ? JSON.stringify(row.parentSnapshot) : null,
      row.businessDate, row.categoryKey, row.externalEvidence ? JSON.stringify(row.externalEvidence) : null, row.operationId,
      row.actor.kind, row.actor.id, row.actor.userId, row.statusReason ?? null])
  return (await lockReference(client, workspaceId, inserted.rows[0]!.id))!
}

export async function setReferenceStatus(client: PoolClient, workspaceId: string, referenceId: string, status: 'replaced' | 'retired', reason: string): Promise<CrmReferenceRow> {
  await client.query(
    `UPDATE crm_business_references SET status=$3,status_reason=$4,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`,
    [workspaceId, referenceId, status, reason])
  return (await lockReference(client, workspaceId, referenceId))!
}

export async function insertHistory(client: PoolClient, workspaceId: string, row: {
  referenceId: string; definitionId: string; targetKind: string; targetId: string
  action: 'assigned' | 'replaced' | 'retired' | 'imported'; formerValue: string | null; newValue: string | null
  reason: string | null; actor: Actor; operationId: string
}): Promise<void> {
  await client.query(
    `INSERT INTO crm_business_reference_history(workspace_id,reference_id,definition_id,target_kind,target_id,action,
       former_value,new_value,reason,actor_kind,actor_id,actor_user_id,operation_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [workspaceId, row.referenceId, row.definitionId, row.targetKind, row.targetId, row.action, row.formerValue,
      row.newValue, row.reason, row.actor.kind, row.actor.id, row.actor.userId, row.operationId])
}

// ── Reads ───────────────────────────────────────────────────────────

/** Target visibility through the canonical access predicate plus the current-member floor. */
function visibleTarget(viewer: CrmReferenceViewer, workspaceId: string, startIdx: number, alias = 'e') {
  const access = mutationActorAccess(viewer.userId, workspaceId)
  const ap = buildAccessPredicate(access, { alias, startIdx, operation: 'read' })
  const member = buildCurrentMemberSourcePredicate(viewer.userId, { alias, startIdx: ap.nextIdx, operation: 'read' })
  return {
    sql: `${alias}.valid_to IS NULL AND ${alias}.retracted_at IS NULL AND NOT ${alias}.scope_held AND ${ap.sql} AND ${member.sql}`,
    params: [...ap.params, ...member.params],
    nextIdx: member.nextIdx,
  }
}

/** Join and predicate for any reference target kind: entity targets and account targets each apply their own scope. */
function targetJoin(viewer: CrmReferenceViewer, workspaceId: string, startIdx: number) {
  const entity = visibleTarget(viewer, workspaceId, startIdx, 'e')
  const account = commercialVisibility(viewer.userId, workspaceId, 'ca', entity.nextIdx)
  const invoice = commercialVisibility(viewer.userId, workspaceId, 'ci', account.nextIdx)
  return {
    join: `LEFT JOIN entities e ON r.target_kind IN('company','deal') AND e.workspace_id=r.workspace_id AND e.id=r.target_id AND e.kind=r.target_kind
      LEFT JOIN crm_customer_accounts ca ON r.target_kind='account' AND ca.workspace_id=r.workspace_id AND ca.id=r.target_id
      LEFT JOIN crm_invoices ci ON r.target_kind='invoice' AND ci.workspace_id=r.workspace_id AND ci.id=r.target_id`,
    sql: `((e.id IS NOT NULL AND ${entity.sql}) OR (ca.id IS NOT NULL AND ${account.sql}) OR (ci.id IS NOT NULL AND ${invoice.sql}))`,
    name: 'coalesce(e.display_name,ca.label,ci.number)',
    params: [...entity.params, ...account.params, ...invoice.params],
    nextIdx: invoice.nextIdx,
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

export function createCrmReferenceReadStore(run: Run = query as unknown as Run): CrmReferenceReadPort {
  async function definitions(workspaceId: string, includeArchived: boolean, allowed?: readonly string[]) {
    const result = await run<Row>(
      `SELECT ${DEFINITION_COLUMNS} FROM crm_reference_definitions d
         LEFT JOIN crm_number_series s ON s.workspace_id=d.workspace_id AND s.definition_id=d.id
        WHERE d.workspace_id=$1 AND ($2::boolean OR d.status<>'archived')
          AND ($3::text[] IS NULL OR d.definition_key=ANY($3::text[])) ORDER BY d.definition_key LIMIT 200`,
      [workspaceId, includeArchived, allowed ? [...allowed] : null])
    return result.rows.map(definitionRow)
  }
  async function visibleTargetRow(workspaceId: string, viewer: CrmReferenceViewer, targetId: string) {
    const scope = visibleTarget(viewer, workspaceId, 3)
    const result = await run<{ id: string; kind: string; name: string; companyId: string | null }>(
      `SELECT e.id,e.kind,e.display_name AS name,e.attributes->>'company_id' AS "companyId" FROM entities e
        WHERE e.workspace_id=$1 AND e.id=$2 AND e.kind IN('company','deal') AND ${scope.sql}`,
      [workspaceId, targetId, ...scope.params])
    if (result.rows[0]) return result.rows[0]
    const account = commercialVisibility(viewer.userId, workspaceId, 'ca', 3)
    const found = await run<{ id: string; kind: string; name: string; companyId: string | null }>(
      `SELECT ca.id,'account' AS kind,ca.label AS name,ca.company_id AS "companyId" FROM crm_customer_accounts ca
        WHERE ca.workspace_id=$1 AND ca.id=$2 AND ${account.sql}`, [workspaceId, targetId, ...account.params])
    if (found.rows[0]) return found.rows[0]
    const invoice = commercialVisibility(viewer.userId, workspaceId, 'ci', 3)
    const issued = await run<{ id: string; kind: string; name: string; companyId: string | null }>(
      `SELECT ci.id,'invoice' AS kind,ci.number AS name,ca.company_id AS "companyId" FROM crm_invoices ci
        JOIN crm_customer_accounts ca ON ca.workspace_id=ci.workspace_id AND ca.id=ci.account_id
        WHERE ci.workspace_id=$1 AND ci.id=$2 AND ${invoice.sql}`, [workspaceId, targetId, ...invoice.params])
    return issued.rows[0] ?? null
  }
  return {
    async listDefinitions(workspaceId, viewer, options = {}) {
      const rows = await definitions(workspaceId, options.includeArchived === true, options.allowedDefinitionKeys)
      const counters = viewer.canConfigure && rows.some((row) => row.seriesId)
        ? (await run<{ seriesId: string; partitionKey: string; nextValue: string; allocatedCount: string }>(
          `SELECT series_id AS "seriesId",partition_key AS "partitionKey",next_value::text AS "nextValue",allocated_count::text AS "allocatedCount"
             FROM crm_number_partitions WHERE workspace_id=$1 ORDER BY series_id,partition_key LIMIT 1000`, [workspaceId])).rows
        : []
      return {
        schemaVersion: 1,
        definitions: rows.map((row) => ({
          ...row,
          ...(viewer.canConfigure ? { partitions: counters.filter((counter) => counter.seriesId === row.seriesId)
            .map((counter) => ({ partitionKey: counter.partitionKey, nextValue: Number(counter.nextValue), allocatedCount: Number(counter.allocatedCount) })) } : {}),
        })),
      }
    },
    async preview(workspaceId, viewer, input) {
      const definition = (await definitions(workspaceId, false)).find((row) => row.definitionKey === input.definitionKey)
      if (!definition) throw new CrmOperationsError('not_found', 'Reference definition was not found.')
      const businessDate = input.businessDate ? resolveCrmBusinessDate(input.businessDate, definition.timezone) : null
      const category = input.categoryKey ? definition.categories.find((item) => item.key === input.categoryKey) : undefined
      if (input.categoryKey && !category) {
        throw new CrmOperationsError('catalog_key_invalid', 'Category is not declared for this definition.',
          { validValues: definition.categories.map((item) => item.key) })
      }
      let parentValue: string | null = null, parentTargetId: string | null = null
      if (input.targetId) {
        const target = await visibleTargetRow(workspaceId, viewer, input.targetId)
        if (!target) throw new CrmOperationsError('not_found', 'The record is unavailable in your current scope.')
        parentTargetId = target.kind === 'deal' || target.kind === 'account' || target.kind === 'invoice' ? target.companyId : null
        const parentSegment = definition.format?.find((segment) => segment.kind === 'parent')
        if (parentSegment?.kind === 'parent' && parentTargetId && await visibleTargetRow(workspaceId, viewer, parentTargetId)) {
          const parent = await run<{ value: string }>(
            `SELECT r.printable_value AS value FROM crm_business_references r JOIN crm_reference_definitions d
               ON d.workspace_id=r.workspace_id AND d.id=r.definition_id
              WHERE r.workspace_id=$1 AND d.definition_key=$2 AND r.target_id=$3 AND r.status='active'`,
            [workspaceId, parentSegment.definitionKey, parentTargetId])
          parentValue = parent.rows[0]?.value ?? null
        }
      }
      const explanation = definition.format ? explainCrmReferenceFormat(definition.format,
        { businessDate, parentValue, categoryCode: category?.code ?? null }, definition.partitionDimensions) : null
      let partitionKey: string | null = null
      try {
        partitionKey = definition.assignmentMode === 'native' ? crmReferencePartitionKey(definition.partitionDimensions,
          { businessDate, parentTargetId, categoryKey: category?.key ?? null }) : null
      } catch { partitionKey = null }
      return {
        schemaVersion: 1,
        definitionKey: definition.definitionKey,
        label: definition.label,
        assignmentMode: definition.assignmentMode,
        assignmentEvent: definition.assignmentEvent,
        partitionDimensions: definition.partitionDimensions,
        partitionKey,
        explanation,
        needsBusinessDate: crmReferenceNeedsBusinessDate(definition.format, definition.partitionDimensions),
        needsCategory: crmReferenceNeedsCategory(definition.format, definition.partitionDimensions),
        categories: definition.categories,
        reserves: false,
        note: 'A preview explains the format only. It does not reserve or promise a number; assignment allocates it.',
      }
    },
    async lookup(workspaceId, viewer, input, allowedDefinitionKeys) {
      const scope = targetJoin(viewer, workspaceId, 2)
      const params: unknown[] = [workspaceId, ...scope.params]
      const add = (value: unknown) => { params.push(value); return `$${params.length}` }
      const filters: string[] = []
      if (input.q !== undefined) {
        const normalized = normalizeCrmBusinessReference(input.q)
        filters.push(input.match === 'prefix'
          ? `r.normalized_value LIKE ${add(`${escapeLike(normalized)}%`)} ESCAPE '\\'`
          : `r.normalized_value=${add(normalized)}`)
      }
      if (input.targetId) filters.push(`r.target_id=${add(input.targetId)}`)
      if (input.definitionKey) filters.push(`d.definition_key=${add(input.definitionKey)}`)
      if (allowedDefinitionKeys) filters.push(`d.definition_key=ANY(${add([...allowedDefinitionKeys])}::text[])`)
      if (!input.includeFormer) filters.push(`r.status='active'`)
      const sql = `SELECT ${REFERENCE_COLUMNS},${scope.name} AS "targetName"
        FROM crm_business_references r
        JOIN crm_reference_definitions d ON d.workspace_id=r.workspace_id AND d.id=r.definition_id
        ${scope.join}
        WHERE r.workspace_id=$1 AND ${scope.sql}${filters.length ? ` AND ${filters.join(' AND ')}` : ''}`
      const page = await queryCrmPage<'references', Row>(run, {
        workspaceId, resource: 'crm_business_references', key: 'references', sql, params,
        query: { limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}) },
      })
      return {
        schemaVersion: 1,
        references: page.references.map((row) => referenceRecord(referenceRow(row), (row.targetName as string) ?? null)),
        nextCursor: page.nextCursor,
      }
    },
    async history(workspaceId, viewer, referenceId, allowedDefinitionKeys) {
      const scope = targetJoin(viewer, workspaceId, 4)
      const found = await run<Row>(
        `SELECT ${REFERENCE_COLUMNS},${scope.name} AS "targetName" FROM crm_business_references r
           JOIN crm_reference_definitions d ON d.workspace_id=r.workspace_id AND d.id=r.definition_id
           ${scope.join}
          WHERE r.workspace_id=$1 AND r.id=$2 AND ($3::text[] IS NULL OR d.definition_key=ANY($3::text[])) AND ${scope.sql}`,
        [workspaceId, referenceId, allowedDefinitionKeys ? [...allowedDefinitionKeys] : null, ...scope.params])
      const row = found.rows[0]
      if (!row) return null
      const reference = referenceRecord(referenceRow(row), (row.targetName as string) ?? null)
      const history = await run<Row>(
        `SELECT h.id,h.reference_id AS "referenceId",d.definition_key AS "definitionKey",h.action,h.former_value AS "formerValue",
           h.new_value AS "newValue",h.reason,h.actor_kind AS "actorKind",h.actor_user_id AS "actorUserId",h.effective_at AS "effectiveAt"
           FROM crm_business_reference_history h JOIN crm_reference_definitions d ON d.workspace_id=h.workspace_id AND d.id=h.definition_id
          WHERE h.workspace_id=$1 AND h.target_id=$2 AND ($3::text[] IS NULL OR d.definition_key=ANY($3::text[]))
          ORDER BY h.effective_at,h.id LIMIT 500`, [workspaceId, reference.targetId, allowedDefinitionKeys ? [...allowedDefinitionKeys] : null])
      return { schemaVersion: 1, reference, history: history.rows }
    },
  }
}
