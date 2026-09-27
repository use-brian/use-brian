/** Departmental activation requires more than the existing v1 Team/Project checks.
 * [COMP:api/departmental-readiness]
 */
import type { DepartmentalReadiness } from '@use-brian/shared'
import { CONTEXT_SCOPE_ENFORCEMENT_VERSION, getContextReadinessSystem, type ContextReadiness, type ContextReadinessCheckId, type ReadinessQuery } from '../context-scope/context-readiness.js'

const REQUIRED_VERSION = 2
const REQUIRED_CAPABILITIES: readonly ContextReadinessCheckId[] = [
  'row_store_coverage', 'turn_entry_points', 'write_inheritance',
  'session_isolation', 'teamspace_agent_access', 'connectors', 'ingest',
  'background_lanes', 'derived_writes', 'delegation', 'operation_separation',
  'replay_delivery', 'grant_expiry', 'org_references', 'scope_review',
]

/** Missing, duplicated or nonblocking required evidence cannot certify a release. */
export function departmentalReadiness(evidence: ContextReadiness): DepartmentalReadiness {
  const missing = new Set<string>()
  if (!Number.isInteger(evidence.enforcementVersion) || evidence.enforcementVersion < REQUIRED_VERSION) {
    missing.add('enforcement_version')
  }
  for (const id of REQUIRED_CAPABILITIES) {
    const rows = evidence.checks.filter(check => check.id === id)
    if (rows.length !== 1 || !rows[0].ready || !rows[0].blocking) missing.add(id)
  }
  for (const check of evidence.checks) if (check.blocking && !check.ready) missing.add(check.id)
  if (!evidence.readyForActivation) missing.add('context_activation')
  return {
    ready: missing.size === 0,
    enforcementVersion: evidence.enforcementVersion,
    requiredEnforcementVersion: REQUIRED_VERSION,
    missingCapabilities: [...missing],
  }
}

/** The transaction's query port keeps schema/review evidence with its command.
 * No environment, request body or workspace setting can substitute this report.
 * v1 deliberately remains blocked until complete v2 probes and CI coverage exist.
 */
export async function getDepartmentalReadinessSystem(
  workspaceId: string,
  queryFn?: ReadinessQuery,
): Promise<DepartmentalReadiness> {
  // A known-old binary cannot qualify. Avoid full inventory scans on every
  // access-panel refresh just to rediscover that immutable release fact.
  if (CONTEXT_SCOPE_ENFORCEMENT_VERSION < REQUIRED_VERSION) {
    return departmentalReadiness({ enforcementVersion: CONTEXT_SCOPE_ENFORCEMENT_VERSION,
      readyForActivation: false, checks: [], legacyGeneral: {} })
  }
  return departmentalReadiness(await getContextReadinessSystem(workspaceId, queryFn))
}
