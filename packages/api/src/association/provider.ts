/** Verified provider object and monetary identity. [COMP:crm/association-provider] */
import { CrmOperationsError } from '@use-brian/core/application-platform/operation-contract.js'
import { AssociationError, type AssociationActor, type AssociationProviderBindingInput } from '@use-brian/core/association/domain.js'

export function requireAssociationProviderActor(actor: AssociationActor): void {
  if (!['api_key', 'brain_key', 'oauth_token', 'integration_key', 'provider', 'system_job'].includes(actor.credentialKind)
    || (actor.credentialKind === 'system_job' && !actor.credentialId.startsWith('association_reconciliation:'))) {
    throw new CrmOperationsError('not_authorized', 'Verified backend provider authority is required.')
  }
}
export type ProviderOrderIdentity = { status: string; provider: string | null; provider_reference: string | null; currency: string; total_minor: string; refunded_minor: string }
export function requireBoundProviderOrderIdentity(order: ProviderOrderIdentity, input: Pick<AssociationProviderBindingInput, 'provider' | 'providerReference'>): void {
  if (order.provider !== input.provider || order.provider_reference !== input.providerReference) {
    throw new AssociationError('conflict', 'The verified provider object does not match the bound Brian order.')
  }
}
export function requireProviderOrderMoney(order: ProviderOrderIdentity, input: AssociationProviderBindingInput): void {
  if (String(input.amountMinor) !== order.total_minor || input.currency !== order.currency || input.amountMinor === 0) {
    throw new AssociationError('conflict', 'Provider amount and currency must match a nonzero Brian order.')
  }
}
export function requireBoundProviderOrder(order: ProviderOrderIdentity, input: AssociationProviderBindingInput): void {
  requireProviderOrderMoney(order, input)
  requireBoundProviderOrderIdentity(order, input)
}
