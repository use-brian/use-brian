/** Private audited transport scheduling. [COMP:decisions/hydra] */
import type { DecisionProvider, DecisionRequest } from './types.js'

const owners = new WeakMap<DecisionProvider, DecisionProvider['evaluate']>()
const budgets = new WeakMap<DecisionRequest, number>()

/** Only the built-in fetch adapter calls this; no public marker grants trust. */
export function registerDecisionTransportOwner(provider: DecisionProvider): DecisionProvider {
  owners.set(provider, provider.evaluate)
  return provider
}

/** Capture the actual implementation before any asynchronous preparation. */
export function captureDecisionTransport(provider: DecisionProvider): DecisionProvider {
  const evaluate = provider.evaluate
  const captured = { id: provider.id, capabilities: provider.capabilities, evaluate: evaluate.bind(provider) }
  return owners.get(provider) === evaluate ? registerDecisionTransportOwner(captured) : captured
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
