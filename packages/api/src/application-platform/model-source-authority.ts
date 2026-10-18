/** Fresh source permission at a model-input boundary. [COMP:api/external-source-access] */
import { ContextScopeAccumulator, type ExecutionContext, type ToolContext } from '@use-brian/core'
import { SourceProtocolError } from '@use-brian/brian-app/connector'
import { getAppPool, applyRLSGucs, rollbackAndRelease, runWithAgentAccess } from '../db/client.js'
import { validateCallerScopeEvidence } from '../context-scope/caller-evidence.js'
import { readExternalSourceAncestors } from './external-source-ancestry.js'
import { assertPreparedExternalSourceAuthorityCurrent, pinPreparedExternalSourceAuthority } from './retained-source-authority.js'
import { getSharedRetainedSourceAuthority } from './source-runtime.js'

const invalid = new WeakSet<ExecutionContext>()
function denied(): never { throw new SourceProtocolError('source_access_denied') }

/** No proof/allow cache: every call prepares a new source operation. Native authority stays separate. */
export async function assertSourceModelInputAuthority(context: ToolContext): Promise<void> {
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
    if (!ancestors.length && !sources.some(source => source.resourceKind === 'external_source')) {
      const current = await validateCallerScopeEvidence(evidence.evidence, execution.security.ceiling)
      await execution.security.authority.assertCurrent()
      if (JSON.stringify(accumulator.evidence) !== originalEvidence) denied()
      accumulator.note(current)
      return
    }
    if (execution.ownership.kind !== 'workspace' || execution.identity.kind !== 'attended'
      || execution.identity.principal.kind !== 'workspace_member' || execution.security.access.sharedAudience) denied()
    const wiring = getSharedRetainedSourceAuthority()
    if (!wiring) denied()
    const prepared = await wiring.coordinator.prepare(execution, sources, 'context')
    if (getSharedRetainedSourceAuthority() !== wiring) denied()
    const client = await getAppPool().connect()
    let raised
    try {
      raised = await runWithAgentAccess(execution.security.access, async () => {
        await client.query('BEGIN')
        await applyRLSGucs(client, execution.security.access.userId)
        await pinPreparedExternalSourceAuthority(client, execution, prepared)
        const current = await validateCallerScopeEvidence(evidence.evidence, execution.security.ceiling, client)
        await execution.security.authority.assertCurrent()
        if (getSharedRetainedSourceAuthority() !== wiring) denied()
        await client.query('COMMIT')
        return current
      })
    } finally { await rollbackAndRelease(client) }
    await assertPreparedExternalSourceAuthorityCurrent(execution, prepared)
    if (getSharedRetainedSourceAuthority() !== wiring || JSON.stringify(accumulator.evidence) !== originalEvidence) denied()
    accumulator.note(raised)
  } catch (error) {
    if (execution) invalid.add(execution)
    throw Object.assign(error instanceof SourceProtocolError ? error : new SourceProtocolError('source_unavailable'), {
      reason: 'authority_changed' as const,retrySafe: false,
    })
  }
}
