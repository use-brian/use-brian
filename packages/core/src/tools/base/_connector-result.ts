/**
 * Shared helpers for projecting raw connector API responses down to the
 * concise, model-relevant shape each tool's description already promises.
 *
 * Connector list/search endpoints (GitHub repo search, Gmail message lists,
 * Drive file lists, Notion query results, …) return large raw provider JSON:
 * arrays of full objects, each carrying dozens of URL / metadata / nested
 * sub-objects the model never needs. Feeding that verbatim into the agent
 * loop bloats context and re-reads it on every subsequent internal turn,
 * which is what drove the cache-read cost blow-up in the 2026-06-10
 * "AI Prof Service" incident. We do **not** blunt-truncate the payload; we
 * select the fields that matter, per tool, so the model gets *precise*
 * information instead of a 60 KB blob.
 *
 * See docs/architecture/integrations/mcp.md → "Connector result projection".
 */

/** Strict-safe view of an unknown JSON object. */
export type Json = Record<string, unknown>

/** Coerce an unknown value to an array of JSON objects (empty if not array). */
export function asRows(v: unknown): Json[] {
  return Array.isArray(v) ? (v.filter((x) => typeof x === 'object' && x !== null) as Json[]) : []
}

/** Read a string field, or undefined if absent / wrong type. */
export function str(o: Json | undefined, key: string): string | undefined {
  const v = o?.[key]
  return typeof v === 'string' ? v : undefined
}

/** Read a numeric field, or undefined if absent / wrong type. */
export function num(o: Json | undefined, key: string): number | undefined {
  const v = o?.[key]
  return typeof v === 'number' ? v : undefined
}

/** Read a boolean field, or undefined if absent / wrong type. */
export function bool(o: Json | undefined, key: string): boolean | undefined {
  const v = o?.[key]
  return typeof v === 'boolean' ? v : undefined
}

/** Read a nested object field as a Json view (undefined if absent). */
export function obj(o: Json | undefined, key: string): Json | undefined {
  const v = o?.[key]
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : undefined
}

/**
 * Project a list of raw rows to a concise shape and cap it, reporting how
 * many matched so the model knows whether to paginate rather than assuming it
 * saw everything. `total` overrides the matched count when the provider
 * reports a separate total (e.g. GitHub search's `total_count`, which exceeds
 * the returned page). `truncated` is true when rows were dropped.
 */
export function projectList<U>(
  rows: Json[],
  limit: number,
  map: (row: Json) => U,
  total?: number,
): { matched: number; returned: number; truncated: boolean; items: U[] } {
  const capped = rows.slice(0, Math.max(0, limit))
  const matched = total ?? rows.length
  return {
    matched,
    returned: capped.length,
    truncated: matched > capped.length,
    items: capped.map(map),
  }
}

/** Map each entry in a nested array field to a primitive (e.g. labels → names). */
export function mapField<U>(o: Json | undefined, key: string, map: (row: Json) => U): U[] {
  return asRows(o?.[key]).map(map)
}
