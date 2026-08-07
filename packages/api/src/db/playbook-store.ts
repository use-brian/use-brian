/**
 * Assistant playbook rules - the admission-gated learned layer of the
 * growth loop (docs/plans/assistant-growth-loop.md §3 Phase 3, migration
 * 419).
 *
 * Plain functions over the shared pool (no class), imported directly by
 * the chat routes (active-rule fetch for the `## Playbook` prompt
 * section), the assistants router (list + decision), and the reflection
 * worker (suggest + dedup corpus). Access control is the caller's job:
 * routes gate through `resolveAssistantAccess`; the worker and prompt
 * paths are system reads.
 *
 * Status machine: 'suggested' → 'active' (owner approve) | 'rejected'
 * (owner reject); 'active' → 'retired' (owner retire). Rejected rules are
 * kept as the reflection worker's do-not-repropose corpus.
 *
 * [COMP:api/assistant-playbook]
 */

import { query } from './client.js'
import { excludeExternalPrincipalsSql } from './external-principal.js'

export type PlaybookRuleStatus = 'suggested' | 'active' | 'rejected' | 'retired'

export type PlaybookRule = {
  id: string
  assistantId: string
  rule: string
  rationale: string | null
  provenance: unknown
  status: PlaybookRuleStatus
  createdBy: 'reflection' | 'owner'
  decidedByUserId: string | null
  decidedAt: string | null
  createdAt: string
}

/** Max rules an assistant may hold in 'active' at once - approval past this
 *  is refused so the injected block stays disciplined. */
export const MAX_ACTIVE_PLAYBOOK_RULES = 12

/** Max pending suggestions per assistant - the reflection worker skips an
 *  assistant at or above this so an unattended inbox never floods. */
export const MAX_PENDING_PLAYBOOK_SUGGESTIONS = 5

const ROW_COLUMNS = `
  id,
  assistant_id       AS "assistantId",
  rule,
  rationale,
  provenance,
  status,
  created_by         AS "createdBy",
  decided_by_user_id AS "decidedByUserId",
  decided_at         AS "decidedAt",
  created_at         AS "createdAt"
` as const

/** Every rule for the assistant, newest first - the management surface read. */
export async function listPlaybookRules(assistantId: string): Promise<PlaybookRule[]> {
  const result = await query<PlaybookRule>(
    `SELECT ${ROW_COLUMNS} FROM assistant_playbook_rules
     WHERE assistant_id = $1
     ORDER BY created_at DESC`,
    [assistantId],
  )
  return result.rows
}

/**
 * Active rule texts, most recently admitted first - the prompt-path read.
 * Ordering matters: `renderCharterBlock` drops whole rules beyond the char
 * cap from the END of the list, so newest-admitted survive.
 */
export async function listActivePlaybookRules(assistantId: string): Promise<string[]> {
  const result = await query<{ rule: string }>(
    `SELECT rule FROM assistant_playbook_rules
     WHERE assistant_id = $1 AND status = 'active'
     ORDER BY decided_at DESC NULLS LAST, created_at DESC`,
    [assistantId],
  )
  return result.rows.map((r) => r.rule)
}

/** Pending-suggestion count - the worker's flood gate. */
export async function countPendingPlaybookSuggestions(assistantId: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM assistant_playbook_rules
     WHERE assistant_id = $1 AND status = 'suggested'`,
    [assistantId],
  )
  return Number(result.rows[0]?.count ?? 0)
}

/** The do-not-repropose corpus: every non-retired rule text, any status. */
export async function listPlaybookCorpus(assistantId: string): Promise<{ rule: string; status: PlaybookRuleStatus }[]> {
  const result = await query<{ rule: string; status: PlaybookRuleStatus }>(
    `SELECT rule, status FROM assistant_playbook_rules
     WHERE assistant_id = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [assistantId],
  )
  return result.rows
}

/**
 * Insert reflection output with auto-admission (founder decision
 * 2026-08-07: always auto-accept; the safety lives in golden-source
 * grounding + visibility + the cap, not an admission tap). Rules activate
 * immediately up to MAX_ACTIVE_PLAYBOOK_RULES; overflow lands as
 * 'suggested' so nothing is lost but nothing self-applies past the cap.
 * An auto-admitted rule is recognizable by `status='active'` +
 * `created_by='reflection'` + `decided_by_user_id IS NULL` - the UI badges
 * it and the owner can retire it any time.
 */
export async function insertPlaybookRules(
  assistantId: string,
  rules: { rule: string; rationale: string | null; provenance: unknown }[],
): Promise<{ activated: number; suggested: number }> {
  const active = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM assistant_playbook_rules
     WHERE assistant_id = $1 AND status = 'active'`,
    [assistantId],
  )
  let slots = MAX_ACTIVE_PLAYBOOK_RULES - Number(active.rows[0]?.count ?? 0)
  let activated = 0
  let suggested = 0
  for (const s of rules) {
    const rule = s.rule.trim().slice(0, 280)
    if (!rule) continue
    const status = slots > 0 ? 'active' : 'suggested'
    await query(
      `INSERT INTO assistant_playbook_rules
         (assistant_id, rule, rationale, provenance, status, created_by, decided_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, 'reflection', CASE WHEN $5 = 'active' THEN now() END)`,
      [assistantId, rule, s.rationale, s.provenance === undefined ? null : JSON.stringify(s.provenance), status],
    )
    if (status === 'active') {
      slots--
      activated++
    } else {
      suggested++
    }
  }
  return { activated, suggested }
}

export type PlaybookDecision = 'approve' | 'reject' | 'retire'

/**
 * Apply an owner decision. Returns the updated rule, or null when the rule
 * doesn't exist / doesn't belong to the assistant / isn't in a status the
 * decision applies to (approve+reject act on 'suggested'; retire on
 * 'active'). Approve additionally refuses past MAX_ACTIVE_PLAYBOOK_RULES,
 * returning 'cap' so the route can 409 with a real reason.
 */
export async function decidePlaybookRule(params: {
  assistantId: string
  ruleId: string
  decision: PlaybookDecision
  userId: string
}): Promise<PlaybookRule | 'cap' | null> {
  const { assistantId, ruleId, decision, userId } = params
  if (decision === 'approve') {
    const active = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM assistant_playbook_rules
       WHERE assistant_id = $1 AND status = 'active'`,
      [assistantId],
    )
    if (Number(active.rows[0]?.count ?? 0) >= MAX_ACTIVE_PLAYBOOK_RULES) return 'cap'
  }
  const fromStatus = decision === 'retire' ? 'active' : 'suggested'
  const toStatus = decision === 'approve' ? 'active' : decision === 'reject' ? 'rejected' : 'retired'
  const result = await query<PlaybookRule>(
    `UPDATE assistant_playbook_rules
     SET status = $1, decided_by_user_id = $2, decided_at = now(), updated_at = now()
     WHERE id = $3 AND assistant_id = $4 AND status = $5
     RETURNING ${ROW_COLUMNS}`,
    [toStatus, userId, ruleId, assistantId, fromStatus],
  )
  return result.rows[0] ?? null
}

/**
 * Worker enumeration: assistants eligible for reflection - a non-empty
 * `charter->>'success'` rubric, and an attribution user (the assistant
 * owner, else the workspace owner) for the usage row.
 */
export async function listReflectableAssistants(): Promise<
  { assistantId: string; workspaceId: string | null; attributionUserId: string; charter: unknown; name: string }[]
> {
  const result = await query<{
    assistantId: string
    workspaceId: string | null
    attributionUserId: string
    charter: unknown
    name: string
  }>(
    `SELECT a.id AS "assistantId",
            a.workspace_id AS "workspaceId",
            COALESCE(a.owner_user_id, w.owner_user_id) AS "attributionUserId",
            a.charter,
            a.name
     FROM assistants a
     LEFT JOIN workspaces w ON w.id = a.workspace_id
     WHERE NULLIF(btrim(a.charter->>'success'), '') IS NOT NULL
       AND COALESCE(a.owner_user_id, w.owner_user_id) IS NOT NULL`,
  )
  return result.rows
}

/**
 * A bounded sample of the assistant's recent user-facing conversation - the
 * reflection worker's evidence. Cron/internal execution sessions are
 * excluded, and so are **external-principal sessions** (chat-link visitors,
 * public-API consumers, via the shared exclusion fragment): golden-source
 * grounding means rules derive from the team's own feedback - an external
 * customer's request is demand, never authority to change standing
 * behavior. Message bodies are truncated server-side so one long turn
 * can't blow the prompt budget.
 */
export async function samplePlaybookEvidence(
  assistantId: string,
  windowDays: number,
  maxMessages: number,
): Promise<{ sessionId: string; role: string; content: string; createdAt: string }[]> {
  const result = await query<{ sessionId: string; role: string; content: string; createdAt: string }>(
    `SELECT sm.session_id AS "sessionId",
            sm.role,
            LEFT(sm.content::text, 600) AS content,
            sm.created_at AS "createdAt"
     FROM session_messages sm
     JOIN sessions s ON s.id = sm.session_id
     WHERE s.assistant_id = $1
       AND s.channel_type <> 'cron'
       AND sm.role IN ('user', 'assistant')
       AND sm.created_at > now() - ($2 || ' days')::interval
       ${excludeExternalPrincipalsSql('s.user_id')}
     ORDER BY sm.created_at DESC
     LIMIT $3`,
    [assistantId, String(windowDays), maxMessages],
  )
  return result.rows.reverse()
}
