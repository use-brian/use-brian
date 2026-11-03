/** Private audited transport scheduling. [COMP:decisions/hydra] */
import type { DecisionProvider, DecisionRequest } from './types.js'

const owners = new WeakMap<DecisionProvider, DecisionProvider['evaluate']>()
const capacityOwners = new WeakMap<DecisionProvider, { evaluate: DecisionProvider['evaluate']; capabilities: DecisionProvider['capabilities']; bytes: string }>()
const budgets = new WeakMap<DecisionRequest, number>()

/** Only the built-in fetch adapter calls this; no public marker grants trust. */
export function registerDecisionTransportOwner(provider: DecisionProvider, canonicalInputCapacity = false): DecisionProvider {
  owners.set(provider, provider.evaluate)
  if (canonicalInputCapacity) capacityOwners.set(provider, { evaluate: provider.evaluate, capabilities: provider.capabilities, bytes: JSON.stringify(provider.capabilities) })
  return provider
}

/** Capture the actual implementation before any asynchronous preparation. */
export function captureDecisionTransport(provider: DecisionProvider): DecisionProvider {
  const evaluate = provider.evaluate
  const captured = { id: provider.id, capabilities: provider.capabilities, evaluate: evaluate.bind(provider) }
  return owners.get(provider) === evaluate ? registerDecisionTransportOwner(captured, ownsDecisionInputCapacity(provider)) : captured
}

/** Exact default adapter metadata, never a caller-selected capacity claim. */
export function ownsDecisionInputCapacity(provider: DecisionProvider): boolean {
  const entry = capacityOwners.get(provider)
  return !!entry && entry.evaluate === provider.evaluate && entry.capabilities === provider.capabilities
    && entry.bytes === JSON.stringify(provider.capabilities)
}

export function ownsDecisionTransportBudget(provider: DecisionProvider): boolean {
  return owners.get(provider) === provider.evaluate
}

export function bindDecisionTransportBudget(request: DecisionRequest, milliseconds: number): DecisionRequest {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new Error('Invalid decision transport budget')
  budgets.set(request, milliseconds)
  return request
}

export function decisionTransportBudget(request: DecisionRequest): number | undefined {
  return budgets.get(request)
}
