import {withCurrentReadAuthority} from '../context-scope/authority-lease.js'
import { hasWorkspaceMcpRetainedAuthority } from '../db/session-context-revisions.js'
import {tryNativeInvocationEvidence} from '../context-scope/native-invocation-evidence.js'
import {admitTurnConversationRecords,assertConversationFloor,recordEvidenceParts} from '../context-scope/conversation-record-admission.js'
import { nativeSessionQueryContextSources } from './session-query-context.js'
import { readPersistentSessionContextAncestors } from '../db/session-context-ancestry.js'
import { beginClosureAdmission } from '../context-scope/admission-closure.js'
/** Fresh source permission at model input/output boundaries. [COMP:api/external-source-access] */
import { isConversationEvidenceRoot } from './conversation-evidence.js'
import { ContextScopeAccumulator, type ScopeEvidence } from '@use-brian/agent-runtime/security/context-scope.js'
import type { ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'
import type { ExecutionContext } from '@use-brian/agent-runtime/security/execution-context.js'
import type { ToolContext } from '@use-brian/agent-runtime/tools/types.js'
import { SourceProtocolError } from '@use-brian/brian-app/connector'
import { getAppPool, applyRLSGucs, rollbackAndRelease, runWithAgentAccess } from '../db/client.js'
import { validateCallerScopeEvidence, validateAudienceScopeEvidence } from '../context-scope/caller-evidence.js'
import { readExternalSourceAncestors } from './external-source-ancestry.js'
import { assertPreparedExternalSourceAuthorityCurrent, pinPreparedExternalSourceAuthority } from './retained-source-authority.js'
import { getSharedRetainedSourceAuthority } from './source-runtime.js'
import { readApplicationFieldAncestors } from './field-evidence.js'
import { applyApplicationRLSContext, getApplicationExecutionBinding, releaseApplicationTransactionBinding } from './execution-context.js'

const invalid = new WeakSet<ExecutionContext>()
const MAX_ADMISSION_CANDIDATES = 32
function assertAdmissionCurrent(context: ToolContext): void {
  if (context.executionContext && invalid.has(context.executionContext)) denied()
  context.abortSignal?.throwIfAborted()
  context.executionContext?.lifecycle.abortSignal.throwIfAborted()
}
function supersededAdmission(accumulator: ContextScopeAccumulator, original: string, admitted: ScopeEvidence): boolean {
  if (JSON.stringify(accumulator.evidence) === original) return false
  // A successful old proof may raise labels, but cannot regress source pointers.
  const { sensitivity, compartments, projectIds } = admitted
  accumulator.note({ sensitivity, compartments, projectIds })
  return true
}
function denied(): never { throw new SourceProtocolError('source_access_denied') }

/** Keep the private exception chain for server logs, never JSON/wire output. */
function sourceAuthorityError(error: unknown): SourceProtocolError {
  if (error instanceof SourceProtocolError) return error
  return Object.defineProperty(new SourceProtocolError('source_unavailable'), 'cause', {
    value: error, configurable: true, writable: true, enumerable: false,
  })
}

/** Complete model-effect admission. Native evidence and live lease facts share
 * one statement; independent asynchronous work retains fresh surrounding checks. */
export async function admitModelSourceEvidence(context: ToolContext, action: 'context' | 'deliver', narrowingGuard?: () => Promise<void>): Promise<void> {
  const validate = action === 'deliver' ? validateAudienceScopeEvidence : validateCallerScopeEvidence
  const execution = context.executionContext
  try {
    for (let candidate = 0; candidate < MAX_ADMISSION_CANDIDATES; candidate++) {
    assertAdmissionCurrent(context)
    const accumulated = context.scopeAccumulator?.evidence
    let evidence = new ContextScopeAccumulator(execution?.security.provenance)
    evidence.note(accumulated)
    let sources = evidence.evidence.sources ?? []
    if (!sources.length) {
      if(narrowingGuard)denied()
      const before=JSON.stringify(context.scopeAccumulator?.evidence)
      await context.authority?.assertCurrent()
      assertAdmissionCurrent(context)
      if(JSON.stringify(context.scopeAccumulator?.evidence)!==before)continue
      return
    }
    const accumulator = context.scopeAccumulator
    if (!execution || !(accumulator instanceof ContextScopeAccumulator)) denied()
    const originalEvidence = JSON.stringify(accumulator.evidence)
    const workspaceId = execution.security.access.workspaceId
    if (sources.some(source => source.workspaceId !== workspaceId)) denied()
    const recordParts=recordEvidenceParts(evidence.evidence)
    // Outward frames require a host-bound destination, supplied by the
    // attended delivery owner. Dispatch validates every fresh source owner.
    if(recordParts&&(action!=='context'||narrowingGuard))denied()
    const note=async(current:import('@use-brian/agent-runtime/security/context-scope.js').ScopeEvidence)=>{
      const recordFrame=recordParts
        ?await admitTurnConversationRecords(execution,recordParts.records,'dispatch')
        :undefined
      assertAdmissionCurrent(context)
      if(!recordFrame){
        if(supersededAdmission(accumulator,originalEvidence,current))return false
        accumulator.note(current);return true
      }
      const combined=new ContextScopeAccumulator(current)
      combined.note({sources:recordFrame.sources})
      assertConversationFloor(combined.evidence,recordFrame.destination)
      if(supersededAdmission(accumulator,originalEvidence,combined.evidence))return false
      accumulator.note(combined.evidence)
      return true
    }
    if(recordParts){
      evidence=new ContextScopeAccumulator(recordParts.fresh)
      sources=evidence.evidence.sources??[]
      if(!sources.length){if(await note(evidence.evidence))return;continue}
    }
    const native=await tryNativeInvocationEvidence(execution,evidence.evidence,execution.security.ceiling,action==='deliver'?'audience':'caller',narrowingGuard)
    if(native){
      if(await note(native))return;continue
    }

    // This admission's view of its turn's admission closure (one witness read).
    const closure = beginClosureAdmission(execution)
    const admitted=await withCurrentReadAuthority(execution.security.authority,async()=>{
    // Ancestry discovery is metadata; the turn's closure may hold this exact
    // input's result while every source it relies on is unchanged.
    const roots = sources, discoverAncestry = async () => {
      const persistent = await readPersistentSessionContextAncestors(workspaceId, roots)
      const expanded = new ContextScopeAccumulator(evidence.evidence); expanded.note({ sources: persistent })
      const reached = expanded.evidence.sources ?? []
      return { persistent, ancestors: await readExternalSourceAncestors(workspaceId, reached), fields: await readApplicationFieldAncestors(workspaceId, reached) }
    }
    const discovered = closure ? await closure.discover('model-source', [...roots], discoverAncestry,
      value => value.ancestors.length ? null : [...roots, ...value.persistent, ...value.fields]) : await discoverAncestry()
    evidence.note({sources:discovered.persistent})
    sources=evidence.evidence.sources ?? []
    const ancestors = discovered.ancestors
    const fields = discovered.fields
    const external = ancestors.length > 0 || sources.some(source => source.resourceKind === 'external_source')
    const persistent = sources.some(source=>source.resourceKind==='session_context_revision')
    const wiring = getSharedRetainedSourceAuthority()
    const prepare = wiring ? ((e: ExecutionContext, roots: readonly ScopeSource[], requested: 'context' | 'deliver') => wiring.coordinator.prepare(e, roots, requested)) : undefined
    const cohortRoots = sources, discoverCohort = () => nativeSessionQueryContextSources(execution, cohortRoots, prepare)
    const cohort = !fields.length ? { sources, independent: false } : closure ? await closure.discover('model-source-cohort', [...cohortRoots], discoverCohort,
      value => value.independent ? null : [...cohortRoots, ...value.sources]) : await discoverCohort()
    const application = getApplicationExecutionBinding(execution)
    const nativeVerifiedAttended = !application && execution.identity.kind === 'attended' && execution.identity.principal.kind === 'workspace_member'
      && (execution.identity.principal.authenticationKind === 'native_session' || execution.identity.principal.authenticationKind === 'verified_channel') && execution.identity.principal.userId === execution.security.access.userId
      && execution.security.access.assistantId === execution.assistant.id && execution.ownership.kind === 'workspace'
      && execution.ownership.workspaceId === workspaceId && !execution.surface.systemRead && !execution.security.access.systemRead && !execution.surface.clientSelfMemory
    const nativeDelegated = !external && !cohort.independent && !application
      && execution.identity.kind === 'delegated'
      && execution.identity.actorUserId === execution.security.access.userId
      && execution.identity.parentCeiling.userId === execution.security.access.userId
      && execution.identity.parentCeiling.workspaceId === workspaceId
      && execution.security.access.assistantId === execution.assistant.id
      && execution.ownership.kind === 'workspace' && execution.ownership.workspaceId === workspaceId
      && !execution.surface.systemRead && !execution.security.access.systemRead && !execution.surface.clientSelfMemory
    const nativeProgrammatic = !external && !cohort.independent && !application && hasWorkspaceMcpRetainedAuthority(execution)
    const needsConversationProof = (nativeVerifiedAttended || nativeDelegated || nativeProgrammatic)
      && sources.some(isConversationEvidenceRoot)
    if (!external && !fields.length && !persistent && !cohort.independent && !needsConversationProof) {
      if(narrowingGuard)denied()
      const current = await validate(evidence.evidence, execution.security.ceiling)
      return current
    }
    // Native delegated consumers keep their original host actor, assistant,
    // current invocation lease and pinned parent ceiling through full canonical
    // field/source admission below.
    // Independent sources and application-bound profiles require their own proof.
    if (execution.ownership.kind !== 'workspace' || execution.security.access.sharedAudience && external
      || !nativeDelegated && !nativeProgrammatic && (!application || external) && (execution.identity.kind !== 'attended' || execution.identity.principal.kind !== 'workspace_member')) denied()
    if ((external || cohort.independent) && !prepare) denied()
    // Query context covers the complete original cohort. Only the original
    // consumed evidence asks for delivery; candidates do not become outputs.
    const contextProof = (external && action === 'context' || cohort.independent)
      ? await prepare!(execution, cohort.sources, 'context') : undefined
    const prepared = external && action === 'deliver' ? await prepare!(execution, sources, 'deliver') : undefined
    if (wiring && getSharedRetainedSourceAuthority() !== wiring) denied()
    const client = await getAppPool().connect()
    let raised
    try {
      raised = await runWithAgentAccess(execution.security.access, async () => {
        await client.query('BEGIN')
        const role = await client.query(`SELECT r.rolsuper OR r.rolbypassrls OR c.relowner=r.oid AS bypass
          FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_class c ON c.oid='entity_instances'::regclass WHERE r.rolname=current_user`)
        if (role.rows[0]?.bypass !== false) denied()
        await applyRLSGucs(client, execution.security.access.userId)
        if (nativeDelegated || nativeVerifiedAttended || nativeProgrammatic) await client.query("SELECT set_config('app.v2_assistant_id',$1,true)", [execution.assistant.id])
        await client.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE',[workspaceId])
        await applyApplicationRLSContext(client, execution)
        if (contextProof) {
          await pinPreparedExternalSourceAuthority(client, execution, contextProof)
          if (action === 'deliver') await validateCallerScopeEvidence(evidence.evidence, execution.security.ceiling, client, undefined, closure)
        }
        if (prepared) await pinPreparedExternalSourceAuthority(client, execution, prepared)
        const current = action === 'deliver'
          ? await validateAudienceScopeEvidence(evidence.evidence, execution.security.ceiling, client, undefined, closure)
          : await validateCallerScopeEvidence(evidence.evidence, execution.security.ceiling, client, undefined, closure)
        // A server-owned guard can only narrow the result. Keep it inside
        // these same native/source locks, never before their acquisition.
        await narrowingGuard?.()
        // A read-only proof is checked again after COMMIT below.
        if (wiring && getSharedRetainedSourceAuthority() !== wiring) denied()
        await client.query('COMMIT')
        return current
      })
    } finally { releaseApplicationTransactionBinding(client); await rollbackAndRelease(client) }
    if (contextProof) await assertPreparedExternalSourceAuthorityCurrent(execution, contextProof)
    if (prepared) await assertPreparedExternalSourceAuthorityCurrent(execution, prepared)
    if (wiring && getSharedRetainedSourceAuthority() !== wiring) denied()
    return raised
    })
    if(await note(admitted))return
    }
    denied()
  } catch (error) {
    if(execution)invalid.add(execution)
    throw Object.assign(sourceAuthorityError(error), {
      reason: 'authority_changed' as const,retrySafe: false,
    })
  }
}
