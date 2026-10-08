import { intersectScopeGrants,type DepartmentReadGrant,type Tool } from '@use-brian/core'
import { runWithAgentAccess, currentAgentAccess } from '../db/client.js'
import { executeWithCurrentAuthority } from './authority-lease.js'

/**
 * Apply the trusted turn projection to every RLS-backed tool execution.
 * Wrapping the async generator itself is insufficient: its body runs on
 * iteration, after AsyncLocalStorage.run() has returned.
 */
export function bindToolsToAgentAccess(
  tools: ReadonlyMap<string, Tool>,
  access: {
    clearance: string | null | undefined
    compartments: string[] | null | undefined
    mutationCompartments?: string[] | null
    projectIds: string[] | null | undefined
    visibilityAssistantIds?: string[] | null
    sharedAudience?: boolean
    departmentRead?: DepartmentReadGrant
  },
): Map<string, Tool> {
  const scoped = new Map<string, Tool>()
  for (const [name, tool] of tools) {
    const execute = tool.execute.bind(tool)
    scoped.set(name, {
      ...tool,
      execute: (input, context) => {
        const canonical = context.executionContext?.security.access
        if (canonical && (canonical.userId !== context.userId
          || canonical.workspaceId !== (context.workspaceId ?? '')
          || canonical.assistantId !== context.assistantId)) throw new Error('access_actor_mismatch')
        // The canonical execution survives legacy call sites that project only
        // flat fields. Apply both ceilings so either may only narrow the other.
        const invoke = () => runWithAgentAccess({
          ...access,
          workspaceId: context.workspaceId ?? undefined,
          userId: context.userId,
          visibilityAssistantIds: intersectScopeGrants(
            access.visibilityAssistantIds ?? null, context.visibilityAssistantIds ?? null,
            context.assistantKind === 'primary' ? null : [context.assistantId],
          ),
        }, () => executeWithCurrentAuthority(() => execute(input, {
          ...context,
          mutationCompartments: currentAgentAccess()?.mutationCompartments,
        })))
        return canonical
          ? context.executionContext!.security.authority.execute(() => runWithAgentAccess(canonical, invoke))
          : invoke()
      },
    })
  }
  return scoped
}
