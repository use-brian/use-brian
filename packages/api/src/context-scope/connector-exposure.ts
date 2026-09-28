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

import { intersectScopeGrants, scopeGrantContains, type ScopeGrant } from '@use-brian/core'
import { currentAgentAccess } from '../db/agent-access-context.js'

export type ConnectorContextBinding = {
  compartments: readonly string[]
  projectIds: readonly string[]
}

export type ConnectorTurnGrant = {
  effectiveCompartments: ScopeGrant
  effectiveProjectIds: ScopeGrant
  /** Present on the canonical TurnScope. Missing preserves legacy membership reach. */
  access?: { mutationCompartments?: ScopeGrant }
}

export type ConnectorOperationBoundary = 'provider-catalog' | 'fixed-operation'

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
  boundary: ConnectorOperationBoundary = 'provider-catalog',
): boolean {
  const ambient = currentAgentAccess()
  // Only non-agent administrative callers may omit a trusted execution scope.
  if (!turn && !ambient) return true
  const read = intersectScopeGrants(
    turn?.effectiveCompartments ?? null,
    // A clearance-only agent wrapper is not authority to access live connectors.
    ambient ? ambient.compartments === undefined ? [] : ambient.compartments : null,
  )
  const mutation = intersectScopeGrants(
    read,
    turn?.access?.mutationCompartments === undefined
      ? turn?.effectiveCompartments ?? null : turn.access.mutationCompartments,
    ambient ? ambient.mutationCompartments === undefined
      ? ambient.compartments === undefined ? [] : ambient.compartments : ambient.mutationCompartments : null,
  )
  const projects = intersectScopeGrants(
    turn?.effectiveProjectIds ?? null,
    ambient ? ambient.projectIds === undefined ? [] : ambient.projectIds : null,
  )
  if (!axisExposureAllowed(mutation, binding.compartments)
      || !axisExposureAllowed(projects, binding.projectIds)) return false
  // Team/Project bindings prove Brian-side reach, not a provider-native root.
  // Generic provider catalogs therefore require company-wide authority. The
  // fixed-operation exception is selected by audited code, never tool metadata.
  return boundary === 'fixed-operation'
    || (read === null && mutation === null && projects === null)
}
