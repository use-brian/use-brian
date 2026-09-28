/** Caller-scoped, versioned meeting tags. [COMP:recordings/meeting-tags] */
import { blocksToMarkdown, type Page } from '@use-brian/core'
import { queryWithRLS } from './client.js'
import { emptyTagState, type TagState, type TagExample } from '../recordings/meeting-tags.js'

export const meetingTagsStore = {
  async read(userId: string, pageId: string): Promise<TagState> {
    const { rows } = await queryWithRLS<{ data: TagState }>(userId, 'SELECT data FROM meeting_tag_state WHERE page_id=$1', [pageId])
    return rows[0]?.data ?? emptyTagState()
  },
  async change(userId: string, pageId: string, transform: (state: TagState) => TagState): Promise<TagState> {
    await queryWithRLS(userId, 'INSERT INTO meeting_tag_state(page_id) VALUES($1) ON CONFLICT DO NOTHING', [pageId])
    for (let attempt = 0; attempt < 4; attempt++) {
      const { rows } = await queryWithRLS<{ data: TagState; version: number }>(userId, 'SELECT data,version FROM meeting_tag_state WHERE page_id=$1', [pageId])
      if (!rows[0]) throw new Error('Meeting page is no longer accessible.')
      const next = transform(rows[0].data)
      const result = await queryWithRLS(userId, 'UPDATE meeting_tag_state SET data=$2,version=version+1 WHERE page_id=$1 AND version=$3 RETURNING page_id', [pageId, JSON.stringify(next), rows[0].version])
      if (result.rows.length) return next
    }
    throw new Error('Meeting tags changed concurrently. Refresh before retrying.')
  },
  async examples(userId: string, folderId: string): Promise<TagExample[]> {
    const { rows } = await queryWithRLS<{ pageId: string; name: string; page: Page | null; tags: TagState['tags'] }>(userId, `
      SELECT p.id AS "pageId",p.name,p.page,s.data->'tags' AS tags
      FROM saved_views p JOIN meeting_tag_state s ON s.page_id=p.id
      JOIN saved_views f ON f.id=p.nest_parent_id
      WHERE f.id=$1 AND p.workspace_id=f.workspace_id AND p.clearance=f.clearance
        AND p.teamspace_id IS NOT DISTINCT FROM f.teamspace_id
        AND p.project_id IS NOT DISTINCT FROM f.project_id
        AND s.data->'tags' @> '[{"source":"manual"}]'::jsonb
      ORDER BY p.updated_at DESC LIMIT 100`, [folderId])
    return rows.map((row) => ({ pageId: row.pageId, text: row.name + '\n' + blocksToMarkdown({ blocks: (row.page?.blocks ?? []).filter((block) => !block.id.startsWith('live:') && !('text' in block && block.text === 'Listening for the first update...')) }), tags: row.tags ?? [] }))
  },
}
export type MeetingTagsStore = typeof meetingTagsStore
