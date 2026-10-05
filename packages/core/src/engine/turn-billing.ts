import type { AssistantResponse, TokenUsage } from '../providers/types.js'

/** Ordinary chat's billable remainder, not the last provider's observed metrics.
 * Native image calls already have their own durable accounting owner, including
 * unknown/unpriced attempts. Never turn an image-only completion into a synthetic
 * zero-cost ordinary row or price earlier text calls as the last image model.
 * This projection does not mutate the response used by delivery/analytics. */
export function billableTurnUsage(event: {
  response: Pick<AssistantResponse, 'model' | 'billableModel' | 'usageAccounting'>
  totalUsage?: TokenUsage | null
}): { model: string; usage: TokenUsage } | null {
  const usage = event.totalUsage
  if (!usage) return null
  if (event.response.usageAccounting === 'native_image' && usage.inputTokens === 0 && usage.outputTokens === 0
    && !usage.cacheReadTokens && !usage.cacheWriteTokens) return null
  return { model: event.response.billableModel ?? event.response.model, usage }
}
