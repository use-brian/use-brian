/** Shared command service for human UI, Brian and live notes. [COMP:recordings/meeting-tags] */
import { blocksToMarkdown, type SavedViewStore } from '@use-brian/core'
import { meetingTagsStore, type MeetingTagsStore } from '../db/meeting-tags-store.js'
import { applyTagRules, changeRules, meetingTagCommand, setManualTags, suggestTagRules } from './meeting-tags.js'

type Views = Pick<SavedViewStore, 'getById' | 'getPage'>
export function createMeetingTagsService(views: Views, store: MeetingTagsStore = meetingTagsStore) {
  async function resolve(userId: string, workspaceId: string, pageId: string) {
    const page = await views.getById(userId, pageId)
    if (!page || page.workspaceId !== workspaceId) throw new Error('Meeting page not found in this workspace.')
    const folder = page.anchorKey === 'meeting-notes-folder' ? page
      : page.nestParentId ? await views.getById(userId, page.nestParentId) : null
    if (!folder || folder.workspaceId !== workspaceId || folder.anchorKey !== 'meeting-notes-folder') return null
    // Folder rules can carry sensitive user labels. Never project them onto a
    // child with a different access envelope, or learn back across that seam.
    if (page.clearance !== folder.clearance || (page.teamspaceId ?? null) !== (folder.teamspaceId ?? null)
      || (page.projectId ?? null) !== (folder.projectId ?? null)) return null
    return { page, folder }
  }
  async function read(userId: string, workspaceId: string, pageId: string) {
    const scope = await resolve(userId, workspaceId, pageId)
    if (!scope) return null
    const [state, folderState, examples] = await Promise.all([
      store.read(userId, pageId), store.read(userId, scope.folder.id), store.examples(userId, scope.folder.id),
    ])
    return {
      folderId: scope.folder.id, isFolder: pageId === scope.folder.id,
      tags: state.tags, rules: folderState.rules, suggestions: suggestTagRules(examples, folderState),
    }
  }
  return {
    read,
    async command(userId: string, workspaceId: string, pageId: string, input: unknown) {
      const command = meetingTagCommand.parse(input)
      const scope = await resolve(userId, workspaceId, pageId)
      if (!scope) throw new Error('Choose the Meeting notes folder or one of its meeting pages.')
      if (command.kind === 'set-tags') {
        if (scope.page.id === scope.folder.id) throw new Error('Apply manual tags to a meeting page, not its folder.')
        await store.change(userId, pageId, (state) => setManualTags(state, command.tags))
      } else {
        const examples = await store.examples(userId, scope.folder.id)
        await store.change(userId, scope.folder.id, (state) => changeRules(state, command, suggestTagRules(examples, state)))
      }
      return read(userId, workspaceId, pageId)
    },
    async apply(userId: string, workspaceId: string, pageId: string, notes?: string) {
      const scope = await resolve(userId, workspaceId, pageId)
      if (!scope || scope.page.id === scope.folder.id) return
      const { rules } = await store.read(userId, scope.folder.id)
      if (!rules.length) return // No opted-in rules means no assignment, write or model call.
      const text = scope.page.name + '\n' + (notes ?? blocksToMarkdown(await views.getPage(userId, pageId) ?? { blocks: [] }))
      await store.change(userId, pageId, (state) => applyTagRules(state, rules, text))
    },
  }
}
