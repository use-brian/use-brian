import type { AccessContext } from './access-context.js'
import { intersectScopeGrants, type ScopeGrant } from './context-scope.js'
import { isSensitivity, minSensitivity, RANK, type Sensitivity } from './sensitivity.js'

/** Trusted server snapshot. Null is explicit universe; no axis may be absent. */
export type AccessCeiling = {
  workspaceId: string
  userId: string
  clearance: Sensitivity
  compartments: ScopeGrant
  mutationCompartments: ScopeGrant
  projectIds: ScopeGrant
  visibilityAssistantIds: ScopeGrant
}

/** Durable consent captured from an attended authoring turn. */
export type AuthoringAuthority = {
  version: 1
  assistantId: string
  ceiling: AccessCeiling
}

function grant(value: unknown): ScopeGrant {
  if(value===null)return null
  if(!Array.isArray(value)||value.some(v=>typeof v!=='string'||!v.trim()))throw new Error('access_ceiling_missing')
  return [...new Set(value)].sort()
}

export function pinAccessCeiling(context: AccessContext): AccessCeiling {
  if(typeof context.workspaceId!=='string'||!context.userId||!context.assistantId
    ||!['primary','standard','app'].includes(context.assistantKind)||!isSensitivity(context.clearance)) {
    throw new Error('access_ceiling_missing')
  }
  return {
    workspaceId:context.workspaceId,userId:context.userId,clearance:context.clearance,
    compartments:grant(context.compartments),
    mutationCompartments:intersectScopeGrants(grant(context.compartments),grant(context.mutationCompartments===undefined?context.compartments:context.mutationCompartments)),
    projectIds:grant(context.projectIds),
    visibilityAssistantIds:intersectScopeGrants(
      context.assistantKind==='primary'?null:[context.assistantId],
      context.visibilityAssistantIds===undefined?null:grant(context.visibilityAssistantIds),
    ),
  }
}

export function pinAuthoringAuthority(context: AccessContext): AuthoringAuthority {
  return { version: 1, assistantId: context.assistantId, ceiling: pinAccessCeiling(context) }
}

/** Parse persisted JSON without accepting partial or model-authored authority. */
export function parseAuthoringAuthority(value: unknown): AuthoringAuthority | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as { version?: unknown; assistantId?: unknown; ceiling?: unknown }
  if (candidate.version !== 1 || typeof candidate.assistantId !== 'string' || !candidate.assistantId) return null
  if (!candidate.ceiling || typeof candidate.ceiling !== 'object') return null
  const ceiling = candidate.ceiling as AccessCeiling
  try {
    if (!ceiling.workspaceId || !ceiling.userId || !isSensitivity(ceiling.clearance)) return null
    const normalized: AccessCeiling = {
      workspaceId: ceiling.workspaceId,
      userId: ceiling.userId,
      clearance: ceiling.clearance,
      compartments: grant(ceiling.compartments),
      mutationCompartments: grant(ceiling.mutationCompartments),
      projectIds: grant(ceiling.projectIds),
      visibilityAssistantIds: grant(ceiling.visibilityAssistantIds),
    }
    return { version: 1, assistantId: candidate.assistantId, ceiling: normalized }
  } catch {
    return null
  }
}

export function intersectAccessCeilings(a: AccessCeiling,b: AccessCeiling): AccessCeiling {
  if(a.workspaceId!==b.workspaceId||a.userId!==b.userId)throw new Error('access_actor_mismatch')
  if(!isSensitivity(a.clearance)||!isSensitivity(b.clearance))throw new Error('access_ceiling_missing')
  return {workspaceId:a.workspaceId,userId:a.userId,clearance:minSensitivity(a.clearance,b.clearance),
    compartments:intersectScopeGrants(grant(a.compartments),grant(b.compartments)),
    mutationCompartments:intersectScopeGrants(grant(a.mutationCompartments),grant(b.mutationCompartments),grant(a.compartments),grant(b.compartments)),
    projectIds:intersectScopeGrants(grant(a.projectIds),grant(b.projectIds)),
    visibilityAssistantIds:intersectScopeGrants(grant(a.visibilityAssistantIds),grant(b.visibilityAssistantIds)),
  }
}

/** Used after re-resolution: a broader current grant never widens a running turn. */
export function accessCeilingContains(current:AccessCeiling,starting:AccessCeiling):boolean {
  const narrowed=intersectAccessCeilings(current,starting)
  const contains=(a:ScopeGrant,b:ScopeGrant)=>a===null?b===null:b!==null&&a.length===b.length&&a.every(v=>b.includes(v))
  return RANK[narrowed.clearance]>=RANK[starting.clearance]
    &&contains(narrowed.compartments,grant(starting.compartments))
    &&contains(narrowed.mutationCompartments,grant(starting.mutationCompartments))
    &&contains(narrowed.projectIds,grant(starting.projectIds))
    &&contains(narrowed.visibilityAssistantIds,grant(starting.visibilityAssistantIds))
}
