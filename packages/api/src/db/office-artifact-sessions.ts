/**
 * One shared Brian conversation per Office file (migration 739).
 *
 * The link row is the source of truth for "which session is this file's
 * thread": session uniqueness alone is per (assistant, user, channel), so a
 * per-user `findOrCreateSession` would give every sender a private thread.
 * Every function here is system-side; callers gate first (the Office routes
 * through `resolveOfficeAccess`, session reads through `gateSessionRead`).
 *
 * Spec: docs/architecture/features/office.md -> "Brian conversation in the file".
 * [COMP:api/office-chat-session]
 */
import { admitAnchoredSession } from '../workspace-access/session-create-admission.js'
import { randomUUID } from 'node:crypto'
import { getPool, query } from './client.js'

export const OFFICE_THREAD_CHANNEL_TYPE = 'office_thread'

export type OfficeArtifactSessionLink = { artifactId: string; workspaceId: string; sessionId: string }

/** The file's thread, if one was ever started. */
export async function findOfficeArtifactSessionSystem(artifactId: string): Promise<OfficeArtifactSessionLink | null> {
  const result = await query<OfficeArtifactSessionLink>(
    `SELECT artifact_id AS "artifactId", workspace_id AS "workspaceId", session_id AS "sessionId"
       FROM office_artifact_sessions WHERE artifact_id = $1`,
    [artifactId],
  )
  return result.rows[0] ?? null
}

/** Which file a thread belongs to. `null` means it is not an Office thread. */
export async function findOfficeArtifactForSessionSystem(sessionId: string): Promise<OfficeArtifactSessionLink | null> {
  const result = await query<OfficeArtifactSessionLink>(
    `SELECT artifact_id AS "artifactId", workspace_id AS "workspaceId", session_id AS "sessionId"
       FROM office_artifact_sessions WHERE session_id = $1`,
    [sessionId],
  )
  return result.rows[0] ?? null
}

/**
 * Get or lazily create the file's thread. Serialized on the artifact row, so
 * concurrent first sends converge on one session. The session is
 * `visibility='workspace'` with `effective_clearance` = the file's sensitivity;
 * its read gate is the Office access predicate, not workspace membership.
 */
export async function ensureOfficeArtifactSessionSystem(params: {
  artifactId: string
  assistantId: string
  userId: string
}): Promise<OfficeArtifactSessionLink> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const root = await client.query<{ workspaceId: string; sensitivity: string }>(
      `SELECT workspace_id AS "workspaceId", sensitivity FROM office_artifacts
        WHERE id = $1 AND lifecycle_state <> 'purged' FOR UPDATE`,
      [params.artifactId],
    )
    const artifact = root.rows[0]
    if (!artifact) throw new Error('office_artifact_not_found')
    const existing = await client.query<OfficeArtifactSessionLink>(
      `SELECT artifact_id AS "artifactId", workspace_id AS "workspaceId", session_id AS "sessionId"
         FROM office_artifact_sessions WHERE artifact_id = $1`,
      [params.artifactId],
    )
    if (existing.rows[0]) {
      await client.query('COMMIT')
      return existing.rows[0]
    }
    // The file anchors the thread: admitted by the anchor (L12), read by the
    // file's audience, its clearance is the file's sensitivity (D10).
    const channelId = randomUUID()
    await admitAnchoredSession(client, {
      assistantId: params.assistantId, userId: params.userId, channelType: 'web', channelId,
      workspaceId: artifact.workspaceId, effectiveClearance: artifact.sensitivity,
      anchorKind: 'office_file', anchorRef: params.artifactId,
    })
    const session = await client.query<{ id: string }>(
      `INSERT INTO sessions (assistant_id, user_id, channel_type, channel_id, app_id,
                             visibility, workspace_id, effective_clearance,
                             anchor_kind, anchor_ref, clearance_source)
       VALUES ($1, $2, 'web', $3, 'Use Brian', 'workspace', $4, $5, 'office_file', $6, 'anchor')
       RETURNING id`,
      [params.assistantId, params.userId, channelId, artifact.workspaceId, artifact.sensitivity, params.artifactId],
    )
    const sessionId = session.rows[0]!.id
    await client.query(
      `INSERT INTO office_artifact_sessions (artifact_id, session_id, workspace_id) VALUES ($1, $2, $3)`,
      [params.artifactId, sessionId, artifact.workspaceId],
    )
    await client.query('COMMIT')
    return { artifactId: params.artifactId, workspaceId: artifact.workspaceId, sessionId }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

/** The root's labels for the lane ceiling. System-side: callers pass `resolveOfficeAccess` first. */
export async function readOfficeLaneArtifactSystem(artifactId: string): Promise<{
  id: string; workspaceId: string; family: string; title: string; headVersion: number; lifecycleState: string
  sensitivity: 'public' | 'internal' | 'confidential'; compartments: string[]; projectIds: string[]
} | null> {
  const result = await query<{
    id: string; workspaceId: string; family: string; title: string; headVersion: number; lifecycleState: string
    sensitivity: 'public' | 'internal' | 'confidential'; compartments: string[]; projectIds: string[]
  }>(
    `SELECT id, workspace_id AS "workspaceId", family, title, head_version::int AS "headVersion",
            lifecycle_state AS "lifecycleState", sensitivity, compartments, project_ids AS "projectIds"
       FROM office_artifacts WHERE id = $1`,
    [artifactId],
  )
  return result.rows[0] ?? null
}

/** The file's latest job, for the lane's generation guard and context line. */
export async function latestOfficeJobSystem(artifactId: string): Promise<{ id: string; jobKind: string; status: string } | null> {
  const result = await query<{ id: string; jobKind: string; status: string }>(
    `SELECT id, job_kind AS "jobKind", status FROM office_generation_jobs
      WHERE artifact_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [artifactId],
  )
  return result.rows[0] ?? null
}
