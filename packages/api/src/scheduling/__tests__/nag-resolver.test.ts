/**
 * Unit tests for the post-user-turn nag resolver.
 * Component tag: [COMP:api/scheduling-nag-resolver].
 *
 * Fakes a `JobStore`. Verifies detectAndResolveNags: the empty-message
 * and no-active-nags early exits, case-insensitive nagUntilKeyword
 * matching, skipping jobs with no keyword, clearing activeNag via
 * setState({}), and the post-collapse `next_run_at` rewind back to the
 * normal schedule cadence (so the parent doesn't keep re-firing on the
 * nag interval after resolution).
 */

import { describe, it, expect, vi } from 'vitest'

import { detectAndResolveNags } from '../nag-resolver.js'
import type { JobStore, ScheduledJob } from '@sidanclaw/core'

function job(over: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: 'job-1',
    assistantId: 'a-1',
    userId: 'u-1',
    schedule: { type: 'daily', time: '09:00' },
    timezone: 'UTC',
    mode: 'local',
    instructions: 'pill',
    channelType: 'telegram',
    channelId: 'chat_1',
    enabled: true,
    nextRunAt: new Date(),
    lastRunAt: null,
    lastStatus: null,
    silentUntilFire: false,
    nagIntervalMins: 15,
    nagUntilKeyword: 'done',
    state: { activeNag: { openedAt: '2026-05-04T02:00:00.000Z', cycleDate: '2026-05-04' } },
    workflowId: 'wf_1',
    workflowStepRunId: null,
    viewId: null,
    ...over,
  }
}

function makeJobStore(activeJobs: ScheduledJob[]) {
  return {
    listActiveNagsForUser: vi.fn().mockResolvedValue(activeJobs),
    setState: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(null),
  }
}

describe('[COMP:api/scheduling-nag-resolver] detectAndResolveNags', () => {
  it('exits early on an empty / whitespace-only message without touching the store', async () => {
    const js = makeJobStore([job()])
    const res = await detectAndResolveNags({
      userId: 'u-1',
      userMessage: '   ',
      jobStore: js as unknown as JobStore,
    })
    expect(res).toEqual({ resolved: 0, jobIds: [] })
    expect(js.listActiveNagsForUser).not.toHaveBeenCalled()
  })

  it('returns nothing when the user has no active nags', async () => {
    const js = makeJobStore([])
    const res = await detectAndResolveNags({
      userId: 'u-1',
      userMessage: 'done',
      jobStore: js as unknown as JobStore,
    })
    expect(res).toEqual({ resolved: 0, jobIds: [] })
    expect(js.setState).not.toHaveBeenCalled()
    expect(js.update).not.toHaveBeenCalled()
  })

  it('leaves nags open when the message matches no keyword', async () => {
    const js = makeJobStore([job({ nagUntilKeyword: 'done' })])
    const res = await detectAndResolveNags({
      userId: 'u-1',
      userMessage: 'still working on it',
      jobStore: js as unknown as JobStore,
    })
    expect(res).toEqual({ resolved: 0, jobIds: [] })
    expect(js.setState).not.toHaveBeenCalled()
    expect(js.update).not.toHaveBeenCalled()
  })

  it('resolves a nag on a case-insensitive keyword match, clearing state and rewinding next_run_at to the normal schedule', async () => {
    const js = makeJobStore([job({ id: 'job-1', nagUntilKeyword: 'done', assistantId: 'a-1', userId: 'u-1' })])
    const res = await detectAndResolveNags({
      userId: 'u-1',
      userMessage: 'all DONE now',
      jobStore: js as unknown as JobStore,
    })
    expect(res).toEqual({ resolved: 1, jobIds: ['job-1'] })
    expect(js.setState).toHaveBeenCalledWith('job-1', {})

    // The parent's next_run_at is rewound to the normal schedule via
    // computeNextRun(schedule, timezone). Without this, the executor's
    // most-recent `now + nagIntervalMins * 60_000` override would still
    // be on the row and the parent would re-fire on the nag interval
    // forever.
    expect(js.update).toHaveBeenCalledTimes(1)
    const [updatedId, updates] = js.update.mock.calls[0]
    expect(updatedId).toBe('job-1')
    expect((updates as { nextRunAt: Date }).nextRunAt).toBeInstanceOf(Date)
    // It is the daily 09:00 UTC schedule fire (`computeNextRun`), NOT the
    // executor's `now + nagIntervalMins` override. Assert the schedule time
    // directly — clock-independent. (The old `> 30min from now` check was
    // flaky: it failed whenever the test ran in the 08:30-09:00 UTC window,
    // where the next 09:00 fire is genuinely less than 30 minutes away.)
    const next = (updates as { nextRunAt: Date }).nextRunAt
    expect(next.getUTCHours()).toBe(9)
    expect(next.getUTCMinutes()).toBe(0)
  })

  it('skips an active job that has no nagUntilKeyword', async () => {
    const js = makeJobStore([job({ id: 'job-x', nagUntilKeyword: null as unknown as string })])
    const res = await detectAndResolveNags({
      userId: 'u-1',
      userMessage: 'done',
      jobStore: js as unknown as JobStore,
    })
    expect(res).toEqual({ resolved: 0, jobIds: [] })
    expect(js.setState).not.toHaveBeenCalled()
    expect(js.update).not.toHaveBeenCalled()
  })

  it('resolves only the jobs whose keyword the message matches', async () => {
    const js = makeJobStore([
      job({ id: 'job-1', nagUntilKeyword: 'done' }),
      job({ id: 'job-2', nagUntilKeyword: 'finished' }),
    ])
    const res = await detectAndResolveNags({
      userId: 'u-1',
      userMessage: 'I am done',
      jobStore: js as unknown as JobStore,
    })
    expect(res).toEqual({ resolved: 1, jobIds: ['job-1'] })
    expect(js.setState).toHaveBeenCalledTimes(1)
    expect(js.setState).toHaveBeenCalledWith('job-1', {})
    expect(js.update).toHaveBeenCalledTimes(1)
    expect(js.update.mock.calls[0][0]).toBe('job-1')
  })
})
