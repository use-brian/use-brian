import { describe, it, expect } from 'vitest'
import {
  ACTIVE_WORKFLOW_RUN_STATUSES,
  createPermissionGrantEvaluator,
  isActiveWorkflowRunStatus,
  matchPermissionGrant,
  type ActiveWorkflowRun,
  type PermissionGrantEvaluatorContext,
  type WorkflowPermissionGrant,
} from '../permission-grants.js'

const ctx: PermissionGrantEvaluatorContext = {
  userId: 'user-1',
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  channelType: 'web',
  channelId: 'web-1',
}

describe('[COMP:brain/workflow-permission-grant-evaluator] matchPermissionGrant', () => {
  it('returns null for an empty grants array', () => {
    expect(matchPermissionGrant([], 'createEntity')).toBeNull()
  })

  it('matches by exact action_kind = tool name', () => {
    const grants: WorkflowPermissionGrant[] = [
      { action_kind: 'createEntity', grant: 'allow' },
      { action_kind: 'createEdge', grant: 'ask' },
    ]
    expect(matchPermissionGrant(grants, 'createEntity')).toEqual(grants[0])
    expect(matchPermissionGrant(grants, 'createEdge')).toEqual(grants[1])
  })

  it('returns null when no action_kind matches', () => {
    const grants: WorkflowPermissionGrant[] = [{ action_kind: 'createEntity', grant: 'allow' }]
    expect(matchPermissionGrant(grants, 'deleteEntity')).toBeNull()
  })

  it('prefers connector_id:action_kind namespaced match when both forms exist', () => {
    const grants: WorkflowPermissionGrant[] = [
      { action_kind: 'writeFile', grant: 'ask' },
      { action_kind: 'github:writeFile', grant: 'allow' },
    ]
    expect(matchPermissionGrant(grants, 'writeFile', 'github')).toEqual(grants[1])
  })

  it('a grant on the canonical name covers an instance-suffixed variant (imapSendMessage__bd_1a2b3c4d)', () => {
    // Multi-instance tools carry `__<slug>_<id8>`; policies and write grants
    // resolve against the canonical base name and so must workflow grants
    // (mailbox-imap.md → "Multiple mailboxes"; plan §4.4 / §10 row 13).
    const grants = [{ action_kind: 'imapSendMessage', grant: 'allow' as const }]
    expect(matchPermissionGrant(grants, 'imapSendMessage__bd_1a2b3c4d')).toEqual(grants[0])
    expect(matchPermissionGrant(grants, 'imapSendMessage__bd_1a2b3c4d', 'imap')).toEqual(grants[0])
    // Namespaced canonical also resolves for the variant.
    const ns = [{ action_kind: 'imap:imapSendMessage', grant: 'ask' as const }]
    expect(matchPermissionGrant(ns, 'imapSendMessage__bd_1a2b3c4d', 'imap')).toEqual(ns[0])
  })

  it('an exact suffixed grant still wins over the canonical one (a grant CAN target one instance)', () => {
    const grants = [
      { action_kind: 'imapSendMessage', grant: 'allow' as const },
      { action_kind: 'imapSendMessage__bd_1a2b3c4d', grant: 'block' as const },
    ]
    expect(matchPermissionGrant(grants, 'imapSendMessage__bd_1a2b3c4d')).toEqual(grants[1])
    expect(matchPermissionGrant(grants, 'imapSendMessage')).toEqual(grants[0])
    // A different variant does not inherit the block.
    expect(matchPermissionGrant(grants, 'imapSendMessage__ops_9f8e7d6c')).toEqual(grants[0])
  })

  it('falls back to bare tool name when no namespaced grant is present', () => {
    const grants: WorkflowPermissionGrant[] = [{ action_kind: 'writeFile', grant: 'ask' }]
    expect(matchPermissionGrant(grants, 'writeFile', 'github')).toEqual(grants[0])
  })
})

describe('[COMP:brain/workflow-permission-grant-evaluator] isActiveWorkflowRunStatus', () => {
  it('treats running / awaiting_wait / awaiting_input as active', () => {
    expect(isActiveWorkflowRunStatus('running')).toBe(true)
    expect(isActiveWorkflowRunStatus('awaiting_wait')).toBe(true)
    expect(isActiveWorkflowRunStatus('awaiting_input')).toBe(true)
  })

  it('treats pre-start and terminal statuses as inactive', () => {
    expect(isActiveWorkflowRunStatus('pending')).toBe(false)
    expect(isActiveWorkflowRunStatus('completed')).toBe(false)
    expect(isActiveWorkflowRunStatus('failed')).toBe(false)
    expect(isActiveWorkflowRunStatus('timeout')).toBe(false)
  })

  it('exposes the active set as a read-only set', () => {
    expect(ACTIVE_WORKFLOW_RUN_STATUSES.has('running')).toBe(true)
    expect(ACTIVE_WORKFLOW_RUN_STATUSES.has('completed')).toBe(false)
  })
})

describe('[COMP:brain/workflow-permission-grant-evaluator] createPermissionGrantEvaluator', () => {
  function deps(opts: {
    run?: ActiveWorkflowRun | null
    grants?: readonly WorkflowPermissionGrant[]
  }) {
    return {
      fetchActiveRunForContext: async () => opts.run ?? null,
      fetchWorkflowGrants: async () => opts.grants ?? [],
    }
  }

  it('returns no_grant when no active run exists for the context', async () => {
    const evaluate = createPermissionGrantEvaluator(deps({ run: null }))
    const decision = await evaluate('createEntity', ctx)
    expect(decision).toEqual({ kind: 'no_grant' })
  })

  it('returns no_grant when the run exists but its status is not active', async () => {
    const evaluate = createPermissionGrantEvaluator(
      deps({
        run: { id: 'run-1', workflowId: 'wf-1', status: 'pending' },
        grants: [{ action_kind: 'createEntity', grant: 'allow' }],
      }),
    )
    const decision = await evaluate('createEntity', ctx)
    expect(decision).toEqual({ kind: 'no_grant' })
  })

  it('returns allow when an active run grants the tool', async () => {
    const grant: WorkflowPermissionGrant = { action_kind: 'createEntity', grant: 'allow' }
    const evaluate = createPermissionGrantEvaluator(
      deps({
        run: { id: 'run-1', workflowId: 'wf-1', status: 'running' },
        grants: [grant],
      }),
    )
    const decision = await evaluate('createEntity', ctx)
    expect(decision).toEqual({ kind: 'allow', workflowRunId: 'run-1', grant })
  })

  it('returns ask when an active run sets the tool to ask', async () => {
    const grant: WorkflowPermissionGrant = { action_kind: 'createEntity', grant: 'ask' }
    const evaluate = createPermissionGrantEvaluator(
      deps({
        run: { id: 'run-2', workflowId: 'wf-2', status: 'awaiting_input' },
        grants: [grant],
      }),
    )
    const decision = await evaluate('createEntity', ctx)
    expect(decision).toEqual({ kind: 'ask', workflowRunId: 'run-2', grant })
  })

  it('returns block when an active run blocks the tool', async () => {
    const grant: WorkflowPermissionGrant = { action_kind: 'createEntity', grant: 'block' }
    const evaluate = createPermissionGrantEvaluator(
      deps({
        run: { id: 'run-3', workflowId: 'wf-3', status: 'awaiting_wait' },
        grants: [grant],
      }),
    )
    const decision = await evaluate('createEntity', ctx)
    expect(decision).toEqual({ kind: 'block', workflowRunId: 'run-3', grant })
  })

  it('returns no_grant when an active run has grants but none match the tool', async () => {
    const evaluate = createPermissionGrantEvaluator(
      deps({
        run: { id: 'run-4', workflowId: 'wf-4', status: 'running' },
        grants: [{ action_kind: 'createEdge', grant: 'allow' }],
      }),
    )
    const decision = await evaluate('createEntity', ctx)
    expect(decision).toEqual({ kind: 'no_grant' })
  })
})
