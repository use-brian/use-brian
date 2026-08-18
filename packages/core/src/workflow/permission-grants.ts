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

/**
 * Multi-instance tool variants carry a per-instance suffix after `__`
 * (`imapSendMessage__bd_1a2b3c4d`, `githubCreateIssue__acme_…` - the
 * convention `packages/api/src/mcp/inject.ts::instanceToolSuffix` mints and
 * `baseToolName` reverses; `__` never appears in a canonical name). Policies
 * and write grants resolve against the canonical base name, and a workflow
 * grant must too: a founder who writes `{ action_kind: 'imapSendMessage',
 * grant: 'allow' }` expects it to cover the second mailbox's suffixed send
 * tool as well, not to be silently ignored for it (mailbox-imap.md →
 * "Multiple mailboxes"). Kept as a local mirror rather than an import: core
 * cannot depend on the api package.
 */
const INSTANCE_TOOL_SEP = '__'

export function canonicalGrantToolName(toolName: string): string {
  const i = toolName.indexOf(INSTANCE_TOOL_SEP)
  return i === -1 ? toolName : toolName.slice(0, i)
}

// Spec: action_kind matches the MCP tool name OR `connector_id:action_kind`.
// Namespaced form wins when both are present; the exact (suffixed) name wins
// over the canonical base name, so a grant CAN still target one instance's
// variant specifically when it names it.
export function matchPermissionGrant(
  grants: readonly WorkflowPermissionGrant[],
  toolName: string,
  connectorId?: string,
): WorkflowPermissionGrant | null {
  const candidates = [toolName]
  const canonical = canonicalGrantToolName(toolName)
  if (canonical !== toolName) candidates.push(canonical)
  for (const name of candidates) {
    if (connectorId) {
      const namespaced = `${connectorId}:${name}`
      const hit = grants.find((g) => g.action_kind === namespaced)
      if (hit) return hit
    }
    const hit = grants.find((g) => g.action_kind === name)
    if (hit) return hit
  }
  return null
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
