import {tryNativeInvocationEvidence} from '../context-scope/native-invocation-evidence.js'
import { nativeSessionQueryContextSources } from './session-query-context.js'
import { readPersistentSessionContextAncestors } from '../db/session-context-ancestry.js'
/** Fresh source permission at model input/output boundaries. [COMP:api/external-source-access] */
import { ContextScopeAccumulator, type ExecutionContext, type ScopeSource, type ToolContext } from '@use-brian/core'
import { SourceProtocolError } from '@use-brian/brian-app/connector'
import { getAppPool, applyRLSGucs, rollbackAndRelease, runWithAgentAccess } from '../db/client.js'
import { validateCallerScopeEvidence, validateAudienceScopeEvidence } from '../context-scope/caller-evidence.js'
import { readExternalSourceAncestors } from './external-source-ancestry.js'
import { assertPreparedExternalSourceAuthorityCurrent, pinPreparedExternalSourceAuthority } from './retained-source-authority.js'
import { getSharedRetainedSourceAuthority } from './source-runtime.js'
import { readApplicationFieldAncestors } from './field-evidence.js'
import { applyApplicationRLSContext, getApplicationExecutionBinding, releaseApplicationTransactionBinding } from './execution-context.js'

const invalid = new WeakSet<ExecutionContext>()
function denied(): never { throw new SourceProtocolError('source_access_denied') }

/** No proof/allow cache: every call prepares a new source operation. Native authority stays separate. */
export async function assertSourceModelInputAuthority(context: ToolContext): Promise<void> {
  return assertSourceModelAuthority(context, 'context')
}

/** Input permission never substitutes for the actual recipient's delivery decision.
 * A server-owned metadata guard may narrow admission inside the same SQL frame;
 * it must not open a nested source operation or perform a mutation there. */
export async function assertSourceModelOutputAuthority(context: ToolContext, narrowingGuard?: () => Promise<void>): Promise<void> {
  return assertSourceModelAuthority(context, 'deliver', narrowingGuard)
}

async function assertSourceModelAuthority(context: ToolContext, action: 'context' | 'deliver', narrowingGuard?: () => Promise<void>): Promise<void> {
  const validate = action === 'deliver' ? validateAudienceScopeEvidence : validateCallerScopeEvidence
  const execution = context.executionContext
  try {
    if (execution && invalid.has(execution)) denied()
    const accumulated = context.scopeAccumulator?.evidence
    const evidence = new ContextScopeAccumulator(execution?.security.provenance)
    evidence.note(accumulated)
    let sources = evidence.evidence.sources ?? []
    if (!sources.length) { if(narrowingGuard)denied();return }
    const accumulator = context.scopeAccumulator
    if (!execution || !(accumulator instanceof ContextScopeAccumulator)) denied()
    const originalEvidence = JSON.stringify(accumulator.evidence)
    await execution.security.authority.assertCurrent()
    const workspaceId = execution.security.access.workspaceId
    if (sources.some(source => source.workspaceId !== workspaceId)) denied()
    const native=await tryNativeInvocationEvidence(execution,evidence.evidence,execution.security.ceiling,action==='deliver'?'audience':'caller',narrowingGuard)
    if(native){
      await execution.security.authority.assertCurrent()
      if(JSON.stringify(accumulator.evidence)!==originalEvidence)denied()
      accumulator.note(native);return
    }

    evidence.note({sources:await readPersistentSessionContextAncestors(workspaceId,sources)})
    sources=evidence.evidence.sources ?? []
    const ancestors = await readExternalSourceAncestors(workspaceId, sources)
    const fields = await readApplicationFieldAncestors(workspaceId, sources)
    const external = ancestors.length > 0 || sources.some(source => source.resourceKind === 'external_source')
    const persistent = sources.some(source=>source.resourceKind==='session_context_revision')
    const wiring = getSharedRetainedSourceAuthority()
    const prepare = wiring ? ((e: ExecutionContext, roots: readonly ScopeSource[], requested: 'context' | 'deliver') => wiring.coordinator.prepare(e, roots, requested)) : undefined
    const cohort = fields.length ? await nativeSessionQueryContextSources(execution, sources, prepare) : { sources, independent: false }
    if (!external && !fields.length && !persistent && !cohort.independent) {
      if(narrowingGuard)denied()
      const current = await validate(evidence.evidence, execution.security.ceiling)
      await execution.security.authority.assertCurrent()
      if (JSON.stringify(accumulator.evidence) !== originalEvidence) denied()
      accumulator.note(current)
      return
    }
    const application = getApplicationExecutionBinding(execution)
    // Native delegated consumers keep their original host actor, assistant,
    // current invocation lease and pinned parent ceiling through full canonical
    // field/source admission below.
    // Independent sources and application-bound profiles require their own proof.
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
    if (execution.ownership.kind !== 'workspace' || execution.security.access.sharedAudience && external
      || !nativeDelegated && (!application || external) && (execution.identity.kind !== 'attended' || execution.identity.principal.kind !== 'workspace_member')) denied()
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
        if (nativeDelegated || nativeVerifiedAttended) await client.query("SELECT set_config('app.v2_assistant_id',$1,true)", [execution.assistant.id])
        await client.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE',[workspaceId])
        await applyApplicationRLSContext(client, execution)
        if (contextProof) {
          await pinPreparedExternalSourceAuthority(client, execution, contextProof)
          if (action === 'deliver') await validateCallerScopeEvidence(evidence.evidence, execution.security.ceiling, client)
        }
        if (prepared) await pinPreparedExternalSourceAuthority(client, execution, prepared)
        const current = await validate(evidence.evidence, execution.security.ceiling, client)
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
    await execution.security.authority.assertCurrent()
    if (wiring && getSharedRetainedSourceAuthority() !== wiring || JSON.stringify(accumulator.evidence) !== originalEvidence) denied()
    accumulator.note(raised)
  } catch (error) {
    if (execution) invalid.add(execution)
    throw Object.assign(error instanceof SourceProtocolError ? error : new SourceProtocolError('source_unavailable'), {
      reason: 'authority_changed' as const,retrySafe: false,
    })
  }
}
