/**
 * Budget-aware skill listing formatter.
 *
 * Produces a compact "- id: trigger — description" listing for injection into
 * the system prompt. Entries are capped at 250 chars, total listing at ~1000
 * tokens.
 *
 * [COMP:skills/listing]
 */

import type { SkillMeta } from './types.js'

/** Total listing budget in characters (~1000 tokens). */
export const SKILL_LISTING_BUDGET_CHARS = 4000

/** Per-entry description cap. */
export const MAX_ENTRY_CHARS = 250

/**
 * One entry body: the trigger first, the description after.
 *
 * The order is load-bearing, because truncation always eats the tail.
 * `whenToUse` is what the model SELECTS on; `description` only elaborates.
 * With the previous description-first join the trigger was discarded exactly
 * when the workspace grew big enough to need it: in prod, an assistant with
 * 41 enabled skills re-truncated every entry to 60 chars, so the concatenated
 * `whenToUse` was never reached and the listing collapsed into 41 rows that
 * all opened "Standard procedure for...". Skills with no trigger render
 * exactly as before.
 */
function entryBody(s: SkillMeta): string {
  return s.whenToUse ? `${s.whenToUse} — ${s.description}` : s.description
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

/**
 * Format a compact skill listing for system prompt injection.
 * Returns empty string if no skills are available.
 */
export function formatSkillListing(skills: SkillMeta[]): string {
  if (skills.length === 0) return ''

  const entries = skills.map((s) => `- ${s.id}: ${truncate(entryBody(s), MAX_ENTRY_CHARS)}`)

  // Check total budget
  const full = entries.join('\n')
  if (full.length <= SKILL_LISTING_BUDGET_CHARS) return full

  // Over budget — squeeze every entry body to an equal share of what's left.
  const nameOverhead = skills.reduce((sum, s) => sum + s.id.length + 4, 0)
  const newlines = skills.length - 1
  const availableForDescs = SKILL_LISTING_BUDGET_CHARS - nameOverhead - newlines
  const maxDescLen = Math.max(20, Math.floor(availableForDescs / skills.length))

  return skills.map((s) => `- ${s.id}: ${truncate(entryBody(s), maxDescLen)}`).join('\n')
}
