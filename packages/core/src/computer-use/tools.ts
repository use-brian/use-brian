import { z } from 'zod'
import { buildTool, type Tool, type ToolContext } from '../tools/types.js'
import type { NativeAuthority } from './types.js'
import type { NativeComputerOrchestrator } from './orchestrator.js'

export function createNativeComputerTools(deps: {
  /** Resolve authenticated task/device/grant and reuse its session orchestrator.
   * Never derive identity, task ID or consent from the goal/model arguments. */
  resolve(context: ToolContext): Promise<{ authority: NativeAuthority; orchestrator: NativeComputerOrchestrator } | null>
}): { nativeComputerTask: Tool } {
  return { nativeComputerTask: buildTool({
    name: 'nativeComputerTask',
    description: 'Perform a bounded task in the separately approved native computer session. Cannot grant control, resume Stop, or select another device.',
    inputSchema: z.object({ goal: z.string().min(1).max(2000) }).strict(),
    requiresCapability: 'native_computer', isReadOnly: false, isConcurrencySafe: false,
    async execute(input, context) {
      if (!context.activeCapabilities?.has('native_computer') || !context.workspaceId || context.abortSignal.aborted) return { data: 'Native computer unavailable', isError: true }
      await context.authority?.assertCurrent()
      const binding = await deps.resolve(context)
      if (!binding || binding.authority.grant.identity.userId !== context.userId || binding.authority.grant.identity.workspaceId !== context.workspaceId) return { data: 'Native authority denied', isError: true }
      const authority: NativeAuthority = { ...binding.authority, assertCurrent: async () => { await context.authority?.assertCurrent(); await binding.authority.assertCurrent() } }
      const data = await binding.orchestrator.run({ authority, goal: input.goal, signal: context.abortSignal, deadlineAt: Date.now() + 120_000, onProgress: event => context.progress?.touch(`native:${event.phase}`) })
      return { data, isError: data.outcome !== 'completed' }
    },
  }) }
}
