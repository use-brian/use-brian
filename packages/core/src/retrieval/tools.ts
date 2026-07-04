import { z } from 'zod'
import { buildTool, type Tool, type ToolContext } from '../tools/types.js'
import type {
  AggregateInput,
  AggregateMeasure,
  GetEntityInput,
  MarkUsefulInput,
  ProvenanceInput,
  RecentEpisodesInput,
  RetrievalActor,
  RetrievalErrorBody,
  RetrievalResult,
  RetrievalStore,
  RetrievalToolEvent,
  RowHistoryInput,
  SearchInput,
} from './types.js'

const LIST_LIMIT_CAP = 100

const filtersSchema = z.record(z.unknown())

const limitsSchema = z.object({
  recent_episodes: z.number().int().positive().max(LIST_LIMIT_CAP).optional(),
  recent_memory: z.number().int().positive().max(LIST_LIMIT_CAP).optional(),
  open_tasks: z.number().int().positive().max(LIST_LIMIT_CAP).optional(),
  edges: z.number().int().positive().max(LIST_LIMIT_CAP).optional(),
  files: z.number().int().positive().max(LIST_LIMIT_CAP).optional(),
  kb_chunks: z.number().int().positive().max(LIST_LIMIT_CAP).optional(),
})

const isoTimestamp = z.string().datetime({ offset: true })

const getEntitySchema = z.object({
  id_or_name: z.string().min(1, 'id_or_name is required'),
  as_of: isoTimestamp.optional(),
  walk_depth: z.number().int().nonnegative().max(3).optional(),
  walk_edge_types: z.array(z.string()).optional(),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  limits: limitsSchema.optional(),
}) satisfies z.ZodType<GetEntityInput>

const searchSchema = z.object({
  query: z.string().min(1, 'query is required'),
  as_of: isoTimestamp.optional(),
  scope: z.string().optional(),
  filters: filtersSchema.optional(),
  limit: z.number().int().positive().max(LIST_LIMIT_CAP).optional(),
  cursor: z.string().optional(),
}) satisfies z.ZodType<SearchInput>

const recentEpisodesSchema = z.object({
  entity: z.string().optional(),
  as_of: isoTimestamp.optional(),
  limit: z.number().int().positive().max(LIST_LIMIT_CAP).optional(),
  cursor: z.string().optional(),
  filters: filtersSchema.optional(),
}) satisfies z.ZodType<RecentEpisodesInput>

const provenanceSchema = z.object({
  row_id: z.string().min(1, 'row_id is required'),
}) satisfies z.ZodType<ProvenanceInput>

const markUsefulSchema = z.object({
  row_id: z.string().min(1, 'row_id is required'),
  primitive: z.enum(['memory', 'entity', 'edge', 'task', 'kb_chunk']),
}) satisfies z.ZodType<MarkUsefulInput>

const aggregateMeasureSchema = z.discriminatedUnion('fn', [
  z.object({ fn: z.literal('count') }),
  z.object({ fn: z.literal('sum'), path: z.string().min(1) }),
  z.object({ fn: z.literal('max'), path: z.string().min(1) }),
  z.object({ fn: z.literal('min'), path: z.string().min(1) }),
  z.object({ fn: z.literal('avg'), path: z.string().min(1) }),
]) satisfies z.ZodType<AggregateMeasure>

const aggregateSchema = z.object({
  measure: aggregateMeasureSchema,
  dimensions: z.array(z.string().min(1)).min(1, 'at least one dimension is required'),
  filters: filtersSchema.optional(),
  as_of: isoTimestamp.optional(),
}) satisfies z.ZodType<AggregateInput>

const rowHistorySchema = z.object({
  primitive: z.enum([
    'memories',
    'tasks',
    'workspace_files',
    'entities',
    'companies',
    'contacts',
    'deals',
  ]),
  row_id: z.string().min(1, 'row_id is required'),
  include_retracted: z.boolean().optional(),
  as_of: isoTimestamp.optional(),
}) satisfies z.ZodType<RowHistoryInput>

export type RetrievalToolOptions = {
  onEvent?: (event: RetrievalToolEvent) => void
  /**
   * CL-9 retrieval-miss hook — fires once after the `search` tool
   * returns. Implementation lives in `packages/api/src/retrieval/
   * retrieval-miss-detector.ts`. Decoupled because the detector
   * depends on a database store (`retrieval_miss`) which packages/core
   * cannot reference (it's the orchestration engine; no DB seam).
   *
   * Errors from the hook are swallowed by the detector itself; this
   * surface intentionally forces a fire-and-forget contract so a
   * detector exception cannot break the search hot path.
   *
   * Spec: `docs/architecture/context-engine/memory-consolidation.md` → CL-9 lock.
   */
  onAfterSearch?: (info: {
    query: string
    sessionId: string
    workspaceId: string | null | undefined
    userId: string
    resultIds: string[]
  }) => void
}

/**
 * Resolve the actor projection from a `ToolContext`. The store's permission
 * predicate only needs workspaceId / userId / assistantId / clearance — the
 * full ToolContext stays inside the engine.
 *
 * Returns an error body when workspaceId is absent; retrieval is workspace-
 * scoped (see retrieval.md §"Universal projection") and a call without one
 * has no defined permission boundary.
 */
function actorFromContext(context: ToolContext): RetrievalActor | RetrievalErrorBody {
  if (!context.workspaceId) {
    return { error: 'Retrieval requires a workspace-scoped session.' }
  }
  return {
    workspaceId: context.workspaceId,
    userId: context.userId,
    assistantId: context.assistantId,
    assistantKind: context.assistantKind ?? 'standard',
    clearance: context.clearance,
    compartments: context.compartments,
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Build the 7 retrieval tools. Each tool's `data` payload is the canonical
 * `RetrievalEnvelope<T>` (or `RetrievalErrorBody` on failure) — the same
 * shape the eventual HTTP / MCP wrapper surfaces externally.
 *
 * Read tools advertise `isReadOnly: true` + `isConcurrencySafe: true`.
 * `markUseful` is an idempotent write (`isReadOnly: false`, `isConcurrencySafe: true`).
 */
export function createRetrievalTools(
  store: RetrievalStore,
  opts?: RetrievalToolOptions,
): {
  getEntity: Tool
  search: Tool
  recentEpisodes: Tool
  provenance: Tool
  markUseful: Tool
  aggregate: Tool
  getRowHistory: Tool
} {
  const getEntity = buildTool({
    name: 'getEntity',
    description:
      'Fetch a brain entity by id or display_name with a rich rollup (summary counts + embedded recent_episodes, recent_memory, open_tasks, edges). ' +
      'Supports `as_of` for point-in-time reads, `walk_depth` / `walk_edge_types` for edge expansion, and `include` / `exclude` / `limits` to narrow the embedded sections. ' +
      'Auto-follows merged-entity supersession; the breadcrumb surfaces in `meta.followed_supersession`.',
    inputSchema: getEntitySchema,
    isConcurrencySafe: true,
    isReadOnly: true,

    async execute(input, context) {
      const actor = actorFromContext(context)
      if ('error' in actor) return { data: actor, isError: true }
      try {
        const result = await store.getEntity(actor, input)
        opts?.onEvent?.({
          type: 'entity_retrieved',
          idOrName: input.id_or_name,
          found: result !== null,
        })
        if (result === null) {
          const body: RetrievalErrorBody = { error: `Entity ${input.id_or_name} not found` }
          return { data: body, isError: true }
        }
        return { data: result satisfies RetrievalResult<unknown> }
      } catch (err) {
        return { data: { error: errorMessage(err) } satisfies RetrievalErrorBody, isError: true }
      }
    },
  })

  const search = buildTool({
    name: 'search',
    description:
      'Hybrid search across the company brain. Returns matched rows keyed by `primitive` + `row_id`. ' +
      'Supports `scope` (primitive kind), `filters` (flat key-value, per-primitive allowlist), `limit`, and opaque `cursor` pagination. ' +
      'Bi-temporal `as_of` defaults to now. Vector fusion ships with WS-8; v1 uses FTS + graph + recency. ' +
      'Rows with `primitive: "file_segment"` are passages inside a stored document (capped per file here); ' +
      'follow up with the per-file content tool using their `file_id` to search or read that document in depth.',
    inputSchema: searchSchema,
    isConcurrencySafe: true,
    isReadOnly: true,

    async execute(input, context) {
      const actor = actorFromContext(context)
      if ('error' in actor) return { data: actor, isError: true }
      try {
        const result = await store.search(actor, input)
        opts?.onEvent?.({
          type: 'search_executed',
          query: input.query,
          resultCount: result.data.length,
        })
        // CL-9 retrieval-miss hook. Fire-and-forget — the detector
        // catches its own exceptions; we still guard here so a
        // synchronously-throwing hook can never reach the chat path.
        if (opts?.onAfterSearch) {
          try {
            opts.onAfterSearch({
              query: input.query,
              sessionId: context.sessionId,
              workspaceId: context.workspaceId,
              userId: context.userId,
              resultIds: result.data.map((row) => row.row_id),
            })
          } catch {
            // Swallow — see RetrievalToolOptions.onAfterSearch contract.
          }
        }
        return { data: result satisfies RetrievalResult<unknown> }
      } catch (err) {
        return { data: { error: errorMessage(err) } satisfies RetrievalErrorBody, isError: true }
      }
    },
  })

  const recentEpisodes = buildTool({
    name: 'recentEpisodes',
    description:
      'List recent Episodes ordered by recency. Optional filters: `entity` (anchor on an entity id), `filters` (flat key-value), `as_of` (bi-temporal), `limit`, opaque `cursor`. ' +
      'Sensitivity projection applies — episodes above the assistant clearance are silently elided.',
    inputSchema: recentEpisodesSchema,
    isConcurrencySafe: true,
    isReadOnly: true,

    async execute(input, context) {
      const actor = actorFromContext(context)
      if ('error' in actor) return { data: actor, isError: true }
      try {
        const result = await store.recentEpisodes(actor, input)
        opts?.onEvent?.({
          type: 'recent_episodes_listed',
          resultCount: result.data.length,
          entity: input.entity,
        })
        return { data: result satisfies RetrievalResult<unknown> }
      } catch (err) {
        return { data: { error: errorMessage(err) } satisfies RetrievalErrorBody, isError: true }
      }
    },
  })

  const provenance = buildTool({
    name: 'provenance',
    description:
      'Trace a row to its source Episode, authorship, supersession chain, and derived-from references. ' +
      'One level deep — the model can call again on returned `row_id`s to follow further. ' +
      'Inaccessible sources surface as `source_episode: null` and inaccessible `derived_from` entries are omitted (silent redaction, P1-8).',
    inputSchema: provenanceSchema,
    isConcurrencySafe: true,
    isReadOnly: true,

    async execute(input, context) {
      const actor = actorFromContext(context)
      if ('error' in actor) return { data: actor, isError: true }
      try {
        const result = await store.provenance(actor, input)
        opts?.onEvent?.({
          type: 'provenance_walked',
          rowId: input.row_id,
          found: result !== null,
        })
        if (result === null) {
          const body: RetrievalErrorBody = { error: `Row ${input.row_id} not found` }
          return { data: body, isError: true }
        }
        return { data: result satisfies RetrievalResult<unknown> }
      } catch (err) {
        return { data: { error: errorMessage(err) } satisfies RetrievalErrorBody, isError: true }
      }
    },
  })

  const markUseful = buildTool({
    name: 'markUseful',
    description:
      'Record an opt-in usefulness signal for a retrieved row (CL-7 raw-retrieval feedback). Idempotent; repeated calls do not error.',
    inputSchema: markUsefulSchema,
    isConcurrencySafe: true,
    isReadOnly: false,

    async execute(input, context) {
      const actor = actorFromContext(context)
      if ('error' in actor) return { data: actor, isError: true }
      try {
        const result = await store.markUseful(actor, input)
        opts?.onEvent?.({
          type: 'mark_useful_recorded',
          rowId: input.row_id,
          primitive: input.primitive,
        })
        return { data: result satisfies RetrievalResult<unknown> }
      } catch (err) {
        return { data: { error: errorMessage(err) } satisfies RetrievalErrorBody, isError: true }
      }
    },
  })

  const aggregate = buildTool({
    name: 'aggregate',
    description:
      'BI-style aggregate. `measure` is `{ fn: "count" }` or `{ fn: "sum"|"max"|"min"|"avg", path }` where `path` follows the flat-filter dot-syntax against the target primitive\'s typed columns or JSONB attributes (e.g. `amount_cents`, `attributes.engagement_count`). ' +
      '`dimensions` are grouping keys. Server validates `measure.path` and dimensions against the per-primitive allowlist. ' +
      'Permission projection applies — rows above clearance never enter the aggregate.',
    inputSchema: aggregateSchema,
    isConcurrencySafe: true,
    isReadOnly: true,

    async execute(input, context) {
      const actor = actorFromContext(context)
      if ('error' in actor) return { data: actor, isError: true }
      try {
        const result = await store.aggregate(actor, input)
        opts?.onEvent?.({
          type: 'aggregate_computed',
          resultCount: result.data.length,
          fn: input.measure.fn,
        })
        return { data: result satisfies RetrievalResult<unknown> }
      } catch (err) {
        return { data: { error: errorMessage(err) } satisfies RetrievalErrorBody, isError: true }
      }
    },
  })

  const getRowHistory = buildTool({
    name: 'getRowHistory',
    description:
      'Trace the full bi-temporal version chain of a brain row (D.7 supersession audit). ' +
      'Returns every version oldest→newest with status (active / superseded / retracted), validity window, ' +
      'authorship, and `current_id` — the version active now or at `as_of`. ' +
      'Use to answer "how did this fact change over time" or "who created/edited this row". ' +
      '`include_retracted` defaults to true.',
    inputSchema: rowHistorySchema,
    isConcurrencySafe: true,
    isReadOnly: true,

    async execute(input, context) {
      const actor = actorFromContext(context)
      if ('error' in actor) return { data: actor, isError: true }
      try {
        const result = await store.getRowHistory(actor, input)
        opts?.onEvent?.({
          type: 'row_history_walked',
          primitive: input.primitive,
          rowId: input.row_id,
          chainLength: result === null ? 0 : result.data.chain.length,
        })
        if (result === null) {
          const body: RetrievalErrorBody = { error: `Row ${input.row_id} not found` }
          return { data: body, isError: true }
        }
        return { data: result satisfies RetrievalResult<unknown> }
      } catch (err) {
        return { data: { error: errorMessage(err) } satisfies RetrievalErrorBody, isError: true }
      }
    },
  })

  return { getEntity, search, recentEpisodes, provenance, markUseful, aggregate, getRowHistory }
}
