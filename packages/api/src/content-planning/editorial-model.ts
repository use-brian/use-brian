/** Existing model routing and usage hooks for bounded Feed editorial calls. [COMP:feed/draft-review] */
import { calculateCost, type UsageStore } from '@use-brian/agent-runtime/billing/cost-tracker.js'
import { collectStream } from '@use-brian/agent-runtime/providers/accumulator.js'
import type { LLMProvider } from '@use-brian/agent-runtime/providers/types.js'
import { registryRow, type ProviderAvailability } from '@use-brian/shared/model-registry'
import { FEED_EDITORIAL_LIMITS } from '@use-brian/shared'
import { getWorkspacePlan } from '../db/workspace-store.js'
import { FeedCollaborationError } from '../db/feed-collaboration-store.js'
import { ensureServableModel, resolveModel } from '../model-resolution.js'
import { checkUsageBudget, type CreditBudgetGate } from '../routes/route-helpers.js'
import type { WorkspaceCustomLlmResolver } from '../custom-llm-runtime.js'
export type FeedModelIdentity = { workspaceId: string; userId: string; assistantId: string; sessionId: string }
export type FeedEditorialModel = {
  model: string; tier: string; providerKeySource?: 'user' | 'platform'; inputCharacters: number; maxTokens: number;
  call(input: { systemPrompt: string; prompt: string; signal: AbortSignal }): Promise<{ text: string; usage?: unknown }>;
}
export type FeedEditorialModelResolver = (actor: FeedModelIdentity, tier: string) => Promise<FeedEditorialModel>
export function createFeedEditorialModelResolver(options: { provider: LLMProvider; configuredProviders: ProviderAvailability; resolveWorkspaceCustomLlm?: WorkspaceCustomLlmResolver; usageStore?: UsageStore; checkCreditBudget?: CreditBudgetGate; triggerKey?: string }): FeedEditorialModelResolver {
  return async (actor, tier) => {
    const plan = await getWorkspacePlan(actor.workspaceId)
    const budget = await checkUsageBudget(actor.workspaceId, plan, options.checkCreditBudget)
    if (budget.status === 'blocked') throw new FeedCollaborationError(402, 'usage_budget_exhausted')
    const managedModel = ensureServableModel(resolveModel(tier, plan, budget.status), options.configuredProviders)
    const effectiveTier = registryRow(managedModel)?.tier ?? 'standard'
    const custom = await options.resolveWorkspaceCustomLlm?.({ workspaceId: actor.workspaceId, requestedTier: effectiveTier, allowDefault: true, allowFailureFallback: false })
    const provider = custom?.provider ?? options.provider
    const model = custom?.selector ?? managedModel
    if (!custom && !provider.models.includes(model) && !options.configuredProviders.size) throw new FeedCollaborationError(503, 'editorial_model_unavailable')
    const maxTokens = Math.min(FEED_EDITORIAL_LIMITS.outputTokens, custom?.maxTokens ?? FEED_EDITORIAL_LIMITS.outputTokens)
    // One Unicode character may consume a token. Keep a conservative budget
    // for source JSON and instructions; whole sources are omitted visibly.
    const inputCharacters = Math.max(0, Math.min(FEED_EDITORIAL_LIMITS.inputCharacters, (custom?.inputTokenLimit ?? registryRow(model)?.contextWindow ?? 32_768) - maxTokens - 4_000))
    return { model, tier: effectiveTier, providerKeySource: custom?.providerKeySource ?? 'platform', inputCharacters, maxTokens, async call(input) {
      const response = await collectStream(provider.stream({ model, systemPrompt: input.systemPrompt, messages: [{ role: 'user', content: input.prompt }], maxTokens, responseFormat: 'json', signal: input.signal }))
      const usage = response.usage
      let usageRecorded = !options.usageStore || !usage
      if (usage && options.usageStore) {
        try { await options.usageStore.recordUsage({ userId: actor.userId, assistantId: actor.assistantId, sessionId: actor.sessionId, model: response.model || model, modelTier: effectiveTier, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens, actualCostUsd: custom?.providerKeySource === 'user' ? 0 : calculateCost(response.model || model, usage), source: 'included', triggerKey: options.triggerKey ?? 'feed_review', providerKeySource: custom?.providerKeySource ?? 'platform' }); usageRecorded = true } catch { /* Saved receipt retains measured usage for reconciliation. */ }
      }
      return { text: response.content.some(block => block.type === 'tool_use') ? '' : response.content.filter(block => block.type === 'text').map(block => block.type === 'text' ? block.text : '').join(''), usage: { model: response.model || model, ...usage, usageRecorded } }
    } }
  }
}

/** Included confirmation synthesis uses the configured background runtime. */
export function createFeedLearningModelResolver(options: { provider: LLMProvider; configuredProviders: ProviderAvailability; resolveBackgroundRuntime?: import('../custom-llm-runtime.js').BackgroundRuntimeResolver; usageStore?: UsageStore }): FeedEditorialModelResolver {
  return async actor => {
    const { backgroundModelFor } = await import('../model-resolution.js')
    const { FEED_LEARNING_LIMITS } = await import('@use-brian/shared')
    const custom = await options.resolveBackgroundRuntime?.(actor.workspaceId)
    const provider = custom?.provider ?? options.provider; const model = custom?.selector ?? backgroundModelFor(options.configuredProviders)
    const maxTokens = Math.min(FEED_LEARNING_LIMITS.outputTokens, custom?.maxTokens ?? FEED_LEARNING_LIMITS.outputTokens)
    const inputCharacters = Math.max(0, Math.min(FEED_LEARNING_LIMITS.inputCharacters, (custom?.inputTokenLimit ?? registryRow(model)?.contextWindow ?? 32768) - maxTokens - 4000))
    return { model, tier: 'background', inputCharacters, maxTokens, providerKeySource: custom?.providerKeySource ?? 'platform', async call(input) {
      const response = await collectStream(provider.stream({ model, systemPrompt: input.systemPrompt, messages: [{ role: 'user', content: input.prompt }], maxTokens, responseFormat: 'json', signal: input.signal }))
      const usage = response.usage; let usageRecorded = !usage || !options.usageStore
      if (usage && options.usageStore) { try { await options.usageStore.recordUsage({ userId: actor.userId, assistantId: actor.assistantId, sessionId: actor.sessionId, model: response.model || model, modelTier: 'standard', ...usage, actualCostUsd: custom?.providerKeySource === 'user' ? 0 : calculateCost(response.model || model, usage), source: 'overhead:playbook-reflection', triggerKey: 'feed_confirmation_learning', providerKeySource: custom?.providerKeySource ?? 'platform' }); usageRecorded = true } catch { /* The durable receipt retains measured usage. */ } }
      return { text: response.content.some(block => block.type === 'tool_use') ? '' : response.content.filter(block => block.type === 'text').map(block => block.type === 'text' ? block.text : '').join(''), usage: { model: response.model || model, ...usage, usageRecorded } }
    } }
  }
}
