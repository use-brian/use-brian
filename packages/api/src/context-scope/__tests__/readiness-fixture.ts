/** Complete readiness evidence for route tests. The binding gate is
 * fail-closed on missing checks, so a mock must carry every check id.
 * [COMP:api/context-scope-routes] */
import type { ContextReadiness, ContextReadinessCheckId } from '../context-readiness.js'

const IDS: ContextReadinessCheckId[] = [
  'row_store_coverage', 'turn_entry_points', 'write_inheritance',
  'session_isolation', 'teamspace_agent_access', 'connectors', 'ingest',
  'background_lanes', 'legacy_data', 'derived_writes', 'delegation',
  'operation_separation', 'replay_delivery', 'grant_expiry', 'org_references',
  'scope_review',
]

export function contextReadinessFixture(failing: ContextReadinessCheckId[] = []): ContextReadiness {
  const checks = IDS.map((id) => ({
    id,
    ready: !failing.includes(id),
    blocking: id !== 'legacy_data',
    detail: failing.includes(id) ? 'missing' : 'ok',
  }))
  return {
    enforcementVersion: 2,
    readyForActivation: checks.every((check) => !check.blocking || check.ready),
    checks,
    legacyGeneral: {},
  }
}
