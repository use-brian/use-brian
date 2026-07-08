// WU-6.5 — Workflow-scoped permission grants evaluator.
//
// Spec: docs/plans/company-brain/approvals.md → "Workflow-scoped permission
// grants". The JSONB column lives on `workflows.permission_grants` (migration
// 123). Within an active workflow run, listed action_kinds short-circuit the
// pending_approvals path: `allow` skips confirmation, `block` refuses, `ask`
// falls through to normal confirmation. Outside an active run, this module
// is a no-op (returns `{ kind: 'no_grant' }`).

type PermissionGrantKind = 'allow' | 'ask' | 'block'

export type WorkflowPermissionGrant = {
  action_kind: string
  grant: PermissionGrantKind
  granted_at?: string
  granted_by?: string
}

type PermissionGrantDecision =
  | { kind: 'allow'; workflowRunId: string; grant: WorkflowPermissionGrant }
  | { kind: 'ask'; workflowRunId: string; grant: WorkflowPermissionGrant }
  | { kind: 'block'; workflowRunId: string; grant: WorkflowPermissionGrant }
  | { kind: 'no_grant' }

export type PermissionGrantEvaluatorContext = {
  userId: string
  sessionId: string
  workspaceId?: string | null
  channelType: string
  channelId: string
}

export type PermissionGrantEvaluator = (
  toolName: string,
  ctx: PermissionGrantEvaluatorContext,
) => Promise<PermissionGrantDecision>

// Derived from the workflow_runs CHECK in migration 115. 'pending' is
// pre-start, terminal statuses are out — only in-flight runs grant.
export const ACTIVE_WORKFLOW_RUN_STATUSES: ReadonlySet<string> = new Set([
  'running',
  'awaiting_wait',
  'awaiting_input',
])

export function isActiveWorkflowRunStatus(status: string): boolean {
  return ACTIVE_WORKFLOW_RUN_STATUSES.has(status)
}

// Spec: action_kind matches the MCP tool name OR `connector_id:action_kind`.
// Namespaced form wins when both are present.
export function matchPermissionGrant(
  grants: readonly WorkflowPermissionGrant[],
  toolName: string,
  connectorId?: string,
): WorkflowPermissionGrant | null {
  if (connectorId) {
    const namespaced = `${connectorId}:${toolName}`
    const hit = grants.find((g) => g.action_kind === namespaced)
    if (hit) return hit
  }
  return grants.find((g) => g.action_kind === toolName) ?? null
}

export type ActiveWorkflowRun = {
  id: string
  workflowId: string
  status: string
}

export type PermissionGrantsDeps = {
  fetchActiveRunForContext: (
    ctx: PermissionGrantEvaluatorContext,
  ) => Promise<ActiveWorkflowRun | null>
  fetchWorkflowGrants: (
    workflowId: string,
  ) => Promise<readonly WorkflowPermissionGrant[]>
}

export function createPermissionGrantEvaluator(
  deps: PermissionGrantsDeps,
): PermissionGrantEvaluator {
  return async (toolName, ctx) => {
    const run = await deps.fetchActiveRunForContext(ctx)
    if (!run || !isActiveWorkflowRunStatus(run.status)) {
      return { kind: 'no_grant' }
    }
    const grants = await deps.fetchWorkflowGrants(run.workflowId)
    const match = matchPermissionGrant(grants, toolName)
    if (!match) return { kind: 'no_grant' }
    return { kind: match.grant, workflowRunId: run.id, grant: match }
  }
}
