import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import type { WorkspaceDirectoryStore } from './types.js'

/**
 * Workspace-roster tool for the primary assistant.
 *
 * One tool: `listWorkspaceMembers`. Its job is assignment resolution —
 * `tasks.assignee_id` is a `workspace_members.id`, and without a way to
 * enumerate members the model cannot turn a name into that id. Gated on
 * the `tasks` capability for exactly that reason: an assistant that
 * cannot touch tasks has no use for the roster.
 *
 * See docs/architecture/platform/workspaces.md → "Member directory tool".
 */

export function createWorkspaceTools(store: WorkspaceDirectoryStore): {
  listWorkspaceMembers: Tool
} {
  const listWorkspaceMembers = buildTool({
    name: 'listWorkspaceMembers',
    requiresCapability: 'tasks',
    description:
      'List the people in the current workspace — each with their member id, name, email, and role. ' +
      'Use this to resolve a person named in chat into the `assignee_id` that `saveTask` and `updateTask` expect: `assignee_id` is a workspace member id (the `memberId` field returned here), not a user id. ' +
      'Returns every member; match on name or email yourself before assigning. Takes no arguments.',
    inputSchema: z.object({}),
    isConcurrencySafe: true,
    isReadOnly: true,
    async execute(_input, context) {
      if (!context.workspaceId) {
        return {
          data: 'This assistant is not bound to a workspace, so it has no member roster. Tasks and assignment are unavailable here.',
          isError: true,
        }
      }
      const members = await store.listMembers(context.userId, context.workspaceId)
      return { data: members }
    },
  })

  return { listWorkspaceMembers }
}
