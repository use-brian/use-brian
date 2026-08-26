import type { Tool } from '@use-brian/core'
import { runWithAgentAccess } from '../db/client.js'

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
    projectIds: string[] | null | undefined
  },
): Map<string, Tool> {
  const scoped = new Map<string, Tool>()
  for (const [name, tool] of tools) {
    const execute = tool.execute.bind(tool)
    scoped.set(name, {
      ...tool,
      execute: (input, context) => runWithAgentAccess(access, () => execute(input, context)),
    })
  }
  return scoped
}
