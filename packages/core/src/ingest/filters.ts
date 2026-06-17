/**
 * Filter library for the Pipeline C ingest engine.
 *
 * Filters are pure synchronous predicates `(event, params) → boolean`.
 * The engine (see `./engine.ts`) walks ordered `ingest_rules` rows,
 * resolves `:placeholder` values in `filter_params` to literal lists,
 * then calls the registered filter for the row's `filter_type`.
 *
 * Spec: docs/plans/company-brain/ingest.md → "Filter library"
 * (lines 506-522). Source-specific filters (Gmail, Slack, GitHub,
 * Calendar, Fathom) ship with their adapters under WS-7; this module
 * exposes only the universal set plus a registry compose helper.
 *
 * [COMP:brain/filter-library]
 */

// ── Event shape ─────────────────────────────────────────────────────

/**
 * Adapter-normalized event handed to the engine. The `normalized`
 * record carries source-specific fields; filters read documented keys
 * (`text`, `sender`, `actor_id`, `mentions`, `user_flags`, etc.) with
 * defensive runtime guards because the type is intentionally loose.
 */
export type IngestEvent = {
  /** Denormalized from `connector_instance.provider`. Matches `ingest_rules.source`. */
  source: string
  /** Source-specific normalized payload. */
  normalized: Record<string, unknown>
}

// ── Registry types ──────────────────────────────────────────────────

export type FilterParams = Record<string, unknown>
export type FilterFn = (event: IngestEvent, params: FilterParams) => boolean
export type FilterRegistry = Readonly<Record<string, FilterFn>>

/**
 * Merge multiple filter registries into one. Later registries override
 * earlier ones on key collision — adapters can shadow a universal
 * filter with a source-aware variant if needed (rarely).
 */
export function composeFilters(...registries: FilterRegistry[]): FilterRegistry {
  const out: Record<string, FilterFn> = {}
  for (const reg of registries) {
    for (const [key, fn] of Object.entries(reg)) {
      out[key] = fn
    }
  }
  return Object.freeze(out)
}

// ── Field accessors (defensive narrowers) ───────────────────────────

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  return v.every((x) => typeof x === 'string') ? (v as string[]) : null
}

function paramStringList(params: FilterParams, key: string): string[] {
  const raw = params[key]
  return asStringArray(raw) ?? []
}

// ── Universal filters ───────────────────────────────────────────────

function matchesAlways(): boolean {
  return true
}

function matchesKeywords(event: IngestEvent, params: FilterParams): boolean {
  const keywords = paramStringList(params, 'keywords')
  if (keywords.length === 0) return false
  const text = asString(event.normalized.text)
  if (text === null) return false
  const haystack = text.toLowerCase()
  return keywords.some((k) => k.length > 0 && haystack.includes(k.toLowerCase()))
}

function matchesActor(event: IngestEvent, params: FilterParams): boolean {
  const values = paramStringList(params, 'values')
  if (values.length === 0) return false
  const actor =
    asString(event.normalized.actor_id) ?? asString(event.normalized.sender)
  if (actor === null) return false
  return values.includes(actor)
}

function matchesSender(event: IngestEvent, params: FilterParams): boolean {
  const values = paramStringList(params, 'values')
  if (values.length === 0) return false
  const sender = asString(event.normalized.sender)
  if (sender === null) return false
  return values.includes(sender)
}

function matchesMention(event: IngestEvent, params: FilterParams): boolean {
  const values = paramStringList(params, 'values')
  if (values.length === 0) return false
  const mentions = asStringArray(event.normalized.mentions)
  if (mentions === null) return false
  return mentions.some((m) => values.includes(m))
}

function matchesUserFlag(event: IngestEvent, params: FilterParams): boolean {
  const values = paramStringList(params, 'values')
  if (values.length === 0) return false
  const flags = asStringArray(event.normalized.user_flags)
  if (flags === null) return false
  return flags.some((f) => values.includes(f))
}

/**
 * The five universal filters (`ingest.md:509-514`). Source-specific
 * adapters extend this with their own registry via `composeFilters`.
 */
export const universalFilters: FilterRegistry = Object.freeze({
  always: matchesAlways,
  keyword_match: matchesKeywords,
  actor_match: matchesActor,
  sender_match: matchesSender,
  mention_of: matchesMention,
  user_flag: matchesUserFlag,
})
