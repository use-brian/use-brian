/**
 * Chip-input helpers for the event trigger's `EventMatch` editor (app-web).
 *
 * Ported from `apps/web/src/lib/workflow-match.ts` (app consolidation §5a).
 * The editor renders one chip-input per `EventMatch` field. The user
 * types comma-separated or newline-separated values; this module is the
 * pure normalization layer — trims, dedupes, and clamps to the cap from
 * `packages/core/src/workflow/schemas.ts`. Pulling the limits out into
 * named constants keeps them visible to the test and prevents quiet
 * drift if the schema ever loosens.
 *
 * Spec: docs/architecture/features/workflow.md → Event trigger UI.
 */

export const MATCH_CAPS = {
  keywords: 64,
  fromActors: 128,
  inChannels: 128,
  mentions: 128,
} as const

export type MatchField = keyof typeof MATCH_CAPS

/**
 * Parse a user-entered string (comma + newline separated) into a chip
 * list. Trims whitespace, drops empties, dedupes while preserving the
 * first occurrence order, and clamps to the field's cap.
 */
export function parseChipInput(raw: string, field: MatchField): string[] {
  if (!raw) return []
  const tokens = raw
    .split(/[\n,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tokens) {
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
    if (out.length >= MATCH_CAPS[field]) break
  }
  return out
}

/**
 * Append one chip to an existing list. Returns the same list reference
 * when the value is a no-op (empty after trim, duplicate, or over cap)
 * so React's `setState` skips the re-render.
 */
export function appendChip(
  current: string[],
  value: string,
  field: MatchField,
): string[] {
  const trimmed = value.trim()
  if (!trimmed) return current
  if (current.includes(trimmed)) return current
  if (current.length >= MATCH_CAPS[field]) return current
  return [...current, trimmed]
}

/** Remove the chip at `index`, returning a new array. */
export function removeChipAt(current: string[], index: number): string[] {
  if (index < 0 || index >= current.length) return current
  return current.slice(0, index).concat(current.slice(index + 1))
}
