/**
 * Server-side aggregations for the Phase-4 chart widgets.
 *
 * Pure (over its input arrays) — the only side effect is the store
 * call that loads rows. Once the rows are in memory, every reducer
 * here is deterministic and order-stable, so unit tests can drive
 * them with synthetic arrays without touching the DB.
 *
 * The shape mirrors what every chart widget consumes:
 *   { groups: { label, value }[], total? }
 *
 * `chart_bar` reads `groups` straight; `chart_line` builds a single
 * series whose `points[].x = group.label, y = group.value`; `chart_pie`
 * reads `groups` straight too. `kpi` reads `total`.
 *
 * The renderer never reaches into this module — it consumes the
 * resolved chart widget. The block resolver in `page-render.ts` calls
 * `resolveAggregation` to translate a `ChartBlock`'s binding into a
 * widget.
 *
 * [COMP:views/aggregations]
 */

import { z } from 'zod'
import type { CrmStore } from '../crm/types.js'
import type { AccessContext } from '../security/access-context.js'
import type { TaskStore } from '../tasks/types.js'

// ── Public types ──────────────────────────────────────────────────────

/**
 * Entity universes the aggregator can read. Mirrors the same closed
 * set as `BindingConfig.entity` minus `workflow_runs` (where chart
 * value is questionable — left out of v1 scope).
 */
export type AggregateEntity = 'tasks' | 'deals' | 'contacts' | 'companies'

/**
 * Aggregation operators. Each one collapses an entity's rows into a
 * `groups[]` array (and optionally a scalar `total`).
 *
 *   • `count_by`         — number of rows per `groupBy` value
 *   • `sum_by`           — `measure` summed per `groupBy` value
 *   • `avg_by`           — `measure` averaged per `groupBy` value
 *   • `series_by_date`   — rows bucketed by a date `groupBy` field at
 *                          day/week/month granularity; values are
 *                          either a row count or a `measure` sum
 */
export type AggregateOp =
  | 'count_by'
  | 'sum_by'
  | 'avg_by'
  | 'series_by_date'

/** Calendar bucket granularity for `series_by_date`. */
export type DateBucket = 'day' | 'week' | 'month'

export type AggregateBinding = {
  entity: AggregateEntity
  op: AggregateOp
  /**
   * The field name on the entity row to group by. For `series_by_date`
   * this MUST be a date-typed field; for the other ops it can be any
   * scalar (string / number) — non-stringifiable values are coerced
   * via `String(value)`.
   */
  groupBy: string
  /**
   * The numeric field to reduce. Required for `sum_by` / `avg_by` and
   * optional for `series_by_date` (defaults to row count). Ignored for
   * `count_by`.
   */
  measure?: string
  /**
   * Date-bucket granularity for `series_by_date`. Default 'day'.
   */
  bucket?: DateBucket
  /**
   * Free-form filter object. Each key is matched against the row's
   * same-named field with `===`. Used by the resolver to forward
   * `assigneeId`, `stage`, etc. into the underlying store list call;
   * also used as a final in-memory filter for any keys the store
   * didn't apply.
   */
  filters?: Record<string, unknown>
}

export type AggregateGroup = {
  label: string
  value: number
}

export type AggregateResult = {
  groups: AggregateGroup[]
  /** Scalar reduction (sum of values) — useful for KPI widgets. */
  total: number
}

/**
 * Stores the resolver needs. Injected by the route layer / chat tool
 * deps so this module remains pure of DB driver dependencies.
 *
 * `accessContext` is built by the caller from the calling user and
 * workspace — same shape as `bindingCtx` in `bindings.ts`.
 */
export type AggregationDeps = {
  taskStore: TaskStore
  crmStore: CrmStore
  accessContext: AccessContext
}

// ── Row-loading shim ──────────────────────────────────────────────────

type EntityRow = Record<string, unknown>

async function loadEntityRows(
  binding: AggregateBinding,
  deps: AggregationDeps,
): Promise<EntityRow[]> {
  switch (binding.entity) {
    case 'tasks': {
      const rows = await deps.taskStore.list(deps.accessContext, {})
      return rows as unknown as EntityRow[]
    }
    case 'deals': {
      const rows = await deps.crmStore.listDeals(deps.accessContext, {})
      return rows as unknown as EntityRow[]
    }
    case 'contacts': {
      const rows = await deps.crmStore.listContacts(deps.accessContext, {})
      return rows as unknown as EntityRow[]
    }
    case 'companies': {
      const rows = await deps.crmStore.listCompanies(deps.accessContext, {})
      return rows as unknown as EntityRow[]
    }
  }
}

// ── Pure reducers (exported for tests) ────────────────────────────────

function applyFilters(rows: EntityRow[], filters?: Record<string, unknown>): EntityRow[] {
  if (!filters) return rows
  const entries = Object.entries(filters)
  if (entries.length === 0) return rows
  return rows.filter((row) => entries.every(([k, v]) => row[k] === v))
}

function readField(row: EntityRow, field: string): unknown {
  return row[field]
}

function toLabel(value: unknown): string {
  if (value === null || value === undefined) return '∅'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

/**
 * Group rows by `groupBy` field and count occurrences. Groups are
 * sorted by descending count (stable insertion-order tiebreak).
 *
 * Exported for tests.
 */
export function countBy(rows: EntityRow[], groupBy: string): AggregateResult {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const label = toLabel(readField(row, groupBy))
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const groups: AggregateGroup[] = [...counts.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
  const total = groups.reduce((acc, g) => acc + g.value, 0)
  return { groups, total }
}

/**
 * Sum the `measure` field per `groupBy` value. Rows whose measure is
 * not a finite number contribute 0.
 *
 * Exported for tests.
 */
export function sumBy(
  rows: EntityRow[],
  groupBy: string,
  measure: string,
): AggregateResult {
  const sums = new Map<string, number>()
  for (const row of rows) {
    const label = toLabel(readField(row, groupBy))
    const value = toNumber(readField(row, measure)) ?? 0
    sums.set(label, (sums.get(label) ?? 0) + value)
  }
  const groups: AggregateGroup[] = [...sums.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
  const total = groups.reduce((acc, g) => acc + g.value, 0)
  return { groups, total }
}

/**
 * Average the `measure` field per `groupBy` value. Rows whose measure
 * is not a finite number are excluded from the average; an empty
 * group resolves to 0.
 *
 * Exported for tests.
 */
export function avgBy(
  rows: EntityRow[],
  groupBy: string,
  measure: string,
): AggregateResult {
  const sums = new Map<string, { sum: number; count: number }>()
  for (const row of rows) {
    const label = toLabel(readField(row, groupBy))
    const value = toNumber(readField(row, measure))
    if (value === null) continue
    const prev = sums.get(label) ?? { sum: 0, count: 0 }
    sums.set(label, { sum: prev.sum + value, count: prev.count + 1 })
  }
  const groups: AggregateGroup[] = [...sums.entries()]
    .map(([label, { sum, count }]) => ({
      label,
      value: count === 0 ? 0 : sum / count,
    }))
    .sort((a, b) => b.value - a.value)
  const total = groups.reduce((acc, g) => acc + g.value, 0)
  return { groups, total }
}

/**
 * Bucket a date-valued `groupBy` field at the given granularity. The
 * bucket label is an ISO date string trimmed to the granularity
 * (`YYYY-MM-DD` for day, the ISO date of week-start Monday for week,
 * `YYYY-MM` for month). Buckets are returned chronologically.
 *
 * When `measure` is present, the bucket value is the sum of that
 * numeric field; otherwise it's the row count.
 *
 * Exported for tests.
 */
export function seriesByDate(
  rows: EntityRow[],
  groupBy: string,
  bucket: DateBucket,
  measure?: string,
): AggregateResult {
  const buckets = new Map<string, number>()
  for (const row of rows) {
    const raw = readField(row, groupBy)
    const date = coerceDate(raw)
    if (!date) continue
    const label = bucketLabel(date, bucket)
    const value = measure ? toNumber(readField(row, measure)) ?? 0 : 1
    buckets.set(label, (buckets.get(label) ?? 0) + value)
  }
  const groups: AggregateGroup[] = [...buckets.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
  const total = groups.reduce((acc, g) => acc + g.value, 0)
  return { groups, total }
}

function coerceDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value === 'string') {
    const d = new Date(value)
    if (!Number.isNaN(d.getTime())) return d
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value)
    if (!Number.isNaN(d.getTime())) return d
  }
  return null
}

function bucketLabel(date: Date, bucket: DateBucket): string {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  if (bucket === 'day') return `${y}-${m}-${d}`
  if (bucket === 'month') return `${y}-${m}`
  // Week: ISO date of Monday in UTC.
  const dayOfWeek = date.getUTCDay() // 0 = Sun, 1 = Mon, ... 6 = Sat
  const offsetToMonday = ((dayOfWeek + 6) % 7) // Mon -> 0, Sun -> 6
  const monday = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() - offsetToMonday,
  ))
  const wy = monday.getUTCFullYear()
  const wm = String(monday.getUTCMonth() + 1).padStart(2, '0')
  const wd = String(monday.getUTCDate()).padStart(2, '0')
  return `${wy}-${wm}-${wd}`
}

// ── Public resolver ───────────────────────────────────────────────────

/**
 * Resolve an `AggregateBinding` to its `{ groups, total }` shape by
 * loading the entity rows through the appropriate store and running
 * the requested op.
 *
 * Throws on `sum_by` / `avg_by` without `measure` so misconfigured
 * chart blocks fail loudly instead of silently emitting zeros.
 */
export async function resolveAggregation(
  binding: AggregateBinding,
  deps: AggregationDeps,
): Promise<AggregateResult> {
  if ((binding.op === 'sum_by' || binding.op === 'avg_by') && !binding.measure) {
    throw new Error(
      `[aggregations] op="${binding.op}" requires \`measure\` (numeric field name).`,
    )
  }
  const rawRows = await loadEntityRows(binding, deps)
  const rows = applyFilters(rawRows, binding.filters)

  switch (binding.op) {
    case 'count_by':
      return countBy(rows, binding.groupBy)
    case 'sum_by':
      return sumBy(rows, binding.groupBy, binding.measure!)
    case 'avg_by':
      return avgBy(rows, binding.groupBy, binding.measure!)
    case 'series_by_date':
      return seriesByDate(rows, binding.groupBy, binding.bucket ?? 'day', binding.measure)
  }
}

// ── Zod schema (for the renderChart tool) ─────────────────────────────

export const aggregateBindingSchema: z.ZodType<AggregateBinding> = z.object({
  entity: z.enum(['tasks', 'deals', 'contacts', 'companies']),
  op: z.enum(['count_by', 'sum_by', 'avg_by', 'series_by_date']),
  groupBy: z.string().min(1).max(128),
  measure: z.string().min(1).max(128).optional(),
  bucket: z.enum(['day', 'week', 'month']).optional(),
  filters: z.record(z.unknown()).optional(),
}) as z.ZodType<AggregateBinding>
