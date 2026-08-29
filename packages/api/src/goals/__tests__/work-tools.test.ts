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
import { getGoalByIdSystem, setGoalAwaitingEventSystem, stampGoalCompletionSystem, updateGoalSystem } from '../../db/goals.js'
import type { EventSubscription, GoalVerifier } from '@use-brian/core'

const mockGet = vi.mocked(getGoalByIdSystem)
const mockStamp = vi.mocked(stampGoalCompletionSystem)
const mockSetAwaiting = vi.mocked(setGoalAwaitingEventSystem)
const mockUpdate = vi.mocked(updateGoalSystem)

beforeEach(() => vi.clearAllMocks())

const ctx = { workspaceId: 'w1', userId: 'u1', assistantId: 'a1' } as never
const GOAL = { id: 'g1', workspaceId: 'w1', outcome: 'Email the Q3 report to Acme', confirmedAt: new Date() }

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
      workspaceId: 'w1',
      assistantId: 'a1',
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

  it('refuses to stamp when no verifier is wired (fail-safe)', async () => {
    mockGet.mockResolvedValue(GOAL as never)
    const { markGoalComplete } = makeTools(undefined)

    const r = await markGoalComplete.execute({ goal_id: 'g1', because: 'done' }, ctx)

    expect(r.isError).toBe(true)
    expect(mockGet).toHaveBeenCalledWith('g1')
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
      workspaceId: 'w1',
      assistantId: 'a1',
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
      workspaceId: 'w1',
      assistantId: 'a1',
    })
    expect(mockStamp).toHaveBeenCalled()
  })

  it('does not verify or stamp a goal owned by another workspace', async () => {
    mockGet.mockResolvedValue({ ...GOAL, workspaceId: 'w2' } as never)
    const verify: GoalVerifier = vi.fn().mockResolvedValue({ verified: true })
    const { markGoalComplete } = makeTools(verify)

    const result = await markGoalComplete.execute({ goal_id: 'g1', because: 'done' }, ctx)

    expect(result.isError).toBe(true)
    expect(verify).not.toHaveBeenCalled()
    expect(mockStamp).not.toHaveBeenCalled()
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
    expect(String(r.data)).toMatch(/not parked and no event subscription was written/i)
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

/**
 * [COMP:goals/work-tools] Failure copy — docs/architecture/engine/tool-executor.md
 * → "Failure copy". Every miss and gate on these four tools must name the goal
 * id, say what did NOT happen, point at the tool that re-resolves a live id,
 * and give the retry verdict. Goal ids are STABLE (`updateGoalSystem` updates
 * in place), which is the one thing a model reaching for a "newer id" needs
 * told, so it is asserted explicitly.
 */
describe('[COMP:goals/work-tools] failure copy — misses carry the discovery pointer', () => {
  const EVENT: EventSubscription = {
    source: { type: 'channel', channelIntegrationId: 'ci1', channel: 'slack' },
    match: { keywords: ['approved'] },
  }

  function expectGoalMiss(data: string) {
    expect(data).toContain('g1')
    expect(data).toMatch(/Goal g1 not found/i)
    expect(data).toContain('listGoals')
    expect(data).toMatch(/include_terminal/)
    // The supersession clause tasks/CRM carry is INVERTED here on purpose.
    expect(data).toMatch(/never mints a new id/i)
    expect(data).toMatch(/Do NOT retry this exact id/i)
  }

  it.each([
    ['workTask', (t: ReturnType<typeof makeTools>) => t.workTask.execute({ goal_id: 'g1' }, ctx)],
    [
      'waitForEvent',
      (t: ReturnType<typeof makeTools>) => t.waitForEvent.execute({ goal_id: 'g1', event: EVENT }, ctx),
    ],
  ])('%s: a missing goal names the id, listGoals, and the no-retry verdict', async (_name, run) => {
    mockGet.mockResolvedValue(null as never)
    expectGoalMiss(String((await run(makeTools())).data))
  })

  it('markGoalComplete: a missing goal says nothing was verified or stamped', async () => {
    mockGet.mockResolvedValue(null as never)
    const verify: GoalVerifier = vi.fn().mockResolvedValue({ verified: true })
    const r = await makeTools(verify).markGoalComplete.execute(
      { goal_id: 'g1', because: 'done' },
      ctx,
    )
    expect(r.isError).toBe(true)
    expectGoalMiss(String(r.data))
    expect(String(r.data)).toMatch(/Nothing was verified and nothing was stamped/i)
    expect(verify).not.toHaveBeenCalled()
  })

  it('markGoalComplete: a verifier PASS that cannot be stamped is not reported as a miss', async () => {
    mockGet.mockResolvedValue(GOAL as never)
    mockStamp.mockResolvedValue(null as never)
    const verify: GoalVerifier = vi.fn().mockResolvedValue({ verified: true })

    const r = await makeTools(verify).markGoalComplete.execute(
      { goal_id: 'g1', because: 'sent it' },
      ctx,
    )

    expect(r.isError).toBe(true)
    const data = String(r.data)
    expect(data).toMatch(/verifier ACCEPTED/i)
    expect(data).toMatch(/did not close/i)
    expect(data).toMatch(/deleted while the claim was being verified/i)
    expect(data).toMatch(/Do NOT retry this exact id/i)
    // It is NOT a plain not-found: there is nothing to re-resolve to.
    expect(data).not.toMatch(/never mints a new id/i)
  })

  it('markGoalComplete: no verifier wired names the missing dependency and the remedy', async () => {
    const r = await makeTools(undefined).markGoalComplete.execute(
      { goal_id: 'g1', because: 'done' },
      ctx,
    )
    expect(r.isError).toBe(true)
    const data = String(r.data)
    expect(data).toContain('g1')
    expect(data).toMatch(/no completion verifier wired/i)
    expect(data).toMatch(/only close on a verifier PASS/i)
    expect(data).toMatch(/Nothing was saved/i)
    expect(data).toMatch(/goals board/i)
    expect(data).toMatch(/fail the same way/i)
    // Never the banned shape.
    expect(data).not.toMatch(/not available in this context/i)
  })

  it('markGoalComplete: a refutation names the outcome it was judged against', async () => {
    mockGet.mockResolvedValue(GOAL as never)
    const verify: GoalVerifier = vi
      .fn()
      .mockResolvedValue({ verified: false, refutation: 'no evidence the email was sent' })

    const r = await makeTools(verify).markGoalComplete.execute(
      { goal_id: 'g1', because: 'I think it is done' },
      ctx,
    )

    expect(r.isError).toBe(true)
    const data = String(r.data)
    expect(data).toContain(GOAL.outcome)
    expect(data).toContain('no evidence the email was sent')
    expect(data).toMatch(/nothing was stamped and the goal stays open/i)
    expect(data).toMatch(/same `because` unchanged will be rejected/i)
    expect(mockStamp).not.toHaveBeenCalled()
  })

  it('workTask: an unconfirmed goal names the draft state, confirmGoal, and the verdict', async () => {
    mockGet.mockResolvedValue({ ...GOAL, confirmedAt: null } as never)

    const r = await makeTools().workTask.execute({ goal_id: 'g1' }, ctx)

    expect(r.isError).toBe(true)
    const data = String(r.data)
    expect(data).toContain('g1')
    expect(data).toMatch(/still a DRAFT/i)
    expect(data).toContain(GOAL.outcome)
    expect(data).toContain('confirmGoal')
    expect(data).toMatch(/nothing was started/i)
    expect(data).toMatch(/refused the same way/i)
  })

  it('workTask: emits acceptance metadata only after kickoff succeeds', async () => {
    mockGet.mockResolvedValue(GOAL as never)
    mockUpdate.mockResolvedValue({ ...GOAL, means: { workflowId: 'wf-1' } } as never)
    const createCompletionWorkflow = vi.fn().mockResolvedValue('wf-1')
    const kickoffGoal = vi.fn().mockResolvedValue(undefined)
    const { workTask } = createGoalWorkTools({
      createCompletionWorkflow,
      kickoffGoal,
    })

    const result = await workTask.execute({ goal_id: 'g1' }, ctx)

    expect(kickoffGoal).toHaveBeenCalledWith('g1')
    expect(result.isError).toBeFalsy()
    expect(result.meta).toEqual({ goal_event: 'accepted', goal_id: 'g1' })
  })

  it('the workspace gate names the missing binding and the remedy, not "this context"', async () => {
    const r = await makeTools().workTask.execute(
      { goal_id: 'g1' },
      { workspaceId: null, userId: 'u1' } as never,
    )
    expect(r.isError).toBe(true)
    const data = String(r.data)
    expect(data).toMatch(/not bound to one/i)
    expect(data).toMatch(/no goal was read or changed/i)
    expect(data).toMatch(/workspace-scoped chat/i)
    expect(data).toMatch(/fail the same way/i)
    expect(data).not.toMatch(/not available in this context/i)
  })
})

describe('[COMP:goals/work-tools] workTask origin-session stamp (in-chat pursuit)', () => {
  const UUID = '123e4567-e89b-42d3-a456-426614174000'
  const armedCtx = (sessionId: string) =>
    ({ workspaceId: 'w1', userId: 'u1', assistantId: 'a1', sessionId }) as never

  function makeWorkTools() {
    return createGoalWorkTools({
      createCompletionWorkflow: vi.fn().mockResolvedValue('wf1'),
      kickoffGoal: vi.fn(),
    })
  }

  it('stamps a UUID chat session onto the goal when arming', async () => {
    mockGet.mockResolvedValue({ ...GOAL, means: {} } as never)
    mockUpdate.mockResolvedValue({ ...GOAL, means: { workflowId: 'wf1' } } as never)
    const r = await makeWorkTools().workTask.execute({ goal_id: 'g1' }, armedCtx(UUID))
    expect(r.isError).toBeFalsy()
    expect(mockUpdate).toHaveBeenCalledWith(
      'g1',
      expect.objectContaining({ originSessionId: UUID }),
    )
  })

  it('stamps nothing for a synthetic workflow-run session id', async () => {
    mockGet.mockResolvedValue({ ...GOAL, means: {} } as never)
    mockUpdate.mockResolvedValue({ ...GOAL, means: { workflowId: 'wf1' } } as never)
    const r = await makeWorkTools().workTask.execute(
      { goal_id: 'g1' },
      armedCtx(`workflow_run_${UUID}`),
    )
    expect(r.isError).toBeFalsy()
    expect(mockUpdate).toHaveBeenCalledWith(
      'g1',
      expect.not.objectContaining({ originSessionId: expect.anything() }),
    )
  })
})
