/**
 * Bulk group suggestion — proposes a library group for a workspace's skills,
 * so a library that accumulated dozens of them (its own, plus everything the
 * background curator induced) can be organised in one review pass instead of
 * one editor visit per skill.
 *
 * Propose → review → apply. This module only ever PROPOSES: it returns
 * suggestions, writes nothing, and the route that applies them takes an
 * explicit per-skill assignment list the user has seen. That split is the
 * point — a bulk write nobody reviewed is the failure mode here, and the
 * group is metadata the model is guessing at from a name and a description.
 *
 * Groups are an OPEN vocabulary (`@use-brian/shared/skill-groups`): the model
 * may reuse one of the four built-ins, reuse a group the workspace already
 * has, or name a new one. It used to be a closed four-value enum, and the
 * shape of that failure is worth remembering — the parser dropped every value
 * outside the enum, so the model could not have proposed "Nutrition" even if
 * it wanted to, and a library of workouts, meal plans and grocery runs came
 * back filed under "Productivity".
 *
 * Spec: docs/architecture/engine/skill-system.md → "Suggesting groups".
 *
 * [COMP:api/skill-categorize]
 */

import { collectStream, type LLMProvider } from '@use-brian/core'
import {
  BUILTIN_SKILL_GROUPS,
  UNSORTED_SKILL_GROUP,
  distinctSkillGroups,
  normalizeSkillGroup,
  skillGroupKey,
} from '@use-brian/shared/skill-groups'

/** Which skills a pass is allowed to re-decide. */
export type CategorizeScope =
  /** Only the unsorted sink — the default, and the only non-destructive one. */
  | 'unsorted'
  /** Every active skill, including groups somebody already chose. Opt-in. */
  | 'all'

export type CategorizableSkill = {
  rowId: string
  name: string
  description: string
  whenToUse?: string | null
  category: string
}

export type CategorySuggestion = {
  skillRowId: string
  name: string
  current: string
  suggested: string
  rationale?: string
}

/**
 * The skills a pass may touch.
 *
 * `unsorted` (the default) filters to the `custom` sink. `custom` is what the
 * create route writes when nobody said otherwise, so it means *unclassified*;
 * every other value was set deliberately — by an imported file's frontmatter,
 * by a human in the editor, or by an earlier reviewed pass — and re-deciding
 * those behind the user's back would overwrite an intent they expressed.
 *
 * `all` lifts that filter, and is reachable only from an explicit tick in the
 * dialog. It exists because the first pass at this was scoped to `custom`
 * alone, which meant a library already filed under the old four-value enum
 * could never be improved: the coarse buckets were, technically, chosen. Every
 * move is still reviewed row by row before anything is written, so widening
 * the scope widens what the user is *shown*, never what is applied unseen.
 */
export function selectCategorizableSkills<T extends { category: string }>(
  skills: T[],
  scope: CategorizeScope = 'unsorted',
): T[] {
  if (scope === 'all') return skills
  return skills.filter((s) => normalizeSkillGroup(s.category) === UNSORTED_SKILL_GROUP)
}

/**
 * How many groups a single pass may INVENT, on top of every group the
 * workspace already has.
 *
 * An open vocabulary's failure mode is fifteen near-synonyms — "Fitness",
 * "Gym", "Gym & Training", "Workouts" — which is a worse library than one
 * coarse heap, because now nothing is where you look for it. The prompt asks
 * for restraint and this enforces it: past the cap, a suggestion naming yet
 * another new group is dropped and the skill simply stays where it is.
 */
export const MAX_NEW_GROUPS_PER_PASS = 12

// Keep the per-skill footprint small: this runs over a whole library in one
// call, and a name + description + trigger is all the signal a group needs.
const DESCRIPTION_CAP = 300
const WHEN_TO_USE_CAP = 200

function clip(value: string, cap: number): string {
  const trimmed = value.trim().replace(/\s+/g, ' ')
  return trimmed.length > cap ? `${trimmed.slice(0, cap)}…` : trimmed
}

/**
 * The groups already in use across a library, most-used first, with the
 * built-ins that are actually populated included. This is what the prompt
 * offers the model to REUSE, and reuse is the whole game: a new group is only
 * worth minting when nothing here fits.
 */
export function existingGroupsOf(skills: Array<{ category: string }>): string[] {
  const counts = new Map<string, { group: string; count: number }>()
  for (const skill of skills) {
    const group = normalizeSkillGroup(skill.category)
    if (group === UNSORTED_SKILL_GROUP) continue
    const key = group.toLowerCase()
    const entry = counts.get(key)
    if (entry) entry.count += 1
    else counts.set(key, { group, count: 1 })
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.group.localeCompare(b.group))
    .map((e) => e.group)
}

/**
 * One prompt for the whole batch. Skills are addressed by 1-based INDEX, not
 * row id: the ids are internal, cost tokens, and would give the model a
 * writable-looking handle on a specific row. The index round-trips through
 * `parseCategorySuggestions`, which is the only thing that knows the mapping.
 */
export function buildCategorizePrompt(
  skills: CategorizableSkill[],
  existingGroups: string[] = [],
): string {
  const lines = skills.map((s, i) => {
    const parts = [`${i + 1}. ${s.name.trim()}`]
    if (s.description?.trim()) parts.push(`   what it does: ${clip(s.description, DESCRIPTION_CAP)}`)
    if (s.whenToUse?.trim()) parts.push(`   when it runs: ${clip(s.whenToUse, WHEN_TO_USE_CAP)}`)
    const current = normalizeSkillGroup(s.category)
    if (current !== UNSORTED_SKILL_GROUP) parts.push(`   currently in: ${current}`)
    return parts.join('\n')
  })

  const groups = distinctSkillGroups(existingGroups).filter(
    (g) => g !== UNSORTED_SKILL_GROUP,
  )

  return [
    'Sort each of these workplace assistant skills into exactly one group.',
    '',
    'A group is a short heading in a library sidebar. Name it for what the',
    'skills in it are ABOUT, the way this person would say it — "Gym &',
    'Training", "Nutrition", "Client Outreach" — not for an abstract quality',
    'like "Productivity". Groups are free text, so a good name is worth more',
    'than a familiar one.',
    '',
    groups.length > 0
      ? `Groups this library already uses (reuse these before inventing anything, and copy the spelling exactly): ${groups.join(', ')}`
      : 'This library has no groups yet, so you are naming them from scratch.',
    '',
    `These four names are always available and have translated labels: ${BUILTIN_SKILL_GROUPS.join(', ')}. Use "${UNSORTED_SKILL_GROUP}" for a skill that genuinely belongs nowhere.`,
    '',
    'Skills:',
    ...lines,
    '',
    'Rules:',
    '- Answer with a JSON array only, no prose: [{"i": <skill number>, "group": "<group name>", "why": "<max 12 words>"}]',
    '- Include every skill number exactly once.',
    '- Reuse a group name you have already used in this answer rather than a near-synonym of it. Aim for the smallest number of groups that still separates the work: usually 4 to 8 across the whole library.',
    '- 1 to 3 words, Title Case, in the same language as the skill names.',
    `- Use "${UNSORTED_SKILL_GROUP}" when the fit is genuinely unclear. A wrong confident group is worse than leaving it unsorted.`,
  ].join('\n')
}

/** First JSON array in the text, tolerating a ```json fence or stray prose. */
function extractJsonArray(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = (fenced?.[1] ?? raw).trim()
  const start = candidate.indexOf('[')
  const end = candidate.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * Map the model's answer back onto row ids, dropping anything it invented.
 *
 * Every row is validated rather than trusted: an out-of-range index, a missing
 * group, or a repeat of an index already seen is discarded silently. A
 * suggestion equal to the skill's current group is dropped too — it changes
 * nothing and would only pad a list the user has to read row by row.
 *
 * Two things are specific to an open vocabulary. A proposed name is FOLDED
 * onto an existing group whose `skillGroupKey` matches, so "gym & training"
 * lands in "Gym & Training" instead of forking it on capitalisation. And the
 * number of genuinely new names is capped at `MAX_NEW_GROUPS_PER_PASS`; past
 * that the suggestion is dropped, because a library with twenty headings is
 * not organised.
 */
export function parseCategorySuggestions(
  raw: string,
  skills: CategorizableSkill[],
  existingGroups: string[] = [],
): CategorySuggestion[] {
  const parsed = extractJsonArray(raw)
  if (!Array.isArray(parsed)) return []

  const out: CategorySuggestion[] = []
  const seen = new Set<number>()

  // Known display forms, keyed for folding. Seeded with the built-ins and the
  // workspace's current groups; a new name the model coins joins it, so the
  // SECOND skill it files under that name reuses the first one's spelling.
  const known = new Map<string, string>()
  for (const group of BUILTIN_SKILL_GROUPS) known.set(group, group)
  for (const group of distinctSkillGroups(existingGroups)) {
    known.set(skillGroupKey(group), normalizeSkillGroup(group))
  }
  const preexisting = new Set(known.keys())
  let minted = 0

  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>

    const index = typeof row.i === 'number' ? row.i : Number.NaN
    if (!Number.isInteger(index) || index < 1 || index > skills.length) continue
    if (seen.has(index)) continue

    // `group` is the field the prompt asks for; `category` is accepted as the
    // older name so a model echoing the column does not lose its answer.
    const proposed = typeof row.group === 'string' ? row.group : row.category
    if (typeof proposed !== 'string' || !proposed.trim()) continue

    const key = skillGroupKey(proposed)
    const existing = known.get(key)
    let group: string
    if (existing) {
      group = existing
    } else {
      if (minted >= MAX_NEW_GROUPS_PER_PASS) continue
      group = normalizeSkillGroup(proposed)
      known.set(key, group)
      if (!preexisting.has(key)) minted += 1
    }

    const skill = skills[index - 1]!
    const current = normalizeSkillGroup(skill.category)
    if (skillGroupKey(group) === skillGroupKey(current)) continue

    seen.add(index)
    const suggestion: CategorySuggestion = {
      skillRowId: skill.rowId,
      name: skill.name,
      current,
      suggested: group,
    }
    if (typeof row.why === 'string' && row.why.trim()) {
      suggestion.rationale = row.why.trim()
    }
    out.push(suggestion)
  }

  return out
}

/** Ask the model to group a batch. Returns `[]` rather than throwing when the
 *  answer is unusable — an empty review list is a fine outcome, an exception
 *  on the user's "Suggest" click is not. */
export async function suggestSkillCategories(params: {
  provider: LLMProvider
  model: string
  skills: CategorizableSkill[]
  /** Groups the library already uses, so the model reuses before inventing. */
  existingGroups?: string[]
}): Promise<CategorySuggestion[]> {
  const { provider, model, skills, existingGroups = [] } = params
  if (skills.length === 0) return []

  // One stateless turn — the `draft-generator.ts` plain-turn shape. No tools,
  // no session: this is a classification, and nothing it produces is applied
  // without the user checking it first.
  const response = await collectStream(
    provider.stream({
      model,
      systemPrompt:
        'You sort workplace assistant skills into short, concrete library groups. You answer with a JSON array only.',
      messages: [{ role: 'user', content: buildCategorizePrompt(skills, existingGroups) }],
      maxTokens: 2000,
      // Grouping is a judgement with one defensible answer per skill; the
      // latitude that helps prose writing only adds variance here.
      temperature: 0,
    }),
  )

  const text = response.content
    .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
    .join('')
    .trim()

  return parseCategorySuggestions(text, skills, existingGroups)
}
