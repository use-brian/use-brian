import {
  ContextScopeAccumulator, deriveResourceScope, intersectAccessCeilings, scopeGrantContains, RANK, isSensitivity,
  type AccessCeiling, type ResourceScope, type ScopeEvidence,
} from '@use-brian/core'
import { getPool } from '../db/client.js'
import { validateDerivedMemoryInputs } from '../db/derived-scope-store.js'

function unavailable(): Error {
  return Object.assign(new Error('The source context is unavailable. Start a new request with current access.'), {
    reason:'caller_evidence_unavailable', retrySafe:false,
  })
}

/** Trusted transport metadata, revalidated before model use and lease renewal. */
export async function validateCallerScopeEvidence(evidence: ScopeEvidence, ceiling: AccessCeiling): Promise<ScopeEvidence> {
  try {
    ceiling=intersectAccessCeilings(ceiling,ceiling)
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw unavailable()
    if (evidence.sensitivity !== undefined && !isSensitivity(evidence.sensitivity)) throw unavailable()
    for (const labels of [evidence.compartments,evidence.projectIds]) {
      if (labels !== undefined && (!Array.isArray(labels) || labels.some(value=>typeof value!=='string'||!value.trim()))) throw unavailable()
    }
    if (evidence.sources !== undefined && !Array.isArray(evidence.sources)) throw unavailable()
    // Detach before any await: later caller mutations cannot erase the floor.
    const snapshot = new ContextScopeAccumulator(structuredClone(evidence)).evidence
    const floor: ResourceScope = snapshot.sources?.length
      ? deriveResourceScope({ producer:'consult',sources:snapshot.sources })
      : { workspaceId:ceiling.workspaceId,userId:null,assistantId:null,sensitivity:'public',compartments:[],projectIds:[] }
    if (floor.workspaceId!==ceiling.workspaceId || (floor.userId!==null&&floor.userId!==ceiling.userId)
      || (floor.assistantId!==null&&!scopeGrantContains(ceiling.visibilityAssistantIds,[floor.assistantId]))
      || RANK[snapshot.sensitivity!]>RANK[ceiling.clearance]
      || !scopeGrantContains(ceiling.compartments,snapshot.compartments)
      || !scopeGrantContains(ceiling.projectIds,snapshot.projectIds)) throw unavailable()
    if (snapshot.sources?.length) {
      const client=await getPool().connect()
      try {
        await client.query('BEGIN')
        await validateDerivedMemoryInputs(client,{producer:'consult',sources:snapshot.sources})
        await client.query('COMMIT')
      } catch(error) { await client.query('ROLLBACK').catch(()=>{});throw error }
      finally { client.release() }
    }
    return snapshot
  } catch { throw unavailable() }
}
