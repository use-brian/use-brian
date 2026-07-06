import type {
  AggregateData,
  AggregateInput,
  AggregateMeasure,
  AggregateResultRow,
  RetrievalActor,
  RetrievalEnvelope,
  RetrievalStore,
} from '@sidanclaw/core'
import { buildAccessPredicate } from './access-predicate.js'
import { queryWithRLS } from './client.js'

/**
 * `aggregate({ measure, dimensions, filters?, as_of? })` — BI-style
 * grouped reads over the company-brain primitives. WS-5 / WU-5.4.
 *
 * Spec: docs/architecture/brain/retrieval-layer.md §"aggregate semantics"
 * (lines 32-51). The companion contract types live in
 * packages/core/src/retrieval/types.ts (WU-5.1).
 *
 * Target primitive carries on `filters.primitive` (reserved key) —
 * matches the convention `search` already established with `scope`.
 * The `AggregateInput` contract has no `target_primitive` field; if
 * the convention ever changes, the spec gains a reserved-filter line
 * and this validator updates with it.
 *
 * Safety model — every SQL fragment is a validated-token substitution
 * looked up from the per-primitive ALLOWLIST below. Only filter VALUES
 * pass through $n placeholders. JSONB-path measure paths (e.g.
 * `attributes.amount_cents`) are gated by the same allowlist so the
 * surface stays bounded — the spec calls this out as "the allowlist
 * prevents unbounded JSONB-aggregate attack surface."
 *
 * Permission projection (WS-4 / WU-4.2b) — every row inside the
 * aggregate is gated by `buildAccessPredicate(actor)` (workspace +
 * visibility-double + sensitivity ≤ clearance). `RetrievalActor` is
 * structurally an `AccessContext` (same four fields), so it flows
 * directly into the helper. Sensitivity is dropped from the predicate
 * when `actor.clearance` is undefined (system callers).
 */

// ── Allowlist ────────────────────────────────────────────────────────

type PathSpec = {
  /** Rendered SQL fragment that resolves to the value (column ref or JSONB cast). */
  sql: string
  /** Logical type — gates which measure fns are valid for this path. */
  type: 'numeric' | 'text' | 'timestamp' | 'uuid'
}

type PrimitiveAllowlist = {
  /** Physical table name. */
  table: string
  /** Allowed paths for `measure.path` (sum / max / min / avg). */
  measurePaths: Record<string, PathSpec>
  /** Allowed grouping keys. */
  dimensionPaths: Record<string, PathSpec>
  /** Allowed filter keys (equality only at launch). */
  filterPaths: Record<string, PathSpec>
  /** Optional constant predicate ANDed into the WHERE — used when several
   *  primitives share the `entities` table and need a `kind` filter. */
  baseWhere?: string
  /**
   * `false` for non-bi-temporal primitives (doc `entity_instances`):
   * skips the `retracted_at`/`valid_from`/`valid_to` window AND the
   * visibility-double access predicate (those columns don't exist) —
   * `workspace_id` + RLS gate instead. Defaults to `true` when omitted.
   */
  biTemporal?: boolean
}

/**
 * Minimal launch coverage. JSONB attribute paths (e.g.
 * `attributes.engagement_count`, `attributes.amount_cents`) are
 * mentioned in the spec as forward-looking; they get wired here once
 * Pipeline B (WU-3.6) starts emitting those keys. The PathSpec shape
 * already supports JSONB casts — adding a path is a one-line edit.
 */
const ALLOWLIST: Readonly<Record<string, PrimitiveAllowlist>> = {
  deals: {
    table: 'entities',
    baseWhere: "kind = 'deal'",
    measurePaths: {
      amount: { sql: "(attributes->>'amount')::numeric", type: 'numeric' },
      created_at: { sql: 'created_at', type: 'timestamp' },
    },
    dimensionPaths: {
      stage: { sql: "attributes->>'stage'", type: 'text' },
      company_id: { sql: "(attributes->>'company_id')::uuid", type: 'uuid' },
      contact_id: { sql: "(attributes->>'contact_id')::uuid", type: 'uuid' },
      quarter: { sql: "date_trunc('quarter', created_at)", type: 'timestamp' },
      month: { sql: "date_trunc('month', created_at)", type: 'timestamp' },
    },
    filterPaths: {
      stage: { sql: "attributes->>'stage'", type: 'text' },
      company_id: { sql: "(attributes->>'company_id')::uuid", type: 'uuid' },
      contact_id: { sql: "(attributes->>'contact_id')::uuid", type: 'uuid' },
    },
  },
  tasks: {
    table: 'tasks',
    measurePaths: {},
    dimensionPaths: {
      status: { sql: 'status', type: 'text' },
      assignee_id: { sql: 'assignee_id', type: 'uuid' },
      quarter: { sql: "date_trunc('quarter', created_at)", type: 'timestamp' },
      month: { sql: "date_trunc('month', created_at)", type: 'timestamp' },
    },
    filterPaths: {
      status: { sql: 'status', type: 'text' },
      assignee_id: { sql: 'assignee_id', type: 'uuid' },
      parent_id: { sql: 'parent_id', type: 'uuid' },
    },
  },
  memories: {
    table: 'memories',
    measurePaths: {},
    dimensionPaths: {
      type: { sql: 'type', type: 'text' },
      scope: { sql: 'scope', type: 'text' },
      source: { sql: 'source', type: 'text' },
      sensitivity: { sql: 'sensitivity', type: 'text' },
    },
    filterPaths: {
      type: { sql: 'type', type: 'text' },
      scope: { sql: 'scope', type: 'text' },
      source: { sql: 'source', type: 'text' },
      sensitivity: { sql: 'sensitivity', type: 'text' },
    },
  },
  workspace_files: {
    table: 'workspace_files',
    measurePaths: {},
    dimensionPaths: {
      mime: { sql: 'mime', type: 'text' },
      sensitivity: { sql: 'sensitivity', type: 'text' },
      source: { sql: 'source', type: 'text' },
    },
    filterPaths: {
      mime: { sql: 'mime', type: 'text' },
      sensitivity: { sql: 'sensitivity', type: 'text' },
      source: { sql: 'source', type: 'text' },
    },
  },
  companies: {
    table: 'entities',
    baseWhere: "kind = 'company'",
    measurePaths: {},
    dimensionPaths: {
      sensitivity: { sql: 'sensitivity', type: 'text' },
      source: { sql: 'source', type: 'text' },
    },
    filterPaths: {
      sensitivity: { sql: 'sensitivity', type: 'text' },
      source: { sql: 'source', type: 'text' },
    },
  },
  contacts: {
    table: 'entities',
    baseWhere: "kind = 'person' AND NOT COALESCE((attributes->>'self')::boolean, false)",
    measurePaths: {},
    dimensionPaths: {
      company_id: { sql: "(attributes->>'company_id')::uuid", type: 'uuid' },
      sensitivity: { sql: 'sensitivity', type: 'text' },
      source: { sql: 'source', type: 'text' },
    },
    filterPaths: {
      company_id: { sql: "(attributes->>'company_id')::uuid", type: 'uuid' },
      sensitivity: { sql: 'sensitivity', type: 'text' },
      source: { sql: 'source', type: 'text' },
    },
  },
  kb_chunks: {
    table: 'kb_chunks',
    measurePaths: {
      chunk_index: { sql: 'chunk_index', type: 'numeric' },
    },
    dimensionPaths: {
      source_path: { sql: 'source_path', type: 'text' },
      sensitivity: { sql: 'sensitivity', type: 'text' },
      source: { sql: 'source', type: 'text' },
    },
    filterPaths: {
      source_path: { sql: 'source_path', type: 'text' },
      sensitivity: { sql: 'sensitivity', type: 'text' },
      source: { sql: 'source', type: 'text' },
    },
  },
  entities: {
    table: 'entities',
    measurePaths: {
      centrality: { sql: 'centrality', type: 'numeric' },
    },
    dimensionPaths: {
      kind: { sql: 'kind', type: 'text' },
      sensitivity: { sql: 'sensitivity', type: 'text' },
      source: { sql: 'source', type: 'text' },
    },
    filterPaths: {
      kind: { sql: 'kind', type: 'text' },
      sensitivity: { sql: 'sensitivity', type: 'text' },
      source: { sql: 'source', type: 'text' },
    },
  },
  entity_instances: {
    table: 'entity_instances',
    // Doc user-defined rows (mig 200): no bi-temporal window, no
    // visibility-double — workspace_id + RLS gate.
    biTemporal: false,
    measurePaths: {
      // JSONB attribute measure — the launch path for doc numeric
      // attributes. Add more keys here as the catalog grows.
      rating: { sql: "(data->>'rating')::numeric", type: 'numeric' },
    },
    dimensionPaths: {
      entity_type_id: { sql: 'entity_type_id', type: 'uuid' },
      source_app: { sql: 'source_app', type: 'text' },
    },
    filterPaths: {
      entity_type_id: { sql: 'entity_type_id', type: 'uuid' },
      source_app: { sql: 'source_app', type: 'text' },
    },
  },
}

/** Reserved filter key — selects the target primitive. */
const PRIMITIVE_KEY = 'primitive'

const MAX_GROUPED_ROWS = 1000

// ── Validation helpers ───────────────────────────────────────────────

function resolvePrimitive(filters: Record<string, unknown> | undefined): PrimitiveAllowlist {
  const rawPrim = filters?.[PRIMITIVE_KEY]
  if (typeof rawPrim !== 'string' || rawPrim.length === 0) {
    throw new Error('aggregate: filters.primitive is required.')
  }
  const spec = ALLOWLIST[rawPrim]
  if (!spec) {
    throw new Error(
      `aggregate: unknown primitive "${rawPrim}". Valid: ${Object.keys(ALLOWLIST).sort().join(', ')}.`,
    )
  }
  return spec
}

function resolveMeasureSql(
  measure: AggregateMeasure,
  allow: PrimitiveAllowlist,
  primitiveName: string,
): string {
  if (measure.fn === 'count') return 'COUNT(*)'

  const spec = allow.measurePaths[measure.path]
  if (!spec) {
    throw new Error(
      `aggregate: path "${measure.path}" is not registered for primitive "${primitiveName}".`,
    )
  }

  if ((measure.fn === 'sum' || measure.fn === 'avg') && spec.type !== 'numeric') {
    throw new Error(`aggregate: path "${measure.path}" is not numeric.`)
  }
  if (measure.fn === 'max' || measure.fn === 'min') {
    if (spec.type !== 'numeric' && spec.type !== 'timestamp') {
      throw new Error(
        `aggregate: ${measure.fn} on path "${measure.path}" requires a numeric or timestamp path.`,
      )
    }
  }

  return `${measure.fn.toUpperCase()}(${spec.sql})`
}

function resolveDimensions(
  dimensions: string[],
  allow: PrimitiveAllowlist,
  primitiveName: string,
): Array<{ name: string; sql: string }> {
  return dimensions.map((dim) => {
    const spec = allow.dimensionPaths[dim]
    if (!spec) {
      throw new Error(
        `aggregate: dimension "${dim}" is not registered for primitive "${primitiveName}".`,
      )
    }
    return { name: dim, sql: spec.sql }
  })
}

function validateAsOf(asOf: string | undefined): Date | null {
  if (asOf === undefined) return null
  const d = new Date(asOf)
  if (Number.isNaN(d.getTime())) {
    throw new Error('aggregate: as_of is not a valid ISO timestamp.')
  }
  return d
}

// ── Public surface ───────────────────────────────────────────────────

export function createDbAggregateStore(): Pick<RetrievalStore, 'aggregate'> {
  return {
    async aggregate(
      actor: RetrievalActor,
      input: AggregateInput,
    ): Promise<RetrievalEnvelope<AggregateData>> {
      const allow = resolvePrimitive(input.filters)
      const measureSql = resolveMeasureSql(input.measure, allow, getPrimitiveName(input.filters))
      const dims = resolveDimensions(input.dimensions, allow, getPrimitiveName(input.filters))
      const asOf = validateAsOf(input.as_of)

      const biTemporal = allow.biTemporal !== false

      // Access predicate. Bi-temporal primitives carry the universal
      // visibility-double + sensitivity≤clearance columns (WU-4.2b).
      // entity_instances has none of those — it's workspace_id + RLS only.
      let apSql: string
      const values: unknown[] = []
      let asOfIdx = 0
      let idx: number
      if (biTemporal) {
        const ap = buildAccessPredicate(actor, { startIdx: 1 })
        values.push(...ap.params, asOf)
        apSql = ap.sql
        asOfIdx = ap.nextIdx
        idx = asOfIdx + 1
      } else {
        values.push(actor.workspaceId)
        apSql = 'workspace_id = $1'
        idx = 2
      }

      const filterClauses: string[] = []
      for (const [key, raw] of Object.entries(input.filters ?? {})) {
        if (key === PRIMITIVE_KEY) continue
        const spec = allow.filterPaths[key]
        if (!spec) {
          throw new Error(
            `aggregate: filter "${key}" is not registered for primitive "${getPrimitiveName(input.filters)}".`,
          )
        }
        filterClauses.push(`${spec.sql} = $${idx}`)
        values.push(raw)
        idx++
      }

      const dimSelect = dims.map((d, i) => `${d.sql} AS "dim_${i}"`).join(', ')
      const groupOrderSql = dims.map((d) => d.sql).join(', ')

      const bitemporalClause = biTemporal
        ? `AND retracted_at IS NULL
           AND valid_from <= COALESCE($${asOfIdx}::timestamptz, now())
           AND (valid_to IS NULL OR valid_to > COALESCE($${asOfIdx}::timestamptz, now()))`
        : ''

      const sql = `
        SELECT ${dimSelect}, ${measureSql} AS measure_value
          FROM ${allow.table}
         WHERE ${apSql}
           ${allow.baseWhere ? `AND ${allow.baseWhere}` : ''}
           ${bitemporalClause}
           ${filterClauses.length > 0 ? `AND ${filterClauses.join(' AND ')}` : ''}
         GROUP BY ${groupOrderSql}
         ORDER BY ${groupOrderSql}
         LIMIT ${MAX_GROUPED_ROWS}
      `

      const result = await queryWithRLS<Record<string, unknown>>(actor.userId, sql, values)

      const data: AggregateData = result.rows.map((row) => {
        const out: AggregateResultRow = {
          measure_value: coerceMeasureValue(row.measure_value),
        }
        dims.forEach((d, i) => {
          out[d.name] = row[`dim_${i}`] ?? null
        })
        return out
      })

      return {
        api_version: 'v1',
        data,
        meta: {
          retrieved_at: new Date().toISOString(),
          truncated: result.rows.length >= MAX_GROUPED_ROWS,
        },
      }
    },
  }
}

function getPrimitiveName(filters: Record<string, unknown> | undefined): string {
  const raw = filters?.[PRIMITIVE_KEY]
  return typeof raw === 'string' ? raw : '<missing>'
}

/**
 * pg returns NUMERIC and COUNT as strings to preserve precision. Coerce
 * to number when finite; otherwise keep the string (large NUMERIC sums
 * outside the safe-integer range pass through unchanged).
 */
function coerceMeasureValue(raw: unknown): number | string {
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') {
    const n = Number(raw)
    if (Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER) return n
    return raw
  }
  if (raw === null || raw === undefined) return 0
  return String(raw)
}
