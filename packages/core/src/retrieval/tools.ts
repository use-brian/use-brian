import { z } from 'zod'
import { buildTool, type Tool, type ToolContext } from '../tools/types.js'
import { describeToolFailure } from '../tools/tool-failure.js'
import { tolerantIsoTimestamp } from '../tools/schema-tolerance.js'
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
import { scopeEvidenceFromRows } from '../security/context-scope.js'

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

/**
 * Point-in-time reads accept a bare `YYYY-MM-DD` (widened to midnight UTC) as
 * well as a full ISO timestamp. A model asked "what did we know on the 14th"
 * emits the bare date, and the old strict shape rejected it with zod's
 * "Invalid datetime" — a message that names neither the accepted shape nor the
 * fix, so the retry was a guess. See `tolerantIsoTimestamp`.
 */
const isoTimestamp = tolerantIsoTimestamp()

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
export function actorFromContext(context: ToolContext): RetrievalActor | RetrievalErrorBody {
  if (!context.workspaceId) {
    return {
      error:
        'This chat is not bound to a workspace, so the company brain cannot be read here — brain rows are workspace-scoped and there is no permission boundary to evaluate. No argument change or retry will help in this session. Answer from what is already in context, or tell the user to ask from a workspace chat.',
    }
  }
  return {
    workspaceId: context.workspaceId,
    userId: context.userId,
    assistantId: context.assistantId,
    assistantKind: context.assistantKind ?? 'standard',
    clearance: context.clearance,
    compartments: context.compartments,
    projectIds: context.projectIds,
  }
}

/**
 * Retrieval's `catch` frame. The body stays the canonical one-key
 * `RetrievalErrorBody` (the executor unwraps `{ error }` to bare prose, and
 * the HTTP / MCP wrapper surfaces the same shape) — only the string inside it
 * changes, from a bare `err.message` to the shared first-party failure copy:
 * what ran on which target, why, the next step, and whether a retry can ever
 * work. Reads are non-mutating, so no "nothing was saved" clause.
 */
function retrievalFailure(
  err: unknown,
  tool: string,
  target: string | undefined,
  next?: string,
): { data: RetrievalErrorBody; isError: true } {
  const body: RetrievalErrorBody = {
    error: describeToolFailure(err, { tool, target, next }),
  }
  return { data: body, isError: true }
}

/**
 * The brain search tool's name differs by surface — `search` in chat,
 * `searchBrain` on brain-MCP — so every discovery pointer names both rather
 * than sending the model hunting for a tool this surface does not expose.
 */
const BRAIN_SEARCH = '`search` (`searchBrain` on the brain-MCP surface)'

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
      'Auto-follows merged-entity supersession; the breadcrumb surfaces in `meta.followed_supersession`. ' +
      'Use this when you already have an entity id or name and want its full rollup. To find an entity by topic first, use `search`.',
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
          const body: RetrievalErrorBody = {
            error:
              `getEntity found no brain entity matching "${input.id_or_name}"` +
              (input.as_of ? ` as of ${input.as_of}` : '') +
              ". It may never have existed under that name, may have been merged into another record (a merge supersedes the old id), may have been deleted, or may sit above this assistant's clearance. " +
              `Call ${BRAIN_SEARCH} with a describing phrase to find the real record, then retry getEntity with the id it returns` +
              (input.as_of ? ', or drop `as_of` to check whether it exists now' : '') +
              '. Do NOT retry this exact id_or_name — it will miss the same way.',
          }
          return { data: body, isError: true }
        }
        return {
          data: result satisfies RetrievalResult<unknown>,
          scopeEvidence: scopeEvidenceFromRows([result.data]),
        }
      } catch (err) {
        return retrievalFailure(err, 'getEntity', `entity \`${input.id_or_name}\``)
      }
    },
  })

  const search = buildTool({
    name: 'search',
    description:
      'Hybrid search across the company brain. Returns matched rows keyed by `primitive` + `row_id`. ' +
      'Supports `scope` (primitive kind), `filters` (flat key-value, per-primitive allowlist), `limit`, and opaque `cursor` pagination. ' +
      'Bi-temporal `as_of` defaults to now. Combines full-text, graph, and recency signals. ' +
      'Rows with `primitive: "file_segment"` are passages inside a stored document (capped per file here); ' +
      'follow up with the per-file content tool using their `file_id` to search or read that document in depth. ' +
      'Use this to find something by topic across every brain primitive (memories, entities, tasks, files). To fetch one entity by id/name use `getEntity`; to fetch one memory by id use `getMemory`; for typed rows of a user-defined type use `queryEntities`.',
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
        return {
          data: result satisfies RetrievalResult<unknown>,
          scopeEvidence: scopeEvidenceFromRows(result.data),
        }
      } catch (err) {
        return retrievalFailure(
          err,
          'search',
          `query "${input.query}"`,
          'Narrow the query, or drop `filters` / `scope` if the message names one of them.',
        )
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
        return {
          data: result satisfies RetrievalResult<unknown>,
          scopeEvidence: scopeEvidenceFromRows(result.data),
        }
      } catch (err) {
        return retrievalFailure(err, 'recentEpisodes', input.entity ? `entity \`${input.entity}\`` : 'the recent-episode feed')
      }
    },
  })

  const provenance = buildTool({
    name: 'provenance',
    description:
      'Trace a row to its source Episode, authorship, supersession chain, and derived-from references. ' +
      'One level deep — the model can call again on returned `row_id`s to follow further. ' +
      'Inaccessible sources surface as `source_episode: null` and inaccessible `derived_from` entries are omitted (silently redacted). ' +
      'Use this to trace where a row you retrieved came from. For the full version-change timeline of a row use `getRowHistory`; for a deep multi-hop chain walk in an audit context use `inspectRowProvenance`.',
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
          const body: RetrievalErrorBody = {
            error:
              `provenance found no brain row with id ${input.row_id}, so there is no source to trace. ` +
              "Either no row carries that id, or the row is above this assistant's clearance. " +
              `Row ids come from a ${BRAIN_SEARCH} / getEntity result (its \`row_id\` field), never from a title or a guess — re-run one of those and pass the id it returns. ` +
              'Do NOT retry this exact row_id.',
          }
          return { data: body, isError: true }
        }
        return {
          data: result satisfies RetrievalResult<unknown>,
          scopeEvidence: scopeEvidenceFromRows([result.data]),
        }
      } catch (err) {
        return retrievalFailure(err, 'provenance', `row ${input.row_id}`)
      }
    },
  })

  const markUseful = buildTool({
    name: 'markUseful',
    description:
      'Record an opt-in usefulness signal for a retrieved row. Idempotent; repeated calls do not error.',
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
        return retrievalFailure(
          err,
          'markUseful',
          `${input.primitive} row ${input.row_id}`,
          'The usefulness signal is advisory, so if it keeps failing carry on with the answer instead of retrying.',
        )
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
        return {
          data: result satisfies RetrievalResult<unknown>,
          scopeEvidence: scopeEvidenceFromRows([result.data]),
        }
      } catch (err) {
        return retrievalFailure(
          err,
          'aggregate',
          `${input.measure.fn} over ${input.dimensions.join(', ')}`,
          '`measure.path` and every dimension are validated against the per-primitive allowlist; if the message names one, fix that field.',
        )
      }
    },
  })

  const getRowHistory = buildTool({
    name: 'getRowHistory',
    description:
      'Trace the full bi-temporal version chain of a brain row. ' +
      'Returns every version oldest→newest with status (active / superseded / retracted), validity window, ' +
      'authorship, and `current_id` — the version active now or at `as_of`. ' +
      'Use to answer "how did this fact change over time" or "who created/edited this row". To trace where a row came from (source episode) use `provenance` instead. ' +
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
          const body: RetrievalErrorBody = {
            error:
              `getRowHistory found no ${input.primitive} row with id ${input.row_id}, so there is no version chain to return. ` +
              `The id may belong to a DIFFERENT primitive (\`primitive\` is part of the lookup, so an entity id misses under \`${input.primitive}\`), the row may not exist, or it may sit above this assistant's clearance. ` +
              `Fix \`primitive\` if you know the row's kind, or call ${BRAIN_SEARCH} / getEntity to re-resolve the id (their results carry the primitive). ` +
              'Do NOT retry this exact primitive + row_id pair.',
          }
          return { data: body, isError: true }
        }
        return {
          data: result satisfies RetrievalResult<unknown>,
          scopeEvidence: scopeEvidenceFromRows([result.data]),
        }
      } catch (err) {
        return retrievalFailure(
          err,
          'getRowHistory',
          `${input.primitive} row ${input.row_id}`,
          'If it persists, answer from what you already have rather than re-walking the chain.',
        )
      }
    },
  })

  return { getEntity, search, recentEpisodes, provenance, markUseful, aggregate, getRowHistory }
}
