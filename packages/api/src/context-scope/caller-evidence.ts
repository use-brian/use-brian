import {
  ContextScopeAccumulator, intersectAccessCeilings, scopeGrantContains, RANK, isSensitivity,
  type AccessCeiling, type ScopeEvidence,
} from '@use-brian/core'
import { getPool } from '../db/client.js'
import { revalidateScopeSources } from '../db/derived-scope-store.js'

function unavailable(kind: 'caller' | 'audience' = 'caller'): Error {
  return Object.assign(new Error(kind === 'caller'
    ? 'The source context is unavailable. Start a new request with current access.'
    : 'The destination audience cannot receive this output under its current access.'), {
    reason: kind === 'caller' ? 'caller_evidence_unavailable' : 'delivery_audience_unverified', retrySafe:false,
  })
}

async function validateScopeEvidence(
  evidence: ScopeEvidence,
  ceiling: AccessCeiling,
  kind: 'caller' | 'audience',
): Promise<ScopeEvidence> {
  try {
    ceiling=intersectAccessCeilings(ceiling,ceiling)
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw unavailable(kind)
    if (evidence.sensitivity !== undefined && !isSensitivity(evidence.sensitivity)) throw unavailable(kind)
    for (const labels of [evidence.compartments,evidence.projectIds]) {
      if (labels !== undefined && (!Array.isArray(labels) || labels.some(value=>typeof value!=='string'||!value.trim()))) throw unavailable(kind)
    }
    if (evidence.sources !== undefined && !Array.isArray(evidence.sources)) throw unavailable(kind)
    // Detach before any await: later caller mutations cannot erase the floor.
    const snapshot = new ContextScopeAccumulator(structuredClone(evidence)).evidence
    // Each source must be visible to the receiver on its own. Never intersect
    // their visibility into one envelope: a primary's read evidence spans the
    // same user's rows other assistants own, which no single row can represent
    // (scoped-context.md -> "Reading is not deriving").
    const sources = snapshot.sources ?? []
    if (sources.some(source => source.workspaceId!==ceiling.workspaceId
      || (source.userId!==null&&source.userId!==ceiling.userId)
      || (source.assistantId!==null&&!scopeGrantContains(ceiling.visibilityAssistantIds,[source.assistantId])))
      || RANK[snapshot.sensitivity!]>RANK[ceiling.clearance]
      || !scopeGrantContains(ceiling.compartments,snapshot.compartments)
      || !scopeGrantContains(ceiling.projectIds,snapshot.projectIds)) throw unavailable(kind)
    if (sources.length) {
      const client=await getPool().connect()
      try {
        await client.query('BEGIN')
        await revalidateScopeSources(client,ceiling.workspaceId,sources)
        await client.query('COMMIT')
      } catch(error) { await client.query('ROLLBACK').catch(()=>{});throw error }
      finally { client.release() }
    }
    return snapshot
  } catch { throw unavailable(kind) }
}

/** Trusted transport metadata, revalidated before model use and lease renewal. */
export async function validateCallerScopeEvidence(evidence: ScopeEvidence, ceiling: AccessCeiling): Promise<ScopeEvidence> {
  return validateScopeEvidence(evidence, ceiling, 'caller')
}

/** Final output evidence checked against the current destination audience. */
export async function validateAudienceScopeEvidence(evidence: ScopeEvidence, ceiling: AccessCeiling): Promise<ScopeEvidence> {
  return validateScopeEvidence(evidence, ceiling, 'audience')
}
