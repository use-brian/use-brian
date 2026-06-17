/**
 * Budget-aware skill listing formatter.
 *
 * Produces a compact "- id: description" listing for injection into the
 * system prompt. Mirrors Claude Code's formatCommandsWithinBudget() pattern:
 * entries are capped at 250 chars, total listing at ~1000 tokens.
 *
 * [COMP:skills/listing]
 */

import type { SkillMeta } from './types.js'

/** Total listing budget in characters (~1000 tokens). */
export const SKILL_LISTING_BUDGET_CHARS = 4000

/** Per-entry description cap. */
export const MAX_ENTRY_CHARS = 250

/**
 * Format a compact skill listing for system prompt injection.
 * Returns empty string if no skills are available.
 */
export function formatSkillListing(skills: SkillMeta[]): string {
  if (skills.length === 0) return ''

  const entries = skills.map((s) => {
    const desc = s.whenToUse
      ? `${s.description} — ${s.whenToUse}`
      : s.description
    const truncated = desc.length > MAX_ENTRY_CHARS
      ? desc.slice(0, MAX_ENTRY_CHARS - 1) + '\u2026'
      : desc
    return `- ${s.id}: ${truncated}`
  })

  // Check total budget
  const full = entries.join('\n')
  if (full.length <= SKILL_LISTING_BUDGET_CHARS) return full

  // Over budget — truncate descriptions further to fit
  const nameOverhead = skills.reduce((sum, s) => sum + s.id.length + 4, 0)
  const newlines = skills.length - 1
  const availableForDescs = SKILL_LISTING_BUDGET_CHARS - nameOverhead - newlines
  const maxDescLen = Math.max(20, Math.floor(availableForDescs / skills.length))

  return skills.map((s) => {
    const desc = s.whenToUse
      ? `${s.description} — ${s.whenToUse}`
      : s.description
    const truncated = desc.length > maxDescLen
      ? desc.slice(0, maxDescLen - 1) + '\u2026'
      : desc
    return `- ${s.id}: ${truncated}`
  }).join('\n')
}
