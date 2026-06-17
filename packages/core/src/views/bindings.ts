/**
 * Bindings catalog — produces an A2UI v0.8 ViewPayload from a
 * (BindingConfig, deps) pair by calling the appropriate primitive store
 * and mapping rows → A2UI rows / cards.
 *
 * Pure functions of (config, deps) — no side effects. The renderer never
 * sees the underlying records; it only consumes the ViewPayload.
 *
 * For v1 the catalog is *closed*: per-workspace custom column configs are
 * explicit v2 scope (docs/architecture/features/views.md → "Deferred").
 *
 * [COMP:views/bindings]
 */

import type {
  CompanyListRow,
  ContactListRow,
  CrmStore,
  DealListRow,
  DealStage,
} from '../crm/types.js'
import type { AccessContext } from '../security/access-context.js'
import type { TaskListRow, TaskStore } from '../tasks/types.js'
import type {
  WorkflowRunRecord,
  WorkflowRunStore,
  WorkflowRunStatus,
} from '../workflow/types.js'
import type { WorkspaceDirectoryStore, WorkspaceMemberInfo } from '../workspace/types.js'
import { DEAL_STAGES } from '../crm/types.js'
import { TASK_STATUSES } from '../tasks/types.js'
import { WORKFLOW_RUN_STATUSES } from '../workflow/types.js'
import type {
  A2UIBoardCard,
  A2UIBoardColumn,
  A2UIColumn,
  A2UIRow,
  A2UIRowValue,
  A2UIWidget,
  BadgeWidget,
  ColumnStatusGroup,
  DateWidget,
  FilesWidget,
  NumberWidget,
  PersonWidget,
  PropertyKind,
  RelationWidget,
  StatusWidget,
  ViewPayload,
} from './a2ui.js'
import type {
  BindingConfig,
  CompanyColumnId,
  ContactColumnId,
  DealColumnId,
  TaskColumnId,
  WorkflowRunColumnId,
} from './types.js'
import type {
  CellValue,
  EntityInstance,
  EntityStore as DocEntityStore,
  PropertyDef,
  PropertyKind as EntityPropertyKind,
  StatusGroup,
} from '../entities/doc-types.js'

export type BindingDeps = {
  taskStore: TaskStore
  crmStore: CrmStore
  workflowRunStore: WorkflowRunStore
  workspaceDirectory: WorkspaceDirectoryStore
  userId: string
  workspaceId: string
  /**
   * User-defined entity store (Phase B). Required to resolve a
   * `{ entity: 'custom' }` binding — its absence renders an empty custom table
   * (the anonymous public-share render path injects no entity store). Built-in
   * bindings never read it.
   */
  docEntityStore?: DocEntityStore
  /**
   * Optional pre-built access context. When set, every binding store read
   * runs under THIS context instead of the member-derived one. The
   * anonymous public-share render path sets it to `buildPublicAccessContext`
   * (clearance:'public') so externally shared pages resolve data at the
   * public sensitivity tier only — never the member's (clearance:undefined)
   * context, which sees the whole workspace. See `bindingCtx`.
   */
  accessContext?: AccessContext
}

/**
 * Synthetic principal id for the anonymous public-share render path. Never
 * a real member; only used so the predicate's user_id partition matches
 * workspace-shared rows (user_id IS NULL) and never another user's
 * personal rows.
 */
export const PUBLIC_SHARE_PRINCIPAL = '00000000-0000-0000-0000-000000000000'

/**
 * The pinned access context for the anonymous public-share render path.
 *
 * `clearance: 'public'` is MANDATORY — it is the data containment for
 * externally shared pages. A member context (or `clearance: undefined`)
 * would expose every sensitivity tier in the workspace. `assistantKind:
 * 'primary'` drops the assistant_id partition (data authored by any
 * assistant shows), while the user_id partition keeps personal rows
 * (user_id set) hidden. `compartments: []` clears into uncompartmented
 * rows only.
 */
export function buildPublicAccessContext(workspaceId: string): AccessContext {
  return {
    workspaceId,
    userId: PUBLIC_SHARE_PRINCIPAL,
    assistantId: PUBLIC_SHARE_PRINCIPAL,
    assistantKind: 'primary',
    clearance: 'public',
    compartments: [],
    // The synthetic principal is not a workspace member, so member RLS
    // would hide every row. Read system-side; the clearance:'public'
    // predicate clause above is the containment.
    systemRead: true,
  }
}

/**
 * Build an `AccessContext` for view-binding store reads. The view
 * routes are workspace-admin-level (no specific chat assistant), so
 * we synthesise `assistantId = userId` and pass `assistantKind = 'primary'`
 * so the predicate's assistant_id partition drops — the admin view
 * sees every row in the workspace regardless of which assistant
 * authored it. (`assistantId` itself is only consulted by the
 * non-primary branch of the predicate; here it's a non-functional
 * placeholder.) Clearance is undefined — the route layer is the trust
 * boundary (workspace membership is verified before the binding runs).
 *
 * When `deps.accessContext` is set (public-share render), it is returned
 * verbatim so the caller's pinned clearance is honoured.
 */
export function bindingCtx(deps: BindingDeps): AccessContext {
  if (deps.accessContext) return deps.accessContext
  return {
    workspaceId: deps.workspaceId,
    userId: deps.userId,
    assistantId: deps.userId,
    assistantKind: 'primary',
    clearance: undefined,
  }
}

// ── Default column sets ───────────────────────────────────────────────

const DEFAULT_TASK_COLUMNS: TaskColumnId[] = ['title', 'status', 'assignee', 'due', 'tags', 'updated_at']
const DEFAULT_CONTACT_COLUMNS: ContactColumnId[] = ['name', 'company', 'email', 'tags', 'updated_at']
const DEFAULT_COMPANY_COLUMNS: CompanyColumnId[] = ['name', 'domain', 'tags', 'updated_at']
const DEFAULT_DEAL_COLUMNS: DealColumnId[] = ['name', 'company', 'contact', 'stage', 'amount', 'close_date', 'updated_at']
const DEFAULT_WORKFLOW_RUN_COLUMNS: WorkflowRunColumnId[] = ['started_at', 'status', 'trigger_kind', 'finished_at', 'error']

// ── Column definitions (header text per column id) ────────────────────

const TASK_COL_HEADERS: Record<TaskColumnId, string> = {
  title: 'Title',
  status: 'Status',
  assignee: 'Assignee',
  due: 'Due',
  tags: 'Tags',
  updated_at: 'Updated',
}

const CONTACT_COL_HEADERS: Record<ContactColumnId, string> = {
  name: 'Name',
  company: 'Company',
  email: 'Email',
  tags: 'Tags',
  updated_at: 'Updated',
}

const COMPANY_COL_HEADERS: Record<CompanyColumnId, string> = {
  name: 'Name',
  domain: 'Domain',
  tags: 'Tags',
  updated_at: 'Updated',
}

const DEAL_COL_HEADERS: Record<DealColumnId, string> = {
  name: 'Deal',
  company: 'Company',
  contact: 'Contact',
  stage: 'Stage',
  amount: 'Amount',
  close_date: 'Close',
  updated_at: 'Updated',
}

const WORKFLOW_RUN_COL_HEADERS: Record<WorkflowRunColumnId, string> = {
  started_at: 'Started',
  status: 'Status',
  trigger_kind: 'Trigger',
  triggered_by: 'By',
  finished_at: 'Finished',
  error: 'Error',
}

// ── Property-kind maps (Phase 1 — Notion-feel) ──────────────────────
//
// `kind` drives the renderer's property-module dispatch
// (`packages/views-renderer/src/properties/`). Server cell builders
// emit the matching typed widget so the dispatcher has the data it
// needs. Columns without an explicit kind fall through to text.

const TASK_COL_KINDS: Record<TaskColumnId, PropertyKind> = {
  title: 'text',
  status: 'select',
  assignee: 'person',
  due: 'date',
  tags: 'tags',
  updated_at: 'date',
}

const CONTACT_COL_KINDS: Record<ContactColumnId, PropertyKind> = {
  name: 'text',
  company: 'relation',
  email: 'text',
  tags: 'tags',
  updated_at: 'date',
}

const COMPANY_COL_KINDS: Record<CompanyColumnId, PropertyKind> = {
  name: 'text',
  domain: 'text',
  tags: 'tags',
  updated_at: 'date',
}

const DEAL_COL_KINDS: Record<DealColumnId, PropertyKind> = {
  name: 'text',
  company: 'relation',
  contact: 'relation',
  stage: 'select',
  amount: 'number',
  close_date: 'date',
  updated_at: 'date',
}

const WORKFLOW_RUN_COL_KINDS: Record<WorkflowRunColumnId, PropertyKind> = {
  started_at: 'date',
  status: 'select',
  trigger_kind: 'text',
  triggered_by: 'text',
  finished_at: 'date',
  error: 'text',
}

// ── Property-typed cell helpers ─────────────────────────────────────

function dateCell(d: Date | null, format: DateWidget['format'] = 'relative'): DateWidget {
  return { type: 'date', iso: d ? d.toISOString() : null, format }
}

function numberCell(
  v: number | null,
  format: NumberWidget['format'] = 'plain',
  currency?: string,
): NumberWidget {
  return { type: 'number', value: v, format, ...(currency ? { currency } : {}) }
}

function initialsFrom(name: string | null): string {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/).slice(0, 2)
  const initials = parts.map((p) => p.charAt(0).toUpperCase()).join('')
  return initials || '?'
}

function personCell(memberId: string, member: WorkspaceMemberInfo | undefined): PersonWidget {
  const name = member?.name ?? memberId
  return {
    type: 'person',
    id: memberId,
    name,
    ...(member?.avatarUrl ? { avatarUrl: member.avatarUrl } : {}),
    initials: initialsFrom(member?.name ?? null),
  }
}

function relationCell(
  entityType: RelationWidget['entityType'],
  id: string,
  labelMap: Map<string, string>,
): RelationWidget {
  return {
    type: 'relation',
    entityType,
    id,
    label: labelMap.get(`${entityType}:${id}`) ?? id.slice(0, 8),
  }
}

// ── Status-to-tone helpers ────────────────────────────────────────────

function taskStatusTone(status: TaskListRow['status']): BadgeWidget['tone'] {
  if (status === 'done') return 'success'
  if (status === 'blocked') return 'danger'
  if (status === 'in_progress') return 'default'
  // archived rendered with default tone (typically filtered out of board view)
  return 'default'
}

function dealStageTone(stage: DealStage): BadgeWidget['tone'] {
  if (stage === 'won') return 'success'
  if (stage === 'lost') return 'danger'
  if (stage === 'negotiation' || stage === 'proposal') return 'warning'
  return 'default'
}

function workflowRunStatusTone(status: WorkflowRunStatus): BadgeWidget['tone'] {
  if (status === 'completed') return 'success'
  if (status === 'failed' || status === 'timeout') return 'danger'
  if (status === 'awaiting_input' || status === 'awaiting_wait') return 'warning'
  return 'default'
}

function statusBadge(text: string, tone: BadgeWidget['tone']): BadgeWidget {
  return { type: 'badge', text, tone }
}

// ── Cell renderers — each returns an A2UIRowValue ─────────────────────

function tagsBadges(tags: string[]): A2UIWidget {
  return {
    type: 'container',
    direction: 'row',
    children: tags.map<BadgeWidget>((t) => ({ type: 'badge', text: t })),
  }
}

// ── Task bindings ─────────────────────────────────────────────────────

function taskCell(
  row: TaskListRow,
  col: TaskColumnId,
  memberMap: Map<string, WorkspaceMemberInfo>,
): A2UIRowValue {
  switch (col) {
    case 'title':
      return row.title
    case 'status':
      return statusBadge(row.status, taskStatusTone(row.status))
    case 'assignee':
      if (!row.assigneeId) return null
      return personCell(row.assigneeId, memberMap.get(row.assigneeId))
    case 'due':
      return dateCell(row.due)
    case 'tags':
      return row.tags.length > 0 ? tagsBadges(row.tags) : null
    case 'updated_at':
      return dateCell(row.updatedAt)
  }
}

function buildTaskRow(
  row: TaskListRow,
  columns: TaskColumnId[],
  memberMap: Map<string, WorkspaceMemberInfo>,
): A2UIRow {
  const out: A2UIRow = { id: row.id }
  for (const col of columns) out[col] = taskCell(row, col, memberMap)
  return out
}

function buildTaskColumns(columns: TaskColumnId[]): A2UIColumn[] {
  return columns.map((field) => ({
    field,
    header: TASK_COL_HEADERS[field],
    kind: TASK_COL_KINDS[field],
    // Inline-edit option list for the `status` select cell (raw enum values
    // — the cell stores + displays them raw, so the dropdown round-trips).
    ...(field === 'status' ? { options: [...TASK_STATUSES] } : {}),
  }))
}

async function resolveTaskMembers(
  rows: TaskListRow[],
  columns: TaskColumnId[],
  deps: BindingDeps,
): Promise<Map<string, WorkspaceMemberInfo>> {
  if (!columns.includes('assignee')) return new Map()
  const ids = [...new Set(rows.map((r) => r.assigneeId).filter((x): x is string => !!x))]
  if (ids.length === 0) return new Map()
  return deps.workspaceDirectory.batchGet(deps.workspaceId, ids)
}

async function buildTasksTable(
  config: Extract<BindingConfig, { entity: 'tasks'; viewType: 'table' }>,
  deps: BindingDeps,
): Promise<A2UIWidget> {
  const columns = config.columns ?? DEFAULT_TASK_COLUMNS
  const rows = await deps.taskStore.list(bindingCtx(deps), {
    assigneeId: config.filters?.assigneeId,
    status: config.filters?.status,
    tag: config.filters?.tag,
    dueBefore: config.filters?.dueBefore ? new Date(config.filters.dueBefore) : undefined,
    dueAfter: config.filters?.dueAfter ? new Date(config.filters.dueAfter) : undefined,
  })
  const memberMap = await resolveTaskMembers(rows, columns, deps)
  return {
    type: 'table',
    columns: buildTaskColumns(columns),
    rows: rows.map((r) => buildTaskRow(r, columns, memberMap)),
    rowAction: { id: 'open-entity', params: { entity: 'tasks' } },
  }
}

async function buildTasksBoard(
  config: Extract<BindingConfig, { entity: 'tasks'; viewType: 'board' }>,
  deps: BindingDeps,
): Promise<A2UIWidget> {
  const columns = config.columns ?? DEFAULT_TASK_COLUMNS
  const rows = await deps.taskStore.list(bindingCtx(deps), {
    assigneeId: config.filters?.assigneeId,
    tag: config.filters?.tag,
  })
  const memberMap = await resolveTaskMembers(rows, columns, deps)
  // Active statuses only on the board (archived hidden).
  const boardStatuses = TASK_STATUSES.filter((s) => s !== 'archived')
  const cardsByStatus: Record<string, A2UIBoardCard[]> = Object.fromEntries(
    boardStatuses.map((s) => [s, []]),
  )
  for (const row of rows) {
    if (row.status === 'archived') continue
    cardsByStatus[row.status].push({
      id: row.id,
      data: buildTaskRow(row, columns, memberMap),
    })
  }
  const boardColumns: A2UIBoardColumn[] = boardStatuses.map((s) => ({
    id: s,
    title: s.replace('_', ' '),
    cards: cardsByStatus[s],
  }))
  return {
    type: 'board',
    groupBy: 'status',
    columns: boardColumns,
    cardSchema: {
      type: 'container',
      direction: 'column',
      children: [
        { type: 'text', text: '{{title}}', variant: 'body' },
        { type: 'text', text: '{{due}}', variant: 'caption' },
      ],
    },
  }
}

// ── Contacts bindings ─────────────────────────────────────────────────

function contactCell(
  row: ContactListRow,
  col: ContactColumnId,
  labelMap: Map<string, string>,
): A2UIRowValue {
  switch (col) {
    case 'name':
      return row.name
    case 'company':
      if (!row.companyId) return null
      return relationCell('company', row.companyId, labelMap)
    case 'email':
      return row.email ?? null
    case 'tags':
      return row.tags.length > 0 ? tagsBadges(row.tags) : null
    case 'updated_at':
      return dateCell(row.updatedAt)
  }
}

async function buildContactsTable(
  config: Extract<BindingConfig, { entity: 'contacts'; viewType: 'table' }>,
  deps: BindingDeps,
): Promise<A2UIWidget> {
  const columns = config.columns ?? DEFAULT_CONTACT_COLUMNS
  const rows = await deps.crmStore.listContacts(bindingCtx(deps), {
    query: config.filters?.query,
    tag: config.filters?.tag,
    companyId: config.filters?.companyId,
  })
  let labelMap = new Map<string, string>()
  if (columns.includes('company')) {
    const companyIds = [...new Set(rows.map((r) => r.companyId).filter((x): x is string => !!x))]
    if (companyIds.length > 0) {
      labelMap = await deps.crmStore.batchLabels(bindingCtx(deps), [
        { entity: 'company', ids: companyIds },
      ])
    }
  }
  return {
    type: 'table',
    columns: columns.map((field) => ({
      field,
      header: CONTACT_COL_HEADERS[field],
      kind: CONTACT_COL_KINDS[field],
    })),
    rows: rows.map((r) => {
      const out: A2UIRow = { id: r.id }
      for (const col of columns) out[col] = contactCell(r, col, labelMap)
      return out
    }),
    rowAction: { id: 'open-entity', params: { entity: 'contacts' } },
  }
}

// ── Companies bindings ────────────────────────────────────────────────

function companyCell(row: CompanyListRow, col: CompanyColumnId): A2UIRowValue {
  switch (col) {
    case 'name':
      return row.name
    case 'domain':
      return row.domain ?? null
    case 'tags':
      return row.tags.length > 0 ? tagsBadges(row.tags) : null
    case 'updated_at':
      return dateCell(row.updatedAt)
  }
}

async function buildCompaniesTable(
  config: Extract<BindingConfig, { entity: 'companies'; viewType: 'table' }>,
  deps: BindingDeps,
): Promise<A2UIWidget> {
  const columns = config.columns ?? DEFAULT_COMPANY_COLUMNS
  const rows = await deps.crmStore.listCompanies(bindingCtx(deps), {
    query: config.filters?.query,
    tag: config.filters?.tag,
  })
  return {
    type: 'table',
    columns: columns.map((field) => ({
      field,
      header: COMPANY_COL_HEADERS[field],
      kind: COMPANY_COL_KINDS[field],
    })),
    rows: rows.map((r) => {
      const out: A2UIRow = { id: r.id }
      for (const col of columns) out[col] = companyCell(r, col)
      return out
    }),
    rowAction: { id: 'open-entity', params: { entity: 'companies' } },
  }
}

// ── Deal bindings ─────────────────────────────────────────────────────

function dealCell(
  row: DealListRow,
  col: DealColumnId,
  labelMap: Map<string, string>,
): A2UIRowValue {
  switch (col) {
    case 'name':
      // No name column on deals — render id slug.
      return row.id.slice(0, 8)
    case 'company':
      if (!row.companyId) return null
      return relationCell('company', row.companyId, labelMap)
    case 'contact':
      if (!row.contactId) return null
      return relationCell('contact', row.contactId, labelMap)
    case 'stage':
      return statusBadge(row.stage, dealStageTone(row.stage))
    case 'amount':
      return numberCell(row.amount, 'currency', 'USD')
    case 'close_date':
      return dateCell(row.closeDate, 'absolute')
    case 'updated_at':
      return dateCell(row.updatedAt)
  }
}

function buildDealRow(
  row: DealListRow,
  columns: DealColumnId[],
  labelMap: Map<string, string>,
): A2UIRow {
  const out: A2UIRow = { id: row.id }
  for (const col of columns) out[col] = dealCell(row, col, labelMap)
  return out
}

async function resolveDealLabels(
  rows: DealListRow[],
  columns: DealColumnId[],
  deps: BindingDeps,
): Promise<Map<string, string>> {
  const requests: { entity: 'company' | 'contact'; ids: string[] }[] = []
  if (columns.includes('company')) {
    const ids = [...new Set(rows.map((r) => r.companyId).filter((x): x is string => !!x))]
    if (ids.length > 0) requests.push({ entity: 'company', ids })
  }
  if (columns.includes('contact')) {
    const ids = [...new Set(rows.map((r) => r.contactId).filter((x): x is string => !!x))]
    if (ids.length > 0) requests.push({ entity: 'contact', ids })
  }
  if (requests.length === 0) return new Map()
  return deps.crmStore.batchLabels(bindingCtx(deps), requests)
}

async function buildDealsTable(
  config: Extract<BindingConfig, { entity: 'deals'; viewType: 'table' }>,
  deps: BindingDeps,
): Promise<A2UIWidget> {
  const columns = config.columns ?? DEFAULT_DEAL_COLUMNS
  const rows = await deps.crmStore.listDeals(bindingCtx(deps), {
    stage: config.filters?.stage,
    contactId: config.filters?.contactId,
    companyId: config.filters?.companyId,
  })
  const labelMap = await resolveDealLabels(rows, columns, deps)
  return {
    type: 'table',
    columns: columns.map((field) => ({
      field,
      header: DEAL_COL_HEADERS[field],
      kind: DEAL_COL_KINDS[field],
      ...(field === 'stage' ? { options: [...DEAL_STAGES] } : {}),
    })),
    rows: rows.map((r) => buildDealRow(r, columns, labelMap)),
    rowAction: { id: 'open-entity', params: { entity: 'deals' } },
  }
}

async function buildDealsBoard(
  config: Extract<BindingConfig, { entity: 'deals'; viewType: 'board' }>,
  deps: BindingDeps,
): Promise<A2UIWidget> {
  const columns = config.columns ?? DEFAULT_DEAL_COLUMNS
  const rows = await deps.crmStore.listDeals(bindingCtx(deps), {
    contactId: config.filters?.contactId,
    companyId: config.filters?.companyId,
  })
  const labelMap = await resolveDealLabels(rows, columns, deps)
  const cardsByStage: Record<string, A2UIBoardCard[]> = Object.fromEntries(
    DEAL_STAGES.map((s) => [s, []]),
  )
  for (const row of rows) {
    cardsByStage[row.stage].push({
      id: row.id,
      data: buildDealRow(row, columns, labelMap),
    })
  }
  const boardColumns: A2UIBoardColumn[] = DEAL_STAGES.map((s) => ({
    id: s,
    title: s,
    cards: cardsByStage[s],
  }))
  return {
    type: 'board',
    groupBy: 'stage',
    columns: boardColumns,
    cardSchema: {
      type: 'container',
      direction: 'column',
      children: [
        { type: 'text', text: '{{name}}', variant: 'body' },
        { type: 'text', text: '{{amount}}', variant: 'caption' },
      ],
    },
  }
}

// ── Workflow runs bindings ────────────────────────────────────────────

function workflowRunCell(row: WorkflowRunRecord, col: WorkflowRunColumnId): A2UIRowValue {
  switch (col) {
    case 'started_at':
      return dateCell(row.startedAt, 'datetime')
    case 'status':
      return statusBadge(row.status, workflowRunStatusTone(row.status))
    case 'trigger_kind':
      return row.triggerKind
    case 'triggered_by':
      return row.triggeredBy ?? null
    case 'finished_at':
      return dateCell(row.finishedAt, 'datetime')
    case 'error': {
      if (!row.error) return null
      const errorRecord = row.error as Record<string, unknown>
      const message = errorRecord.message
      return typeof message === 'string' ? message : JSON.stringify(row.error)
    }
  }
}

async function buildWorkflowRunsTable(
  config: Extract<BindingConfig, { entity: 'workflow_runs'; viewType: 'table' }>,
  deps: BindingDeps,
): Promise<A2UIWidget> {
  const columns = config.columns ?? DEFAULT_WORKFLOW_RUN_COLUMNS
  const rows = await deps.workflowRunStore.listRunsForWorkflow(
    deps.userId,
    config.filters.workflowId,
    { status: config.filters.status },
  )
  return {
    type: 'table',
    columns: columns.map((field) => ({
      field,
      header: WORKFLOW_RUN_COL_HEADERS[field],
      kind: WORKFLOW_RUN_COL_KINDS[field],
      ...(field === 'status' ? { options: [...WORKFLOW_RUN_STATUSES] } : {}),
    })),
    rows: rows.map((r) => {
      const out: A2UIRow = { id: r.id }
      for (const col of columns) out[col] = workflowRunCell(r, col)
      return out
    }),
    rowAction: { id: 'open-entity', params: { entity: 'workflow_runs' } },
  }
}

// ── Custom (user-defined) entity bindings (Phase B) ───────────────────
//
// Unlike the built-in builders above (closed column enums), a custom table's
// columns ARE the EntityType's declared properties — so the column header menu
// can rename / retype / insert / delete them (the `editableColumns` path). The
// 16 doc PropertyKinds map 1:1 onto the renderer's A2UI PropertyKind except
// `multi_select` → `tags`; cell shapes reuse the same typed-widget helpers as
// the built-ins.

/** Map a doc PropertyKind to the renderer's A2UI PropertyKind. */
function customColumnKind(kind: EntityPropertyKind): PropertyKind {
  return kind === 'multi_select' ? 'tags' : kind
}

/** Map the entity number-format DSL onto NumberWidget's format. */
function customNumberFormat(prop: PropertyDef): NumberWidget['format'] {
  if (prop.config.kind !== 'number') return 'plain'
  switch (prop.config.format) {
    case 'int':
      return 'integer'
    case 'dollar':
      return 'currency'
    case 'percent':
      return 'percent'
    default:
      return 'plain' // decimal / comma / unset
  }
}

/** Resolve a status option id to its group bucket + display label. */
function findStatusOption(
  groups: StatusGroup[],
  optionId: string,
): { groupId: 'pending' | 'in_progress' | 'done'; label: string } | null {
  for (const g of groups) {
    const o = g.options.find((opt) => opt.id === optionId)
    if (o) return { groupId: g.id, label: o.name }
  }
  return null
}

function customColumns(properties: PropertyDef[], visible: string[]): A2UIColumn[] {
  const byName = new Map(properties.map((p) => [p.name, p]))
  const cols: A2UIColumn[] = []
  for (const name of visible) {
    const p = byName.get(name)
    if (!p) continue
    const col: A2UIColumn = {
      field: p.name,
      header: p.label ?? p.name,
      kind: customColumnKind(p.config.kind),
    }
    if (p.config.kind === 'select' || p.config.kind === 'multi_select') {
      col.options = p.config.options.map((o) => o.id)
    }
    if (p.config.kind === 'status') {
      col.statusGroups = p.config.groups.map<ColumnStatusGroup>((g) => ({
        id: g.id,
        label: g.label,
        options: g.options.map((o) => ({
          id: o.id,
          name: o.name,
          ...(o.color ? { color: o.color } : {}),
        })),
      }))
    }
    cols.push(col)
  }
  return cols
}

/** Map one user-defined cell value to a renderer A2UIRowValue. Auto-stamp
 *  kinds read from the instance row; everything else from the data cell. */
function customCell(
  cell: CellValue | undefined,
  instance: EntityInstance,
  prop: PropertyDef,
  memberMap: Map<string, WorkspaceMemberInfo>,
  optionNames: Map<string, string>,
): A2UIRowValue {
  switch (prop.config.kind) {
    case 'created_time':
      return dateCell(new Date(instance.createdAt), 'datetime')
    case 'last_edited_time':
      return dateCell(new Date(instance.lastEditedAt), 'datetime')
    case 'created_by':
      return instance.createdBy
        ? personCell(instance.createdBy, memberMap.get(instance.createdBy))
        : null
    case 'last_edited_by':
      return instance.lastEditedBy
        ? personCell(instance.lastEditedBy, memberMap.get(instance.lastEditedBy))
        : null
    default:
      break
  }
  if (!cell) return null
  switch (cell.kind) {
    case 'text':
      return typeof cell.value === 'string' ? cell.value : null
    case 'number':
      return numberCell(cell.value, customNumberFormat(prop))
    case 'select':
      return cell.value == null
        ? null
        : statusBadge(optionNames.get(`${prop.name}:${cell.value}`) ?? cell.value, 'default')
    case 'multi_select':
      return cell.value.length === 0
        ? null
        : tagsBadges(cell.value.map((id) => optionNames.get(`${prop.name}:${id}`) ?? id))
    case 'status': {
      if (cell.value == null) return null
      const resolved =
        prop.config.kind === 'status' ? findStatusOption(prop.config.groups, cell.value) : null
      const w: StatusWidget = {
        type: 'status',
        optionId: cell.value,
        ...(resolved ? { groupId: resolved.groupId, label: resolved.label } : {}),
      }
      return w
    }
    case 'date':
      return cell.value
        ? dateCell(new Date(cell.value.start), cell.value.time ? 'datetime' : 'absolute')
        : dateCell(null)
    case 'person':
      return cell.value ? personCell(cell.value, memberMap.get(cell.value)) : null
    case 'relation':
      // v1: render the raw id — RelationWidget.entityType can't carry a
      // user-defined target. Label resolution is a follow-up.
      return cell.value ?? null
    case 'files': {
      const w: FilesWidget = { type: 'files', files: cell.value }
      return w
    }
    case 'checkbox':
      // A2UIRowValue carries no boolean; show a check glyph for `true`.
      return cell.value ? '✓' : null
    case 'url':
    case 'email':
    case 'phone':
      return cell.value ?? null
    default:
      return null
  }
}

async function buildCustomEntityTable(
  config: Extract<BindingConfig, { entity: 'custom' }>,
  deps: BindingDeps,
): Promise<A2UIWidget> {
  const rowAction = {
    id: 'open-entity',
    params: { entity: 'custom', entityTypeId: config.entityTypeId },
  }
  const store = deps.docEntityStore
  // No entity store wired (e.g. the anonymous public-share render path, which
  // pins an access context but injects no user-scoped entity store) — render
  // an empty table rather than throw, so the rest of the page still loads.
  if (!store) return { type: 'table', columns: [], rows: [], rowAction }

  const entityType = await store.getEntityType(deps.workspaceId, config.entityTypeId)
  if (!entityType) return { type: 'table', columns: [], rows: [], rowAction }

  const properties = entityType.properties
  const visible = config.columns ?? properties.map((p) => p.name)
  const { rows: instances } = await store.queryEntities(
    deps.workspaceId,
    config.entityTypeId,
    undefined,
    undefined,
    500,
  )

  // Pre-resolve select / multi_select option ids → display names.
  const optionNames = new Map<string, string>()
  for (const p of properties) {
    if (p.config.kind === 'select' || p.config.kind === 'multi_select') {
      for (const o of p.config.options) optionNames.set(`${p.name}:${o.id}`, o.name)
    }
  }

  // Batch-resolve every referenced member (person cells + created_by /
  // last_edited_by stamps) in one directory call.
  const personFields = properties.filter((p) => p.config.kind === 'person').map((p) => p.name)
  const wantsCreatedBy = properties.some((p) => p.config.kind === 'created_by')
  const wantsLastEditedBy = properties.some((p) => p.config.kind === 'last_edited_by')
  const memberIds = new Set<string>()
  for (const inst of instances) {
    for (const f of personFields) {
      const c = inst.data[f]
      if (c && c.kind === 'person' && c.value) memberIds.add(c.value)
    }
    if (wantsCreatedBy && inst.createdBy) memberIds.add(inst.createdBy)
    if (wantsLastEditedBy && inst.lastEditedBy) memberIds.add(inst.lastEditedBy)
  }
  const memberMap =
    memberIds.size > 0
      ? await deps.workspaceDirectory.batchGet(deps.workspaceId, [...memberIds])
      : new Map<string, WorkspaceMemberInfo>()

  const byName = new Map(properties.map((p) => [p.name, p]))
  const rows: A2UIRow[] = instances.map((inst) => {
    const out: A2UIRow = { id: inst.id }
    for (const name of visible) {
      const prop = byName.get(name)
      if (!prop) continue
      out[name] = customCell(inst.data[name], inst, prop, memberMap, optionNames)
    }
    return out
  })

  return { type: 'table', columns: customColumns(properties, visible), rows, rowAction }
}

// ── Public dispatcher ─────────────────────────────────────────────────

/**
 * Build an A2UI v0.8 ViewPayload from a BindingConfig. The discriminated
 * union ensures exhaustiveness — adding a new entity / viewType combination
 * to BindingConfig forces a switch arm here.
 */
export async function buildPayload(
  config: BindingConfig,
  deps: BindingDeps,
): Promise<ViewPayload> {
  let root: A2UIWidget
  switch (config.entity) {
    case 'tasks':
      root = config.viewType === 'table'
        ? await buildTasksTable(config, deps)
        : await buildTasksBoard(config, deps)
      break
    case 'contacts':
      root = await buildContactsTable(config, deps)
      break
    case 'companies':
      root = await buildCompaniesTable(config, deps)
      break
    case 'deals':
      root = config.viewType === 'table'
        ? await buildDealsTable(config, deps)
        : await buildDealsBoard(config, deps)
      break
    case 'workflow_runs':
      root = await buildWorkflowRunsTable(config, deps)
      break
    case 'custom':
      root = await buildCustomEntityTable(config, deps)
      break
  }
  return { a2ui: '0.8', root }
}
