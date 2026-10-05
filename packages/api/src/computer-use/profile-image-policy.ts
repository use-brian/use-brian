import type { LLMProvider, ToolContext } from '@use-brian/core'
import { isRegistryModelAvailable, registryRow } from '@use-brian/shared/model-registry'
import type { WorkspaceCustomLlmResolver } from '../custom-llm-runtime.js'
import { createNativeConfiguredGrounderApproval, type NativeBootOptions } from './boot-runtime.js'

export type ProfileImagePermit = {
  assertCurrent(context: ToolContext): Promise<void>
  reserve(context: ToolContext, tokens: number): Promise<void>
}
export type ProfileImagePolicy = (context: ToolContext, lease: { id: string; expiresAt: number }) => Promise<ProfileImagePermit | null>
type ManagedRoute = { model: string; tier: string; workspaceId: string }
/** Register only provider instances returned by boot's configured managed-route
 * factory. Matching names/models or inherited workerRuntime are NOT proof. */
export function trackProfileImageRoutes(resolver: WorkspaceCustomLlmResolver) {
  const managedRoutes = new WeakMap<LLMProvider, ManagedRoute>()
  const resolve: WorkspaceCustomLlmResolver = async params => {
    const route = await resolver(params)
    if (route?.routeKind === 'managed' && route.providerKeySource === 'platform' && !route.fallback.enabled) {
      managedRoutes.set(route.provider, { model: route.selector, tier: route.modelTier, workspaceId: params.workspaceId })
    }
    return route
  }
  return { resolve, managedRoutes }
}
type Options = Pick<NativeBootOptions, 'provider' | 'configuredProviders' | 'resolveWorkspaceCustomLlm' | 'getWorkspacePlan' | 'checkCreditBudget' | 'budget'> & {
  imageApproval: { accepted: boolean; model?: string }
  managedRoutes?: Pick<WeakMap<LLMProvider, ManagedRoute>, 'get'>
}
const VISION_TOKENS = 4 * 1024 * 1024 + 32768

/** Approval of the ACTUAL chat invocation, not a model resolver or a hidden
 * grounding call. Opaque custom endpoints and BYO provider instances fail closed.
 * Managed routes must match live workspace configuration and a boot-registered
 * provider instance as well as the query-loop's authoritative invocation route.
 * Reservations are per live lease, non-refundable. The normal chat call is
 * settled by the profile image accounting hook, never a hidden model runner. */
export function createProfileImagePolicy(options: Options): ProfileImagePolicy {
  const approve = createNativeConfiguredGrounderApproval(options.imageApproval.accepted, options.imageApproval.model)
  const budgets = new Map<string, { expiresAt: number; tokens: number; cost: number }>()
  return async (context, lease) => {
    try {
      const route = context.engineRuntime
      const budget = options.budget
      if (!route?.imageUploads || !context.workspaceId || !budget
        || !Object.values(budget).every(n => Number.isFinite(n) && n > 0) || budget.attemptTokens < 32768
        || budget.tokens < VISION_TOKENS || budget.costUsd < budget.attemptCostUsd * VISION_TOKENS / budget.attemptTokens) return null
      const scope = JSON.stringify([context.userId, context.workspaceId, context.assistantId, context.sessionId, lease.id])
      for (const [id, value] of budgets) if (value.expiresAt <= Date.now()) budgets.delete(id)
      let remaining = budgets.get(scope)
      if (!remaining) {
        if (budgets.size >= 500 || lease.expiresAt <= Date.now()) return null
        remaining = { expiresAt: lease.expiresAt, tokens: budget.tokens, cost: budget.costUsd }
        budgets.set(scope, remaining)
      }
      const assertCurrent = async (current: ToolContext) => {
        const actual = current.engineRuntime
        const row = registryRow(route.model)
        const managed = options.managedRoutes?.get(route.provider)
        if (!actual?.imageUploads || actual.provider !== route.provider || actual.model !== route.model
          || current.workspaceId !== context.workspaceId || current.userId !== context.userId
          || current.assistantId !== context.assistantId || current.sessionId !== context.sessionId
          || !options.imageApproval.accepted || options.imageApproval.model !== actual.model
          || lease.expiresAt <= Date.now() || !row?.capabilities.vision || row.provider === 'openai-codex'
          || !isRegistryModelAvailable(row, options.configuredProviders) || !actual.provider.models.includes(actual.model)) throw new Error('Native image route denied')
        current.abortSignal.throwIfAborted()
        await current.authority?.assertCurrent()
        const plan = await options.getWorkspacePlan(current.workspaceId!)
        if ((await options.checkCreditBudget?.(current.workspaceId!, plan))?.status === 'blocked') throw new Error('Native image credits denied')
        const custom = await options.resolveWorkspaceCustomLlm({ workspaceId: current.workspaceId!,
          requestedTier: managed?.tier ?? row.tier, allowDefault: true, allowFailureFallback: false })
        if (custom && (custom.routeKind !== 'managed' || custom.selector !== actual.model || !custom.supportsVision || custom.fallback.enabled)) throw new Error('Native image configured route changed')
        if (actual.provider !== options.provider && (!managed || !custom || managed.workspaceId !== current.workspaceId
          || managed.model !== actual.model || managed.tier !== custom.modelTier)) throw new Error('Native image provider denied')
        const approval = await approve(current, { provider: actual.provider, model: actual.model, providerKeySource: 'platform' })
        if (!approval?.nativeGrounding || approval.provider !== actual.provider || approval.model !== actual.model) throw new Error('Native image approval denied')
        current.abortSignal.throwIfAborted()
      }
      await assertCurrent(context)
      if (remaining.tokens < VISION_TOKENS || remaining.cost < budget.attemptCostUsd * VISION_TOKENS / budget.attemptTokens) return null
      return { assertCurrent, async reserve(current, tokens) {
        await assertCurrent(current)
        const bound = Math.max(VISION_TOKENS, tokens)
        const cost = budget.attemptCostUsd * bound / budget.attemptTokens
        if (!Number.isFinite(bound) || !Number.isFinite(cost) || remaining!.expiresAt <= Date.now()
          || remaining!.tokens < bound || remaining!.cost < cost) throw new Error('Native image budget exhausted')
        // Synchronous debit after the final await: concurrent uploads cannot
        // both spend the same remaining budget. Never refund failed attempts.
        remaining!.tokens -= bound
        remaining!.cost -= cost
      } }
    } catch { return null }
  }
}
