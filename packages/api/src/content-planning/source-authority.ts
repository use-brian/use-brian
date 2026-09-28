/** Exact selected-resource projection for a workspace draft. [COMP:feed/source-authority] */
import { maxSensitivity, type Sensitivity } from '@use-brian/core'
import { walkFeed } from '@use-brian/doc-model'
import { feedLinkedInFileIds, type FeedLinkedInContext, type FeedComposition } from '@use-brian/shared'
import type { FeedActor, FeedReader, FeedScope } from '../db/feed-collaboration-store.js'

export function feedSelectedFiles(composition: FeedComposition, linkedin?: FeedLinkedInContext): Map<string, string | null> {
  const ids = new Map<string, string | null>()
  for (const { node } of walkFeed(composition)) {
    if (node.type === 'image') ids.set(node.attrs.fileId, node.attrs.mimeType)
    if (node.type === 'generationPlaceholder') {
      if (node.attrs.baseImageFileId && !ids.has(node.attrs.baseImageFileId)) ids.set(node.attrs.baseImageFileId, null)
      for (const ref of node.attrs.references) if ('fileId' in ref && !ids.has(ref.fileId)) ids.set(ref.fileId, null)
    }
  }
  for (const id of feedLinkedInFileIds(linkedin)) if (!ids.has(id)) ids.set(id, null)
  return ids
}
export type FeedSelectedSource = { id: string; sensitivity: Sensitivity; compartments?: string[]; projectIds?: string[]; name?: string; mime?: string; summary?: string; detail?: string | null; metadata?: Record<string, unknown> }
/**
 * This exception is resource-specific, like API client self-memory. It never
 * changes AccessContext or the assistant's ambient memory/tool clearance.
 * The entire workspace can currently view a draft, so every member must pass.
 */
export async function readFeedSelectedSources(client: FeedReader, actor: FeedActor, scope: FeedScope, kind: 'file' | 'memory', ids: readonly string[] | null): Promise<FeedSelectedSource[]> {
  if (ids && !ids.length) return []
  const table = kind === 'file' ? 'workspace_files' : 'memories'
  const columns = kind === 'file' ? 'r.mime,r.metadata,COALESCE(r.title,r.name) AS name' : 'r.summary,r.detail,r.summary AS name'
  return (await client.query<FeedSelectedSource>(`SELECT r.id,r.sensitivity,r.compartments,r.project_ids AS "projectIds",${columns} FROM ${table} r
    WHERE r.workspace_id=$1 AND ($2::uuid[] IS NULL OR r.id=ANY($2::uuid[])) AND r.valid_to IS NULL AND r.retracted_at IS NULL
      AND (r.assistant_id IS NULL OR r.assistant_id=$3)
      AND EXISTS(SELECT 1 FROM sessions s WHERE s.id=$5 AND (s.context_project_id IS NULL OR r.project_ids <@ ARRAY[s.context_project_id]))
      AND NOT EXISTS(SELECT 1 FROM unnest(r.compartments) c WHERE c LIKE 'client:%')
      AND EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$4)
      AND NOT EXISTS(SELECT 1 FROM workspace_members v WHERE v.workspace_id=r.workspace_id AND (
        (r.user_id IS NOT NULL AND r.user_id<>v.user_id)
        OR sensitivity_rank(r.sensitivity)>sensitivity_rank(v.clearance)
        OR (effective_member_team_compartments(v.user_id,v.workspace_id) IS NOT NULL
          AND NOT r.compartments <@ effective_member_team_compartments(v.user_id,v.workspace_id))
      )) ORDER BY r.created_at DESC LIMIT CASE WHEN $2::uuid[] IS NULL THEN 50 ELSE 100 END`, [scope.workspaceId, ids ? [...new Set(ids)] : null, actor.assistantId, actor.userId, actor.sessionId])).rows
}
export function feedSourceFloor(prior: Sensitivity | undefined, sources: readonly FeedSelectedSource[]): Sensitivity {
  return maxSensitivity(prior ?? 'public', ...sources.map(source => source.sensitivity))
}

/** Serialize outgoing Feed frames and recheck live member/source authority. */
export function guardFeedStream<T>(reader: FeedReader, sessionId: string, userId: string, send: (event: T) => void, close: () => void): (event: T) => void {
  let tail = Promise.resolve(); let closed = false
  return event => {
    tail = tail.then(async () => {
      if (closed) return
      const allowed = (await reader.query(`SELECT 1 FROM sessions s JOIN workspace_members m ON m.workspace_id=s.workspace_id
        WHERE s.id=$1 AND m.user_id=$2 AND feed_draft_audience_allowed(s.id)`, [sessionId, userId])).rows.length > 0
      if (!allowed) { closed = true; close(); return }
      send(event)
    }).catch(() => { if (!closed) { closed = true; close() } })
  }
}
