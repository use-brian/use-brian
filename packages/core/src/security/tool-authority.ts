import type { ToolContext } from '../tools/types.js'
import { intersectAccessCeilings, parseAuthoringAuthority, pinAuthoringAuthority, type AuthoringAuthority } from './access-ceiling.js'

/** Freeze the trusted access fields already resolved onto an attended tool turn. */
export function pinToolAuthoringAuthority(context: ToolContext): AuthoringAuthority {
  if (!context.workspaceId || !context.assistantKind) {
    throw Object.assign(new Error('The current turn has no trusted workspace authoring authority.'), {
      reason: 'authoring_authority_unavailable',
    })
  }
  const execution = context.executionContext
  if (execution) {
    try {
      const access = execution.security.access
      if (access.workspaceId !== context.workspaceId || access.userId !== context.userId
        || access.assistantId !== context.assistantId || execution.assistant.id !== context.assistantId
        || access.assistantKind !== context.assistantKind || execution.assistant.kind !== context.assistantKind) {
        throw new Error('execution_actor_mismatch')
      }
      const frozen = parseAuthoringAuthority({ version: 1, assistantId: context.assistantId,
        ceiling: execution.security.ceiling })
      if (!frozen) throw new Error('execution_ceiling_missing')
      return { ...frozen, ceiling: intersectAccessCeilings(frozen.ceiling, pinAuthoringAuthority(access).ceiling) }
    } catch {
      throw Object.assign(new Error('The current turn has no trusted workspace authoring authority.'), {
        reason: 'authoring_authority_unavailable',
      })
    }
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
