/**
 * Bulk category suggestion — proposes a library group for the skills sitting
 * in the `custom` sink, so a workspace that accumulated dozens of skills (its
 * own, plus everything the background curator induced) can be organised in
 * one review pass instead of one editor visit per skill.
 *
 * Propose → review → apply. This module only ever PROPOSES: it returns
 * suggestions, writes nothing, and the route that applies them takes an
 * explicit per-skill assignment list the user has seen. That split is the
 * point — a bulk write nobody reviewed is the failure mode here, and
 * `category` is metadata the model is guessing at from a name and a
 * description.
 *
 * Spec: docs/architecture/engine/skill-system.md → "Suggesting groups".
 *
 * [COMP:api/skill-categorize]
 */

import { collectStream, type LLMProvider } from '@use-brian/core'

/** The library display order, mirrored from `apps/app-web/src/lib/skills-view.ts`. */
export const SKILL_CATEGORIES = [
  'productivity',
  'communication',
  'research',
  'custom',
] as const

export type SkillCategory = (typeof SKILL_CATEGORIES)[number]

const KNOWN = new Set<string>(SKILL_CATEGORIES)

/** Fold any value the TEXT column carries onto the known set. Local: the
 *  client has its own copy (`skillCategoryOf`) because it cannot import from
 *  packages/api. */
function normalizeCategory(value: unknown): SkillCategory {
  return typeof value === 'string' && KNOWN.has(value) ? (value as SkillCategory) : 'custom'
}

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
  current: SkillCategory
  suggested: SkillCategory
  rationale?: string
}

/**
 * The skills a bulk suggestion may touch: only those in the `custom` sink.
 *
 * `custom` is what the create route writes when nobody said otherwise, so it
 * means "unclassified". Every other value was set deliberately — by an
 * imported file's frontmatter or by a human in the editor — and re-deciding
 * those in bulk would quietly overwrite an intent the user already expressed.
 * A legacy or third-party value outside the enum reads as `custom` here for
 * the same reason it does in the UI: it is not a bucket anyone chose.
 */
export function selectCategorizableSkills<T extends { category: string }>(skills: T[]): T[] {
  return skills.filter((s) => normalizeCategory(s.category) === 'custom')
}

// Keep the per-skill footprint small: this runs over a whole library in one
// call, and a name + description + trigger is all the signal a bucket needs.
const DESCRIPTION_CAP = 300
const WHEN_TO_USE_CAP = 200

function clip(value: string, cap: number): string {
  const trimmed = value.trim().replace(/\s+/g, ' ')
  return trimmed.length > cap ? `${trimmed.slice(0, cap)}…` : trimmed
}

/**
 * One prompt for the whole batch. Skills are addressed by 1-based INDEX, not
 * row id: the ids are internal, cost tokens, and would give the model a
 * writable-looking handle on a specific row. The index round-trips through
 * `parseCategorySuggestions`, which is the only thing that knows the mapping.
 */
export function buildCategorizePrompt(skills: CategorizableSkill[]): string {
  const lines = skills.map((s, i) => {
    const parts = [`${i + 1}. ${s.name.trim()}`]
    if (s.description?.trim()) parts.push(`   what it does: ${clip(s.description, DESCRIPTION_CAP)}`)
    if (s.whenToUse?.trim()) parts.push(`   when it runs: ${clip(s.whenToUse, WHEN_TO_USE_CAP)}`)
    return parts.join('\n')
  })

  return [
    'Sort each of these workplace assistant skills into exactly one category.',
    '',
    'Categories:',
    '- productivity — planning, scheduling, tasks, documents, internal process',
    '- communication — writing to or for people: email, messages, updates, posts',
    '- research — finding out about something: companies, people, markets, sources',
    '- custom — anything that does not clearly belong to the three above',
    '',
    'Skills:',
    ...lines,
    '',
    'Rules:',
    `- Answer with a JSON array only, no prose: [{"i": <skill number>, "category": "<one of ${SKILL_CATEGORIES.join(' | ')}>", "why": "<max 12 words>"}]`,
    '- Include every skill number exactly once.',
    '- Use "custom" when the fit is genuinely unclear. A wrong confident bucket is worse than leaving it unsorted.',
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
 * Every row is validated rather than trusted: an out-of-range index, a
 * category outside the enum, or a repeat of an index already seen is
 * discarded silently. A suggestion equal to the skill's current category is
 * dropped too — it changes nothing and would only pad a list the user has to
 * read row by row.
 */
export function parseCategorySuggestions(
  raw: string,
  skills: CategorizableSkill[],
): CategorySuggestion[] {
  const parsed = extractJsonArray(raw)
  if (!Array.isArray(parsed)) return []

  const out: CategorySuggestion[] = []
  const seen = new Set<number>()

  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>

    const index = typeof row.i === 'number' ? row.i : Number.NaN
    if (!Number.isInteger(index) || index < 1 || index > skills.length) continue
    if (seen.has(index)) continue

    const category = row.category
    if (typeof category !== 'string' || !KNOWN.has(category)) continue

    const skill = skills[index - 1]!
    const current = normalizeCategory(skill.category)
    if (category === current) continue

    seen.add(index)
    const suggestion: CategorySuggestion = {
      skillRowId: skill.rowId,
      name: skill.name,
      current,
      suggested: category as SkillCategory,
    }
    if (typeof row.why === 'string' && row.why.trim()) {
      suggestion.rationale = row.why.trim()
    }
    out.push(suggestion)
  }

  return out
}

/** Ask the model to bucket a batch. Returns `[]` rather than throwing when the
 *  answer is unusable — an empty review list is a fine outcome, an exception
 *  on the user's "Suggest" click is not. */
export async function suggestSkillCategories(params: {
  provider: LLMProvider
  model: string
  skills: CategorizableSkill[]
}): Promise<CategorySuggestion[]> {
  const { provider, model, skills } = params
  if (skills.length === 0) return []

  // One stateless turn — the `draft-generator.ts` plain-turn shape. No tools,
  // no session: this is a classification, and nothing it produces is applied
  // without the user checking it first.
  const response = await collectStream(
    provider.stream({
      model,
      systemPrompt:
        'You sort workplace assistant skills into a small fixed set of categories. You answer with a JSON array only.',
      messages: [{ role: 'user', content: buildCategorizePrompt(skills) }],
      maxTokens: 2000,
      // Bucketing is a judgement with one defensible answer per skill; the
      // latitude that helps prose writing only adds variance here.
      temperature: 0,
    }),
  )

  const text = response.content
    .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
    .join('')
    .trim()

  return parseCategorySuggestions(text, skills)
}
