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

import { createHash } from 'node:crypto'

import { z } from 'zod'

import { getPool, query } from './client.js'
import { excludeExternalPrincipalsSql } from './external-principal.js'
import { appendDecisionDerivation } from './decision-provenance-store.js'

export type PlaybookRuleStatus = 'suggested' | 'active' | 'rejected' | 'retired'

export type PlaybookRule = {
  id: string
  assistantId: string
  rule: string
  rationale: string | null
  provenance: unknown
  status: PlaybookRuleStatus
  createdBy: 'reflection' | 'owner' | 'decision_reflection'
  appliesToUserId: string | null
  applicabilityKind: 'general' | 'email' | 'tool'
  applicabilityKey: string | null
  evidenceCount: number
  semanticKey: string | null
  decisionSensitivity: 'public' | 'internal' | 'confidential' | 'restricted'
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

/** Decision-derived active cap per assistant/member pair. */
export const MAX_ACTIVE_DECISION_PLAYBOOK_RULES = 6

const ROW_COLUMNS = `
  id,
  assistant_id       AS "assistantId",
  rule,
  rationale,
  provenance,
  status,
  created_by         AS "createdBy",
  applies_to_user_id AS "appliesToUserId",
  applicability_kind AS "applicabilityKind",
  applicability_key  AS "applicabilityKey",
  evidence_count     AS "evidenceCount",
  semantic_key       AS "semanticKey",
  decision_sensitivity AS "decisionSensitivity",
  decided_by_user_id AS "decidedByUserId",
  decided_at         AS "decidedAt",
  created_at         AS "createdAt"
` as const

/** Every rule for the assistant, newest first - the management surface read. */
export async function listPlaybookRules(assistantId: string): Promise<PlaybookRule[]> {
  const result = await query<PlaybookRule>(
    `SELECT ${ROW_COLUMNS} FROM assistant_playbook_rules
     WHERE assistant_id = $1 AND applies_to_user_id IS NULL
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
     WHERE assistant_id = $1 AND applies_to_user_id IS NULL AND status = 'active'
     ORDER BY decided_at DESC NULLS LAST, created_at DESC`,
    [assistantId],
  )
  return result.rows.map((r) => r.rule)
}

/** Pending-suggestion count - the worker's flood gate. */
export async function countPendingPlaybookSuggestions(assistantId: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM assistant_playbook_rules
     WHERE assistant_id = $1 AND applies_to_user_id IS NULL AND status = 'suggested'`,
    [assistantId],
  )
  return Number(result.rows[0]?.count ?? 0)
}

/** The do-not-repropose corpus: every non-retired rule text, any status. */
export async function listPlaybookCorpus(assistantId: string): Promise<{ rule: string; status: PlaybookRuleStatus }[]> {
  const result = await query<{ rule: string; status: PlaybookRuleStatus }>(
    `SELECT rule, status FROM assistant_playbook_rules
     WHERE assistant_id = $1 AND applies_to_user_id IS NULL
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
     WHERE assistant_id = $1 AND applies_to_user_id IS NULL AND status = 'active'`,
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

export const decisionRuleProposalSchema = z.object({
  rule: z.string().trim().min(1).max(280),
  applicabilityKind: z.enum(['general', 'email', 'tool']),
  applicabilityKey: z.string().trim().min(1).max(256).nullable().optional().default(null),
  sourceEventIds: z.array(z.string().uuid()).min(1).max(30),
  eligibility: z.enum(['suggestion', 'activation']),
}).strict()

export type DecisionRuleProposal = z.output<typeof decisionRuleProposalSchema>

const PROHIBITED_DECISION_RULE_PATTERNS = [
  /\b(?:grant|revoke|elevate|bypass|change|modify|update|set)\b.{0,48}\b(?:permissions?|access|roles?|workspace polic(?:y|ies))\b/i,
  /\b(?:permissions?|access|roles?|workspace polic(?:y|ies))\b.{0,48}\b(?:grant|revoke|elevate|bypass|change|modify|update|set)\b/i,
  /\b(?:create|delete|modify|update|install|publish)\b.{0,48}\b(?:skills?|workflows?)\b/i,
  /\b(?:skills?|workflows?)\b.{0,48}\b(?:create|delete|modify|update|install|publish)\b/i,
  /\b(?:merge|bind|identify|reassign)\b.{0,48}\b(?:persons?|contacts?|identit(?:y|ies))\b/i,
  /\b(?:persons?|contacts?|identit(?:y|ies))\b.{0,48}\b(?:merge|bind|identify|reassign)\b/i,
  /\b(?:task admission|task policy|workspace policy)\b/i,
]

/** Projector guard: behavioral advice only, never another authority system. */
export function isProhibitedDecisionRule(rule: string): boolean {
  return PROHIBITED_DECISION_RULE_PATTERNS.some((pattern) => pattern.test(rule))
}

export function semanticKeyForDecisionRule(input: {
  rule: string
  applicabilityKind: 'general' | 'email' | 'tool'
  applicabilityKey?: string | null
}): string {
  const normalized = input.rule
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  return createHash('sha256')
    .update(`${input.applicabilityKind}\u0000${input.applicabilityKey?.trim().toLowerCase() ?? ''}\u0000${normalized}`)
    .digest('hex')
}

type DecisionEvidenceRow = {
  id: string
  eventKind: 'approval.decided' | 'email.draft_revised'
  sourceKind: string
  sourceId: string
  payload: Record<string, unknown>
  reason: string | null
  sensitivity: 'public' | 'internal' | 'confidential' | 'restricted'
  createdAt: Date
}

function isReviewedEmailEvidence(row: DecisionEvidenceRow): boolean {
  return row.eventKind === 'email.draft_revised'
    || (
      row.eventKind === 'approval.decided'
      && row.payload.approvalKind === 'workflow_step'
      && row.payload.toolName === 'imapSendMessage'
    )
}

const DECISION_SENSITIVITY_RANK: Record<DecisionEvidenceRow['sensitivity'], number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
}

function decisionEvidenceSourceKeys(rows: readonly DecisionEvidenceRow[]): {
  eventCount: number
  distinctSources: number
} {
  // Approval ids in one revision chain form one normalized example even when
  // the model cites every event id in that chain.
  const parent = new Map<string, string>()
  const find = (value: string): string => {
    const current = parent.get(value)
    if (!current || current === value) return value
    const root = find(current)
    parent.set(value, root)
    return root
  }
  const union = (left: string, right: string) => {
    if (!parent.has(left)) parent.set(left, left)
    if (!parent.has(right)) parent.set(right, right)
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) {
      const root = leftRoot < rightRoot ? leftRoot : rightRoot
      parent.set(leftRoot, root)
      parent.set(rightRoot, root)
    }
  }
  for (const row of rows) {
    if (row.eventKind !== 'email.draft_revised') continue
    const previous = typeof row.payload.previousApprovalId === 'string'
      ? row.payload.previousApprovalId
      : null
    const replacement = typeof row.payload.replacementApprovalId === 'string'
      ? row.payload.replacementApprovalId
      : null
    if (previous && replacement) union(previous, replacement)
  }
  const normalizedEvents = new Set<string>()
  const sources = new Set<string>()
  for (const row of rows) {
    if (row.eventKind === 'email.draft_revised') {
      const previous = typeof row.payload.previousApprovalId === 'string'
        ? row.payload.previousApprovalId
        : row.sourceId
      const key = `email:${find(previous)}`
      normalizedEvents.add(key)
      sources.add(key)
      continue
    }
    if (isReviewedEmailEvidence(row)) {
      const approvalId = typeof row.payload.approvalId === 'string'
        ? row.payload.approvalId
        : row.sourceId
      normalizedEvents.add(`email-decision:${row.id}`)
      sources.add(`email:${find(approvalId)}`)
      continue
    }
    const approvalId = typeof row.payload.approvalId === 'string'
      ? row.payload.approvalId
      : typeof row.payload.toolCallId === 'string'
        ? row.payload.toolCallId
        : row.sourceId
    normalizedEvents.add(`tool-event:${row.id}`)
    sources.add(`tool:${approvalId}`)
  }
  return { eventCount: normalizedEvents.size, distinctSources: sources.size }
}

function proposalMatchesApplicability(
  proposal: DecisionRuleProposal,
  rows: readonly DecisionEvidenceRow[],
): boolean {
  if (proposal.applicabilityKind === 'general') return true
  if (proposal.applicabilityKind === 'email') {
    if (rows.some((row) => !isReviewedEmailEvidence(row))) return false
    return proposal.applicabilityKey === null || rows.every((row) =>
      row.payload.accountKey === proposal.applicabilityKey)
  }
  if (rows.some((row) => row.eventKind !== 'approval.decided' || isReviewedEmailEvidence(row))) {
    return false
  }
  return proposal.applicabilityKey === null || rows.every((row) =>
    row.payload.toolName === proposal.applicabilityKey)
}

export type InsertDecisionRulesResult = {
  activated: number
  suggested: number
  deduped: number
  rejected: number
}

/**
 * Independently validate model-selected evidence and atomically insert scoped
 * rules plus canonical derivations. Model eligibility claims are advisory.
 */
export async function insertDecisionReflectedRules(params: {
  assistantId: string
  actorUserId: string
  workspaceId: string | null
  proposals: unknown[]
}): Promise<InsertDecisionRulesResult> {
  const result: InsertDecisionRulesResult = {
    activated: 0,
    suggested: 0,
    deduped: 0,
    rejected: 0,
  }
  const parsed: DecisionRuleProposal[] = []
  for (const candidate of params.proposals.slice(0, 2)) {
    const proposal = decisionRuleProposalSchema.safeParse(candidate)
    if (!proposal.success || isProhibitedDecisionRule(
      proposal.success ? proposal.data.rule : '',
    )) {
      result.rejected++
      continue
    }
    parsed.push(proposal.data)
  }
  if (parsed.length === 0) return result

  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`decision-playbook:${params.assistantId}:${params.actorUserId}`],
    )
    const active = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM assistant_playbook_rules
        WHERE assistant_id = $1 AND applies_to_user_id = $2
          AND created_by = 'decision_reflection' AND status = 'active'`,
      [params.assistantId, params.actorUserId],
    )
    let slots = Math.max(
      0,
      MAX_ACTIVE_DECISION_PLAYBOOK_RULES - Number(active.rows[0]?.count ?? 0),
    )

    for (const proposal of parsed) {
      const eventIds = [...new Set(proposal.sourceEventIds)]
      const events = await client.query<DecisionEvidenceRow>(
        `SELECT de.id, de.event_kind AS "eventKind", de.source_kind AS "sourceKind",
                de.source_id AS "sourceId", de.payload, de.reason,
                de.sensitivity, de.created_at AS "createdAt"
           FROM decision_events de
          WHERE de.id = ANY($1::uuid[])
            AND de.assistant_id = $2 AND de.actor_user_id = $3
            AND de.workspace_id IS NOT DISTINCT FROM $4::uuid
            AND de.created_at >= now() - interval '30 days'
            AND (
              de.event_kind = 'email.draft_revised'
              OR (
                de.event_kind = 'approval.decided'
                AND de.payload->>'resolution' IN ('deny', 'always_deny')
                AND NULLIF(btrim(de.reason), '') IS NOT NULL
              )
            )
            ${excludeExternalPrincipalsSql('de.actor_user_id')}
          ORDER BY de.created_at, de.id`,
        [eventIds, params.assistantId, params.actorUserId, params.workspaceId],
      )
      if (events.rows.length !== eventIds.length
        || !proposalMatchesApplicability(proposal, events.rows)) {
        result.rejected++
        continue
      }
      const counts = decisionEvidenceSourceKeys(events.rows)
      const qualifiesForActivation = counts.eventCount >= 3 && counts.distinctSources >= 2
      const status: PlaybookRuleStatus = qualifiesForActivation && slots > 0
        ? 'active'
        : 'suggested'
      const sensitivity = events.rows.reduce<DecisionEvidenceRow['sensitivity']>(
        (highest, row) => DECISION_SENSITIVITY_RANK[row.sensitivity]
          > DECISION_SENSITIVITY_RANK[highest] ? row.sensitivity : highest,
        'public',
      )
      const semanticKey = semanticKeyForDecisionRule(proposal)
      const sourceKinds = [...new Set(events.rows.map((row) => row.sourceKind))].sort()
      const dates = events.rows.map((row) => row.createdAt).sort((a, b) => a.getTime() - b.getTime())
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO assistant_playbook_rules (
           assistant_id, rule, rationale, provenance, status, created_by,
           applies_to_user_id, applicability_kind, applicability_key,
           evidence_count, semantic_key, decision_sensitivity, decided_at
         ) VALUES (
           $1,$2,NULL,$3::jsonb,$4,'decision_reflection',$5,$6,$7,$8,$9,$10,
           CASE WHEN $4 = 'active' THEN now() END
         )
         ON CONFLICT (assistant_id, applies_to_user_id, semantic_key)
           WHERE semantic_key IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          params.assistantId,
          proposal.rule,
          JSON.stringify({
            sourceKinds,
            firstEvidenceAt: dates[0]?.toISOString() ?? null,
            lastEvidenceAt: dates[dates.length - 1]?.toISOString() ?? null,
          }),
          status,
          params.actorUserId,
          proposal.applicabilityKind,
          proposal.applicabilityKey,
          counts.eventCount,
          semanticKey,
          sensitivity,
        ],
      )
      if (!inserted.rows[0]) {
        result.deduped++
        continue
      }
      for (const eventId of eventIds) {
        await appendDecisionDerivation({
          decisionEventId: eventId,
          artifactKind: 'assistant_playbook_rule',
          artifactId: inserted.rows[0].id,
          relation: 'supports',
        }, client)
      }
      if (status === 'active') {
        result.activated++
        slots--
      } else {
        result.suggested++
      }
    }
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
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
       WHERE assistant_id = $1 AND applies_to_user_id IS NULL AND status = 'active'`,
      [assistantId],
    )
    if (Number(active.rows[0]?.count ?? 0) >= MAX_ACTIVE_PLAYBOOK_RULES) return 'cap'
  }
  const fromStatus = decision === 'retire' ? 'active' : 'suggested'
  const toStatus = decision === 'approve' ? 'active' : decision === 'reject' ? 'rejected' : 'retired'
  const result = await query<PlaybookRule>(
    `UPDATE assistant_playbook_rules
     SET status = $1, decided_by_user_id = $2, decided_at = now(), updated_at = now()
     WHERE id = $3 AND assistant_id = $4 AND applies_to_user_id IS NULL AND status = $5
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
