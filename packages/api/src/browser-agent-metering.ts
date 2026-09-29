/** Precise usage_tracking rows for the Jev Ultrafast browser-agent lane. */
import {
  calculateCost,
  type BrowserAgentUsage,
  type ToolContext,
  type UsageStore,
} from '@use-brian/core'

export function createBrowserAgentUsageRecorder(usageStore: UsageStore | undefined) {
  return async (usage: BrowserAgentUsage[], context: ToolContext): Promise<void> => {
    if (!usageStore) return
    for (const line of usage) {
      try {
        await usageStore.recordUsage({
          userId: context.userId,
          actorUserId: context.userId,
          assistantId: context.assistantId,
          ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
          sessionId: context.sessionId,
          model: line.model,
          inputTokens: line.inputTokens,
          outputTokens: line.outputTokens,
          actualCostUsd: line.providerKeySource === 'user'
            ? 0
            : calculateCost(line.model, line),
          source: 'included',
          triggerKey: line.kind === 'jev'
            ? 'computer_use:jev_ultrafast'
            : 'computer_use:jev_text_helper',
          providerKeySource: line.providerKeySource,
        })
      } catch (error) {
        console.error('[browser-agent-metering] failed to record provider usage', {
          backend: line.kind,
          model: line.model,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
}
