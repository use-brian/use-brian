/**
 * Assistant charter - the single identity item that replaced the
 * `bio` + `system_prompt` pair (docs/plans/assistant-growth-loop.md §2,
 * docs/architecture/features/assistant-detail-page.md → "Charter").
 *
 * Typed exactly where a mechanism reads the field:
 *   - `mission`      → the assistant's own prompt, peer `purpose`
 *                      (listConnectedAssistants), the public chat-link
 *                      header, app souls, and the future reflection loop.
 *   - `audience`     → the assistant's own prompt.
 *   - `success`      → the assistant's own prompt; the grading rubric for
 *                      the Phase-3 reflection loop.
 *   - `instructions` → free prose (scope, procedure, rules, voice); the
 *                      direct successor of `system_prompt`.
 *
 * Shared by api (prompt builder, routes, stores), core, app-web, and
 * api-platform so parsing / merging / rendering exists exactly once.
 *
 * [COMP:shared/assistant-charter]
 */

export type AssistantCharter = {
  mission?: string
  audience?: string
  success?: string
  instructions?: string
}

export const CHARTER_FIELDS = ['mission', 'audience', 'success', 'instructions'] as const
export type CharterField = (typeof CHARTER_FIELDS)[number]

/** Per-field character caps, enforced at the PATCH boundary and in the UI. */
export const CHARTER_FIELD_LIMITS: Record<CharterField, number> = {
  mission: 300,
  audience: 500,
  success: 2000,
  instructions: 10000,
}

/**
 * Parse an unknown value (a JSONB column, a request body key) into a
 * charter. Unknown keys are dropped; non-string values are dropped;
 * whitespace-only strings are dropped. Never throws - a malformed column
 * degrades to an empty charter, not a dead chat route.
 */
export function parseCharter(value: unknown): AssistantCharter {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const out: AssistantCharter = {}
  for (const field of CHARTER_FIELDS) {
    const raw = (value as Record<string, unknown>)[field]
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    out[field] = trimmed
  }
  return out
}

/**
 * Resolve the effective charter of an assistant row under the
 * authoritative-if-present rule (§2 D4): a non-null `charter` column is the
 * whole truth; the legacy `system_prompt` / `bio` columns are consulted only
 * when `charter` is NULL (a row migration 418's backfill has not reached -
 * defensive, since the backfill runs in the same transaction as the column
 * add). This is what stops a cleared charter field from resurrecting stale
 * legacy text.
 */
export function resolveCharter(row: {
  charter?: unknown
  systemPrompt?: string | null
  bio?: string | null
}): AssistantCharter {
  if (row.charter !== null && row.charter !== undefined) {
    return parseCharter(row.charter)
  }
  const legacy: AssistantCharter = {}
  const mission = row.bio?.trim()
  if (mission) legacy.mission = mission
  const instructions = row.systemPrompt?.trim()
  if (instructions) legacy.instructions = instructions
  return legacy
}

/** True when no field carries content. */
export function charterIsEmpty(charter: AssistantCharter): boolean {
  return CHARTER_FIELDS.every((f) => !charter[f])
}

/**
 * The assistant's one-line purpose - what `bio` used to be for every
 * external reader (peer assistants, the public chat-link header, app
 * souls). Null when neither mission nor a legacy bio exists.
 */
export function charterMission(charter: AssistantCharter): string | null {
  return charter.mission ?? null
}

const SECTION_HEADINGS: Record<CharterField, string> = {
  mission: '## Mission',
  audience: '## Audience',
  success: '## What good looks like',
  instructions: '## Instructions',
}

/**
 * Char cap for the rendered `## Playbook` section (Brand-digest
 * discipline: whole rules are dropped from the END of the list past the
 * cap, never truncated mid-sentence - so callers pass rules
 * newest-admitted first).
 */
export const PLAYBOOK_BLOCK_CHAR_CAP = 2000

/**
 * Render the `# Charter` prompt block - slot 2 of the stable prefix, the
 * successor of `# Assistant instructions`. Only non-empty sections are
 * emitted, in the fixed order mission → audience → success → instructions
 * (identity before conduct). Returns null when the charter is empty AND no
 * playbook rules exist, so the caller can skip the block entirely.
 *
 * `opts.playbookRules` are the assistant's owner-admitted learned rules
 * (migration 419, docs/plans/assistant-growth-loop.md §3 Phase 3),
 * rendered as a trailing `## Playbook` bullet list under the char cap.
 */
export function renderCharterBlock(
  charter: AssistantCharter,
  opts?: { playbookRules?: string[] },
): string | null {
  const parts: string[] = []
  for (const field of CHARTER_FIELDS) {
    const value = charter[field]
    if (!value) continue
    parts.push(`${SECTION_HEADINGS[field]}\n${value}`)
  }
  const rules = (opts?.playbookRules ?? []).map((r) => r.trim()).filter((r) => r.length > 0)
  if (rules.length > 0) {
    const bullets: string[] = []
    let spent = 0
    for (const rule of rules) {
      const line = `- ${rule}`
      if (spent + line.length + 1 > PLAYBOOK_BLOCK_CHAR_CAP) break
      bullets.push(line)
      spent += line.length + 1
    }
    if (bullets.length > 0) {
      parts.push(
        `## Playbook\nRules this assistant has learned from its own reviewed work. They are already recorded - do not save them as memories.\n${bullets.join('\n')}`,
      )
    }
  }
  if (parts.length === 0) return null
  return `# Charter\n${parts.join('\n\n')}`
}
