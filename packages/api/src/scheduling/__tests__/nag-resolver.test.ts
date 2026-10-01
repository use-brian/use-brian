/**
 * Unit tests for the post-user-turn nag resolver.
 * Component tag: [COMP:api/scheduling-nag-resolver].
 *
 * Fakes a `JobStore`. Verifies detectAndResolveNags: the empty-message
 * and no-active-nags early exits, case-insensitive nagUntilKeyword
 * matching, skipping jobs with no keyword, compare-and-swap resolution, and the post-collapse `next_run_at` rewind back to the
 * normal schedule cadence (so the parent doesn't keep re-firing on the
 * nag interval after resolution).
 */

import { describe, it, expect, vi } from 'vitest'

import { detectAndResolveNags } from '../nag-resolver.js'
import type { JobStore, ScheduledJob } from '@use-brian/core'

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
    resolveActiveNag: vi.fn().mockResolvedValue(true),
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
    expect(js.resolveActiveNag).toHaveBeenCalledWith('job-1', 'u-1', job().state.activeNag, expect.any(Date))
    expect(js.setState).not.toHaveBeenCalled()
    expect(js.update).not.toHaveBeenCalled()
    const next = js.resolveActiveNag.mock.calls[0][3] as Date
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
    expect(js.resolveActiveNag).toHaveBeenCalledTimes(1)
    expect(js.resolveActiveNag.mock.calls[0][0]).toBe('job-1')
    expect(js.setState).not.toHaveBeenCalled()
    expect(js.update).not.toHaveBeenCalled()
  })
  it('counts only applied resolutions, not stale cycles', async () => {
    const js = makeJobStore([job(), job({ id: 'job-2' })])
    js.resolveActiveNag.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    expect(await detectAndResolveNags({ userId: 'u-1', userMessage: 'done', jobStore: js as unknown as JobStore }))
      .toEqual({ resolved: 1, jobIds: ['job-2'] })
    expect(js.setState).not.toHaveBeenCalled()
    expect(js.update).not.toHaveBeenCalled()
  })

  it('fails closed without an atomic resolution port or observed cycle', async () => {
    for (const js of [makeJobStore([job({ state: {} })]), { ...makeJobStore([job()]), resolveActiveNag: undefined }]) {
      expect(await detectAndResolveNags({ userId: 'u-1', userMessage: 'done', jobStore: js as unknown as JobStore }))
        .toEqual({ resolved: 0, jobIds: [] })
      expect(js.setState).not.toHaveBeenCalled()
      expect(js.update).not.toHaveBeenCalled()
    }
  })

})
