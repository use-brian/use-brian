/**
 * Scoped research lessons (docs/architecture/features/research.md ->
 * "Scoped lessons").
 *
 * Lessons are rows in the one learned prompt layer, `assistant_playbook_rules`
 * (`applicability_kind = 'research'`), never a second store. A model may only
 * propose wording, a scope and the follow-ups it rests on; this module
 * recomputes everything that matters from canonical state inside one
 * transaction: current evidence, threshold, scope admissibility, prohibited
 * content, semantic suppression and the per-target cap. Company (workspace)
 * methods are proposals until a current workspace owner accepts them.
 *
 * [COMP:api/research-learning]
 */
import { createHash } from 'node:crypto'
import type pg from 'pg'
import {
  evaluateResearchLessonSupport,
  isProhibitedResearchLesson,
  MAX_ACTIVE_RESEARCH_LESSONS_PER_SCOPE,
  RESEARCH_LESSON_KINDS,
  RESEARCH_LESSON_WINDOW_DAYS,
  researchLessonProposalSchema,
  researchLessonScopeAdmissible,
  researchLessonStatusFor,
  type ResearchLessonEvidence,
  type ResearchLessonProposal,
  type ResearchLessonScope,
} from '@use-brian/core'
import { getPool } from '../db/client.js'
import { appendDecisionEvent } from '../db/decision-event-store.js'
import { appendDecisionDerivation } from '../db/decision-provenance-store.js'
import { listResearchEvidenceSystem, withResearchTransaction, type ResearchEvidenceRow, type ResearchSensitivity } from '../db/research-store.js'

export type ResearchLesson = {
  id: string
  workspaceId: string
  assistantId: string
  rule: string
  scope: ResearchLessonScope
  appliesToUserId: string | null
  appliesToProjectId: string | null
  status: 'suggested' | 'active' | 'rejected' | 'retired'
  evidenceCount: number
  sensitivity: ResearchSensitivity
  revision: number
  decidedByUserId: string | null
  createdAt: Date
}

const LESSON_COLUMNS = `r.id, r.workspace_id AS "workspaceId", r.assistant_id AS "assistantId", r.rule,
  r.research_scope AS scope, r.applies_to_user_id AS "appliesToUserId", r.applies_to_project_id AS "appliesToProjectId",
  r.status, r.evidence_count AS "evidenceCount", r.decision_sensitivity AS sensitivity, r.revision::int AS revision,
  r.decided_by_user_id AS "decidedByUserId", r.created_at AS "createdAt"`

const RANK: Record<ResearchSensitivity, number> = { public: 0, internal: 1, confidential: 2 }

export function researchLessonSemanticKey(scope: ResearchLessonScope, rule: string): string {
  const normalized = rule.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  return createHash('sha256').update(`research\u0000${scope}\u0000${normalized}`).digest('hex')
}

function toEvidence(rows: readonly ResearchEvidenceRow[]): ResearchLessonEvidence[] {
  return rows.map((r) => ({
    feedbackId: r.feedbackId, activityId: r.activityId, outputKey: r.outputKey, actorUserId: r.actorUserId,
    projectId: r.projectId, kind: r.kind, uncertain: r.uncertain, current: r.current, createdAt: new Date(r.createdAt),
  }))
}

export type InsertLessonsResult = { created: number; activated: number; suggested: number; rejected: number; deduped: number }

/**
 * Validate and insert reflection proposals for one workspace. Every check is
 * recomputed here; a proposal citing a stale, uncertain, ineligible or
 * foreign follow-up is rejected whole. Serialized per workspace, so
 * concurrent runs converge on one rule per semantic key.
 */
export async function insertResearchLessons(params: {
  workspaceId: string
  proposals: readonly ResearchLessonProposal[]
  now?: Date
}): Promise<InsertLessonsResult> {
  const now = params.now ?? new Date()
  const result: InsertLessonsResult = { created: 0, activated: 0, suggested: 0, rejected: 0, deduped: 0 }
  return withResearchTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`research-lessons:${params.workspaceId}`])
    for (const raw of params.proposals.slice(0, 2)) {
      const parsed = researchLessonProposalSchema.safeParse(raw)
      if (!parsed.success || isProhibitedResearchLesson(parsed.data.rule)) { result.rejected += 1; continue }
      const proposal = parsed.data
      const since = new Date(now.getTime() - RESEARCH_LESSON_WINDOW_DAYS * 86_400_000)
      const rows = await listResearchEvidenceSystem({ workspaceId: params.workspaceId, since, feedbackIds: proposal.feedbackIds, client })
      const cited = new Set(rows.map((r) => r.feedbackId))
      if (proposal.feedbackIds.some((id) => !cited.has(id))
        || rows.some((r) => !r.current || r.uncertain || !RESEARCH_LESSON_KINDS.includes(r.kind))) {
        result.rejected += 1
        continue
      }
      const actors = [...new Set(rows.map((r) => r.actorUserId))]
      const projects = [...new Set(rows.map((r) => r.projectId))]
      const target = proposal.scope === 'user' ? { actorUserId: actors.length === 1 ? actors[0]! : null }
        : proposal.scope === 'project' ? { projectId: projects.length === 1 ? projects[0] ?? null : null } : {}
      const evidence = toEvidence(rows)
      if (!researchLessonScopeAdmissible(proposal.scope, evidence, target)) { result.rejected += 1; continue }
      const support = evaluateResearchLessonSupport(evidence, now)
      const semanticKey = researchLessonSemanticKey(proposal.scope, proposal.rule)
      const userId = proposal.scope === 'user' ? (target as { actorUserId: string }).actorUserId : null
      const projectId = proposal.scope === 'project' ? (target as { projectId: string }).projectId : null
      const prior = (await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM assistant_playbook_rules
          WHERE applicability_kind = 'research' AND workspace_id = $1 AND research_scope = $2
            AND applies_to_user_id IS NOT DISTINCT FROM $3::uuid AND applies_to_project_id IS NOT DISTINCT FROM $4::uuid
            AND semantic_key = $5 FOR UPDATE`, [params.workspaceId, proposal.scope, userId, projectId, semanticKey])).rows[0]
      // Rejected and retired keys stay suppressed; an existing lesson is
      // reinforced rather than duplicated.
      if (prior && (prior.status === 'rejected' || prior.status === 'retired')) { result.deduped += 1; continue }
      let status = researchLessonStatusFor(proposal.scope, support)
      if (status === 'active') {
        const active = (await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM assistant_playbook_rules
            WHERE applicability_kind = 'research' AND workspace_id = $1 AND research_scope = $2 AND status = 'active'
              AND applies_to_user_id IS NOT DISTINCT FROM $3::uuid AND applies_to_project_id IS NOT DISTINCT FROM $4::uuid
              AND id IS DISTINCT FROM $5::uuid`, [params.workspaceId, proposal.scope, userId, projectId, prior?.id ?? null])).rows[0]!.n
        if (active >= MAX_ACTIVE_RESEARCH_LESSONS_PER_SCOPE) status = 'suggested'
      }
      const sensitivity = rows.reduce<ResearchSensitivity>((s, r) => (RANK[r.sensitivity] > RANK[s] ? r.sensitivity : s), 'public')
      const assistantId = rows[rows.length - 1]!.assistantId
      let ruleId: string
      if (prior) {
        ruleId = prior.id
        await client.query(
          `UPDATE assistant_playbook_rules SET evidence_count = $2, decision_sensitivity = $3, updated_at = now(), revision = revision + 1,
             status = CASE WHEN status = 'suggested' AND $4 = 'active' THEN 'active' ELSE status END,
             decided_at = CASE WHEN status = 'suggested' AND $4 = 'active' THEN now() ELSE decided_at END
           WHERE id = $1`, [ruleId, support.units, sensitivity, status])
        result.deduped += 1
      } else {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO assistant_playbook_rules (assistant_id, rule, rationale, provenance, status, created_by, decided_at,
             applies_to_user_id, applicability_kind, evidence_count, semantic_key, decision_sensitivity,
             workspace_id, research_scope, applies_to_project_id)
           VALUES ($1,$2,NULL,$3::jsonb,$4,'research_reflection',CASE WHEN $4 = 'active' THEN now() END,
             $5,'research',$6,$7,$8,$9,$10,$11)
           ON CONFLICT DO NOTHING RETURNING id`,
          [assistantId, proposal.rule, JSON.stringify({ kind: 'research', feedbackIds: [...cited] }), status,
            userId, support.units, semanticKey, sensitivity, params.workspaceId, proposal.scope, projectId])
        if (!inserted.rows[0]) { result.deduped += 1; continue }
        ruleId = inserted.rows[0].id
        result.created += 1
        if (status === 'active') result.activated += 1
        else result.suggested += 1
      }
      for (const row of rows) {
        if (!row.decisionEventId) continue
        await appendDecisionDerivation({ decisionEventId: row.decisionEventId, artifactKind: 'assistant_playbook_rule', artifactId: ruleId, relation: 'supports' }, client)
      }
    }
    return result
  })
}

/** Current supporting evidence of research lessons, through their provenance edges. */
async function lessonEvidence(client: pg.PoolClient | pg.Pool, ruleIds: readonly string[], now: Date): Promise<Map<string, ResearchLessonEvidence[]>> {
  const since = new Date(now.getTime() - RESEARCH_LESSON_WINDOW_DAYS * 86_400_000)
  const rows = (await client.query<{ ruleId: string; feedbackId: string; activityId: string; outputKey: string; actorUserId: string; projectId: string | null
    kind: ResearchLessonEvidence['kind']; uncertain: boolean; current: boolean; createdAt: Date }>(
    `SELECT dd.artifact_id AS "ruleId", f.id AS "feedbackId", f.activity_id AS "activityId", f.output_key AS "outputKey",
            f.actor_user_id AS "actorUserId", f.project_id AS "projectId", rv.kind, rv.uncertain,
            (m.id IS NOT NULL AND coalesce(m.scope_held, false) = false AND coalesce(m.scope_version, f.message_version) = f.message_version
              AND f.created_at >= $2) AS current,
            f.created_at AS "createdAt"
       FROM decision_derivations dd
       JOIN research_feedback f ON f.decision_event_id = dd.decision_event_id
       JOIN research_feedback_revisions rv ON rv.feedback_id = f.id AND rv.revision = f.current_revision
       LEFT JOIN session_messages m ON m.id = f.message_id
      WHERE dd.artifact_kind = 'assistant_playbook_rule' AND dd.relation = 'supports' AND dd.artifact_id = ANY($1::text[])`,
    [[...ruleIds], since])).rows
  const out = new Map<string, ResearchLessonEvidence[]>()
  for (const r of rows) {
    const list = out.get(r.ruleId) ?? []
    list.push({ ...r, createdAt: new Date(r.createdAt) })
    out.set(r.ruleId, list)
  }
  return out
}

/**
 * Re-check active research lessons against their current support. An
 * automatic personal/Project lesson that no longer qualifies (a corrected
 * label, a deleted or held source, an edited message) drops back to a
 * suggestion; an accepted company method needs at least one current support.
 */
export async function revalidateResearchLessons(workspaceId: string, now: Date = new Date()): Promise<{ demoted: string[] }> {
  return withResearchTransaction(async (client) => {
    const active = (await client.query<{ id: string; scope: ResearchLessonScope }>(
      `SELECT id, research_scope AS scope FROM assistant_playbook_rules
        WHERE applicability_kind = 'research' AND workspace_id = $1 AND status = 'active' FOR UPDATE`, [workspaceId])).rows
    if (active.length === 0) return { demoted: [] }
    const evidence = await lessonEvidence(client, active.map((r) => r.id), now)
    const demoted: string[] = []
    for (const rule of active) {
      const support = evaluateResearchLessonSupport(evidence.get(rule.id) ?? [], now)
      const keep = rule.scope === 'workspace' ? support.units >= 1 : support.qualifies
      if (keep) continue
      await client.query(`UPDATE assistant_playbook_rules SET status = 'suggested', decided_at = NULL, updated_at = now(), revision = revision + 1 WHERE id = $1`, [rule.id])
      demoted.push(rule.id)
    }
    return { demoted }
  })
}

// ── Governance ────────────────────────────────────────────────────────────

export type LessonDecisionActor = {
  userId: string
  /** True only for a direct human action (UI, or Brian acting on the member's explicit attended instruction). */
  human: boolean
  kind: 'user' | 'assistant' | 'credential'
}

export class ResearchLessonError extends Error {
  constructor(readonly code: 'research_not_found' | 'research_forbidden' | 'research_stale', readonly status: number) { super(code) }
}

async function isWorkspaceOwner(client: pg.PoolClient, workspaceId: string, userId: string): Promise<boolean> {
  return (await client.query(`SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 AND role = 'owner'`, [workspaceId, userId])).rows.length > 0
}

async function isProjectOwner(client: pg.PoolClient, projectId: string, userId: string): Promise<boolean> {
  return (await client.query(`SELECT 1 FROM project_shared_owners o WHERE o.project_id = $1 AND o.user_id = $2
    AND public.project_member_live($1, 'user', $2)`, [projectId, userId])).rows.length > 0
}

/** Who may see a lesson's governance card: its member, the Project roster, or workspace members for company methods. */
export async function lessonVisibleTo(client: pg.PoolClient | pg.Pool, lesson: Pick<ResearchLesson, 'workspaceId' | 'scope' | 'appliesToUserId' | 'appliesToProjectId'>, userId: string): Promise<boolean> {
  const member = (await client.query(`SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [lesson.workspaceId, userId])).rows.length > 0
  if (!member) return false
  if (lesson.scope === 'user') return lesson.appliesToUserId === userId
  if (lesson.scope === 'project') {
    return (await client.query('SELECT public.project_member_live($1, $2, $3) AS ok', [lesson.appliesToProjectId, 'user', userId])).rows[0]?.ok === true
  }
  return true
}

/**
 * Approve, reject or retire one research lesson. A personal lesson is decided
 * by its member; a Project lesson by a live Project owner; a company method
 * only by a current workspace owner acting directly - never by an assistant
 * or a credential, so an assistant cannot approve its own proposal.
 */
export async function decideResearchLessonSystem(actor: LessonDecisionActor, workspaceId: string, ruleId: string, input: {
  decision: 'approve' | 'reject' | 'retire'
  expectedVersion: number
  idempotencyKey: string
}): Promise<{ lesson: ResearchLesson; replayed: boolean }> {
  return withResearchTransaction(async (client) => {
    const row = (await client.query<ResearchLesson>(
      `SELECT ${LESSON_COLUMNS} FROM assistant_playbook_rules r
        WHERE r.id = $1 AND r.workspace_id = $2 AND r.applicability_kind = 'research' FOR UPDATE`, [ruleId, workspaceId])).rows[0]
    if (!row || !(await lessonVisibleTo(client, row, actor.userId))) throw new ResearchLessonError('research_not_found', 404)
    const key = `research-lesson:${ruleId}:${input.idempotencyKey}`
    const replay = (await client.query(`SELECT 1 FROM decision_events WHERE idempotency_key = $1`, [key])).rows[0]
    if (replay) return { lesson: row, replayed: true }
    const authorized = actor.kind === 'user' && actor.human && (
      row.scope === 'user' ? row.appliesToUserId === actor.userId
        : row.scope === 'project' ? !!row.appliesToProjectId && await isProjectOwner(client, row.appliesToProjectId, actor.userId)
          : await isWorkspaceOwner(client, workspaceId, actor.userId))
    if (!authorized) throw new ResearchLessonError('research_forbidden', 403)
    if (row.revision !== input.expectedVersion) throw new ResearchLessonError('research_stale', 409)
    const from = input.decision === 'approve' ? ['suggested'] : input.decision === 'reject' ? ['suggested'] : ['active']
    if (!from.includes(row.status)) throw new ResearchLessonError('research_stale', 409)
    if (input.decision === 'approve') {
      const active = (await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM assistant_playbook_rules
          WHERE applicability_kind = 'research' AND workspace_id = $1 AND research_scope = $2 AND status = 'active'
            AND applies_to_user_id IS NOT DISTINCT FROM $3::uuid AND applies_to_project_id IS NOT DISTINCT FROM $4::uuid`,
        [workspaceId, row.scope, row.appliesToUserId, row.appliesToProjectId])).rows[0]!.n
      if (active >= MAX_ACTIVE_RESEARCH_LESSONS_PER_SCOPE) throw new ResearchLessonError('research_stale', 409)
    }
    const status = input.decision === 'approve' ? 'active' : input.decision === 'reject' ? 'rejected' : 'retired'
    const updated = (await client.query<ResearchLesson>(
      `UPDATE assistant_playbook_rules r SET status = $2, decided_by_user_id = $3, decided_at = now(), updated_at = now(), revision = r.revision + 1
        WHERE r.id = $1 RETURNING ${LESSON_COLUMNS}`, [ruleId, status, actor.userId])).rows[0]!
    const { event } = await appendDecisionEvent({
      idempotencyKey: key,
      workspaceId,
      actorUserId: actor.userId,
      assistantId: row.assistantId,
      eventKind: 'playbook.rule_decided',
      sourceKind: 'assistant_playbook_rule',
      sourceId: ruleId,
      declaredScope: row.scope === 'user' ? 'user' : 'workspace',
      visibility: row.scope === 'user' ? 'owner' : 'workspace',
      sensitivity: row.sensitivity,
      payload: { ruleId, decision: input.decision },
    }, client)
    if (input.decision !== 'approve') {
      await appendDecisionDerivation({ decisionEventId: event.id, artifactKind: 'assistant_playbook_rule', artifactId: ruleId, relation: 'invalidates' }, client)
    }
    return { lesson: updated, replayed: false }
  })
}

/** Lessons whose governance the viewer may see, newest first. */
export async function listResearchLessonsForViewer(workspaceId: string, userId: string, filter: { projectId?: string | null } = {}): Promise<ResearchLesson[]> {
  const pool = getPool()
  const rows = (await pool.query<ResearchLesson>(
    `SELECT ${LESSON_COLUMNS} FROM assistant_playbook_rules r
      WHERE r.applicability_kind = 'research' AND r.workspace_id = $1
        AND ($2::uuid IS NULL OR r.applies_to_project_id = $2)
      ORDER BY CASE r.status WHEN 'suggested' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, r.created_at DESC LIMIT 100`,
    [workspaceId, filter.projectId ?? null])).rows
  const visible: ResearchLesson[] = []
  for (const lesson of rows) if (await lessonVisibleTo(pool, lesson, userId)) visible.push(lesson)
  return visible
}

/** The follow-ups a lesson rests on, as ids the viewer can then open through their own access. */
export async function lessonSupportIds(ruleId: string): Promise<string[]> {
  const rows = (await getPool().query<{ id: string }>(
    `SELECT DISTINCT f.id FROM decision_derivations dd JOIN research_feedback f ON f.decision_event_id = dd.decision_event_id
      WHERE dd.artifact_kind = 'assistant_playbook_rule' AND dd.artifact_id = $1 AND dd.relation = 'supports'`, [ruleId])).rows
  return rows.map((r) => r.id)
}

// ── Selection for a research turn ─────────────────────────────────────────

export type ResearchPromptLesson = {
  id: string
  rule: string
  scope: ResearchLessonScope
  sensitivity: ResearchSensitivity
}

/**
 * Active lessons for one research turn: the actor's own lessons (any
 * assistant in the workspace), lessons of the turn's Project when both the
 * actor and the acting assistant are on its live roster, and accepted company
 * methods. An external principal gets none of the personal ones.
 */
export async function listResearchLessonsForTurn(params: {
  workspaceId: string
  actorUserId: string | null
  assistantId: string
  projectId: string | null
  externalPrincipal: boolean
}): Promise<ResearchPromptLesson[]> {
  const rows = (await getPool().query<ResearchPromptLesson & { decidedAt: Date | null }>(
    `SELECT r.id, r.rule, r.research_scope AS scope, r.decision_sensitivity AS sensitivity, r.decided_at AS "decidedAt"
       FROM assistant_playbook_rules r
      WHERE r.applicability_kind = 'research' AND r.workspace_id = $1 AND r.status = 'active'
        AND EXISTS (SELECT 1 FROM assistants a WHERE a.id = $3 AND a.workspace_id = r.workspace_id)
        -- Never apply a lesson whose support is gone: at least one follow-up
        -- still exists on a readable (unheld) source message.
        AND EXISTS (SELECT 1 FROM decision_derivations dd
                      JOIN research_feedback f ON f.decision_event_id = dd.decision_event_id
                      JOIN session_messages m ON m.id = f.message_id AND NOT coalesce(m.scope_held, false)
                     WHERE dd.artifact_kind = 'assistant_playbook_rule' AND dd.artifact_id = r.id::text AND dd.relation = 'supports')
        AND (
          (r.research_scope = 'user' AND NOT $5::boolean AND $2::uuid IS NOT NULL AND r.applies_to_user_id = $2)
          OR (r.research_scope = 'project' AND $4::uuid IS NOT NULL AND r.applies_to_project_id = $4
              AND $2::uuid IS NOT NULL AND NOT $5::boolean
              AND public.project_member_live($4, 'user', $2) AND public.project_member_live($4, 'assistant', $3))
          OR r.research_scope = 'workspace'
        )
      ORDER BY CASE r.research_scope WHEN 'user' THEN 0 WHEN 'project' THEN 1 ELSE 2 END, r.decided_at DESC NULLS LAST`,
    [params.workspaceId, params.actorUserId, params.assistantId, params.projectId, params.externalPrincipal])).rows
  return rows.map(({ decidedAt: _d, ...rest }) => rest)
}

// ── Reflection worker ─────────────────────────────────────────────────────

const MAX_EVIDENCE = 60
const MAX_TEXT = 1000

export const RESEARCH_REFLECTION_SYSTEM_PROMPT = [
  'You turn repeated research follow-up feedback into at most two short, generic research lessons.',
  'A lesson changes how research is done or presented (coverage to include, source checking, format). It never changes goals, budgets, permissions, credentials, connectors, confirmations or releases, and never states a topic fact.',
  'Scope: "user" for one member\'s preference, "project" for a habit specific to one Project, "workspace" only for a genuinely generic method several members asked for.',
  'Cite only feedback ids from the evidence. Output JSON only: {"lessons":[{"rule":"...","scope":"user|project|workspace","feedbackIds":["..."]}]}. Output {"lessons":[]} when nothing repeats.',
].join('\n')

export function parseResearchReflectionOutput(text: string): ResearchLessonProposal[] | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { lessons?: unknown }
    if (!Array.isArray(parsed.lessons)) return null
    const out: ResearchLessonProposal[] = []
    for (const l of parsed.lessons.slice(0, 2)) {
      const p = researchLessonProposalSchema.safeParse(l)
      if (!p.success || isProhibitedResearchLesson(p.data.rule)) return null
      out.push(p.data)
    }
    return out
  } catch {
    return null
  }
}

export type ResearchReflectionEvidence = {
  feedbackId: string
  kind: string
  projectId: string | null
  actor: string
  text: string
}

/** Workspaces with eligible follow-ups newer than the newest one already supporting a lesson. */
export async function listResearchReflectionSubjects(now: Date = new Date()): Promise<string[]> {
  const since = new Date(now.getTime() - RESEARCH_LESSON_WINDOW_DAYS * 86_400_000)
  const rows = (await getPool().query<{ workspaceId: string }>(
    `SELECT f.workspace_id AS "workspaceId"
       FROM research_feedback f
       JOIN research_feedback_revisions r ON r.feedback_id = f.id AND r.revision = f.current_revision
      WHERE f.created_at >= $1 AND NOT r.uncertain AND r.kind = ANY($2::text[])
      GROUP BY f.workspace_id
     HAVING max(f.created_at) > coalesce((
       SELECT max(f2.created_at) FROM research_feedback f2
         JOIN decision_derivations dd ON dd.decision_event_id = f2.decision_event_id AND dd.relation = 'supports'
        WHERE f2.workspace_id = f.workspace_id), '-infinity'::timestamptz)
      LIMIT 100`, [since, [...RESEARCH_LESSON_KINDS]])).rows
  return rows.map((r) => r.workspaceId)
}

/** Bounded evidence for the model: ids, labels and the member's own words only. */
export async function readResearchReflectionEvidence(workspaceId: string, now: Date = new Date()): Promise<ResearchReflectionEvidence[]> {
  const since = new Date(now.getTime() - RESEARCH_LESSON_WINDOW_DAYS * 86_400_000)
  const rows = (await listResearchEvidenceSystem({ workspaceId, since }))
    .filter((r) => r.current && !r.uncertain && RESEARCH_LESSON_KINDS.includes(r.kind))
    .slice(-MAX_EVIDENCE)
  if (rows.length === 0) return []
  const texts = new Map((await getPool().query<{ id: string; content: unknown }>(
    'SELECT id, content FROM session_messages WHERE id = ANY($1::uuid[])', [rows.map((r) => r.messageId)])).rows.map((m) => [m.id, m.content]))
  const { ownFollowupText } = await import('./feedback.js')
  return rows.map((r) => ({
    feedbackId: r.feedbackId, kind: r.kind, projectId: r.projectId, actor: r.actorUserId,
    text: ownFollowupText(texts.get(r.messageId)).slice(0, MAX_TEXT),
  }))
}

export type ResearchReflectionModelCall = (input: { workspaceId: string; system: string; prompt: string }) => Promise<string>

export type ResearchReflectionEvent =
  | { type: 'subject_processed'; workspaceId: string; result: InsertLessonsResult }
  | { type: 'subject_skipped'; workspaceId: string; reason: 'no_evidence' | 'parse_failed' }
  | { type: 'error'; workspaceId?: string; error: unknown }

export function createResearchReflectionWorker(options: {
  modelCall: ResearchReflectionModelCall
  onEvent?: (event: ResearchReflectionEvent) => void
  tickIntervalMs?: number
  firstTickDelayMs?: number
  deps?: Partial<{
    listSubjects: typeof listResearchReflectionSubjects
    readEvidence: typeof readResearchReflectionEvidence
    insertLessons: typeof insertResearchLessons
    revalidate: typeof revalidateResearchLessons
  }>
}) {
  const deps = {
    listSubjects: options.deps?.listSubjects ?? listResearchReflectionSubjects,
    readEvidence: options.deps?.readEvidence ?? readResearchReflectionEvidence,
    insertLessons: options.deps?.insertLessons ?? insertResearchLessons,
    revalidate: options.deps?.revalidate ?? revalidateResearchLessons,
  }
  let running = false
  let interval: ReturnType<typeof setInterval> | null = null
  let first: ReturnType<typeof setTimeout> | null = null

  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      for (const workspaceId of await deps.listSubjects()) {
        try {
          await deps.revalidate(workspaceId)
          const evidence = await deps.readEvidence(workspaceId)
          if (evidence.length === 0) { options.onEvent?.({ type: 'subject_skipped', workspaceId, reason: 'no_evidence' }); continue }
          const text = await options.modelCall({ workspaceId, system: RESEARCH_REFLECTION_SYSTEM_PROMPT, prompt: JSON.stringify({ evidence }) })
          const proposals = parseResearchReflectionOutput(text)
          if (!proposals) { options.onEvent?.({ type: 'subject_skipped', workspaceId, reason: 'parse_failed' }); continue }
          const result = await deps.insertLessons({ workspaceId, proposals })
          options.onEvent?.({ type: 'subject_processed', workspaceId, result })
        } catch (error) {
          options.onEvent?.({ type: 'error', workspaceId, error })
        }
      }
    } catch (error) {
      options.onEvent?.({ type: 'error', error })
    } finally {
      running = false
    }
  }

  return {
    tick,
    start() {
      first = setTimeout(() => void tick(), options.firstTickDelayMs ?? 60_000)
      first.unref?.()
      interval = setInterval(() => void tick(), options.tickIntervalMs ?? 24 * 3_600_000)
      interval.unref?.()
    },
    stop() {
      if (first) clearTimeout(first)
      if (interval) clearInterval(interval)
    },
  }
}
