import { withRoutineCalendarContext } from '@use-brian/core/engine/routine-read-ownership.js'
import { intersectScopeGrants } from '@use-brian/agent-runtime/security/context-scope.js'
import type { DepartmentReadGrant } from '@use-brian/agent-runtime/security/department-read.js'
import type { Tool, ToolContext } from '@use-brian/agent-runtime/tools/types.js'
import { runWithAgentAccess, currentAgentAccess } from '../db/client.js'
import { executeWithCurrentAuthority } from './authority-lease.js'

/** Captured by the turn preparation owner, never selected by a surface tool context. */
export type ToolInvocationBinding = {
  assertContext(context: ToolContext, operationMayHaveExecuted?: boolean): void
  execute<T>(operation: () => Promise<T>, effect: { started: boolean }): Promise<T>
}

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
  invocation?: ToolInvocationBinding,
): Map<string, Tool> {
  const scoped = new Map<string, Tool>()
  const projection = structuredClone(access)
  const assertContext = invocation?.assertContext, dispatch = invocation?.execute
  for (const [name, tool] of tools) {
    const execute = tool.execute.bind(tool)
    scoped.set(name, {
      ...tool,
      execute: (input, context) => {
        assertContext?.(context)
        const effect = { started: false }
        const canonical = context.executionContext?.security.access
        if (canonical && (canonical.userId !== context.userId
          || canonical.workspaceId !== (context.workspaceId ?? '')
          || canonical.assistantId !== context.assistantId)) throw new Error('access_actor_mismatch')
        // The canonical execution survives legacy call sites that project only
        // flat fields. Apply both ceilings so either may only narrow the other.
        const invoke = () => runWithAgentAccess({
          ...projection,
          workspaceId: context.workspaceId ?? undefined,
          userId: context.userId,
          visibilityAssistantIds: intersectScopeGrants(
            projection.visibilityAssistantIds ?? null, context.visibilityAssistantIds ?? null,
            context.assistantKind === 'primary' ? null : [context.assistantId],
          ),
        }, () => executeWithCurrentAuthority(() => {
          assertContext?.(context)
          const active = currentAgentAccess()
          const derived = { ...context, ...(active ? { clearance: active.clearance, compartments: active.compartments,
            projectIds: active.projectIds, visibilityAssistantIds: active.visibilityAssistantIds,
            sharedAudience: active.sharedAudience ?? context.sharedAudience } : {}),
            mutationCompartments: active?.mutationCompartments }
          return withRoutineCalendarContext(context, derived, async () => {
            effect.started = true
            try { return await execute(input, derived) }
            finally { assertContext?.(context, true) }
          })
        }))
        if (dispatch) return dispatch(() => {
          assertContext!(context)
          return invoke()
        }, effect).then(result => {
          assertContext!(context, effect.started)
          return result
        }, error => {
          assertContext!(context, effect.started)
          throw error
        })
        return canonical
          ? context.executionContext!.security.authority.execute(() => runWithAgentAccess(canonical, invoke))
          : invoke()
      },
    })
  }
  return scoped
}
