/** Bounded current-authority page picker projection. [COMP:api/page-directory] */
import { queryWithRLS } from './client.js'

export type PageDirectoryItem = { id: string; title: string }
type PageDirectoryRead = { pages: PageDirectoryItem[]; validForMs: number }

const directorySql = `
  WITH caller AS (
    SELECT 1
    FROM workspace_members
    WHERE workspace_id = $1 AND user_id = $2
  ), visible_pages AS (
    SELECT id, name AS title
    FROM saved_views
    WHERE workspace_id = $1
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object('id', page.id, 'title', page.title)
      ORDER BY lower(page.title), page.id
    ) FILTER (WHERE page.id IS NOT NULL),
    '[]'::jsonb
  ) AS pages,
  least(30000, department_media_valid_for_ms($1))::integer AS "validForMs"
  FROM caller
  LEFT JOIN visible_pages page ON true
  GROUP BY department_media_valid_for_ms($1)`

export type PageDirectoryReply =
  | { status: 200; body: { workspaceId: string; viewerId: string; pages: PageDirectoryItem[]; validForMs: number } }
  | { status: 404 | 409; body: { error: 'page_directory_unavailable' | 'page_directory_changed' } }

/**
 * Read the RLS-visible page rows twice in independent transactions. Publication
 * is refused when membership or the visible set changes between snapshots.
 */
export async function readWorkspacePageDirectory(
  userId: string,
  workspaceId: string,
): Promise<PageDirectoryReply> {
  const started = performance.now()
  const initial = await queryWithRLS<PageDirectoryRead>(userId, directorySql, [workspaceId, userId])
  const first = initial.rows[0]
  if (!first) return { status: 404, body: { error: 'page_directory_unavailable' } }

  const verified = await queryWithRLS<PageDirectoryRead>(userId, directorySql, [workspaceId, userId])
  const second = verified.rows[0]
  if (!second || JSON.stringify(second.pages) !== JSON.stringify(first.pages)) {
    return { status: 409, body: { error: 'page_directory_changed' } }
  }

  const validForMs = Math.floor(Math.min(first.validForMs, second.validForMs, 30_000 - (performance.now() - started)))
  if (!Number.isFinite(validForMs) || validForMs <= 0) {
    return { status: 404, body: { error: 'page_directory_unavailable' } }
  }
  return { status: 200, body: { workspaceId, viewerId: userId, pages: second.pages, validForMs } }
}
