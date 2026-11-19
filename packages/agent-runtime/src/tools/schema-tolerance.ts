/**
 * Zod helper schemas for first-party tool input tolerance.
 *
 * The production failure class: models emit stringly-typed values for boolean
 * and number params (e.g. `include_archived: "true"`, `limit: "10"`) and
 * domain-name / slug strings for UUID params (e.g.
 * `listEntityTypes({ workspaceId: "fls.com.hk" })`). These helpers accept the
 * model-typical forms and coerce them correctly, or reject them with an
 * actionable error message.
 *
 * Do NOT use `z.coerce.boolean()` for booleans: `Boolean("false") === true`,
 * which silently inverts the intent. Use `tolerantBoolean()` instead.
 *
 * See docs/architecture/engine/tool-input-tolerance.md.
 *
 * [COMP:engine/tool-input-tolerance]
 */

import { z } from 'zod'

// ── tolerantBoolean ──────────────────────────────────────────────────────────

/**
 * Accepts a real boolean OR the strings `"true"` / `"false"` (any case) and
 * maps them to the correct boolean value. Rejects everything else.
 *
 * Use instead of `z.boolean()` on any tool param that a model plausibly passes
 * as a string (flags, toggles, include_* options).
 *
 * NEVER use `z.coerce.boolean()` — `Boolean("false") === true` would flip
 * `include_archived: "false"` to `true`.
 */
export function tolerantBoolean(): z.ZodType<boolean, z.ZodTypeDef, unknown> {
  return z.preprocess((v) => {
    if (typeof v === 'boolean') return v
    if (typeof v === 'string') {
      const lower = v.trim().toLowerCase()
      if (lower === 'true') return true
      if (lower === 'false') return false
    }
    return v
  }, z.boolean())
}

// ── tolerantNumber / tolerantInt ─────────────────────────────────────────────

/**
 * Accepts a real number OR a numeric string and coerces to a number.
 * Optional `min` / `max` refinements applied after coercion.
 *
 * Use for any tool param that a model may pass as a quoted number
 * (e.g. `limit: "25"`).
 */
export function tolerantNumber(opts?: { min?: number; max?: number }): z.ZodType<number> {
  let schema = z.coerce.number()
  if (opts?.min !== undefined) schema = schema.min(opts.min) as typeof schema
  if (opts?.max !== undefined) schema = schema.max(opts.max) as typeof schema
  return schema
}

/**
 * Accepts a real integer OR a numeric string and coerces to an integer.
 * Rejects non-integer values (e.g. 2.7). Optional `min` / `max` applied after
 * coercion.
 *
 * Use for count / limit params that a model may pass as a quoted number.
 */
export function tolerantInt(opts?: { min?: number; max?: number }): z.ZodType<number> {
  let schema = z.coerce.number().int('must be an integer')
  if (opts?.min !== undefined) schema = schema.min(opts.min) as typeof schema
  if (opts?.max !== undefined) schema = schema.max(opts.max) as typeof schema
  return schema
}

// ── tolerantEnumArray ────────────────────────────────────────────────────────

/**
 * Accepts ONE enum member, an array of members, a JSON-stringified array
 * (`'["todo","in_progress"]'`), or a comma-separated list
 * (`'todo, in_progress'`). Anything else falls through to normal validation.
 *
 * Use for any "single value or a list" filter param. The earlier tolerance
 * sweep (2026-07-07) only covered *primitive* params, so a
 * `status: enum | enum[]` union stayed strict — and it is precisely the shape
 * a model serialises loosely, because a list is the thing worth serialising.
 * `listTasks({status: ["todo","in_progress","blocked"]})` failed validation 35
 * times between 2026-07-08 and 2026-08-03, every one of them inside a
 * workflow step, each silently dropping one person's section from the morning
 * digest (the step still reported `completed`).
 *
 * A value that is already a valid single member is returned **unchanged**, not
 * wrapped into an array: the union accepts both, and preserving the model's
 * own shape keeps the tool's returned/logged input honest.
 */
export function tolerantEnumArray<T extends readonly [string, ...string[]]>(
  values: T,
): z.ZodType<T[number] | T[number][], z.ZodTypeDef, unknown> {
  const members = new Set<string>(values)
  const enumSchema = z.enum(values as unknown as [string, ...string[]])
  return z.preprocess((raw) => {
    if (typeof raw !== 'string') return raw
    const trimmed = raw.trim()
    // Already exactly one member — leave the single-value shape alone.
    if (members.has(trimmed)) return trimmed
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (Array.isArray(parsed)) return parsed
      } catch {
        // Not JSON after all — fall through to the comma split / raw value.
      }
    }
    if (trimmed.includes(',')) {
      const parts = trimmed
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
      if (parts.length > 0) return parts
    }
    return raw
  }, enumSchema.or(z.array(enumSchema))) as z.ZodType<T[number] | T[number][], z.ZodTypeDef, unknown>
}

// ── uuidId ───────────────────────────────────────────────────────────────────

/**
 * UUID-validated string with an actionable error message that tells the model
 * to pass the UUID id (from a prior list/get call), never a name, domain, or
 * slug. Prevents DB errors like `invalid input syntax for type uuid`.
 *
 * `label` (optional) names the kind of id expected, improving the error
 * message (e.g. `"workspace"` → "workspaceId must be a UUID, not a name or
 * domain — use the id from a prior list/get call").
 */
export function uuidId(label?: string): z.ZodString {
  const prefix = label ? `${label}Id` : 'id'
  return z
    .string()
    .uuid(
      `${prefix} must be a UUID (e.g. "a1b2c3d4-..."), not a name, domain, or slug — pass the id from a prior list/get call`,
    )
}

// ── tolerantObject ───────────────────────────────────────────────────────────

/**
 * Accepts an object matching `schema` OR a JSON string that parses to such an
 * object. Useful for workflow step arrays where the model occasionally emits
 * JSON-serialised step objects instead of plain objects.
 *
 * JSON parse failures fall through to normal Zod validation (the raw string
 * hits the schema and produces the usual error); invalid JSON strings are also
 * passed through unchanged, so the error message stays informative.
 */
export function tolerantObject<T extends z.ZodTypeAny>(
  schema: T,
): z.ZodType<z.infer<T>, z.ZodTypeDef, unknown> {
  return z.preprocess((v) => {
    if (typeof v === 'string') {
      try {
        const parsed = JSON.parse(v)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed
        }
        // Parsed but not an object — let the raw value reach the schema so the
        // error names the actual type.
        return parsed
      } catch {
        // Invalid JSON — pass the raw string through for a normal schema error.
        return v
      }
    }
    return v
  }, schema)
}

// ── tolerantIsoTimestamp ─────────────────────────────────────────────────────

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * The two shapes a point-in-time param accepts, named in every rejection so
 * the model can fix the field instead of guessing at a second wrong format.
 */
const ISO_TIMESTAMP_SHAPES =
  'pass either a bare date "YYYY-MM-DD" (read as midnight UTC) or a full ISO 8601 timestamp WITH a zone, e.g. "2026-08-17T09:30:00Z" or "2026-08-17T09:30:00+08:00"'

/**
 * Accepts a full ISO 8601 timestamp (`Z` or a numeric offset) unchanged, OR a
 * bare `YYYY-MM-DD` date, which is widened to `YYYY-MM-DDT00:00:00Z`.
 *
 * Bi-temporal `as_of` params are the case: a model asked "what did we know on
 * the 14th" naturally emits `as_of: "2026-08-14"`, and a strict
 * `z.string().datetime({ offset: true })` rejected it with zod's bare
 * "Invalid datetime" — which names neither the accepted shape nor the fix, so
 * the retry is a guess. Widening a date to midnight UTC is the reading the
 * user meant; a zone-less *datetime* (`2026-08-14T09:30:00`) is NOT widened,
 * because inventing a zone would silently shift the answer by up to a day.
 *
 * Anything else fails with a message naming both accepted shapes.
 */
export function tolerantIsoTimestamp(): z.ZodType<string, z.ZodTypeDef, string> {
  const full = z.string().datetime({ offset: true })
  return z
    .string({ invalid_type_error: `must be a timestamp string — ${ISO_TIMESTAMP_SHAPES}` })
    .transform((raw, ctx) => {
      const trimmed = raw.trim()
      const widened = DATE_ONLY_RE.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed
      if (!full.safeParse(widened).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${raw}" is not a timestamp this tool can read — ${ISO_TIMESTAMP_SHAPES}. Fix this field or omit it (omitting means "now"); the same value will fail again.`,
        })
        return z.NEVER
      }
      return widened
    })
}
