/**
 * Research activity, artifact link and follow-up persistence
 * (docs/architecture/features/research.md, migration 756).
 *
 * Two lanes, never mixed:
 * - `*System` writes run on the owner pool inside one transaction, and the
 *   follow-up journal event is appended in that same transaction.
 * - `*ForViewer` reads run as the app role under the viewer's RLS, so every
 *   list/detail/count sees exactly what the viewer may see now (originating
 *   session audience, live Project membership, readable artifact, readable
 *   source message, Department floors).
 *
 * [COMP:api/research-source-authority]
 */
import type pg from 'pg'
import {
  researchSourceRefSchema,
  type ResearchActivityStatus,
  type ResearchArtifactKind,
  type ResearchArtifactRelation,
  type ResearchEntry,
  type ResearchFeedbackKind,
  type ResearchFeedbackOrigin,
  type ResearchSourceRef,
} from '@use-brian/core'
import { applyRLSGucs, getAppPool, getPool, rollbackAndRelease } from './client.js'
import { appendDecisionEvent } from './decision-event-store.js'
import { classifySession, sessionPolicy, type SessionKindRow } from '../session-kind.js'

export type ResearchSensitivity = 'public' | 'internal' | 'confidential'

export type ResearchActivity = {
  id: string
  workspaceId: string
  sessionId: string
  requestMessageId: string | null
  outputMessageId: string | null
  actorUserId: string
  assistantId: string
  projectId: string | null
  taskId: string | null
  predecessorActivityId: string | null
  entry: ResearchEntry
  status: ResearchActivityStatus
  plannedPageId: string | null
  runtime: Record<string, unknown>
  sources: ResearchSourceRef[]
  gaps: string[]
  findingsCount: number
  summary: string | null
  saveError: string | null
  sensitivity: ResearchSensitivity
  compartments: string[]
  revision: number
  createdAt: Date
  completedAt: Date | null
}

export type ResearchArtifactLink = {
  id: string
  activityId: string
  kind: ResearchArtifactKind
  artifactId: string
  version: number | null
  relation: ResearchArtifactRelation
  toolName: string
  verifiedAt: Date
}

export type ResearchFeedbackRevision = {
  revision: number
  kind: ResearchFeedbackKind
  uncertain: boolean
  origin: ResearchFeedbackOrigin
  stance: 'interpretation' | 'disagreement'
  interpreter: string | null
  actorUserId: string | null
  note: string | null
  createdAt: Date
}

export type ResearchFeedback = {
  id: string
  workspaceId: string
  activityId: string
  messageId: string
  messageVersion: number
  actorUserId: string
  outputKey: string
  association: 'explicit_selection' | 'explicit_reply' | 'same_chat_continuation'
  projectId: string | null
  /** Revision number of the current interpretation. */
  currentRevision: number
  /** Latest revision number of any stance; the optimistic-concurrency version. */
  version: number
  kind: ResearchFeedbackKind
  uncertain: boolean
  origin: ResearchFeedbackOrigin
  decisionEventId: string | null
  createdAt: Date
}

const ACTIVITY_COLUMNS = `a.id, a.workspace_id AS "workspaceId", a.session_id AS "sessionId",
  a.request_message_id AS "requestMessageId", a.output_message_id AS "outputMessageId",
  a.actor_user_id AS "actorUserId", a.assistant_id AS "assistantId", a.project_id AS "projectId",
  a.task_id AS "taskId", a.predecessor_activity_id AS "predecessorActivityId", a.entry, a.status,
  a.planned_page_id AS "plannedPageId", a.runtime, a.sources, a.gaps, a.findings_count AS "findingsCount",
  a.summary, a.save_error AS "saveError", a.sensitivity, a.compartments, a.revision::int AS revision,
  a.created_at AS "createdAt", a.completed_at AS "completedAt"`

const LINK_COLUMNS = `l.id, l.activity_id AS "activityId", l.kind, l.artifact_id AS "artifactId", l.version,
  l.relation, l.tool_name AS "toolName", l.verified_at AS "verifiedAt"`

const FEEDBACK_COLUMNS = `f.id, f.workspace_id AS "workspaceId", f.activity_id AS "activityId", f.message_id AS "messageId",
  f.message_version::int AS "messageVersion", f.actor_user_id AS "actorUserId", f.output_key AS "outputKey",
  f.association, f.project_id AS "projectId", f.current_revision AS "currentRevision",
  (SELECT max(r2.revision) FROM research_feedback_revisions r2 WHERE r2.feedback_id = f.id)::int AS version,
  r.kind, r.uncertain, r.origin, f.decision_event_id AS "decisionEventId", f.created_at AS "createdAt"`

function parseSources(value: unknown): ResearchSourceRef[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((s) => {
    const parsed = researchSourceRefSchema.safeParse(s)
    return parsed.success ? [parsed.data] : []
  })
}

function toActivity(row: Record<string, unknown>): ResearchActivity {
  return {
    ...(row as unknown as ResearchActivity),
    sources: parseSources(row.sources),
    gaps: Array.isArray(row.gaps) ? (row.gaps as unknown[]).filter((g): g is string => typeof g === 'string') : [],
    runtime: (row.runtime && typeof row.runtime === 'object' ? row.runtime : {}) as Record<string, unknown>,
  }
}

/** Run as the viewer under RLS in one read transaction. */
async function asViewer<T>(userId: string, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client, userId)
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } finally {
    await rollbackAndRelease(client)
  }
}

/** Owner-pool transaction for a domain write plus its journal append. */
export async function withResearchTransaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

// ── Activity writes ───────────────────────────────────────────────────────

export type OpenResearchActivityInput = {
  workspaceId: string
  sessionId: string
  requestMessageId: string | null
  requestMessageVersion: number | null
  actorUserId: string
  assistantId: string
  projectId: string | null
  taskId?: string | null
  predecessorActivityId?: string | null
  entry: ResearchEntry
  idempotencyKey: string
  plannedPageId: string | null
  runtime: Record<string, unknown>
  sensitivity: ResearchSensitivity
  compartments: string[]
}

/** Create or reuse the activity for one research invocation. */
export async function openResearchActivitySystem(input: OpenResearchActivityInput): Promise<{ activity: ResearchActivity; created: boolean }> {
  const pool = getPool()
  const inserted = await pool.query(
    `INSERT INTO research_activities AS a (workspace_id, session_id, request_message_id, request_message_version, actor_user_id,
       assistant_id, project_id, task_id, predecessor_activity_id, entry, idempotency_key, planned_page_id, runtime, sensitivity, compartments)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)
     ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
     RETURNING ${ACTIVITY_COLUMNS}`,
    [input.workspaceId, input.sessionId, input.requestMessageId, input.requestMessageVersion, input.actorUserId,
      input.assistantId, input.projectId, input.taskId ?? null, input.predecessorActivityId ?? null, input.entry,
      input.idempotencyKey, input.plannedPageId, JSON.stringify(input.runtime), input.sensitivity, input.compartments],
  )
  if (inserted.rows[0]) return { activity: toActivity(inserted.rows[0]), created: true }
  const existing = await pool.query(
    `SELECT ${ACTIVITY_COLUMNS} FROM research_activities a WHERE a.workspace_id = $1 AND a.idempotency_key = $2`,
    [input.workspaceId, input.idempotencyKey],
  )
  if (!existing.rows[0]) throw new Error('research activity replay missing')
  return { activity: toActivity(existing.rows[0]), created: false }
}

export type SettleResearchActivityInput = {
  activityId: string
  workspaceId: string
  status: Exclude<ResearchActivityStatus, 'running'>
  outputMessageId: string | null
  sources: ResearchSourceRef[]
  gaps: string[]
  findingsCount: number
  summary: string | null
  saveError: string | null
  links: Array<{
    kind: ResearchArtifactKind
    artifactId: string
    version: number | null
    relation: ResearchArtifactRelation
    toolName: string
    toolUseId: string
  }>
}

/**
 * Record verified links and settle the activity in one transaction. Links are
 * written only by callers that already re-read the artifact; a settled
 * activity is never reopened, and re-settling an already-saved activity only
 * adds links (a retried delivery converges).
 */
export async function settleResearchActivitySystem(input: SettleResearchActivityInput): Promise<ResearchActivity> {
  return withResearchTransaction(async (client) => {
    const locked = await client.query(`SELECT status FROM research_activities WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
      [input.activityId, input.workspaceId])
    if (!locked.rows[0]) throw new Error('research activity missing')
    for (const link of input.links) {
      await client.query(
        `INSERT INTO research_artifact_links (workspace_id, activity_id, kind, artifact_id, version, relation, tool_name, tool_use_id, verified_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()) ON CONFLICT DO NOTHING`,
        [input.workspaceId, input.activityId, link.kind, link.artifactId, link.version, link.relation, link.toolName, link.toolUseId],
      )
    }
    const prior = locked.rows[0].status as ResearchActivityStatus
    // Saved never regresses: a later partial/failed settle cannot unsave.
    const status = prior === 'saved' ? 'saved' : input.status
    const updated = await client.query(
      `UPDATE research_activities a SET status = $3, output_message_id = coalesce($4, a.output_message_id),
         sources = $5::jsonb, gaps = $6::jsonb, findings_count = $7, summary = $8,
         save_error = CASE WHEN $3 = 'saved' THEN NULL ELSE $9 END,
         completed_at = coalesce(a.completed_at, now()), updated_at = now(), revision = a.revision + 1
       WHERE a.id = $1 AND a.workspace_id = $2
       RETURNING ${ACTIVITY_COLUMNS}`,
      [input.activityId, input.workspaceId, status, input.outputMessageId,
        JSON.stringify(input.sources.slice(0, 50)), JSON.stringify(input.gaps.slice(0, 20).map((g) => g.slice(0, 300))),
        input.findingsCount, input.summary?.slice(0, 1000) ?? null, input.saveError?.slice(0, 200) ?? null],
    )
    return toActivity(updated.rows[0])
  })
}

// ── Follow-up writes ──────────────────────────────────────────────────────

export type RecordResearchFeedbackInput = {
  workspaceId: string
  activityId: string
  sessionId: string
  assistantId: string
  messageId: string
  messageVersion: number
  actorUserId: string
  outputKey: string
  association: ResearchFeedback['association']
  kind: ResearchFeedbackKind
  uncertain: boolean
  interpreter: string
  projectId: string | null
  sensitivity: ResearchSensitivity
  compartments: string[]
}

/**
 * Record one direct-member follow-up and its journal event atomically.
 * Idempotent on the canonical message: a replay returns the existing row and
 * appends nothing.
 */
export async function recordResearchFeedbackSystem(input: RecordResearchFeedbackInput): Promise<{ feedback: ResearchFeedback; inserted: boolean }> {
  return withResearchTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO research_feedback (workspace_id, activity_id, message_id, message_version, actor_user_id, output_key,
         association, project_id, sensitivity, compartments)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (message_id) DO NOTHING RETURNING id`,
      [input.workspaceId, input.activityId, input.messageId, input.messageVersion, input.actorUserId, input.outputKey,
        input.association, input.projectId, input.sensitivity, input.compartments],
    )
    const id = inserted.rows[0]?.id
    if (id) {
      await client.query(
        `INSERT INTO research_feedback_revisions (feedback_id, workspace_id, revision, kind, uncertain, origin, stance, interpreter)
         VALUES ($1,$2,1,$3,$4,'machine','interpretation',$5)`,
        [id, input.workspaceId, input.kind, input.uncertain, input.interpreter],
      )
      const { event } = await appendDecisionEvent({
        idempotencyKey: `research-followup:${input.messageId}`,
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        assistantId: input.assistantId,
        sessionId: input.sessionId,
        eventKind: 'research.followup_recorded',
        sourceKind: 'session_message',
        sourceId: input.messageId,
        declaredScope: 'user',
        visibility: 'owner',
        sensitivity: input.sensitivity,
        payload: { feedbackId: id, activityId: input.activityId, messageId: input.messageId, outputKey: input.outputKey, association: input.association },
      }, client)
      await client.query('UPDATE research_feedback SET decision_event_id = $2 WHERE id = $1', [id, event.id])
    }
    const row = await client.query(
      `SELECT ${FEEDBACK_COLUMNS} FROM research_feedback f
         JOIN research_feedback_revisions r ON r.feedback_id = f.id AND r.revision = f.current_revision
       WHERE f.message_id = $1`, [input.messageId])
    return { feedback: row.rows[0] as ResearchFeedback, inserted: !!id }
  })
}

export class ResearchStaleError extends Error {
  constructor() { super('research_stale') }
}

/**
 * Append one human revision. `interpretation` replaces the current label (the
 * service admits only the original actor); `disagreement` records another
 * participant's counter-evidence without changing it. Optimistic on the
 * latest revision; idempotent on `(feedback, idempotencyKey)`.
 */
export async function appendResearchFeedbackRevisionSystem(input: {
  feedbackId: string
  workspaceId: string
  expectedVersion: number
  stance: 'interpretation' | 'disagreement'
  kind: ResearchFeedbackKind
  note: string | null
  actorUserId: string
  idempotencyKey: string
  assistantId: string | null
  sessionId: string | null
  sensitivity: ResearchSensitivity
}): Promise<{ revision: number; replayed: boolean }> {
  return withResearchTransaction(async (client) => {
    const replay = await client.query<{ revision: number }>(
      `SELECT revision FROM research_feedback_revisions WHERE feedback_id = $1 AND idempotency_key = $2`,
      [input.feedbackId, input.idempotencyKey])
    if (replay.rows[0]) return { revision: replay.rows[0].revision, replayed: true }
    const locked = await client.query(`SELECT id FROM research_feedback WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
      [input.feedbackId, input.workspaceId])
    if (!locked.rows[0]) throw new ResearchStaleError()
    const latest = (await client.query<{ v: number }>(
      `SELECT max(revision)::int AS v FROM research_feedback_revisions WHERE feedback_id = $1`, [input.feedbackId])).rows[0]!.v
    if (latest !== input.expectedVersion) throw new ResearchStaleError()
    const revision = latest + 1
    await client.query(
      `INSERT INTO research_feedback_revisions (feedback_id, workspace_id, revision, kind, uncertain, origin, stance, actor_user_id, note, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,'human',$6,$7,$8,$9)`,
      [input.feedbackId, input.workspaceId, revision, input.kind, input.kind === 'uncertain', input.stance,
        input.actorUserId, input.note, input.idempotencyKey])
    if (input.stance === 'interpretation') {
      await client.query('UPDATE research_feedback SET current_revision = $2, updated_at = now() WHERE id = $1', [input.feedbackId, revision])
    }
    await appendDecisionEvent({
      idempotencyKey: `research-feedback:${input.feedbackId}:${revision}`,
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      assistantId: input.assistantId,
      sessionId: input.sessionId,
      eventKind: 'research.feedback_corrected',
      sourceKind: 'research_feedback',
      sourceId: input.feedbackId,
      declaredScope: 'user',
      visibility: 'owner',
      sensitivity: input.sensitivity,
      payload: { feedbackId: input.feedbackId, revision, stance: input.stance },
    }, client)
    return { revision, replayed: false }
  })
}

// ── Viewer reads ──────────────────────────────────────────────────────────

export async function listResearchActivitiesForViewer(userId: string, workspaceId: string, filter: {
  sessionId?: string | null
  projectId?: string | null
  limit?: number
} = {}): Promise<ResearchActivity[]> {
  const limit = Math.max(1, Math.min(filter.limit ?? 25, 100))
  return asViewer(userId, async (client) => {
    const r = await client.query(
      `SELECT ${ACTIVITY_COLUMNS} FROM research_activities a
        WHERE a.workspace_id = $1
          AND ($2::uuid IS NULL OR a.session_id = $2)
          AND ($3::uuid IS NULL OR a.project_id = $3)
        ORDER BY a.created_at DESC LIMIT $4`,
      [workspaceId, filter.sessionId ?? null, filter.projectId ?? null, limit])
    return r.rows.map(toActivity)
  })
}

export async function countResearchActivitiesForViewer(userId: string, workspaceId: string): Promise<number> {
  return asViewer(userId, async (client) =>
    (await client.query<{ n: number }>('SELECT count(*)::int AS n FROM research_activities WHERE workspace_id = $1', [workspaceId])).rows[0]!.n)
}

export type ResearchActivityDetail = {
  activity: ResearchActivity
  artifacts: ResearchArtifactLink[]
  feedback: Array<ResearchFeedback & { revisions: ResearchFeedbackRevision[] }>
}

export async function getResearchActivityForViewer(userId: string, workspaceId: string, activityId: string): Promise<ResearchActivityDetail | null> {
  return asViewer(userId, async (client) => {
    const a = await client.query(`SELECT ${ACTIVITY_COLUMNS} FROM research_activities a WHERE a.id = $1 AND a.workspace_id = $2`,
      [activityId, workspaceId])
    if (!a.rows[0]) return null
    const links = await client.query<ResearchArtifactLink>(
      `SELECT ${LINK_COLUMNS} FROM research_artifact_links l WHERE l.activity_id = $1 ORDER BY l.created_at`, [activityId])
    const feedback = await client.query<ResearchFeedback>(
      `SELECT ${FEEDBACK_COLUMNS} FROM research_feedback f
         JOIN research_feedback_revisions r ON r.feedback_id = f.id AND r.revision = f.current_revision
        WHERE f.activity_id = $1 ORDER BY f.created_at`, [activityId])
    const ids = feedback.rows.map((f) => f.id)
    const revisions = ids.length ? await client.query<ResearchFeedbackRevision & { feedbackId: string }>(
      `SELECT feedback_id AS "feedbackId", revision, kind, uncertain, origin, stance, interpreter,
              actor_user_id AS "actorUserId", note, created_at AS "createdAt"
         FROM research_feedback_revisions WHERE feedback_id = ANY($1::uuid[]) ORDER BY revision`, [ids]) : { rows: [] }
    return {
      activity: toActivity(a.rows[0]),
      artifacts: links.rows,
      feedback: feedback.rows.map((f) => ({
        ...f,
        revisions: revisions.rows.filter((r) => r.feedbackId === f.id).map(({ feedbackId: _f, ...rest }) => rest),
      })),
    }
  })
}

export async function getResearchFeedbackForViewer(userId: string, workspaceId: string, feedbackId: string): Promise<ResearchFeedback | null> {
  return asViewer(userId, async (client) => {
    const r = await client.query<ResearchFeedback>(
      `SELECT ${FEEDBACK_COLUMNS} FROM research_feedback f
         JOIN research_feedback_revisions r ON r.feedback_id = f.id AND r.revision = f.current_revision
        WHERE f.id = $1 AND f.workspace_id = $2`, [feedbackId, workspaceId])
    return r.rows[0] ?? null
  })
}

/** Is this artifact (as kind/id) readable to the viewer right now? Used to inspect a write receipt. */
export async function artifactReadableForViewer(userId: string, kind: ResearchArtifactKind, artifactId: string): Promise<{ readable: boolean; version: number | null }> {
  return asViewer(userId, async (client) => {
    if (kind === 'page') {
      const r = await client.query<{ version: number | null }>(
        `SELECT coalesce((SELECT d.seq::int FROM documents d WHERE d.page_id = v.id), v.version)::int AS version
           FROM saved_views v WHERE v.id = $1`, [artifactId])
      return { readable: !!r.rows[0], version: r.rows[0]?.version ?? null }
    }
    if (kind === 'file') {
      const r = await client.query('SELECT 1 FROM workspace_files WHERE id = $1', [artifactId])
      return { readable: !!r.rows[0], version: null }
    }
    const r = await client.query<{ version: number | null }>('SELECT version FROM office_artifacts WHERE id = $1', [artifactId])
    return { readable: !!r.rows[0], version: r.rows[0]?.version ?? null }
  })
}

// ── Learning evidence (system read, recomputed on every use) ─────────────

export type ResearchEvidenceRow = {
  feedbackId: string
  activityId: string
  outputKey: string
  actorUserId: string
  projectId: string | null
  assistantId: string
  sessionId: string
  messageId: string
  decisionEventId: string | null
  kind: ResearchFeedbackKind
  uncertain: boolean
  current: boolean
  createdAt: Date
  sensitivity: ResearchSensitivity
}

/**
 * Follow-up evidence for one workspace in the window, with `current` computed
 * from canonical state: the source message still exists, is not held, and is
 * still at the version the follow-up was recorded against.
 */
export async function listResearchEvidenceSystem(params: {
  workspaceId: string
  since: Date
  actorUserId?: string | null
  feedbackIds?: readonly string[] | null
  client?: pg.PoolClient
}): Promise<ResearchEvidenceRow[]> {
  const exec = params.client ?? getPool()
  const r = await exec.query<ResearchEvidenceRow>(
    `SELECT f.id AS "feedbackId", f.activity_id AS "activityId", f.output_key AS "outputKey", f.actor_user_id AS "actorUserId",
            f.project_id AS "projectId", a.assistant_id AS "assistantId", a.session_id AS "sessionId", f.message_id AS "messageId",
            f.decision_event_id AS "decisionEventId", r.kind, r.uncertain,
            (m.id IS NOT NULL AND coalesce(m.scope_held, false) = false AND coalesce(m.scope_version, f.message_version) = f.message_version
              AND EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = f.workspace_id AND wm.user_id = f.actor_user_id)) AS current,
            f.created_at AS "createdAt", f.sensitivity
       FROM research_feedback f
       JOIN research_activities a ON a.id = f.activity_id
       JOIN research_feedback_revisions r ON r.feedback_id = f.id AND r.revision = f.current_revision
       LEFT JOIN session_messages m ON m.id = f.message_id
      WHERE f.workspace_id = $1 AND f.created_at >= $2
        AND ($3::uuid IS NULL OR f.actor_user_id = $3)
        AND ($4::uuid[] IS NULL OR f.id = ANY($4::uuid[]))
      ORDER BY f.created_at`,
    [params.workspaceId, params.since, params.actorUserId ?? null, params.feedbackIds ? [...params.feedbackIds] : null])
  return r.rows
}

// ── Canonical message reads for follow-up capture ─────────────────────────

export type ResearchMessageRow = {
  id: string
  sessionId: string
  role: string
  content: unknown
  senderUserId: string | null
  version: number
  sensitivity: ResearchSensitivity | null
  compartments: string[] | null
}

// A message's human author: the stamped sender, or - where the session kind
// does not stamp senders (a personal chat has one human) - the session owner.
// The kind is answered by session-kind.ts, never re-derived here.
const MESSAGE_COLUMNS = `m.id, m.session_id AS "sessionId", m.role, m.content, m.sender_user_id AS "stampedSender",
  s.user_id AS "sessionOwner", s.visibility, s.mode, s.channel_type AS "channelType", s.channel_id AS "channelId",
  s.anchor_kind AS "anchorKind", s.anchor_ref AS "anchorRef", s.app_origin AS "appOrigin",
  coalesce(m.scope_version, 1)::int AS version, m.sensitivity, m.compartments`

type RawMessageRow = Omit<ResearchMessageRow, 'senderUserId'> & SessionKindRow & { stampedSender: string | null; sessionOwner: string | null }

function toMessageRow(row: RawMessageRow): ResearchMessageRow {
  const attributes = sessionPolicy(classifySession(row)).attribution
  return {
    id: row.id, sessionId: row.sessionId, role: row.role, content: row.content,
    senderUserId: row.stampedSender ?? (attributes ? null : row.sessionOwner),
    version: row.version, sensitivity: row.sensitivity, compartments: row.compartments,
  }
}

/** One persisted message, excluding held ones (a held source is not current evidence). */
export async function getResearchMessageSystem(messageId: string): Promise<ResearchMessageRow | null> {
  const r = await getPool().query<RawMessageRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM session_messages m JOIN sessions s ON s.id = m.session_id
      WHERE m.id = $1 AND coalesce(m.scope_held, false) = false`, [messageId])
  return r.rows[0] ? toMessageRow(r.rows[0]) : null
}

/** Member messages after a delivered output message in the same session, oldest first. */
export async function listResearchMessagesAfterSystem(sessionId: string, afterMessageId: string, limit: number): Promise<ResearchMessageRow[]> {
  const r = await getPool().query<RawMessageRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM session_messages m JOIN sessions s ON s.id = m.session_id
      WHERE m.session_id = $1 AND m.role = 'user'
        AND coalesce(m.scope_held, false) = false
        AND m.sequence_num > (SELECT o.sequence_num FROM session_messages o WHERE o.id = $2 AND o.session_id = $1)
      ORDER BY m.sequence_num LIMIT $3`, [sessionId, afterMessageId, Math.max(1, Math.min(limit, 50))])
  return r.rows.map(toMessageRow)
}

/** The persisted message a channel-native reply points at, in this session. */
export async function findSessionMessageByChannelIdSystem(sessionId: string, channelMessageId: string): Promise<string | null> {
  const r = await getPool().query<{ id: string }>(
    `SELECT id FROM session_messages WHERE session_id = $1 AND channel_message_id = $2 ORDER BY sequence_num DESC LIMIT 1`,
    [sessionId, channelMessageId])
  return r.rows[0]?.id ?? null
}
