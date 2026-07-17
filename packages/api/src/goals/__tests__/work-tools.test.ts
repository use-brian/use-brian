import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * [COMP:goals/work-tools] markGoalComplete — the agentic-termination signal
 * (task-goal-seeker.md §12 Phase 3). The agent's completion claim is gated by
 * the adversarial verifier; a pass stamps the verified-done marker, a refutation
 * is fed back, and without a verifier the tool refuses to stamp (fail-safe).
 */

vi.mock('../../db/goals.js', () => ({
  getGoalByIdSystem: vi.fn(),
  stampGoalCompletionSystem: vi.fn(),
  updateGoalSystem: vi.fn(),
  setGoalAwaitingEventSystem: vi.fn(),
}))

import { createGoalWorkTools, type GoalWorkToolsDeps } from '../work-tools.js'
import { getGoalByIdSystem, setGoalAwaitingEventSystem, stampGoalCompletionSystem } from '../../db/goals.js'
import type { EventSubscription, GoalVerifier } from '@use-brian/core'

const mockGet = vi.mocked(getGoalByIdSystem)
const mockStamp = vi.mocked(stampGoalCompletionSystem)
const mockSetAwaiting = vi.mocked(setGoalAwaitingEventSystem)

beforeEach(() => vi.clearAllMocks())

const ctx = { workspaceId: 'w1', userId: 'u1' } as never
const GOAL = { id: 'g1', outcome: 'Email the Q3 report to Acme', confirmedAt: new Date() }

function makeTools(verify?: GoalVerifier, gatherEvidence?: GoalWorkToolsDeps['gatherEvidence']) {
  return createGoalWorkTools({
    createCompletionWorkflow: vi.fn(),
    kickoffGoal: vi.fn(),
    verify,
    gatherEvidence,
  })
}

describe('[COMP:goals/work-tools] markGoalComplete (§12 agentic termination)', () => {
  it('stamps the verified-done marker when the verifier passes', async () => {
    mockGet.mockResolvedValue(GOAL as never)
    mockStamp.mockResolvedValue(GOAL as never)
    const verify: GoalVerifier = vi.fn().mockResolvedValue({ verified: true })
    const { markGoalComplete } = makeTools(verify)

    const r = await markGoalComplete.execute(
      { goal_id: 'g1', because: 'Sent the report PDF to billing@acme.com' },
      ctx,
    )

    expect(r.isError).toBeFalsy()
    expect(verify).toHaveBeenCalledWith({
      outcome: GOAL.outcome,
      because: 'Sent the report PDF to billing@acme.com',
      userId: 'u1',
    })
    expect(mockStamp).toHaveBeenCalledWith('g1', 'Sent the report PDF to billing@acme.com')
  })

  it('does NOT stamp and returns the refutation when the verifier refutes', async () => {
    mockGet.mockResolvedValue(GOAL as never)
    const verify: GoalVerifier = vi
      .fn()
      .mockResolvedValue({ verified: false, refutation: 'no evidence the email was actually sent' })
    const { markGoalComplete } = makeTools(verify)

    const r = await markGoalComplete.execute({ goal_id: 'g1', because: 'I think it is done' }, ctx)

    expect(r.isError).toBe(true)
    expect(String(r.data)).toContain('no evidence')
    expect(mockStamp).not.toHaveBeenCalled()
  })

  it('refuses to stamp when no verifier is wired (fail-safe; bails before loading)', async () => {
    const { markGoalComplete } = makeTools(undefined)

    const r = await markGoalComplete.execute({ goal_id: 'g1', because: 'done' }, ctx)

    expect(r.isError).toBe(true)
    expect(mockGet).not.toHaveBeenCalled()
    expect(mockStamp).not.toHaveBeenCalled()
  })

  it('gathers host evidence and passes it into the verifier', async () => {
    mockGet.mockResolvedValue(GOAL as never)
    mockStamp.mockResolvedValue(GOAL as never)
    const verify: GoalVerifier = vi.fn().mockResolvedValue({ verified: true })
    const gatherEvidence = vi
      .fn()
      .mockResolvedValue('Host task "Email the Q3 report to Acme": status=done; due=none.')
    const { markGoalComplete } = makeTools(verify, gatherEvidence)

    const r = await markGoalComplete.execute(
      { goal_id: 'g1', because: 'Sent the report PDF to billing@acme.com' },
      ctx,
    )

    expect(r.isError).toBeFalsy()
    // Evidence is gathered for the loaded goal and threaded into the verdict call.
    expect(gatherEvidence).toHaveBeenCalledWith(GOAL)
    expect(verify).toHaveBeenCalledWith({
      outcome: GOAL.outcome,
      because: 'Sent the report PDF to billing@acme.com',
      evidence: 'Host task "Email the Q3 report to Acme": status=done; due=none.',
      userId: 'u1',
    })
    expect(mockStamp).toHaveBeenCalledWith('g1', 'Sent the report PDF to billing@acme.com')
  })

  it('still verifies (evidence omitted) when evidence-gathering throws — fail-soft', async () => {
    mockGet.mockResolvedValue(GOAL as never)
    mockStamp.mockResolvedValue(GOAL as never)
    const verify: GoalVerifier = vi.fn().mockResolvedValue({ verified: true })
    const gatherEvidence = vi.fn().mockRejectedValue(new Error('db unavailable'))
    const { markGoalComplete } = makeTools(verify, gatherEvidence)

    const r = await markGoalComplete.execute({ goal_id: 'g1', because: 'did the work' }, ctx)

    expect(r.isError).toBeFalsy()
    expect(verify).toHaveBeenCalledWith({
      outcome: GOAL.outcome,
      because: 'did the work',
      evidence: undefined,
      userId: 'u1',
    })
    expect(mockStamp).toHaveBeenCalled()
  })
})

describe('[COMP:goals/work-tools] waitForEvent (until:event park)', () => {
  const EVENT: EventSubscription = {
    source: { type: 'channel', channelIntegrationId: 'ci1', channel: 'slack' },
    match: { keywords: ['approved'] },
  }

  it('parks the goal: writes { subscriptions: [event] } via setGoalAwaitingEventSystem', async () => {
    mockGet.mockResolvedValue(GOAL as never)
    const { waitForEvent } = makeTools()

    const r = await waitForEvent.execute({ goal_id: 'g1', event: EVENT }, ctx)

    expect(r.isError).toBeFalsy()
    expect(mockSetAwaiting).toHaveBeenCalledWith('g1', { subscriptions: [EVENT] })
  })

  it('does not park (and reports) when the goal does not exist', async () => {
    mockGet.mockResolvedValue(null as never)
    const { waitForEvent } = makeTools()

    const r = await waitForEvent.execute({ goal_id: 'g1', event: EVENT }, ctx)

    expect(r.isError).toBe(true)
    expect(mockSetAwaiting).not.toHaveBeenCalled()
  })

  it('requires a workspace (goals are workspace-scoped)', async () => {
    const { waitForEvent } = makeTools()
    const r = await waitForEvent.execute(
      { goal_id: 'g1', event: EVENT },
      { workspaceId: null, userId: 'u1' } as never,
    )
    expect(r.isError).toBe(true)
    expect(mockGet).not.toHaveBeenCalled()
    expect(mockSetAwaiting).not.toHaveBeenCalled()
  })
})
