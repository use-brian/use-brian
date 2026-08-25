/**
 * Task guardrail store — the DB half of the admission gate.
 *
 * Spec: docs/architecture/features/task-guardrails.md
 * Schema: migration 377_task_guardrails.sql
 *
 * Implements two core ports against one set of tables:
 *   - `TaskAdmissionPort`   — what the gate reads to decide (rules, similar
 *                             tombstones, similar open tasks) and where it
 *                             records what it refused
 *   - `TaskGuardrailStore`  — what the chat tools write (reject, rule CRUD)
 *
 * SIMILARITY LIVES HERE, NOT IN CORE. `similarity()` is a pg_trgm function over
 * indexed columns; pulling the candidate rows into JS to score them would mean
 * reading every open task in the workspace on every extracted item. Core gets
 * pre-scored matches and stays DB-free.
 *
 * SYSTEM-LEVEL BY DESIGN. Every function here runs through bare `query()` (the
 * default-true `app.system_bypass` path), because the callers are already
 * authorized for the workspace and half of them have no acting user at all —
 * the ingest gate runs inside a batch drain with no session. The REST routes
 * that DO have a user check membership at the route boundary
 * (`requireWorkspaceMember`), the same posture as the GitHub task lifecycle's
 * `findByExternalRefSystem`.
 *
 * [COMP:tasks/admission-store]
 */

import {
  TASK_ADMISSION_THRESHOLDS,
  normalizeTaskTitle,
  proposeRuleFromTombstones,
  significantTokens,
  validateRulePredicate,
  type RecordCandidateInput,
  type ScoredTask,
  type ScoredTombstone,
  type TaskAdmissionPort,
  type TaskReadinessAssessment,
  type TaskGuardrailStore,
  type TaskLane,
  type TaskRuleEffect,
  type TaskRulePredicate,
  type TaskRuleRecord,
  type TaskRuleStatus,
  type TaskTombstoneRecord,
} from '@use-brian/core'
import { applyRLSGucs, getAppPool, query, rollbackAndRelease } from './client.js'
import { appendDecisionEvent } from './decision-event-store.js'
import { abandonGoalsForHostTaskSystem } from './goals.js'

// ── Row mappers ──────────────────────────────────────────────────────────────

type RuleRow = {
  id: string
  workspace_id: string
  status: TaskRuleStatus
  effect: TaskRuleEffect
  predicate: TaskRulePredicate
  nl_clause: string | null
  reason: string | null
  origin: 'user' | 'proposed'
  created_at: Date
}

function toRule(row: RuleRow): TaskRuleRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    status: row.status,
    effect: row.effect,
    predicate: row.predicate ?? {},
    nlClause: row.nl_clause,
    reason: row.reason,
    origin: row.origin,
    createdAt: row.created_at,
  }
}

type TombstoneRow = {
  id: string
  workspace_id: string
  title: string
  title_norm: string
  reason: string
  source_kind: string | null
  lane: TaskLane | null
  created_at: Date
}

function toTombstone(row: TombstoneRow): TaskTombstoneRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    titleNorm: row.title_norm,
    reason: row.reason,
    sourceKind: row.source_kind,
    lane: row.lane,
    createdAt: row.created_at,
  }
}

const RULE_SELECT = `
  id, workspace_id, status, effect, predicate, nl_clause, reason, origin, created_at
`
const TOMBSTONE_SELECT = `
  id, workspace_id, title, title_norm, reason, source_kind, lane, created_at
`

/** Recent tombstones shown to the extractor as negative examples. */
const PROMPT_TOMBSTONE_LIMIT = 8
/** Relevant live tasks shown before extraction so discussion is not re-titled. */
const PROMPT_OPEN_TASK_LIMIT = 8
/** Cap on similarity candidates — the gate only ever uses the best one. */
const SIMILARITY_LIMIT = 5
/** Tombstones the proposer clusters over. Bounded so a long-lived workspace
 *  does not turn every rejection into an unbounded scan. */
const PROPOSAL_SCAN_LIMIT = 100

// ── TaskAdmissionPort ────────────────────────────────────────────────────────

export async function listActiveRules(workspaceId: string): Promise<TaskRuleRecord[]> {
  const res = await query<RuleRow>(
    `SELECT ${RULE_SELECT} FROM task_rules
      WHERE workspace_id = $1 AND status = 'active'
      ORDER BY created_at`,
    [workspaceId],
  )
  return res.rows.map(toRule)
}

/**
 * Tombstones similar to `titleNorm`. `similarity()` on the GIN-indexed
 * `title_norm`; `%` would use the session's `pg_trgm.similarity_threshold`
 * global, so the comparison is explicit instead — the threshold is a product
 * decision that belongs in `admission.ts`, not in a database GUC.
 */
export async function findSimilarTombstones(
  workspaceId: string,
  titleNorm: string,
  minSimilarity: number,
): Promise<ScoredTombstone[]> {
  const res = await query<TombstoneRow & { sim: number }>(
    `SELECT ${TOMBSTONE_SELECT}, similarity(title_norm, $2) AS sim
       FROM task_tombstones
      WHERE workspace_id = $1
        AND similarity(title_norm, $2) >= $3
      ORDER BY sim DESC
      LIMIT ${SIMILARITY_LIMIT}`,
    [workspaceId, titleNorm, minSimilarity],
  )
  return res.rows.map((row) => ({ tombstone: toTombstone(row), similarity: row.sim }))
}

/**
 * Live OPEN tasks similar to `titleNorm`.
 *
 * `status NOT IN ('done','archived')` is load-bearing: re-raising work that
 * finished last month is legitimate, and treating a closed task as a duplicate
 * target would make the guardrail invent policy the user never stated.
 */
export async function findSimilarTasks(
  workspaceId: string,
  titleNorm: string,
  minSimilarity: number,
): Promise<ScoredTask[]> {
  const res = await query<{ id: string; title: string; sim: number }>(
    `SELECT id, title, similarity(lower(title), $2) AS sim
       FROM tasks
      WHERE workspace_id = $1
        AND valid_to IS NULL
        AND retracted_at IS NULL
        AND status NOT IN ('done', 'archived')
        AND similarity(lower(title), $2) >= $3
      ORDER BY sim DESC
      LIMIT ${SIMILARITY_LIMIT}`,
    [workspaceId, titleNorm, minSimilarity],
  )
  return res.rows.map((r) => ({ id: r.id, title: r.title, similarity: r.sim }))
}

export async function recordCandidate(input: RecordCandidateInput): Promise<void> {
  await query(
    `INSERT INTO task_candidates (
       workspace_id, title, due, source_kind, channel_ref, lane, source_episode_id,
       created_by_assistant_id, status, reason_code, matched_task_id,
       matched_rule_id, matched_tombstone_id, similarity, quality,
       created_task_id, expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      input.workspaceId,
      input.title,
      input.due,
      input.sourceKind,
      input.channelRef ?? null,
      input.lane,
      input.sourceEpisodeId,
      input.createdByAssistantId,
      input.status,
      input.reasonCode,
      input.matchedTaskId ?? null,
      input.matchedRuleId ?? null,
      input.matchedTombstoneId ?? null,
      input.similarity ?? null,
      JSON.stringify(input.quality ?? {}),
      input.createdTaskId ?? null,
      input.expiresAt,
    ],
  )
}

export async function loadPolicyForPrompt(workspaceId: string, content?: string): Promise<{
  rules: TaskRuleRecord[]
  tombstones: TaskTombstoneRecord[]
  openTasks: ScoredTask[]
}> {
  const relevantContent = content?.trim() ?? ''
  const [rules, tombstones, openTasks] = await Promise.all([
    listActiveRules(workspaceId),
    query<TombstoneRow>(
      `SELECT ${TOMBSTONE_SELECT} FROM task_tombstones
        WHERE workspace_id = $1
        ORDER BY created_at DESC
        LIMIT ${PROMPT_TOMBSTONE_LIMIT}`,
      [workspaceId],
    ).then((r) => r.rows.map(toTombstone)),
    relevantContent
      ? query<{ id: string; title: string; sim: number }>(
          `SELECT id, title, word_similarity(lower(title), lower($2)) AS sim
             FROM tasks
            WHERE workspace_id = $1
              AND valid_to IS NULL
              AND retracted_at IS NULL
              AND status NOT IN ('done', 'archived')
              AND word_similarity(lower(title), lower($2)) >= $3
            ORDER BY sim DESC
            LIMIT ${PROMPT_OPEN_TASK_LIMIT}`,
          [workspaceId, relevantContent, TASK_ADMISSION_THRESHOLDS.NEAR_DUPLICATE_HOLD],
        ).then((r) => r.rows.map((row) => ({ id: row.id, title: row.title, similarity: row.sim })))
      : Promise.resolve([] as ScoredTask[]),
  ])
  return { rules, tombstones, openTasks }
}

/**
 * Candidate pool for the GitHub PR → task LLM matcher
 * (`[COMP:brain/github-task-match]`): live open tasks whose titles have word
 * overlap with the PR text. Tasks already backlinked to GitHub are excluded —
 * the deterministic lifecycle owns those. The threshold is deliberately looser
 * than the admission thresholds: recall lives here, precision lives in the
 * judge.
 */
const GITHUB_MATCH_POOL_SIMILARITY = 0.3

export type GithubMatchTaskRow = {
  id: string
  title: string
  description: string | null
}

export async function findOpenTasksForGithubMatch(
  workspaceId: string,
  text: string,
  limit = 8,
): Promise<GithubMatchTaskRow[]> {
  const trimmed = text.trim()
  if (!trimmed) return []
  const res = await query<GithubMatchTaskRow & { sim: number }>(
    `SELECT id, title, attributes->>'description' AS description,
            word_similarity(lower(title), lower($2)) AS sim
       FROM tasks
      WHERE workspace_id = $1
        AND valid_to IS NULL
        AND retracted_at IS NULL
        AND status NOT IN ('done', 'archived')
        AND NOT (external_ref @> '{"provider":"github"}'::jsonb)
        AND word_similarity(lower(title), lower($2)) >= $3
      ORDER BY sim DESC
      LIMIT $4`,
    [workspaceId, trimmed, GITHUB_MATCH_POOL_SIMILARITY, limit],
  )
  return res.rows.map(({ sim: _sim, ...row }) => row)
}

/** The port, ready to inject at boot. */
export function createTaskAdmissionPort(): TaskAdmissionPort {
  return {
    listActiveRules,
    findSimilarTombstones,
    findSimilarTasks,
    recordCandidate,
    loadPolicyForPrompt,
  }
}

// ── Rules ────────────────────────────────────────────────────────────────────

export async function createRule(input: {
  workspaceId: string
  userId: string | null
  effect: TaskRuleEffect
  predicate: TaskRulePredicate
  nlClause: string | null
  reason: string | null
  status: TaskRuleStatus
  origin?: 'user' | 'proposed'
}): Promise<TaskRuleRecord> {
  const res = await query<RuleRow>(
    `INSERT INTO task_rules
       (workspace_id, status, effect, predicate, nl_clause, reason, origin, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING ${RULE_SELECT}`,
    [
      input.workspaceId,
      input.status,
      input.effect,
      JSON.stringify(input.predicate),
      input.nlClause,
      input.reason,
      input.origin ?? 'user',
      input.userId,
    ],
  )
  return toRule(res.rows[0])
}

export async function listRules(input: {
  workspaceId: string
  includeDisabled: boolean
}): Promise<TaskRuleRecord[]> {
  const res = await query<RuleRow>(
    `SELECT ${RULE_SELECT} FROM task_rules
      WHERE workspace_id = $1
        ${input.includeDisabled ? '' : "AND status <> 'disabled'"}
      ORDER BY
        CASE status WHEN 'proposed' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
        created_at DESC`,
    [input.workspaceId],
  )
  return res.rows.map(toRule)
}

export async function setRuleStatus(input: {
  workspaceId: string
  ruleId: string
  status: TaskRuleStatus
}): Promise<TaskRuleRecord | null> {
  const res = await query<RuleRow>(
    `UPDATE task_rules SET status = $3
      WHERE id = $2 AND workspace_id = $1
      RETURNING ${RULE_SELECT}`,
    [input.workspaceId, input.ruleId, input.status],
  )
  return res.rows.length === 0 ? null : toRule(res.rows[0])
}

export async function deleteRule(input: {
  workspaceId: string
  ruleId: string
}): Promise<boolean> {
  const res = await query(`DELETE FROM task_rules WHERE id = $2 AND workspace_id = $1`, [
    input.workspaceId,
    input.ruleId,
  ])
  return (res.rowCount ?? 0) > 0
}

// ── Tombstones ───────────────────────────────────────────────────────────────

export async function listTombstones(workspaceId: string, limit = 100): Promise<TaskTombstoneRecord[]> {
  const res = await query<TombstoneRow>(
    `SELECT ${TOMBSTONE_SELECT} FROM task_tombstones
      WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [workspaceId, limit],
  )
  return res.rows.map(toTombstone)
}

export async function deleteTombstone(workspaceId: string, id: string): Promise<boolean> {
  const res = await query(`DELETE FROM task_tombstones WHERE id = $2 AND workspace_id = $1`, [
    workspaceId,
    id,
  ])
  return (res.rowCount ?? 0) > 0
}

/**
 * Soft-delete a task and record WHY, atomically.
 *
 * The soft delete follows the D.4 universal contract (`valid_to = now()`), so a
 * rejected task is recoverable and the bi-temporal history stays intact — the
 * tombstone is additive, not a harder delete.
 *
 * `source_kind` / `lane` come from the task's own provenance so a proposed rule
 * can later be scoped to the source that produced the slop rather than to every
 * source at once.
 */
export async function rejectTask(input: {
  workspaceId: string
  userId: string
  taskId: string
  reason: string
  /** Explicit Tasks-UI consent to create/reuse an active narrow deny rule. */
  createRule?: boolean
}): Promise<{
  title: string
  tombstoneId: string
  activeRuleId: string | null
  proposedRuleId: string | null
  proposedRuleClause: string | null
} | null> {
  const client = await getAppPool().connect()
  let title: string
  let tombstoneId: string
  let sourceKind: string | null
  let activeRuleId: string | null = null
  try {
    await client.query('BEGIN')
    // App pool = RLS-enforced. Without the acting user's GUCs the member
    // policies evaluate against the nil-UUID sentinel and this SELECT can
    // never see the task (every reject 404'd in prod, 2026-08-07).
    await applyRLSGucs(client, input.userId)

    const existing = await client.query<{
      id: string
      title: string
      source: string | null
      source_kind: string | null
      channel_ref: string | null
      source_session_id: string | null
      created_by_assistant_id: string | null
      sensitivity: 'public' | 'internal' | 'confidential' | 'restricted'
    }>(
      `SELECT t.id, t.title, t.source, t.source_session_id,
              t.created_by_assistant_id, t.sensitivity, e.source_kind,
              COALESCE(e.source_ref->>'channel_id', e.source_ref->>'channel_ref') AS channel_ref
         FROM tasks t
         LEFT JOIN episodes e ON e.id = t.source_episode_id
        WHERE t.id = $1 AND t.workspace_id = $2
          AND t.valid_to IS NULL AND t.retracted_at IS NULL`,
      [input.taskId, input.workspaceId],
    )
    if (existing.rows.length === 0) return null
    title = existing.rows[0].title
    sourceKind = existing.rows[0].source_kind
    const channelRef = existing.rows[0].channel_ref
    const sourceSessionId = existing.rows[0].source_session_id
    const createdByAssistantId = existing.rows[0].created_by_assistant_id
    const taskSensitivity = existing.rows[0].sensitivity
    const lane: TaskLane = existing.rows[0].source === 'extracted' ? 'extracted' : 'assistant'

    await client.query(
      `UPDATE tasks SET valid_to = now(), updated_at = now()
        WHERE id = $1 AND valid_to IS NULL`,
      [input.taskId],
    )

    // Host-lifecycle cascade — a rejected task takes its bound goals with it, or
    // the judge's "your assistant can help with this" draft outlives the task it
    // was about and sits on the triage surface forever. Same client, so it is
    // atomic with the soft delete. See db/goals.ts →
    // `abandonGoalsForHostTaskSystem`.
    await abandonGoalsForHostTaskSystem(input.taskId, 'host_task_deleted', { exec: client })

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO task_tombstones
         (workspace_id, title, title_norm, reason, source_kind, lane, original_task_id, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        input.workspaceId,
        title,
        normalizeTaskTitle(title),
        input.reason,
        sourceKind,
        lane,
        input.taskId,
        input.userId,
      ],
    )
    tombstoneId = inserted.rows[0].id

    if (input.createRule) {
      const predicate: TaskRulePredicate = {
        lanes: [lane],
        title_matches: [normalizeTaskTitle(title)],
        ...(sourceKind ? { source_kinds: [sourceKind] } : {}),
        ...(channelRef ? { channel_refs: [channelRef] } : {}),
      }
      const existingRule = await client.query<{ id: string }>(
        `SELECT id FROM task_rules
          WHERE workspace_id = $1 AND effect = 'deny' AND predicate = $2::jsonb
          LIMIT 1`,
        [input.workspaceId, JSON.stringify(predicate)],
      )
      if (existingRule.rows.length > 0) {
        activeRuleId = existingRule.rows[0].id
        await client.query(
          `UPDATE task_rules
              SET status = 'active', nl_clause = $3, reason = $3,
                  origin = 'user', created_by_user_id = $4
            WHERE workspace_id = $1 AND id = $2`,
          [input.workspaceId, activeRuleId, input.reason, input.userId],
        )
      } else {
        const rule = await client.query<{ id: string }>(
          `INSERT INTO task_rules
             (workspace_id, status, effect, predicate, nl_clause, reason, origin, created_by_user_id)
           VALUES ($1, 'active', 'deny', $2::jsonb, $3, $3, 'user', $4)
           RETURNING id`,
          [input.workspaceId, JSON.stringify(predicate), input.reason, input.userId],
        )
        activeRuleId = rule.rows[0].id
      }
    }

    await appendDecisionEvent({
      idempotencyKey: `task-rejection:${tombstoneId}`,
      workspaceId: input.workspaceId,
      actorUserId: input.userId,
      assistantId: createdByAssistantId,
      sessionId: sourceSessionId,
      eventKind: 'task.rejected',
      schemaVersion: 1,
      sourceKind: 'task_tombstone',
      sourceId: tombstoneId,
      declaredScope: 'instance',
      visibility: 'workspace',
      sensitivity: taskSensitivity,
      reason: input.reason,
      payload: {
        taskId: input.taskId,
        tombstoneId,
        activeRuleId,
        proposedRuleId: null,
        reasonStoredOn: 'task_tombstone',
      },
    }, client)

    await client.query('COMMIT')
  } finally {
    // Releases on EVERY exit — including the not-found early return above,
    // which used to leak the checked-out client and exhaust the app pool
    // (PG_POOL_MAX=2 → two 404s took the whole API down, 2026-08-07).
    await rollbackAndRelease(client)
  }

  // Proposal runs AFTER the commit, deliberately. The rejection is the thing
  // the user asked for; a failure while generalizing it must not roll that back
  // or surface as an error on the delete.
  let proposedRuleId: string | null = null
  let proposedRuleClause: string | null = null
  if (!input.createRule) {
    try {
      const proposal = await maybeProposeRule(input.workspaceId, tombstoneId)
      proposedRuleId = proposal?.id ?? null
      proposedRuleClause = proposal?.nlClause ?? null
    } catch (err) {
      console.warn(
        `[task-guardrails] rule proposal failed for workspace ${input.workspaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  return { title, tombstoneId, activeRuleId, proposedRuleId, proposedRuleClause }
}

/**
 * Generalize a cluster of rejections into a `proposed` rule, if the cluster is
 * tight enough to be worth offering. Returns null far more often than not —
 * see `proposeRuleFromTombstones` for why that conservatism is deliberate.
 *
 * Similarity is measured in Postgres (one `similarity()` projection over the
 * scanned tombstones) so the clustering uses the SAME measure the gate does;
 * the decision itself stays in the pure core function.
 */
async function maybeProposeRule(
  workspaceId: string,
  triggerTombstoneId: string,
): Promise<TaskRuleRecord | null> {
  const triggerRes = await query<TombstoneRow>(
    `SELECT ${TOMBSTONE_SELECT} FROM task_tombstones WHERE id = $1`,
    [triggerTombstoneId],
  )
  if (triggerRes.rows.length === 0) return null
  const trigger = toTombstone(triggerRes.rows[0])
  if (!trigger.sourceKind) return null

  const othersRes = await query<TombstoneRow & { sim: number }>(
    `SELECT ${TOMBSTONE_SELECT}, similarity(title_norm, $2) AS sim
       FROM task_tombstones
      WHERE workspace_id = $1 AND id <> $3
      ORDER BY sim DESC
      LIMIT ${PROPOSAL_SCAN_LIMIT}`,
    [workspaceId, trigger.titleNorm, triggerTombstoneId],
  )
  const simByNorm = new Map<string, number>()
  for (const row of othersRes.rows) simByNorm.set(row.id, row.sim)

  const proposal = proposeRuleFromTombstones(
    trigger,
    othersRes.rows.map(toTombstone),
    (a, b) => {
      // Only ever called as (other.titleNorm, trigger.titleNorm) — resolve via
      // the scores Postgres already computed rather than reimplementing trigram
      // similarity in JS, which would drift from the database's answer.
      if (b !== trigger.titleNorm) return 0
      const match = othersRes.rows.find((r) => r.title_norm === a)
      return match ? (simByNorm.get(match.id) ?? 0) : 0
    },
  )
  if (!proposal) return null

  // Don't re-propose what the workspace already decided on — an identical
  // predicate that is active, disabled, or already proposed all mean "asked
  // and answered".
  const existing = await query<{ id: string }>(
    `SELECT id FROM task_rules
      WHERE workspace_id = $1 AND predicate = $2::jsonb LIMIT 1`,
    [workspaceId, JSON.stringify(proposal.predicate)],
  )
  if (existing.rows.length > 0) return null

  return createRule({
    workspaceId,
    userId: null,
    effect: 'deny',
    predicate: proposal.predicate,
    nlClause: proposal.nlClause,
    reason: proposal.reason,
    status: 'proposed',
    origin: 'proposed',
  })
}

// ── Candidates (the suggestions tray + the audit log) ─────────────────────────

export type TaskCandidateRow = {
  id: string
  workspaceId: string
  title: string
  due: Date | null
  sourceKind: string | null
  channelRef: string | null
  lane: TaskLane
  sourceEpisodeId: string | null
  status: string
  reasonCode: string
  matchedTaskId: string | null
  matchedTaskTitle: string | null
  matchedRuleId: string | null
  matchedRuleClause: string | null
  similarity: number | null
  quality: TaskReadinessAssessment | null
  createdTaskId: string | null
  createdAt: Date
  expiresAt: Date
}

const CANDIDATE_SELECT = `
  c.id, c.workspace_id AS "workspaceId", c.title, c.due,
  c.source_kind AS "sourceKind", c.channel_ref AS "channelRef",
  c.lane, c.source_episode_id AS "sourceEpisodeId",
  c.status, c.reason_code AS "reasonCode", c.matched_task_id AS "matchedTaskId",
  m.title AS "matchedTaskTitle",
  c.matched_rule_id AS "matchedRuleId", r.nl_clause AS "matchedRuleClause",
  c.similarity,
  NULLIF(c.quality, '{}'::jsonb) AS quality,
  c.created_task_id AS "createdTaskId",
  c.created_at AS "createdAt", c.expires_at AS "expiresAt"
`

const CANDIDATE_JOINS = `
       LEFT JOIN tasks m ON m.id = c.matched_task_id AND m.valid_to IS NULL
       LEFT JOIN task_rules r ON r.id = c.matched_rule_id
`

/**
 * The tray. Filters on `expires_at` as well as `status` so an entry is invisible
 * the moment it ages out, whether or not the sweep has run yet — the sweep is
 * for reclaiming rows, never for correctness of what the user sees.
 */
export async function listPendingCandidates(
  workspaceId: string,
  limit = 50,
): Promise<TaskCandidateRow[]> {
  const res = await query<TaskCandidateRow>(
    `SELECT ${CANDIDATE_SELECT}
       FROM task_candidates c
       ${CANDIDATE_JOINS}
      WHERE c.workspace_id = $1 AND c.status = 'pending' AND c.expires_at > now()
      ORDER BY c.created_at DESC
      LIMIT $2`,
    [workspaceId, limit],
  )
  return res.rows
}

/**
 * The auto-approval audit: candidates an active allow rule turned straight
 * into tasks. Shown collapsed under the Suggestions view so a rule's work is
 * reviewable after the fact — the whole point of recording the case.
 */
export async function listAutoAcceptedCandidates(
  workspaceId: string,
  limit = 50,
): Promise<TaskCandidateRow[]> {
  const res = await query<TaskCandidateRow>(
    `SELECT ${CANDIDATE_SELECT}
       FROM task_candidates c
       ${CANDIDATE_JOINS}
      WHERE c.workspace_id = $1 AND c.status = 'auto_accepted' AND c.expires_at > now()
      ORDER BY c.created_at DESC
      LIMIT $2`,
    [workspaceId, limit],
  )
  return res.rows
}

export async function getCandidate(
  workspaceId: string,
  id: string,
): Promise<TaskCandidateRow | null> {
  const res = await query<TaskCandidateRow>(
    `SELECT ${CANDIDATE_SELECT}
       FROM task_candidates c
       ${CANDIDATE_JOINS}
      WHERE c.workspace_id = $1 AND c.id = $2`,
    [workspaceId, id],
  )
  return res.rows[0] ?? null
}

/**
 * Find-or-create the active `allow` rule the "Always create tasks like this"
 * affordance activates. The predicate is deliberately class-level, not
 * title-level: the same title next time would be a duplicate anyway, so the
 * useful opt-in is "ready suggestions from this source/channel". An identical
 * existing rule (any status) is re-activated instead of duplicated — the
 * mirror of the reasoned-delete deny-rule reuse.
 */
export async function findOrCreateAllowRule(input: {
  workspaceId: string
  userId: string
  sourceKind: string | null
  channelRef: string | null
  nlClause: string
}): Promise<{ id: string; created: boolean }> {
  const predicate: TaskRulePredicate = {
    lanes: ['extracted'],
    ...(input.sourceKind ? { source_kinds: [input.sourceKind] } : {}),
    ...(input.channelRef ? { channel_refs: [input.channelRef] } : {}),
  }
  const invalid = validateRulePredicate('allow', predicate)
  if (invalid) throw new Error(invalid)

  const existing = await query<{ id: string }>(
    `SELECT id FROM task_rules
      WHERE workspace_id = $1 AND effect = 'allow' AND predicate = $2::jsonb
      LIMIT 1`,
    [input.workspaceId, JSON.stringify(predicate)],
  )
  if (existing.rows.length > 0) {
    const id = existing.rows[0].id
    await query(
      `UPDATE task_rules
          SET status = 'active', origin = 'user', created_by_user_id = $3
        WHERE workspace_id = $1 AND id = $2`,
      [input.workspaceId, id, input.userId],
    )
    return { id, created: false }
  }

  const inserted = await query<{ id: string }>(
    `INSERT INTO task_rules
       (workspace_id, status, effect, predicate, nl_clause, reason, origin, created_by_user_id)
     VALUES ($1, 'active', 'allow', $2::jsonb, $3, $3, 'user', $4)
     RETURNING id`,
    [input.workspaceId, JSON.stringify(predicate), input.nlClause, input.userId],
  )
  return { id: inserted.rows[0].id, created: true }
}

export async function resolveCandidate(input: {
  workspaceId: string
  candidateId: string
  userId: string
  status: 'accepted' | 'dismissed'
  createdTaskId?: string | null
}): Promise<boolean> {
  const res = await query(
    `UPDATE task_candidates
        SET status = $3, resolved_at = now(), resolved_by_user_id = $4,
            created_task_id = COALESCE($5, created_task_id)
      WHERE id = $2 AND workspace_id = $1 AND status = 'pending'`,
    [
      input.workspaceId,
      input.candidateId,
      input.status,
      input.userId,
      input.createdTaskId ?? null,
    ],
  )
  return (res.rowCount ?? 0) > 0
}

/**
 * Auto-prune. Expires aged-out held suggestions and hard-deletes aged-out
 * dropped audit rows.
 *
 * Without this the tray becomes the new task list — the same unbounded-growth
 * failure the guardrail exists to fix, one layer down. Runs from the same
 * maintenance tick as the rest of the retention sweeps; safe to call
 * concurrently (both statements are idempotent).
 */
export async function sweepExpiredCandidates(): Promise<{
  expired: number
  purged: number
}> {
  const expired = await query(
    `UPDATE task_candidates SET status = 'expired'
      WHERE status = 'pending' AND expires_at <= now()`,
  )
  const purged = await query(
    `DELETE FROM task_candidates
      WHERE status IN ('dropped', 'expired', 'auto_accepted')
        AND expires_at <= now() - interval '7 days'`,
  )
  return { expired: expired.rowCount ?? 0, purged: purged.rowCount ?? 0 }
}

/** The guardrail-tool port, ready to inject at boot. */
export function createTaskGuardrailStore(): TaskGuardrailStore {
  return {
    rejectTask,
    createRule: (input) => createRule(input),
    listRules,
    deleteRule,
  }
}

/**
 * Write a tombstone WITHOUT a task to delete — the "dismiss this suggestion,
 * and here is why" path from the tray. Same lesson, no soft delete, because a
 * held candidate never became a task in the first place.
 */
export async function tombstoneFromCandidate(input: {
  workspaceId: string
  userId: string
  title: string
  reason: string
  sourceKind: string | null
  lane: TaskLane
}): Promise<string> {
  const res = await query<{ id: string }>(
    `INSERT INTO task_tombstones
       (workspace_id, title, title_norm, reason, source_kind, lane, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id`,
    [
      input.workspaceId,
      input.title,
      normalizeTaskTitle(input.title),
      input.reason,
      input.sourceKind,
      input.lane,
      input.userId,
    ],
  )
  return res.rows[0].id
}

/** Re-exported for the route layer's predicate-summary rendering. */
export { significantTokens }
