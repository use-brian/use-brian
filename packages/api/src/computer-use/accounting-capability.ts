import type { UsageStore, TokenUsage } from '@use-brian/core'
import { calculateCost } from '@use-brian/core'
import { modelRates, registryRowForPricing } from '@use-brian/shared/model-registry'
import { freezeNativePrice, nativeAccountingHash, NativeUsageReceiptSchema, type NativeAccountingCapability, type NativeAccountingKey, type NativeBillingPrice, type NativeUsageReceipt } from './accounting.js'

// Explicit registration, not duck typing or an inference from void store success.
const capabilities = new WeakMap<UsageStore, NativeAccountingCapability>()
export function registerNativeAccounting(store: UsageStore, capability: NativeAccountingCapability): void { capabilities.set(store, capability) }
export function nativeAccountingFor(store?: UsageStore): NativeAccountingCapability | undefined { return store ? capabilities.get(store) : undefined }

/** Native-only quote. Unknown rates NEVER use calculateCost's generic fallback.
 * Only actual identity prices usage; requested aliases are not accepted here.
 * calculatedCostUsd is an adapter estimate/override, NOT provider provenance.
 * DecisionUsage.costUsd likewise carries no provenance. Neither can bypass the
 * known-rate check or be handed to calculateCost's override/fallback branches.
 * The current Jev transport exposes tokens, not a verified provider cost. */
export function nativePrice(model: string | null, usage: TokenUsage | undefined, keySource: 'user' | 'platform') {
  const rates = model ? modelRates(model) : undefined
  const incurred = !usage ? null : (model && rates ? calculateCost(model, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens }) : null)
  const estimated = !usage ? null : keySource === 'user' ? 0 : incurred
  let price: NativeBillingPrice | null = null
  if (model && usage && estimated !== null) {
    const basis = keySource === 'user' ? 'byok' : 'registry'
    // Registry's Infinity bracket endpoint is an explicit unbounded marker.
    const snapshot = rates ? { ...rates, brackets: rates.brackets.map(b => ({ ...b, upToInputTokens: Number.isFinite(b.upToInputTokens) ? b.upToInputTokens : 'unbounded' })) } : null
    price = freezeNativePrice(estimated, { basis, policyVersion: 'native-usage-v1', rateSnapshotHash: basis === 'registry' ? nativeAccountingHash(snapshot) : null })
  }
  return { incurred, estimated, price, modelTier: (model ? registryRowForPricing(model)?.tier : undefined) ?? 'standard' as const }
}
export function validatedNativeReceipt(value: unknown, key: NativeAccountingKey, intentHash: string): NativeUsageReceipt | undefined {
  const parsed = NativeUsageReceiptSchema.safeParse(value)
  if (!parsed.success || parsed.data.key.nativeSessionId !== key.nativeSessionId || parsed.data.key.invocationId !== key.invocationId || parsed.data.intentHash !== intentHash) return undefined
  return Object.freeze({ ...parsed.data, key: Object.freeze({ ...parsed.data.key }) })
}
