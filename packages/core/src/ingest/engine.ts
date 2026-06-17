/**
 * Routing executor for the Pipeline C ingest engine.
 *
 * Sits between connector adapters and Pipeline B. Walks an ordered list
 * of `ingest_rules` rows (first-match-wins), expands `:placeholder`
 * values in `filter_params` at evaluation time, dispatches the event by
 * routing mode: `realtime` → Pipeline B; `scheduled` → batch table;
 * `drop` → truly discarded.
 *
 * Spec: docs/plans/company-brain/ingest.md → "Engine components"
 * (lines 408-565). Reuses `computeNextRun` from `../scheduling/schedule.ts`
 * for cron-driven fire-time computation.
 *
 * Design choice — ports over imports. The engine accepts every external
 * touch-point (rules store, batch store, Pipeline B, placeholder
 * resolver, event hook) as an interface so the wave can land in
 * parallel with WU-3.6/3.8/3.11. The coordinator wires concrete
 * implementations at app-boot time.
 *
 * [COMP:brain/ingest-engine]
 */

import { computeNextRun } from '../scheduling/schedule.js'

import type { FilterRegistry, IngestEvent } from './filters.js'

// ── DB-shape mirrors ────────────────────────────────────────────────

export type RoutingMode = 'realtime' | 'scheduled' | 'drop'

/** Episode sensitivity tier. Mirrors `episodes.sensitivity`'s allowed values. */
export type RuleEpisodeSensitivity = 'public' | 'internal' | 'confidential'

/**
 * Hydrated row from `ingest_rules` (migration 130; `episode_sensitivity`
 * added in migration 183). Field names match the DB columns; the rules
 * store is expected to return rows ordered by `rule_order` ASC.
 */
export type IngestRule = {
  id: string
  connector_instance_id: string
  source: string
  rule_order: number
  filter_type: string
  filter_params: Record<string, unknown>
  routing_mode: RoutingMode
  routing_schedule: string | null
  routing_timezone: string
  alert: boolean
  /**
   * Per-rule Episode sensitivity override (migration 183). When set,
   * Episodes produced from events matched by this rule are stamped with
   * this tier instead of the source default. NULL = inherit default.
   */
  episode_sensitivity: RuleEpisodeSensitivity | null
}

export type IngestContext = {
  workspace_id: string
  connector_instance_id: string
}

export type RoutingDecision = {
  routing_mode: RoutingMode
  schedule: string | null
  timezone: string
  alert: boolean
  rule_id: string | null
  /** False when no rule matched and the defensive `drop` default fired. */
  matched: boolean
  /**
   * Per-rule Episode sensitivity override (migration 183). NULL when the
   * matched rule didn't set one or no rule matched. Producers thread
   * this through to `appendBatchEvent` and the realtime Episode-creation
   * path so the resulting Episode is stamped at the right tier.
   */
  episode_sensitivity: RuleEpisodeSensitivity | null
}

// ── Ports ───────────────────────────────────────────────────────────

export type IngestRuleStore = {
  /** Rows ordered by `rule_order` ASC. */
  listByConnectorInstance(connectorInstanceId: string): Promise<IngestRule[]>
}

export type PendingBatchStore = {
  /**
   * Find-or-create a `(rule_id, fires_at)` batch row and append `event`
   * to its events JSONB array. App-layer upsert per `ingest.md:557-563`.
   */
  appendEvent(input: {
    workspace_id: string
    rule_id: string
    source: string
    fires_at: Date
    event: IngestEvent
  }): Promise<void>
}

/**
 * Outcome of a realtime Pipeline B run. `episodeId` is the Episode the
 * run constructed — the engine threads it into the `onEvent` hook so a
 * triggered workflow can address the Episode (`input.ingest.episode_id`).
 * A Pipeline B implementation that does not construct an Episode (or
 * whose handle is unavailable) may return `null` / omit the field; the
 * engine then fires `onEvent` with a `null` `episodeId`.
 */
export type PipelineBOutcome = {
  episodeId: string | null
}

export type PipelineB = {
  /**
   * Realtime entry point — engine hands the event off; Pipeline B owns
   * Episode construction + extraction. Returns the constructed Episode's
   * id (when one exists) so the engine can thread it into the alert
   * trigger payload. Returning `void` is still accepted for back-compat.
   */
  process(
    event: IngestEvent,
    ctx: IngestContext,
  ): Promise<PipelineBOutcome | void>
}

/**
 * Resolve a `:placeholder` (e.g. `:crm_contacts`, `:workspace_members`,
 * `:watch_list`, `:assistant`, `:priority_channels`) to its current
 * literal list. Called at event-evaluation time, never at rule-creation
 * time, so the resolved set always reflects the latest workspace state.
 */
export type PlaceholderResolver = (
  placeholder: string,
  ctx: IngestContext,
) => Promise<string[]>

export type IngestEngineDeps = {
  rules: IngestRuleStore
  batches: PendingBatchStore
  filters: FilterRegistry
  pipelineB: PipelineB
  resolvePlaceholders: PlaceholderResolver
  /**
   * Fires once per matched event — every routing mode, regardless of the
   * rule's `alert` flag. `episodeId` is the Episode a realtime Pipeline B
   * run produced (`scheduled` / `drop` modes have none → `null`).
   * `createIngestWorkflowTrigger` (ingest/workflow-trigger.ts) is the
   * wired implementation: it starts the connector's `event`-trigger
   * workflows whose filter matches the event. Decoupled from `alert` —
   * that flag is reserved for the brain-attention path. See
   * workflow-builder.md §Event trigger.
   */
  onEvent?: (
    event: IngestEvent,
    ctx: IngestContext,
    rule: IngestRule,
    episodeId: string | null,
  ) => Promise<void>
  /** Injected for deterministic tests. */
  now?: () => Date
}

export type IngestEngine = {
  ingest(event: IngestEvent, ctx: IngestContext): Promise<RoutingDecision>
}

// ── Factory ─────────────────────────────────────────────────────────

export function createIngestEngine(deps: IngestEngineDeps): IngestEngine {
  return {
    async ingest(event, ctx) {
      const rules = await deps.rules.listByConnectorInstance(ctx.connector_instance_id)
      const placeholderCache = new Map<string, string[]>()

      let matchedRule: IngestRule | null = null

      for (const rule of rules) {
        const filterFn = deps.filters[rule.filter_type]
        if (!filterFn) continue // unknown filter_type — skip, do not crash

        const resolvedParams = await resolveParams(
          rule.filter_params,
          ctx,
          deps.resolvePlaceholders,
          placeholderCache,
        )

        if (filterFn(event, resolvedParams)) {
          matchedRule = rule
          break
        }
      }

      if (matchedRule === null) {
        // Defensive default — no rule matched, drop without a row.
        return {
          routing_mode: 'drop',
          schedule: null,
          timezone: 'UTC',
          alert: false,
          rule_id: null,
          matched: false,
          episode_sensitivity: null,
        }
      }

      const decision: RoutingDecision = {
        routing_mode: matchedRule.routing_mode,
        schedule: matchedRule.routing_schedule,
        timezone: matchedRule.routing_timezone,
        alert: matchedRule.alert,
        rule_id: matchedRule.id,
        matched: true,
        episode_sensitivity: matchedRule.episode_sensitivity,
      }

      // Episode handle for the alert payload. Only the `realtime` mode
      // produces one at this point — `scheduled` defers Pipeline B to
      // the batch worker, `drop` never runs it.
      let episodeId: string | null = null

      switch (decision.routing_mode) {
        case 'realtime': {
          const outcome = await deps.pipelineB.process(event, ctx)
          episodeId = outcome?.episodeId ?? null
          break
        }

        case 'scheduled': {
          if (decision.schedule === null) {
            // Guaranteed non-null by the CHECK on ingest_rules, but the
            // type system can't see the constraint. Treat as config bug.
            throw new Error(
              `ingest engine: rule ${matchedRule.id} has routing_mode='scheduled' but routing_schedule is null`,
            )
          }
          const firesAt = computeNextRun(
            { type: 'cron', expression: decision.schedule },
            decision.timezone,
            deps.now?.(),
          )
          await deps.batches.appendEvent({
            workspace_id: ctx.workspace_id,
            rule_id: matchedRule.id,
            source: matchedRule.source,
            fires_at: firesAt,
            event,
          })
          break
        }

        case 'drop':
          // Truly discard — no row, no Pipeline B, no archival (spec
          // lines 396-403). The `alert` flag still flows below; an
          // alert without storage is rare but expressible.
          break
      }

      // Fire the event hook for every matched event — workflow
      // event-triggers evaluate their own filter, independent of the
      // rule's `alert` flag (see `IngestEngineDeps.onEvent`).
      if (deps.onEvent) {
        await deps.onEvent(event, ctx, matchedRule, episodeId)
      }

      return decision
    },
  }
}

// ── Placeholder resolution ──────────────────────────────────────────

/**
 * Deep-clone `params` with every `:placeholder` string expanded to its
 * resolved literal list. The resolver is called at most once per
 * placeholder per invocation (cached via `cache`).
 *
 * Behavior:
 *  - A leaf string `':x'` inside an array is replaced by the resolved
 *    list spliced in place.
 *  - A leaf string `':x'` as a standalone value (object property,
 *    not in an array) is replaced by the resolved array.
 *  - Non-placeholder strings, numbers, booleans, null, and nested
 *    objects pass through (recursed for objects, deep-cloned otherwise).
 *
 * `rule.filter_params` is never mutated — the engine always passes the
 * cloned shape into the filter.
 */
async function resolveParams(
  params: Record<string, unknown>,
  ctx: IngestContext,
  resolver: PlaceholderResolver,
  cache: Map<string, string[]>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    out[key] = await resolveValue(value, ctx, resolver, cache)
  }
  return out
}

async function resolveValue(
  value: unknown,
  ctx: IngestContext,
  resolver: PlaceholderResolver,
  cache: Map<string, string[]>,
): Promise<unknown> {
  if (typeof value === 'string') {
    if (isPlaceholder(value)) {
      return resolvePlaceholderCached(value, ctx, resolver, cache)
    }
    return value
  }

  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const item of value) {
      if (typeof item === 'string' && isPlaceholder(item)) {
        const resolved = await resolvePlaceholderCached(item, ctx, resolver, cache)
        out.push(...resolved)
      } else {
        out.push(await resolveValue(item, ctx, resolver, cache))
      }
    }
    return out
  }

  if (value !== null && typeof value === 'object') {
    return resolveParams(value as Record<string, unknown>, ctx, resolver, cache)
  }

  // number | boolean | null | undefined — pass through
  return value
}

function isPlaceholder(s: string): boolean {
  return s.startsWith(':')
}

async function resolvePlaceholderCached(
  placeholder: string,
  ctx: IngestContext,
  resolver: PlaceholderResolver,
  cache: Map<string, string[]>,
): Promise<string[]> {
  const cached = cache.get(placeholder)
  if (cached !== undefined) return cached
  const resolved = await resolver(placeholder, ctx)
  cache.set(placeholder, resolved)
  return resolved
}
