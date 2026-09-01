/**
 * Skill groups — the open vocabulary the Brain's skill library files by.
 *
 * `workspace_skills.category` is TEXT and always was. It used to carry a
 * four-value enum (`productivity` / `communication` / `research` / `custom`)
 * that three trees mirrored by hand, and the mirror was the whole problem: a
 * bucket a workspace actually needed — Gym & Training, Nutrition, Study
 * abroad admin — could not be expressed, and the categorize pass silently
 * DISCARDED any name outside the four, so the model could not propose one
 * either. Everything that was not planning, writing or research fell into
 * `custom`, and a personal library ended up as one heap under "Productivity".
 *
 * A group is now either:
 *   - one of the four BUILT-IN slugs, which keep translated labels, or
 *   - a workspace-defined NAME, stored and displayed verbatim — user data,
 *     like a skill's own name, and untranslated for the same reason.
 *
 * This module is the single definition all three trees import (`core` for
 * frontmatter, `api` for the suggest/apply pass and the write routes,
 * `app-web` for grouping and the pickers). It exists so the enum cannot be
 * mirrored back into existence.
 *
 * Spec: docs/architecture/engine/skill-system.md → "Groups are an open
 * vocabulary".
 *
 * [COMP:shared/skill-groups]
 */

/** The unclassified sink. What the create route writes when nobody chose. */
export const UNSORTED_SKILL_GROUP = 'custom'

/**
 * The groups that ship with translated labels, in their historical order.
 * NOT a closed set — any other string is a valid group. This list only says
 * which values the UI has a dictionary entry for; everything else displays as
 * written.
 */
export const BUILTIN_SKILL_GROUPS = [
  'productivity',
  'communication',
  'research',
  UNSORTED_SKILL_GROUP,
] as const

export type BuiltinSkillGroup = (typeof BUILTIN_SKILL_GROUPS)[number]

/**
 * Longest group name we store. A group name is a heading in a narrow sidebar
 * column, not a description, and an unbounded string here is a free-text
 * field the model writes into. Truncation is silent by design: the write
 * paths NORMALIZE rather than reject, because rejecting a value some existing
 * caller already sends turns a tidy-up into an outage.
 */
export const SKILL_GROUP_MAX_LENGTH = 32

const BUILTIN_BY_KEY = new Map<string, BuiltinSkillGroup>(
  BUILTIN_SKILL_GROUPS.map((g) => [g, g]),
)

/** Control characters, which a heading must never carry. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g

/**
 * The stored form of a group name: trimmed, inner whitespace collapsed,
 * control characters dropped, capped at `SKILL_GROUP_MAX_LENGTH`, and folded
 * onto a built-in slug when it names one (so `Research` and `research` are
 * one group, not two). Anything empty becomes the unsorted sink.
 *
 * Every write path runs its input through this — frontmatter, import, the
 * create/patch routes, and the bulk apply — so the column only ever holds
 * shapes the library can render.
 */
export function normalizeSkillGroup(value: unknown): string {
  if (typeof value !== 'string') return UNSORTED_SKILL_GROUP
  const cleaned = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return UNSORTED_SKILL_GROUP
  const builtin = BUILTIN_BY_KEY.get(cleaned.toLowerCase())
  if (builtin) return builtin
  return cleaned.length > SKILL_GROUP_MAX_LENGTH
    ? cleaned.slice(0, SKILL_GROUP_MAX_LENGTH).trim()
    : cleaned
}

/**
 * The identity two group names share when they are the same group.
 *
 * Case and spacing are the only differences we fold: "Gym & Training" and
 * "gym  &  training" are one group. We deliberately do NOT fold further (no
 * stemming, no "and" vs "&"), because a wrong merge silently moves a user's
 * skills between headings, and the review dialog already lets a human say
 * they are the same by picking the existing group.
 */
export function skillGroupKey(value: unknown): string {
  return normalizeSkillGroup(value).toLowerCase()
}

/** Whether a group is one of the four the dictionaries translate. */
export function isBuiltinSkillGroup(value: string): value is BuiltinSkillGroup {
  return BUILTIN_BY_KEY.has(value)
}

/**
 * The distinct groups a set of values names, as display strings.
 *
 * Values agreeing on `skillGroupKey` collapse to ONE entry, and the survivor
 * is the FIRST in the given order rather than whichever the map happened to
 * see last — so the label a picker offers is stable across renders. Callers
 * that want a deterministic answer pass values in a deterministic order.
 */
export function distinctSkillGroups(values: Array<string | null | undefined>): string[] {
  const seen = new Map<string, string>()
  for (const value of values) {
    const group = normalizeSkillGroup(value)
    const key = group.toLowerCase()
    if (!seen.has(key)) seen.set(key, group)
  }
  return [...seen.values()]
}
