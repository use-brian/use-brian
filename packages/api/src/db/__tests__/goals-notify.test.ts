/**
 * [COMP:goals/store] The `goal` workspace primitive's store-seam emits.
 *
 * The goals board, the Triage panel and the goal detail page read their rows
 * through the surface cache and go stale off the workspace event spine
 * (docs/architecture/platform/realtime-sync.md -> "Web client"). Before this
 * primitive they depended on a local `refetchTick` only the acting tab could
 * bump, so a draft the triage judge minted from a worker, or a goal an
 * assistant confirmed from chat, never reached an open board. These pin two
 * things: every lifecycle seam emits ONE `goal` signal carrying the row's own
 * workspace id, and the per-tick claim (one flip per acting-loop iteration)
 * stays silent, or the coalescer would carry a heartbeat.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../client.js', () => ({ query: vi.fn(), queryWithRLS: vi.fn() }))
vi.mock('../../brain-stream/notify.js', () => ({ notifyWorkspaceChange: vi.fn() }))

import { query } from '../client.js'
import { notifyWorkspaceChange } from '../../brain-stream/notify.js'
import {
  abandonGoalsForHostTaskSystem,
  createGoal,
  narrowGoalContextSystem,
  setGoalStatusSystem,
  stampGoalCompletionSystem,
  transitionRunningGoalStatusSystem,
  tryClaimGoalForTick,
  updateGoalSystem,
} from '../goals.js'

const mockQuery = vi.mocked(query)
const mockNotify = vi.mocked(notifyWorkspaceChange)
const AUTHORING_AUTHORITY = {
  version: 1 as const,
  assistantId: 'assistant-1',
  ceiling: {
    workspaceId: 'ws-1',
    userId: 'user-1',
    clearance: 'confidential' as const,
    compartments: null,
    mutationCompartments: null,
    projectIds: null,
    visibilityAssistantIds: null,
  },
}

const ROW = {
  id: 'goal-1',
  workspaceId: 'ws-1',
  parentGoalId: null,
  recipeId: null,
  hostType: 'task',
  hostId: 'task-1',
  outcome: 'Ship the thing',
  doneWhen: { type: 'hostTaskDone' },
  means: {},
  budget: {},
  policy: {},
  status: 'active',
  blockerReason: null,
  createdByUserId: 'user-1',
  originSessionId: null,
  contextGroupId: null,
  contextProjectId: null,
  authoringAuthority: AUTHORING_AUTHORITY,
  confirmedAt: null,
  completionClaim: null,
  brief: null,
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
}

beforeEach(() => {
  mockQuery.mockReset()
  mockNotify.mockReset()
})

describe('[COMP:goals/store] goal primitive store-seam emits', () => {
  it('keeps legacy rows inert until a current authoring principal is captured', async () => {
    await expect(createGoal({
      workspaceId: 'ws-1', outcome: 'Legacy goal', doneWhen: { type: 'hostTaskDone' },
    } as never)).rejects.toMatchObject({ reason: 'goal_authority_unavailable' })
    await expect(updateGoalSystem('goal-1', { confirm: true })).rejects.toMatchObject({
      reason: 'goal_authority_unavailable',
    })
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('createGoal emits create with the new row id and its workspace', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ROW], rowCount: 1 } as never)
    await createGoal({ workspaceId: 'ws-1', outcome: 'Ship the thing', doneWhen: { type: 'hostTaskDone' }, authoringAuthority: AUTHORING_AUTHORITY } as never)
    expect(mockNotify).toHaveBeenCalledTimes(1)
    expect(mockNotify).toHaveBeenCalledWith('ws-1', 'goal', 'create', 'goal-1')
  })

  it('updateGoalSystem (amend / confirm) emits update', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...ROW, confirmedAt: new Date() }], rowCount: 1 } as never)
    await updateGoalSystem('goal-1', { confirm: true, authoringAuthority: AUTHORING_AUTHORITY })
    expect(mockNotify).toHaveBeenCalledWith('ws-1', 'goal', 'update', 'goal-1')
  })

  it('setGoalStatusSystem emits update, and stays silent on a missing row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...ROW, status: 'blocked' }], rowCount: 1 } as never)
    await setGoalStatusSystem('goal-1', 'blocked', 'needs a key')
    expect(mockNotify).toHaveBeenCalledWith('ws-1', 'goal', 'update', 'goal-1')

    mockNotify.mockReset()
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await setGoalStatusSystem('goal-missing', 'blocked')
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it('transitionRunningGoalStatusSystem emits only when the guarded transition landed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'goal-1', workspaceId: 'ws-1' }], rowCount: 1 } as never)
    await expect(transitionRunningGoalStatusSystem('goal-1', 'done')).resolves.toBe(true)
    expect(mockNotify).toHaveBeenCalledWith('ws-1', 'goal', 'update', 'goal-1')
    // The SQL reads the workspace off the row it wrote — never a second lookup.
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('RETURNING id, workspace_id')

    mockNotify.mockReset()
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await expect(transitionRunningGoalStatusSystem('goal-1', 'done')).resolves.toBe(false)
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it('stampGoalCompletionSystem and narrowGoalContextSystem emit update', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...ROW, completionClaim: { because: 'verified', verifiedAt: 'now' } }],
      rowCount: 1,
    } as never)
    await stampGoalCompletionSystem('goal-1', 'verified')
    expect(mockNotify).toHaveBeenCalledWith('ws-1', 'goal', 'update', 'goal-1')

    mockNotify.mockReset()
    mockQuery.mockResolvedValueOnce({ rows: [{ ...ROW, contextGroupId: 'team-1' }], rowCount: 1 } as never)
    await narrowGoalContextSystem('goal-1', 'team-1', null)
    expect(mockNotify).toHaveBeenCalledWith('ws-1', 'goal', 'update', 'goal-1')
  })

  it('the host-task cascade emits once per retired goal from the returned rows', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'goal-1', workspaceId: 'ws-1' },
        { id: 'goal-2', workspaceId: 'ws-1' },
      ],
      rowCount: 2,
    } as never)
    await expect(abandonGoalsForHostTaskSystem('task-1', 'host_task_deleted')).resolves.toBe(2)
    expect(mockNotify).toHaveBeenCalledTimes(2)
    expect(mockNotify).toHaveBeenCalledWith('ws-1', 'goal', 'update', 'goal-1')
    expect(mockNotify).toHaveBeenCalledWith('ws-1', 'goal', 'update', 'goal-2')
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('RETURNING id, workspace_id')
  })

  it('an injected transaction executor that returns no rows still retires the goals, silently', async () => {
    const exec = { query: vi.fn(async () => ({ rowCount: 1 })) }
    await expect(
      abandonGoalsForHostTaskSystem('task-1', 'host_task_closed', { draftsOnly: true, exec }),
    ).resolves.toBe(1)
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it('the per-tick claim NEVER emits (it would be a heartbeat, not a change)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'goal-1' }], rowCount: 1 } as never)
    await expect(tryClaimGoalForTick('goal-1')).resolves.toBe(true)
    expect(mockNotify).not.toHaveBeenCalled()
  })
})
