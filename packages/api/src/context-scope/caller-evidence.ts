import { readNativeSessionEvidence } from '../application-platform/native-session-evidence.js'
import { readPersistentSessionContextAncestors } from '../db/session-context-ancestry.js'
import {
  ContextScopeAccumulator, intersectAccessCeilings, maxSensitivity, scopeGrantContains, resourceScopeKey, RANK, isSensitivity,
  type AccessCeiling, type ResourceScope, type ScopeEvidence, type ScopeSource,
} from '@use-brian/core'
import { getPool } from '../db/client.js'
import { readExternalSourceAncestors } from '../application-platform/external-source-ancestry.js'
import { readApplicationFieldAncestors } from '../application-platform/field-evidence.js'
import { readCurrentScopeSources } from '../db/derived-scope-store.js'
import type { PoolClient } from 'pg'

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
  if (scope.assistantId !== null && !scopeGrantContains(ceiling.visibilityAssistantIds, [scope.assistantId])) {
    return 'assistant_visibility'
  }
  return null
}

function labelFailure(
  labels: Pick<ResourceScope, 'sensitivity' | 'compartments' | 'projectIds'>,
  ceiling: AccessCeiling,
): ScopeEvidenceFailure | null {
  if (!scopeGrantContains(ceiling.projectIds, labels.projectIds)) return 'projects'
  const v2=ceiling.departmentRead
  if(v2){
    const departments=labels.compartments.filter(label=>label.startsWith('team:')).map(label=>label.slice(5))
    if(departments.some(id=>!Object.hasOwn(v2.departments,id)
      || v2.contextDepartment!==null && v2.contextDepartment!==id
      || v2.binding!==null && !v2.binding.includes(id)))return 'teams'
    // Shared Project labels: admitted for this ceiling (member or read
    // oversight) and inside a credential binding; never a tier.
    const projects=labels.compartments.filter(label=>label.startsWith('project:')).map(label=>label.slice(8))
    if(projects.some(id=>!v2.projects?.[id] || v2.binding!==null && !v2.binding.includes(id)))return 'teams'
    if(RANK[labels.sensitivity]>RANK[v2.cap??'confidential']
      || (departments.length===0 ? RANK[labels.sensitivity]>RANK[v2.base]
        : departments.some(id=>RANK[labels.sensitivity]>RANK[v2.departments[id]])))return 'clearance'
    return null
  }
  if (RANK[labels.sensitivity] > RANK[ceiling.clearance]) return 'clearance'
  // A legacy ceiling has no Project admission, even as a universe grant.
  if (labels.compartments.some(label => label.startsWith('project:'))) return 'teams'
  if (!scopeGrantContains(ceiling.compartments, labels.compartments)) return 'teams'
  return null
}

function validateScopeEvidence(evidence:ScopeEvidence,ceiling:AccessCeiling,kind:'caller'|'audience',client:Pick<PoolClient,'query'>|undefined,workflowRunId:string|undefined,nativeOnly:true):Promise<ScopeEvidence|null>
function validateScopeEvidence(evidence:ScopeEvidence,ceiling:AccessCeiling,kind:'caller'|'audience',client?:Pick<PoolClient,'query'>,workflowRunId?:string,nativeOnly?:false):Promise<ScopeEvidence>
async function validateScopeEvidence(
  evidence: ScopeEvidence,
  ceiling: AccessCeiling,
  kind: 'caller' | 'audience',
  client?: Pick<PoolClient, 'query'>,
  workflowRunId?: string,
  nativeOnly = false,
): Promise<ScopeEvidence|null> {
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
  let sources = snapshot.sources ?? []
  const originalSources=structuredClone(sources)
  for (const source of sources) failure ??= visibilityFailure(source, ceiling) ?? labelFailure(source, ceiling)
  failure ??= labelFailure({
    sensitivity: snapshot.sensitivity ?? 'public',
    compartments: snapshot.compartments ?? [],
    projectIds: snapshot.projectIds ?? [],
  }, ceiling)
  if (failure) throw unavailable(kind, failure)
  if (!sources.length) return nativeOnly ? null : snapshot
  if (!client && sources.some(source=>source.resourceKind==='session_context_revision')) throw unavailable(kind,'source_unverifiable')
  // The closed native facade performs the same current checks in one SQL
  // statement. Mixed families and workflow-run profiles retain the original
  // validator below, including independent source and Page admission.
  if (client && !workflowRunId) {
    try {
      const native = await readNativeSessionEvidence(client, ceiling.workspaceId, sources)
      if (native?.kind==='complete') {
        const expanded = new ContextScopeAccumulator(snapshot)
        expanded.note(native.evidence)
        for (const source of [...native.evidence.sources ?? [], ...native.current]) {
          failure ??= visibilityFailure(source, ceiling) ?? labelFailure(source, ceiling)
        }
        if (failure) throw unavailable(kind, failure)
        for (const current of native.current) expanded.note({ sensitivity: current.sensitivity,
          compartments: current.compartments, projectIds: current.projectIds })
        return expanded.evidence
      }
    } catch (error) { throw scopeEvidenceFailureOf(error) ? error : unavailable(kind, 'source_unverifiable', error) }
  }
  if (nativeOnly) return null
  // A history subset carries only checked scopes. It never admits the whole
  // input set or adds its internally qualified old references as factual roots.
  const historyKey=(values:unknown)=>JSON.stringify(values)
  const projectHistory=async(inputRoots:readonly ScopeSource[])=>{
    const roots=structuredClone(inputRoots)
    const scopes:Array<{root:ScopeSource;scopes:ResourceScope[]}>=[]
    if(!client)return scopes
    const fields=roots.filter(source=>source.resourceKind==='application_field')
    if(!fields.length)return scopes
    // Metadata discovery grants nothing. Probing every ordinary field with the
    // history RPC recursively validates its entire closure just to determine
    // that it is not history, four times across the initial/final checks.
    // Skip only positively identified immutable non-history selectors. An
    // unknown/uncommitted resource still takes its original RPC on this client.
    // Every field keeps full ordinary validation. Repeat discovery at the
    // final footprint check, without caching an authorization result.
    const ordinaryIds=new Set((await getPool().query<{id:string}>(`SELECT id FROM application_field_resources
      WHERE workspace_id=$1 AND id=ANY($2::uuid[])
        AND NOT (origin='{"kind":"native","moduleKey":"native"}'::jsonb
          AND type_key='memory' AND selection='history')`,[ceiling.workspaceId,fields.map(source=>source.resourceId)])).rows.map(row=>row.id))
    for(const source of fields){
      if(ordinaryIds.has(source.resourceId))continue
      const value=await readNativeSessionEvidence(client,ceiling.workspaceId,[source])
      if(value?.kind!=='memory_history')continue
      if(!value.available)throw unavailable(kind,'source_unverifiable')
      if(workflowRunId)throw unavailable(kind,'source_unverifiable')
      for(const scope of value.scopes){
        const refused=visibilityFailure(scope,ceiling)??labelFailure(scope,ceiling)
        if(refused)throw unavailable(kind,refused)
      }
      scopes.push({root:value.root,scopes:value.scopes})
    }
    return scopes
  }
  let historyProjection:Awaited<ReturnType<typeof projectHistory>>
  try{historyProjection=await projectHistory(originalSources)}
  catch(error){throw scopeEvidenceFailureOf(error)?error:unavailable(kind,'source_unverifiable',error)}
  if(historyProjection.length){
    const raised=new ContextScopeAccumulator(snapshot)
    for(const projected of historyProjection)for(const scope of projected.scopes)raised.note({
      sensitivity:scope.sensitivity,compartments:scope.compartments,projectIds:scope.projectIds})
    snapshot=raised.evidence;sources=snapshot.sources??[]
  }
  // Cached native refs retain every immutable context parent. Discovery is
  // metadata only; the caller must still provide a real admitted transaction.
  let persistentAncestry:string
  const persistentKey=(values:readonly ScopeSource[])=>JSON.stringify(values.map(source=>[source.resourceId,source.version,resourceScopeKey(source)]).sort())
  try {
    const persistent=await readPersistentSessionContextAncestors(ceiling.workspaceId,sources,client)
    persistentAncestry=persistentKey(persistent)
    if(persistent.length && !client)throw unavailable(kind,'source_unverifiable')
    const expanded=new ContextScopeAccumulator(snapshot)
    expanded.note({sources:persistent});snapshot=expanded.evidence;sources=snapshot.sources ?? []
    for(const source of persistent)failure ??= visibilityFailure(source,ceiling) ?? labelFailure(source,ceiling)
    if(failure)throw unavailable(kind,failure)
  } catch(error){throw scopeEvidenceFailureOf(error) ? error : unavailable(kind,'source_unverifiable',error)}


  // A native envelope cannot erase its independently authorized source ancestry.
  // This metadata read confers no source rights: current transaction receipts
  // are still required by readCurrentScopeSources below.
  const ancestryRoots = sources
  const ancestryKey = (values: readonly ScopeSource[]) => JSON.stringify(values.map(source => [source.resourceId,source.version,resourceScopeKey(source)]).sort())
  let originalAncestry: string
  let originalFieldAncestry: string
  let projectedHistoryRoots:ScopeSource[]=[]
  let projectedHistory:Awaited<ReturnType<typeof projectHistory>>=[]
  try {
    const fieldAncestors = await readApplicationFieldAncestors(ceiling.workspaceId, ancestryRoots, client)
    originalFieldAncestry = ancestryKey(fieldAncestors)
    if (fieldAncestors.length && !client) throw unavailable(kind, 'source_unverifiable')
    for (const source of fieldAncestors) failure ??= visibilityFailure(source, ceiling) ?? labelFailure(source, ceiling)
    // Only fields admitted on the actual client may supply retained-history
    // label metadata. Keep both fixed root sets for the final footprint check.
    projectedHistoryRoots=structuredClone(fieldAncestors)
    projectedHistory=await projectHistory(projectedHistoryRoots)
    for(const projected of projectedHistory){
      const original=historyProjection.find(value=>value.root.resourceId===projected.root.resourceId)
      if(original&&historyKey(original)!==historyKey(projected))throw unavailable(kind,'source_unverifiable')
    }
    const ancestors = await readExternalSourceAncestors(ceiling.workspaceId, ancestryRoots, client)
    originalAncestry = ancestryKey(ancestors)
    const known = new Map(sources.filter(source => source.resourceKind === 'external_source').map(source => [source.resourceId, source]))
    for (const source of ancestors) {
      const previous = known.get(source.resourceId)
      if (previous && (previous.version !== source.version || resourceScopeKey(previous) !== resourceScopeKey(source))) {
        throw unavailable(kind, 'source_unverifiable')
      }
      failure ??= visibilityFailure(source, ceiling) ?? labelFailure(source, ceiling)
    }
    if (failure) throw unavailable(kind, failure)
    const expanded = new ContextScopeAccumulator(snapshot)
    expanded.note({ sources: [...fieldAncestors,...ancestors] })
    for(const projected of projectedHistory)for(const scope of projected.scopes)expanded.note({
      sensitivity:scope.sensitivity,compartments:scope.compartments,projectIds:scope.projectIds})
    snapshot = expanded.evidence
    sources = snapshot.sources ?? []
  } catch (error) {
    throw scopeEvidenceFailureOf(error) ? error : unavailable(kind, 'source_unverifiable', error)
  }

  // Page receipts carry principal boundaries beyond generic labels. Resolve
  // each immutable observation; never treat a missing receipt as D1 deletion.
  const pageKinds = new Set(['page_event_changed','page_event_destination','page_live_changed','page_live_destination'])
  const ordinarySources = sources.filter(source=>!pageKinds.has(source.resourceKind))
  if (ordinarySources.length) {
    try {
      const { rows } = await (client ?? getPool()).query<{dependencies: ScopeSource[]}>(
        `SELECT ${client ? 'read_admitted_page_dependencies' : 'read_resource_page_dependencies'}($1,t.kind,t.id,t.version) AS dependencies
         FROM unnest($2::text[],$3::uuid[],$4::text[]) t(kind,id,version)`,
        [ceiling.workspaceId,ordinarySources.map(s=>s.resourceKind),ordinarySources.map(s=>s.resourceId),ordinarySources.map(s=>s.version)])
      if (rows.length !== ordinarySources.length || rows.some(row=>!Array.isArray(row.dependencies))) throw unavailable(kind,'source_unverifiable')
      const ancestry = new ContextScopeAccumulator(snapshot)
      ancestry.note({sources:rows.flatMap(row=>row.dependencies)})
      snapshot = ancestry.evidence
      sources = snapshot.sources ?? []
      for (const source of sources) failure ??= visibilityFailure(source,ceiling) ?? labelFailure(source,ceiling)
      if (failure) throw unavailable(kind,failure)
    } catch (error) {
      throw scopeEvidenceFailureOf(error) ? error : unavailable(kind,'verification_error',error)
    }
  }
  const raisedPages = new ContextScopeAccumulator(snapshot)
  try {
    for (const source of sources.filter(source => pageKinds.has(source.resourceKind))) {
      const authority = (await (client ?? getPool()).query<{ authority: {
        source: ScopeSource | null; requiredSources: ScopeSource[]; principalAllowed: boolean
      } | null }>(`SELECT ${client ? 'read_admitted_page_authority' : 'read_page_scope_authority'}($1,$2,$3,$4) AS authority`,
      [ceiling.workspaceId,source.resourceKind,source.resourceId,ceiling.userId])).rows[0]?.authority
      if (!authority?.source || !Array.isArray(authority.requiredSources) || !authority.requiredSources.length
        || !authority.principalAllowed) throw unavailable(kind,'source_unverifiable')
      if (authority.source.version !== source.version || resourceScopeKey(authority.source) !== resourceScopeKey(source)) {
        throw unavailable(kind,'source_changed')
      }
      for (const current of authority.requiredSources) {
        if (visibilityFailure(current,ceiling) || labelFailure(current,ceiling)) throw unavailable(kind,'source_reclassified')
        raisedPages.note({sources:[current]})
      }
    }
  } catch (error) {
    throw scopeEvidenceFailureOf(error) ? error : unavailable(kind,'verification_error',error)
  }

  // Current-label revalidation (decision D1): an edit, supersession or delete
  // after the read never blocks by itself - often the turn made that change
  // (list then close a task). A held source, or one whose CURRENT envelope
  // no longer fits the receiver, does. Exact-version lineage is the derived
  // writer's rule (`revalidateScopeSources`), not the audience's.
  let states: Awaited<ReturnType<typeof readCurrentScopeSources>>
  try {
    states = await readCurrentScopeSources(client ?? getPool(), ceiling.workspaceId, sources.filter(source=>!pageKinds.has(source.resourceKind)), workflowRunId, kind === 'caller' ? 'context' : 'deliver', !!client)
  } catch (error) {
    throw unavailable(kind, 'verification_error', error)
  }
  const raised: ScopeEvidence = raisedPages.evidence
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
  try {
    if(historyKey(await projectHistory(originalSources))!==historyKey(historyProjection)
      ||historyKey(await projectHistory(projectedHistoryRoots))!==historyKey(projectedHistory))throw unavailable(kind,'source_unverifiable')
    if(persistentKey(await readPersistentSessionContextAncestors(ceiling.workspaceId,ancestryRoots,client))!==persistentAncestry!) throw unavailable(kind,'source_unverifiable')
    if (ancestryKey(await readExternalSourceAncestors(ceiling.workspaceId, ancestryRoots, client)) !== originalAncestry!) {
      throw unavailable(kind, 'source_unverifiable')
    }
    if (ancestryKey(await readApplicationFieldAncestors(ceiling.workspaceId, ancestryRoots, client)) !== originalFieldAncestry!) {
      throw unavailable(kind, 'source_unverifiable')
    }
  } catch (error) {
    throw scopeEvidenceFailureOf(error) ? error : unavailable(kind, 'source_unverifiable', error)
  }
  return raised
}

/** Trusted transport metadata, revalidated before model use and lease renewal. */
export async function validateCallerScopeEvidence(evidence: ScopeEvidence, ceiling: AccessCeiling, client?: Pick<PoolClient, 'query'>, workflowRunId?: string): Promise<ScopeEvidence> {
  return validateScopeEvidence(evidence, ceiling, 'caller', client, workflowRunId)
}

/** Final output evidence checked against the current destination audience. */
export async function validateAudienceScopeEvidence(evidence: ScopeEvidence, ceiling: AccessCeiling, client?: Pick<PoolClient, 'query'>): Promise<ScopeEvidence> {
  return validateScopeEvidence(evidence, ceiling, 'audience', client)
}

/** Closed native proof only; an unsupported closure must take the original full path. */
export async function tryValidateNativeScopeEvidence(evidence:ScopeEvidence,ceiling:AccessCeiling,client:Pick<PoolClient,'query'>,kind:'caller'|'audience'):Promise<ScopeEvidence|null>{
 return validateScopeEvidence(evidence,ceiling,kind,client,undefined,true)
}
