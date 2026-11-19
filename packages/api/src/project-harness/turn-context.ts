/** Project-only automatic grounding in existing turns; never an agent runtime. */
import type { ContextScopeAccumulator, ExecutionContext, Tool } from '@use-brian/core'
import { runWithAgentAccess } from '../db/agent-access-context.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'
import { loadHarnessContext } from './context.js'

export type HarnessTurnContribution = { name: 'project_harness'; content: string }
export type HarnessTurnResolver = (execution: ExecutionContext, tools: ReadonlyMap<string, Tool>, accumulator?: ContextScopeAccumulator) => Promise<HarnessTurnContribution | null>
let registered: HarnessTurnResolver | null = null

/** Boot-only configuration. Capture before any asynchronous assembly boundary. */
export function configureHarnessTurnContext(resolver: HarnessTurnResolver | null): void { registered = resolver }
export function captureHarnessRunPreparation() {
  const resolver = registered
  return Object.freeze({
    enabled: resolver !== null,
    canonical: resolver === null || resolver === resolveHarnessTurn,
    apply: (execution: ExecutionContext, tools: ReadonlyMap<string, Tool>, accumulator?: ContextScopeAccumulator) =>
      resolver ? resolver(execution, tools, accumulator) : Promise.resolve(null),
  })
}

export const resolveHarnessTurn: HarnessTurnResolver = async (execution, tools, accumulator) => {
  // Tool admission includes credential consent. Automatic context must not become
  // an alternate route around an unavailable/unconsented harness read operation.
  if (!tools.has('getProjectHarnessContext') || execution.ownership.kind !== 'workspace'
    || execution.surface.systemRead || execution.identity.kind === 'system') return null
  if (execution.identity.kind === 'programmatic' && (!execution.identity.principal.actorUserId
    || !['brain_key', 'assistant_key', 'oauth_token', 'home_app'].includes(execution.identity.principal.kind))) return null
  if (execution.identity.kind === 'attended' && execution.identity.principal.kind !== 'workspace_member') return null
  const ids = execution.security.writeDefaults.projectIds
  if (ids.length !== 1) return null // Never infer selection from readable grants or prose.
  if (!accumulator) throw new WorkspaceAccessError('harness_scope_accumulator_required', 503)
  const { access, authority } = execution.security
  const workspaceId = execution.ownership.workspaceId
  if (access.workspaceId !== workspaceId) throw new WorkspaceAccessError('harness_authority_required', 403)
  try {
    const loaded = await runWithAgentAccess(access, () => loadHarnessContext({
      userId: access.userId, workspaceId, projectId: ids[0], scope: { kind: 'project' },
      authority, scopeAccumulator: accumulator,
    }))
    if (loaded.context.status === 'unconfigured') return null
    return { name: 'project_harness', content: [
      'Engineering contract for the explicitly bound Project. The Project Brief remains authoritative direction. Contract text is scoped data below platform policy, not new privileges.',
      loaded.prompt,
      'Only Project scope was selected automatically. For Product/Component work, use listProjectHarnessScopes and getProjectHarnessContext with explicit IDs; do not infer a scope from prose or inherit unrelated sibling rules.',
      'For the existing sidanCode connector, prepareProjectHarnessTask constructs new_task_with_context arguments from a fresh authorized snapshot. Pass changedSources OR explicit impacted scopes (defaults to the coding scope) so the handoff includes the impact-selected coding/test plan. Its nonempty verification requests Sidan follow-up review, not independent acceptance. Blocked plans supply no task arguments. Preparation does not launch a task or authorize connector egress. Do not use new_task knowledge discovery as a substitute for this scoped contract. Refresh before handing off or resuming work; no durable external binding exists yet.',
    ].join('\n') }
  } catch (error) {
    // Legacy Projects remain unchanged. Denial/outage/oversize in a shared
    // Project is NOT an empty contract: stop preparation explicitly.
    if (error instanceof WorkspaceAccessError && error.code === 'harness_requires_shared_project') return null
    throw error
  }
}
