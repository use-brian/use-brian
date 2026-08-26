/**
 * Live connector exposure gate. A connector is data outside Brian's row-level
 * predicates, so a finite Team/Project turn may only receive an exposure that
 * is itself finite and wholly inside that turn's grant.
 *
 * Empty connector arrays mean unbounded/company-wide, never Workspace
 * General. They are therefore usable only when the turn grant is universe on
 * that axis. This is intentionally stricter than model-side filtering.
 *
 * [COMP:api/connector-context]
 */

import { scopeGrantContains, type ScopeGrant } from '@use-brian/core'

export type ConnectorContextBinding = {
  compartments: readonly string[]
  projectIds: readonly string[]
}

export type ConnectorTurnGrant = {
  effectiveCompartments: ScopeGrant
  effectiveProjectIds: ScopeGrant
}

function axisExposureAllowed(
  turnGrant: ScopeGrant,
  exposure: readonly string[],
): boolean {
  if (turnGrant === null) return true
  if (exposure.length === 0) return false
  return scopeGrantContains(turnGrant, exposure)
}

export function connectorExposureAllowed(
  turn: ConnectorTurnGrant | null | undefined,
  binding: ConnectorContextBinding,
): boolean {
  // Compatibility for non-model/admin callers. The graded entry-point check
  // requires every execution overlay to pass the trusted TurnScope.
  if (!turn) return true
  return axisExposureAllowed(turn.effectiveCompartments, binding.compartments)
    && axisExposureAllowed(turn.effectiveProjectIds, binding.projectIds)
}

