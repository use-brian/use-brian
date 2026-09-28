import type { ToolContext } from '../tools/types.js'
import { pinAuthoringAuthority, type AuthoringAuthority } from './access-ceiling.js'

/** Freeze the trusted access fields already resolved onto an attended tool turn. */
export function pinToolAuthoringAuthority(context: ToolContext): AuthoringAuthority {
  if (!context.workspaceId || !context.assistantKind) {
    throw Object.assign(new Error('The current turn has no trusted workspace authoring authority.'), {
      reason: 'authoring_authority_unavailable',
    })
  }
  return pinAuthoringAuthority({
    workspaceId: context.workspaceId,
    userId: context.userId,
    assistantId: context.assistantId,
    assistantKind: context.assistantKind,
    visibilityAssistantIds: context.visibilityAssistantIds,
    clearance: context.clearance,
    compartments: context.compartments,
    mutationCompartments: context.mutationCompartments,
    projectIds: context.projectIds,
  })
}
