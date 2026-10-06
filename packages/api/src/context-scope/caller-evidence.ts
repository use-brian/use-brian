import {
  ContextScopeAccumulator, intersectAccessCeilings, maxSensitivity, scopeGrantContains, RANK, isSensitivity,
  type AccessCeiling, type ResourceScope, type ScopeEvidence,
} from '@use-brian/core'
import { getPool } from '../db/client.js'
import { readCurrentScopeSources } from '../db/derived-scope-store.js'

/**
 * Why evidence could not be admitted. Internal only: it reaches logs and
 * analytics metadata, never the model or the client, because a finer reason
 * would tell a caller which hidden axis it crossed.
 */
export type ScopeEvidenceFailure =
  | 'shape'
  | 'workspace'
  | 'user_visibility'
  | 'assistant_visibility'
  | 'clearance'
  | 'teams'
  | 'projects'
  | 'source_held'
  | 'source_reclassified'
  | 'source_changed'
  | 'source_unverifiable'
  /** Not a policy decision: the check itself failed (e.g. a pool timeout). */
  | 'verification_error'

export type ScopeEvidenceError = Error & {
  reason: 'caller_evidence_unavailable' | 'delivery_audience_unverified'
  retrySafe: false
  diagnostic: ScopeEvidenceFailure
}

function unavailable(kind: 'caller' | 'audience', diagnostic: ScopeEvidenceFailure, cause?: unknown): ScopeEvidenceError {
  return Object.assign(new Error(kind === 'caller'
    ? 'The source context is unavailable. Start a new request with current access.'
    : 'The destination audience cannot receive this output under its current access.', cause === undefined ? undefined : { cause }), {
    reason: kind === 'caller' ? 'caller_evidence_unavailable' as const : 'delivery_audience_unverified' as const,
    retrySafe: false as const,
    diagnostic,
  })
}

export function scopeEvidenceFailureOf(error: unknown): ScopeEvidenceFailure | undefined {
  const diagnostic = (error as { diagnostic?: unknown } | null)?.diagnostic
  return typeof diagnostic === 'string' ? diagnostic as ScopeEvidenceFailure : undefined
}

/** One envelope's visibility, judged alone against the receiver. */
function visibilityFailure(scope: ResourceScope, ceiling: AccessCeiling): ScopeEvidenceFailure | null {
  if (scope.workspaceId !== ceiling.workspaceId) return 'workspace'
  if (scope.userId !== null && scope.userId !== ceiling.userId) return 'user_visibility'
  if (!ceiling.departmentRead && scope.assistantId !== null && !scopeGrantContains(ceiling.visibilityAssistantIds, [scope.assistantId])) {
    return 'assistant_visibility'
  }
  return null
}

function labelFailure(
  labels: Pick<ResourceScope, 'sensitivity' | 'compartments' | 'projectIds'>,
  ceiling: AccessCeiling,
): ScopeEvidenceFailure | null {
  const v2=ceiling.departmentRead
  if(v2){
    const departments=labels.compartments.filter(label=>label.startsWith('team:')).map(label=>label.slice(5))
    if(departments.some(id=>!Object.hasOwn(v2.departments,id)
      || v2.contextDepartment!==null && v2.contextDepartment!==id
      || v2.binding!==null && !v2.binding.includes(id)))return 'teams'
    if(RANK[labels.sensitivity]>RANK[v2.cap??'confidential']
      || (departments.length===0 ? RANK[labels.sensitivity]>RANK[v2.base]
        : departments.some(id=>RANK[labels.sensitivity]>RANK[v2.departments[id]])))return 'clearance'
    return null
  }
  if (RANK[labels.sensitivity] > RANK[ceiling.clearance]) return 'clearance'
  if (!scopeGrantContains(ceiling.compartments, labels.compartments)) return 'teams'
  if (!scopeGrantContains(ceiling.projectIds, labels.projectIds)) return 'projects'
  return null
}

async function validateScopeEvidence(
  evidence: ScopeEvidence,
  ceiling: AccessCeiling,
  kind: 'caller' | 'audience',
): Promise<ScopeEvidence> {
  let failure: ScopeEvidenceFailure | null = null
  let snapshot: ScopeEvidence
  try {
    ceiling=intersectAccessCeilings(ceiling,ceiling)
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw unavailable(kind, 'shape')
    if (evidence.sensitivity !== undefined && !isSensitivity(evidence.sensitivity)) throw unavailable(kind, 'shape')
    for (const labels of [evidence.compartments,evidence.projectIds]) {
      if (labels !== undefined && (!Array.isArray(labels) || labels.some(value=>typeof value!=='string'||!value.trim()))) throw unavailable(kind, 'shape')
    }
    if (evidence.sources !== undefined && !Array.isArray(evidence.sources)) throw unavailable(kind, 'shape')
    // Detach before any await: later caller mutations cannot erase the floor.
    snapshot = new ContextScopeAccumulator(structuredClone(evidence)).evidence
  } catch (error) {
    throw scopeEvidenceFailureOf(error) ? error : unavailable(kind, 'shape', error)
  }

  // Each source must be visible to the receiver on its own. Never intersect
  // their visibility into one envelope: a primary's read evidence spans the
  // same user's rows other assistants own, which no single row can represent
  // (scoped-context.md -> "Reading is not deriving").
  const sources = snapshot.sources ?? []
  for (const source of sources) failure ??= visibilityFailure(source, ceiling) ?? labelFailure(source, ceiling)
  failure ??= labelFailure({
    sensitivity: snapshot.sensitivity ?? 'public',
    compartments: snapshot.compartments ?? [],
    projectIds: snapshot.projectIds ?? [],
  }, ceiling)
  if (failure) throw unavailable(kind, failure)
  if (!sources.length) return snapshot

  // Current-label revalidation (decision D1): an edit, supersession or delete
  // after the read never blocks by itself - often the turn made that change
  // (list then close a task). A held source, or one whose CURRENT envelope
  // no longer fits the receiver, does. Exact-version lineage is the derived
  // writer's rule (`revalidateScopeSources`), not the audience's.
  let states: Awaited<ReturnType<typeof readCurrentScopeSources>>
  try {
    states = await readCurrentScopeSources(getPool(), ceiling.workspaceId, sources)
  } catch (error) {
    throw unavailable(kind, 'verification_error', error)
  }
  const raised: ScopeEvidence = { ...snapshot }
  for (const state of states) {
    if (state.state === 'held') throw unavailable(kind, 'source_held')
    if (state.state === 'unverifiable') throw unavailable(kind, 'source_unverifiable')
    if (state.state === 'stale_input') throw unavailable(kind, 'source_changed')
    if (state.state !== 'changed') continue
    const current = state.current
    if (visibilityFailure(current, ceiling) || labelFailure(current, ceiling)) {
      throw unavailable(kind, 'source_reclassified')
    }
    // High-water: the receiver's evidence carries both the read labels and
    // the source's current ones.
    raised.sensitivity = maxSensitivity(raised.sensitivity ?? 'public', current.sensitivity)
    raised.compartments = [...new Set([...(raised.compartments ?? []), ...current.compartments])].sort()
    raised.projectIds = [...new Set([...(raised.projectIds ?? []), ...current.projectIds])].sort()
  }
  return raised
}

/** Trusted transport metadata, revalidated before model use and lease renewal. */
export async function validateCallerScopeEvidence(evidence: ScopeEvidence, ceiling: AccessCeiling): Promise<ScopeEvidence> {
  return validateScopeEvidence(evidence, ceiling, 'caller')
}

/** Final output evidence checked against the current destination audience. */
export async function validateAudienceScopeEvidence(evidence: ScopeEvidence, ceiling: AccessCeiling): Promise<ScopeEvidence> {
  return validateScopeEvidence(evidence, ceiling, 'audience')
}
