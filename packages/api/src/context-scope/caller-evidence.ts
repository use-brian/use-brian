import type {SessionAuthorityFactsInput} from './session-authority-facts.js'
import { isConversationEvidenceRoot,readConversationEvidence,readConversationPublicationCohorts,readMixedConversationEvidenceRoute,readHybridConversationEvidence,readPageClosureEvidence } from '../application-platform/conversation-evidence.js'
import {readNativeTitleGroupEvidence,type NativeTitleHead} from '../application-platform/native-title-group-evidence.js'
import { readPersistentSessionContextAncestors } from '../db/session-context-ancestry.js'
import {
  intersectAccessCeilings,
  type AccessCeiling,
} from '@use-brian/agent-runtime/security/access-ceiling.js'
import {
  ContextScopeAccumulator,
  scopeGrantContains,
  type ScopeEvidence,
} from '@use-brian/agent-runtime/security/context-scope.js'
import {
  resourceScopeKey,
  type ResourceScope,
  type ScopeSource,
} from '@use-brian/agent-runtime/security/derived-scope.js'
import {
  maxSensitivity,
  RANK,
  isSensitivity,
} from '@use-brian/agent-runtime/security/sensitivity.js'
import { getPool } from '../db/client.js'
import { readExternalSourceAncestors } from '../application-platform/external-source-ancestry.js'
import { readApplicationFieldAncestors } from '../application-platform/field-evidence.js'
import { readCurrentScopeSources } from '../db/derived-scope-store.js'
import type { PoolClient } from 'pg'
import { deliveryFailureMetadata, type DeliveryFailureMetadata, type DeliveryVerificationPhase } from './delivery-failure.js'
import { readPageThreadAudienceAuthority, type PageThreadAudience } from './page-thread-audience.js'
import { enterOptionalEvidenceSlot, yieldOptionalEvidence } from './optional-evidence.js'
import type { ClosureAdmission } from './admission-closure.js'

const pageKinds = new Set(['page_event_changed','page_event_destination','page_live_changed','page_live_destination'])

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

export type ScopeEvidenceError = Error & DeliveryFailureMetadata & {
  reason: 'caller_evidence_unavailable' | 'delivery_audience_unverified'
  retrySafe: false
  diagnostic: ScopeEvidenceFailure
}

function unavailable(kind: 'caller' | 'audience', diagnostic: ScopeEvidenceFailure, cause?: unknown, phase?: DeliveryVerificationPhase): ScopeEvidenceError {
  return Object.assign(new Error(kind === 'caller'
    ? 'The source context is unavailable. Start a new request with current access.'
    : 'The destination audience cannot receive this output under its current access.', cause === undefined ? undefined : { cause }), {
    reason: kind === 'caller' ? 'caller_evidence_unavailable' as const : 'delivery_audience_unverified' as const,
    retrySafe: false as const,
    diagnostic,
    ...deliveryFailureMetadata(cause, phase),
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

function checkedEvidenceInput(evidence:ScopeEvidence,ceiling:AccessCeiling,kind:'caller'|'audience',
 currentVisibility:(scope:ResourceScope,receiver:AccessCeiling)=>ScopeEvidenceFailure|null=visibilityFailure):ScopeEvidence {
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
  for (const source of sources) failure ??= currentVisibility(source, ceiling) ?? labelFailure(source, ceiling)
  failure ??= labelFailure({ sensitivity:snapshot.sensitivity??'public',compartments:snapshot.compartments??[],projectIds:snapshot.projectIds??[] },ceiling)
  if (failure) throw unavailable(kind, failure)
  return snapshot
}

/** The record owner checks its positive SQL proof separately. This check uses
 * the original context's same per-source visibility and label conjunction. */
export function assertScopeEvidenceFitsCeiling(evidence:ScopeEvidence,ceiling:AccessCeiling,kind:'caller'|'audience'):void{
  checkedEvidenceInput(evidence,ceiling,kind)
}

type ConversationCapture=Extract<Awaited<ReturnType<typeof readConversationEvidence>>,{kind:'complete'}>
function checkedConversationCapture(snapshot:ScopeEvidence,native:ConversationCapture,ceiling:AccessCeiling,kind:'caller'|'audience'):ScopeEvidence {
 const expanded=new ContextScopeAccumulator(snapshot)
 expanded.note(native.evidence)
 for(const source of [...native.evidence.sources??[],...native.current]){
  const failure=visibilityFailure(source,ceiling)??labelFailure(source,ceiling)
  if(failure)throw unavailable(kind,failure)
 }
 for(const current of native.current)expanded.note({sensitivity:current.sensitivity,compartments:current.compartments,projectIds:current.projectIds})
 return expanded.evidence
}

/** Validate this operation's exact preparation cohort against the caller floor. */
export function assertPreparedConversationCohortEvidence(evidence:ScopeEvidence,ceiling:AccessCeiling,native:ConversationCapture):void {
 const snapshot=checkedEvidenceInput(evidence,ceiling,'caller')
 checkedConversationCapture(snapshot,native,ceiling,'caller')
}

async function validateScopeEvidence(
  evidence: ScopeEvidence,
  ceiling: AccessCeiling,
  kind: 'caller' | 'audience',
  client?: Pick<PoolClient, 'query'>,
  workflowRunId?: string,
  pageAudience?: PageThreadAudience,
  closure?: ClosureAdmission,
): Promise<ScopeEvidence> {
  const exactPageThread = kind === 'audience' && ceiling.userId === '' ? pageAudience : undefined
  const currentVisibility = (scope: ResourceScope, receiver: AccessCeiling) => {
    const pageSource = exactPageThread && 'resourceKind' in scope && pageKinds.has(String(scope.resourceKind))
    // The Page's own thread proves this principal axis below. Private Memory,
    // fields and every other source keep their ordinary per-source visibility.
    return visibilityFailure(pageSource ? { ...scope, userId: null } : scope, receiver)
  }
  const validateCurrent = async (evidence: ScopeEvidence, currentRoots: readonly ScopeSource[]): Promise<ScopeEvidence> => {
    // Current-label revalidation (decision D1): an edit, supersession or delete
    // after the read never blocks by itself - often the turn made that change
    // (list then close a task). A held source, or one whose CURRENT envelope
    // no longer fits the receiver, does. Exact-version lineage is the derived
    // writer's rule (`revalidateScopeSources`), not the audience's.
    let states: Awaited<ReturnType<typeof readCurrentScopeSources>>
    try {
      states = await readCurrentScopeSources(client ?? getPool(), ceiling.workspaceId, currentRoots, workflowRunId, kind === 'caller' ? 'context' : 'deliver', !!client)
    } catch (error) {
      throw unavailable(kind, 'verification_error', error, 'current_source')
    }
    const raised: ScopeEvidence = { ...evidence }
    for (const state of states) {
      if (state.state === 'held') throw unavailable(kind, 'source_held')
      if (state.state === 'unverifiable') throw unavailable(kind, 'source_unverifiable')
      if (state.state === 'stale_input') throw unavailable(kind, 'source_changed')
      if (state.state !== 'changed') continue
      const current = state.current
      if (currentVisibility(current, ceiling) || labelFailure(current, ceiling)) {
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
  ceiling=intersectAccessCeilings(ceiling,ceiling)
  let snapshot=checkedEvidenceInput(evidence,ceiling,kind,currentVisibility)
  let failure:ScopeEvidenceFailure|null=null
  let sources=snapshot.sources??[]
  const originalSources=structuredClone(sources)
  if (!sources.length) return snapshot
  if (!client && sources.some(source=>source.resourceKind==='session_context_revision')) throw unavailable(kind,'source_unverifiable')
  // Preserve the closed one-statement path for the ordinary conversation.
  // If it explicitly declines, route the original roots before an independent
  // owner starts reconstructing its own ancestry.
  let checkMixedRoute: (() => Promise<void>) | undefined
  if (client && !workflowRunId && sources.some(source => isConversationEvidenceRoot(source)
    && !(exactPageThread && pageKinds.has(source.resourceKind)))) {
    try {
      const native = await readConversationEvidence(client, ceiling.workspaceId, sources)
      if (native?.kind === 'complete') return checkedConversationCapture(snapshot, native, ceiling, kind)
      const canReadPage = !!ceiling.userId && !(kind === 'audience' && pageAudience)
      const provePage = (roots: readonly ScopeSource[]) => readPageClosureEvidence(client, ceiling.workspaceId, roots, ceiling.userId)
      if (native === null && canReadPage) {
        const page = closure
          ? await closure.pageClosure(client, sources, ceiling.userId, provePage)
          : await provePage(sources)
        if (page) return checkedConversationCapture(snapshot, page, ceiling, kind)
      }

      const route = await readMixedConversationEvidenceRoute(client, ceiling.workspaceId, originalSources)
      if (route) {
        const rootsFor = (family: typeof route.families[number]) =>
          originalSources.filter((_, index) => route.families[index] === family)
        const checked = new ContextScopeAccumulator(snapshot)
        const residual = rootsFor('independent')
        const noteIndependent = (independent: ScopeSource[]) => {
          for (const source of independent) {
            const refused = currentVisibility(source, ceiling) ?? labelFailure(source, ceiling)
            if (refused) throw unavailable(kind, refused)
            if (!residual.some(value => value.resourceKind === source.resourceKind && value.resourceId === source.resourceId
              && value.version === source.version && resourceScopeKey(value) === resourceScopeKey(source))) residual.push(source)
          }
        }
        const admitHybrid = async (roots: ScopeSource[]) => {
          if (!roots.length) return
          const { native, independent } = await readHybridConversationEvidence(client, ceiling.workspaceId, roots)
          checked.note(checkedConversationCapture({}, native, ceiling, kind))
          noteIndependent(independent)
        }
        const hybridRoots = [...rootsFor('hybrid'), ...rootsFor('record')]
        const nativeRoots = rootsFor('native')
        if (nativeRoots.length) {
          const proof = await readConversationEvidence(client, ceiling.workspaceId, nativeRoots)
          if (proof?.kind === 'complete') checked.note(checkedConversationCapture({}, proof, ceiling, kind))
          else hybridRoots.push(...nativeRoots)
        }
        const pageRoots = rootsFor('page')
        if (pageRoots.length) {
          if (canReadPage && route.actor === ceiling.userId) {
            const proof = await provePage(pageRoots)
            if (!proof) throw unavailable(kind, 'source_unverifiable')
            checked.note(checkedConversationCapture({}, proof, ceiling, kind))
          } else {
            // A direct Page receipt for its anonymous discussion belongs to
            // that exact Page audience. Prove only its native carriers here.
            for (const root of pageRoots) {
              if (exactPageThread && pageKinds.has(root.resourceKind)) noteIndependent([root])
              else hybridRoots.push(root)
            }
          }
        }
        const retained = rootsFor('retained')
        if (retained.length) {
          // A semantic candidate omitted from the initial query results may
          // still belong to the external coordinator's current context cohort.
          const proof = await readConversationEvidence(client, ceiling.workspaceId, retained)
          if (proof?.kind === 'complete') checked.note(checkedConversationCapture({}, proof, ceiling, kind))
          else hybridRoots.push(...retained)
        }
        await admitHybrid(hybridRoots)
        const history = rootsFor('history')
        const projectSelectedHistory = async () => {
          const scopes: ResourceScope[] = []
          for (const root of history) {
            const proof = await readConversationEvidence(client, ceiling.workspaceId, [root])
            if (proof?.kind !== 'memory_history' || !proof.available) throw unavailable(kind, 'source_unverifiable')
            for (const scope of proof.scopes) {
              const refused = currentVisibility(scope, ceiling) ?? labelFailure(scope, ceiling)
              if (refused) throw unavailable(kind, refused)
              scopes.push(scope)
            }
          }
          return scopes
        }
        const historyScopes = await projectSelectedHistory()
        // A selected-history proof returns labels only. The owned independent
        // leaves still require their own Page, Office or external admission.
        if (history.length) {
          const { independent } = await readHybridConversationEvidence(client, ceiling.workspaceId, history)
          noteIndependent(independent)
        }
        for (const scope of historyScopes) {
          checked.note({ sensitivity: scope.sensitivity, compartments: scope.compartments, projectIds: scope.projectIds })
        }
        // The purpose proof supplies high-water labels. The current field
        // snapshot independently admits the exact historical observation.
        snapshot = await validateCurrent(checked.evidence, history)
        if (originalSources.some(root => !residual.includes(root))) {
          checkMixedRoute = async () => {
            const current = await readMixedConversationEvidenceRoute(client, ceiling.workspaceId, originalSources)
            if (current?.footprint !== route.footprint || JSON.stringify(current.families) !== JSON.stringify(route.families)
                || JSON.stringify(await projectSelectedHistory()) !== JSON.stringify(historyScopes)) {
              throw unavailable(kind, 'source_unverifiable')
            }
          }
          if (!residual.length) {
            await checkMixedRoute()
            return snapshot
          }
          sources = residual
        }
      }
    } catch (error) {
      throw scopeEvidenceFailureOf(error) ? error : unavailable(kind, 'source_unverifiable', error, 'native_proof')
    }
  }
  // Retain the caller's complete floor, but do not send canonically admitted
  // roots and projections through an unrelated owner's validation again.
  const combined = snapshot
  const residualRoots = sources
  snapshot = { ...combined, sources: residualRoots }
  // Optional decoration (session list titles) holds the installation's single
  // optional slot here and yields to foreground admission between the heavy
  // phases below. Outside runOptionalEvidence both are no-ops without SQL.
  const leaveOptional=await enterOptionalEvidenceSlot(client)
  let optionalCompleted=false
  try {
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
      const value=await readConversationEvidence(client,ceiling.workspaceId,[source])
      if(value?.kind!=='memory_history')continue
      if(!value.available)throw unavailable(kind,'source_unverifiable')
      if(workflowRunId)throw unavailable(kind,'source_unverifiable')
      for(const scope of value.scopes){
        const refused=currentVisibility(scope,ceiling)??labelFailure(scope,ceiling)
        if(refused)throw unavailable(kind,refused)
      }
      scopes.push({root:value.root,scopes:value.scopes})
    }
    return scopes
  }
  let historyProjection:Awaited<ReturnType<typeof projectHistory>>
  try{historyProjection=await projectHistory(residualRoots)}
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
  await yieldOptionalEvidence(client)
  const persistentKey=(values:readonly ScopeSource[])=>JSON.stringify(values.map(source=>[source.resourceId,source.version,resourceScopeKey(source)]).sort())
  try {
    const persistent=await readPersistentSessionContextAncestors(ceiling.workspaceId,sources,client)
    persistentAncestry=persistentKey(persistent)
    if(persistent.length && !client)throw unavailable(kind,'source_unverifiable')
    const expanded=new ContextScopeAccumulator(snapshot)
    expanded.note({sources:persistent});snapshot=expanded.evidence;sources=snapshot.sources ?? []
    for(const source of persistent)failure ??= currentVisibility(source,ceiling) ?? labelFailure(source,ceiling)
    if(failure)throw unavailable(kind,failure)
  } catch(error){throw scopeEvidenceFailureOf(error) ? error : unavailable(kind,'source_unverifiable',error,'ancestry')}


  // A native envelope cannot erase its independently authorized source ancestry.
  // This metadata read confers no source rights: current transaction receipts
  // are still required by readCurrentScopeSources below.
  const ancestryRoots = sources
  const ancestryKey = (values: readonly ScopeSource[]) => JSON.stringify(values.map(source => [source.resourceId,source.version,resourceScopeKey(source)]).sort())
  let originalAncestry: string
  let originalFieldAncestry: string
  let projectedHistoryRoots:ScopeSource[]=[]
  let projectedHistory:Awaited<ReturnType<typeof projectHistory>>=[]
  await yieldOptionalEvidence(client)
  try {
    const fieldAncestors = await readApplicationFieldAncestors(ceiling.workspaceId, ancestryRoots, client)
    originalFieldAncestry = ancestryKey(fieldAncestors)
    if (fieldAncestors.length && !client) throw unavailable(kind, 'source_unverifiable')
    for (const source of fieldAncestors) failure ??= currentVisibility(source, ceiling) ?? labelFailure(source, ceiling)
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
      failure ??= currentVisibility(source, ceiling) ?? labelFailure(source, ceiling)
    }
    if (failure) throw unavailable(kind, failure)
    const expanded = new ContextScopeAccumulator(snapshot)
    expanded.note({ sources: [...fieldAncestors,...ancestors] })
    for(const projected of projectedHistory)for(const scope of projected.scopes)expanded.note({
      sensitivity:scope.sensitivity,compartments:scope.compartments,projectIds:scope.projectIds})
    snapshot = expanded.evidence
    sources = snapshot.sources ?? []
  } catch (error) {
    throw scopeEvidenceFailureOf(error) ? error : unavailable(kind, 'source_unverifiable', error, 'ancestry')
  }

  // Page receipts carry principal boundaries beyond generic labels. Resolve
  // each immutable observation; never treat a missing receipt as D1 deletion.
  // Private dialogue has no Page ancestry. Keep it in `sources` for the
  // mandatory current transcript proof below, including mixed evidence.
  const ordinarySources = sources.filter(source=>!pageKinds.has(source.resourceKind)&&source.resourceKind!=='private_transcript')
  await yieldOptionalEvidence(client)
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
      for (const source of sources) failure ??= currentVisibility(source,ceiling) ?? labelFailure(source,ceiling)
      if (failure) throw unavailable(kind,failure)
    } catch (error) {
      throw scopeEvidenceFailureOf(error) ? error : unavailable(kind,'verification_error',error)
    }
  }
  // Office roles and explicit deny grants are not representable by label floors.
  // Recheck the actual recipient, never the originating reader's creator role.
  for(const source of sources.filter(source=>source.resourceKind==='office_observation')) {
    const current=(await (client ?? getPool()).query<{allowed:boolean}>(
      'SELECT read_office_observation_authority($1,$2,$3,$4::jsonb) AS allowed',
      [ceiling.workspaceId,source.resourceId,ceiling.userId || null,JSON.stringify(ceiling.visibilityAssistantIds)])).rows[0]
    if(current?.allowed!==true)throw unavailable(kind,'source_unverifiable')
  }
  const raisedPages = new ContextScopeAccumulator(snapshot)
  try {
    for (const source of sources.filter(source => pageKinds.has(source.resourceKind))) {
      const authority = exactPageThread
        ? await readPageThreadAudienceAuthority(ceiling.workspaceId, source, exactPageThread)
        : (await (client ?? getPool()).query<{ authority: {
        source: ScopeSource | null; requiredSources: ScopeSource[]; principalAllowed: boolean
      } | null }>(`SELECT ${client ? 'read_admitted_page_authority' : 'read_page_scope_authority'}($1,$2,$3,$4) AS authority`,
      [ceiling.workspaceId,source.resourceKind,source.resourceId,ceiling.userId || null])).rows[0]?.authority
      if (!authority?.source || !Array.isArray(authority.requiredSources) || !authority.requiredSources.length
        || !authority.principalAllowed) throw unavailable(kind,'source_unverifiable')
      if (authority.source.version !== source.version || resourceScopeKey(authority.source) !== resourceScopeKey(source)) {
        throw unavailable(kind,'source_changed')
      }
      for (const current of authority.requiredSources) {
        if (currentVisibility(current,ceiling) || labelFailure(current,ceiling)) throw unavailable(kind,'source_reclassified')
        raisedPages.note({sources:[current]})
      }
    }
  } catch (error) {
    throw scopeEvidenceFailureOf(error) ? error : unavailable(kind,'verification_error',error)
  }

  await yieldOptionalEvidence(client)
  const raised = await validateCurrent(raisedPages.evidence, sources.filter(source=>!pageKinds.has(source.resourceKind)))
  await yieldOptionalEvidence(client)
  try {
    if(historyKey(await projectHistory(residualRoots))!==historyKey(historyProjection)
      ||historyKey(await projectHistory(projectedHistoryRoots))!==historyKey(projectedHistory))throw unavailable(kind,'source_unverifiable')
    if(persistentKey(await readPersistentSessionContextAncestors(ceiling.workspaceId,ancestryRoots,client))!==persistentAncestry!) throw unavailable(kind,'source_unverifiable')
    if (ancestryKey(await readExternalSourceAncestors(ceiling.workspaceId, ancestryRoots, client)) !== originalAncestry!) {
      throw unavailable(kind, 'source_unverifiable')
    }
    if (ancestryKey(await readApplicationFieldAncestors(ceiling.workspaceId, ancestryRoots, client)) !== originalFieldAncestry!) {
      throw unavailable(kind, 'source_unverifiable')
    }
  } catch (error) {
    throw scopeEvidenceFailureOf(error) ? error : unavailable(kind, 'source_unverifiable', error, 'ancestry_recheck')
  }
  await checkMixedRoute?.()
  optionalCompleted=true
  const admitted = new ContextScopeAccumulator(combined)
  admitted.note(raised)
  return admitted.evidence
  } finally { leaveOptional(optionalCompleted) }
}

/** Trusted transport metadata, revalidated before model use and lease renewal.
 * `closure` is the admission's view of its turn's admission closure (admission-closure.ts). */
export async function validateCallerScopeEvidence(evidence: ScopeEvidence, ceiling: AccessCeiling, client?: Pick<PoolClient, 'query'>, workflowRunId?: string,
  closure?: ClosureAdmission): Promise<ScopeEvidence> {
  return validateScopeEvidence(evidence, ceiling, 'caller', client, workflowRunId, undefined, closure)
}

/** Final output evidence checked against the current destination audience. */
export async function validateAudienceScopeEvidence(evidence: ScopeEvidence, ceiling: AccessCeiling, client?: Pick<PoolClient, 'query'>,
  pageAudience?: PageThreadAudience, closure?: ClosureAdmission): Promise<ScopeEvidence> {
  return validateScopeEvidence(evidence, ceiling, 'audience', client, undefined, pageAudience, closure)
}

/** The workflow copy transaction owns the exact saved source run and its viewer. */
export async function validateWorkflowOutcomeAudience(evidence: ScopeEvidence, ceiling: AccessCeiling,
  client: Pick<PoolClient, 'query'>, sourceRunId: string): Promise<ScopeEvidence> {
  return validateScopeEvidence(evidence, ceiling, 'audience', client, sourceRunId)
}

/** Closed native proof only; an unsupported closure must take the original full path. */
export async function tryValidateNativeScopeEvidence(evidence:ScopeEvidence,ceiling:AccessCeiling,client:Pick<PoolClient,'query'>,kind:'caller'|'audience',
 settings?:ReadonlyArray<readonly [string,string]>,authority?:{input:SessionAuthorityFactsInput;capture(raw:unknown):void}):Promise<ScopeEvidence|null>{
 const receiver=intersectAccessCeilings(ceiling,ceiling),snapshot=checkedEvidenceInput(evidence,receiver,kind)
 if(!snapshot.sources?.length)return null
 try{
  const captured=await readConversationEvidence(client,receiver.workspaceId,snapshot.sources,settings,authority?.input)
  if(captured?.kind!=='complete')return null
  const checked=checkedConversationCapture(snapshot,captured,receiver,kind)
  authority?.capture(captured.authority)
  return checked
 }catch(error){throw scopeEvidenceFailureOf(error)?error:unavailable(kind,'source_unverifiable',error,'native_proof')}
}

/** Acquire and validate both original cohorts; each retains its own source floor. */
export async function readValidatedNativePublicationCohorts(evidence:readonly [ScopeEvidence,ScopeEvidence],ceiling:AccessCeiling,
 client:Pick<PoolClient,'query'>):Promise<[ScopeEvidence,ScopeEvidence]|null>{
 const originalCeiling=intersectAccessCeilings(ceiling,ceiling)
 const cohorts=evidence.map(value=>checkedEvidenceInput(value,originalCeiling,'caller'))
 try{
  const acquired=await readConversationPublicationCohorts(client,originalCeiling.workspaceId,[cohorts[0].sources??[],cohorts[1].sources??[]])
  if(!acquired)return null
  return cohorts.map((cohort,index)=>checkedConversationCapture(cohort,acquired[index],originalCeiling,'caller')) as [ScopeEvidence,ScopeEvidence]
 }catch(error){throw scopeEvidenceFailureOf(error)?error:unavailable('caller','source_unverifiable',error)}
}

/** Named title acquisition owns its SQL; pure checks cannot substitute a reader. */
export async function readValidatedNativeTitleGroup(heads:readonly NativeTitleHead[],evidence:ScopeEvidence,
 ceiling:AccessCeiling,client:Pick<PoolClient,'query'>):Promise<{titles:unknown[];checked:ScopeEvidence}|null>{
 const originalCeiling=intersectAccessCeilings(ceiling,ceiling),identities=structuredClone(heads)
 const snapshot=checkedEvidenceInput(evidence,originalCeiling,'caller')
 try{
  const captured=await readNativeTitleGroupEvidence(client,originalCeiling.workspaceId,identities,snapshot.sources??[])
  return captured?{titles:captured.titles,checked:checkedConversationCapture(snapshot,captured.native,originalCeiling,'caller')}:null
 }catch(error){throw scopeEvidenceFailureOf(error)?error:unavailable('caller','source_unverifiable',error,'native_proof')}
}
