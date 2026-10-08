import type { SavedViewStore } from '@use-brian/core'

const MEETING_NOTES_FOLDER_ANCHOR = 'meeting-notes-folder'

/**
 * Find or create the workspace's default Meeting notes folder (stable anchor
 * `meeting-notes-folder`) under the caller's access. Shared by every recording
 * lane that files a new meeting page by default: live capture and Watch.
 * See docs/architecture/media/live-capture.md -> "Default: new page in the Meeting notes folder".
 */
export async function ensureMeetingNotesFolder(
  store: Pick<SavedViewStore, 'findIdByAnchorKey' | 'createDraft'>,
  userId: string,
  workspaceId: string,
  folderName?: string | null,
): Promise<string> {
  const anchorKey = MEETING_NOTES_FOLDER_ANCHOR
  const existing = await store.findIdByAnchorKey(userId, workspaceId, anchorKey)
  if (existing) return existing
  try {
    const folder = await store.createDraft({
      userId, workspaceId, anchorKey,
      name: typeof folderName === 'string' && folderName.trim()
        ? folderName.trim().slice(0, 120) : 'Meeting notes',
      nameOrigin: 'user', icon: '📁',
      entity: 'tasks', viewType: 'table',
      binding: { entity: 'tasks', viewType: 'table' },
      page: { blocks: [] }, state: 'saved', writtenBy: 'user',
    })
    return folder.id
  } catch (error) {
    // The workspace anchor's unique index arbitrates concurrent starts.
    if ((error as { code?: string } | null)?.code !== '23505') throw error
    const winner = await store.findIdByAnchorKey(userId, workspaceId, anchorKey)
    if (!winner) throw error
    return winner
  }
}
