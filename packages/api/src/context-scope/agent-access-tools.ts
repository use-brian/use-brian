import { intersectScopeGrants,type Tool } from '@use-brian/core'
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
  },
): Map<string, Tool> {
  const scoped = new Map<string, Tool>()
  for (const [name, tool] of tools) {
    const execute = tool.execute.bind(tool)
    scoped.set(name, {
      ...tool,
      execute: (input, context) => runWithAgentAccess({
        ...access,workspaceId:context.workspaceId??undefined,userId:context.userId,
        visibilityAssistantIds:intersectScopeGrants(
          access.visibilityAssistantIds??null,context.visibilityAssistantIds??null,
          context.assistantKind==='primary'?null:[context.assistantId],
        ),
      }, () => executeWithCurrentAuthority(() => execute(input, {...context,mutationCompartments:currentAgentAccess()?.mutationCompartments}))),
    })
  }
  return scoped
}
