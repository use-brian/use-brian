/** Fresh source permission at model input/output boundaries. [COMP:api/external-source-access] */
import { ContextScopeAccumulator, type ExecutionContext, type ToolContext } from '@use-brian/core'
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

/** Input permission never substitutes for the actual recipient's delivery decision. */
export async function assertSourceModelOutputAuthority(context: ToolContext): Promise<void> {
  return assertSourceModelAuthority(context, 'deliver')
}

async function assertSourceModelAuthority(context: ToolContext, action: 'context' | 'deliver'): Promise<void> {
  const validate = action === 'deliver' ? validateAudienceScopeEvidence : validateCallerScopeEvidence
  const execution = context.executionContext
  try {
    if (execution && invalid.has(execution)) denied()
    const accumulated = context.scopeAccumulator?.evidence
    const evidence = new ContextScopeAccumulator(execution?.security.provenance)
    evidence.note(accumulated)
    const sources = evidence.evidence.sources ?? []
    if (!sources.length) return
    const accumulator = context.scopeAccumulator
    if (!execution || !(accumulator instanceof ContextScopeAccumulator)) denied()
    const originalEvidence = JSON.stringify(accumulator.evidence)
    await execution.security.authority.assertCurrent()
    const workspaceId = execution.security.access.workspaceId
    if (sources.some(source => source.workspaceId !== workspaceId)) denied()
    const ancestors = await readExternalSourceAncestors(workspaceId, sources)
    const fields = await readApplicationFieldAncestors(workspaceId, sources)
    const external = ancestors.length > 0 || sources.some(source => source.resourceKind === 'external_source')
    if (!external && !fields.length) {
      const current = await validate(evidence.evidence, execution.security.ceiling)
      await execution.security.authority.assertCurrent()
      if (JSON.stringify(accumulator.evidence) !== originalEvidence) denied()
      accumulator.note(current)
      return
    }
    const application = getApplicationExecutionBinding(execution)
    if (execution.ownership.kind !== 'workspace' || execution.security.access.sharedAudience
      || (!application || external) && (execution.identity.kind !== 'attended' || execution.identity.principal.kind !== 'workspace_member')) denied()
    const wiring = external ? getSharedRetainedSourceAuthority() : undefined
    if (external && !wiring) denied()
    const prepared = wiring ? await wiring.coordinator.prepare(execution, sources, action) : undefined
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
        await applyApplicationRLSContext(client, execution)
        if (prepared) await pinPreparedExternalSourceAuthority(client, execution, prepared)
        const current = await validate(evidence.evidence, execution.security.ceiling, client)
        await execution.security.authority.assertCurrent()
        if (wiring && getSharedRetainedSourceAuthority() !== wiring) denied()
        await client.query('COMMIT')
        return current
      })
    } finally { releaseApplicationTransactionBinding(client); await rollbackAndRelease(client) }
    if (prepared) await assertPreparedExternalSourceAuthorityCurrent(execution, prepared)
    if (wiring && getSharedRetainedSourceAuthority() !== wiring || JSON.stringify(accumulator.evidence) !== originalEvidence) denied()
    accumulator.note(raised)
  } catch (error) {
    if (execution) invalid.add(execution)
    throw Object.assign(error instanceof SourceProtocolError ? error : new SourceProtocolError('source_unavailable'), {
      reason: 'authority_changed' as const,retrySafe: false,
    })
  }
}
