/** [COMP:recordings/meeting-tags] Brian uses the same commands as the page UI. */
import { z } from 'zod'
import { actorFromContext, buildTool, type SavedViewStore } from '@use-brian/core'
import { createMeetingTagsService } from './meeting-tags-service.js'
import { meetingTagCommand } from './meeting-tags.js'
import { runWithAgentAccess } from '../db/client.js'

export function createMeetingTagsTool(views: Pick<SavedViewStore, 'getById' | 'getPage'>) {
  const service = createMeetingTagsService(views)
  return buildTool({
    name: 'manageMeetingTags',
    description: 'Read tags and phrase rules for a Meeting notes folder or child page. Omit command to read. Only add manual tags, create rules, or accept suggestions when the user requests it. Never invent default tags or activate learned suggestions on your own. Rules require ALL phrases in the meeting title or notes. set-tags replaces the visible tag list; preserve tags the user did not ask to remove. Rules apply to future live-note updates; acceptance does not retag historical notes.',
    inputSchema: z.object({ pageId: z.string().uuid(), command: meetingTagCommand.optional() }),
    isReadOnly: false, isConcurrencySafe: false, requiresConfirmation: false,
    timeoutMs: 15_000,
    async execute(input, context) {
      const actor = actorFromContext(context)
      if ('error' in actor) return { data: actor.error, isError: true }
      try {
        const data = await runWithAgentAccess({ ...actor, clearance: actor.clearance, compartments: actor.compartments }, () => input.command
          ? service.command(actor.userId, actor.workspaceId, input.pageId, input.command)
          : service.read(actor.userId, actor.workspaceId, input.pageId))
        return { data }
      } catch (error) {
        return { data: error instanceof Error ? error.message : 'Meeting tags unavailable. Refresh before retrying.', isError: true }
      }
    },
  })
}
