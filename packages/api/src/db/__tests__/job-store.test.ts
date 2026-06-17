import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
}))

import { createDbJobStore } from '../job-store.js'
import { query } from '../client.js'

const mockQuery = vi.mocked(query)

beforeEach(() => {
  mockQuery.mockReset()
})

describe('[COMP:db/job-store-claim] markCompleted reap + nag preservation (2026-05 nag-chain collapse)', () => {
  it('deletes a once-job (no nag) and cascade-deletes the implicit workflow', async () => {
    // Read the row.
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          schedule: { type: 'once', datetime: '2026-05-04T10:00:00Z' },
          nag_interval_mins: null,
          channel_type: 'telegram',
          workflow_id: 'wf_1',
          state_json: {},
        },
      ],
      rowCount: 1,
    } as never)
    // DELETE scheduled_jobs.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    // DELETE workflows.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

    const store = createDbJobStore()
    await store.markCompleted('job_1', new Date(0))

    const sqls = mockQuery.mock.calls.map((c) => c[0] as string)
    expect(sqls[0]).toContain('SELECT schedule')
    expect(sqls[1]).toContain('DELETE FROM scheduled_jobs')
    expect(sqls[2]).toContain('DELETE FROM workflows')
  })

  it('deletes a once-job but skips workflow cascade when channel_type = workflow', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          schedule: { type: 'once', datetime: '2026-05-04T10:00:00Z' },
          nag_interval_mins: null,
          channel_type: 'workflow', // scheduleWorkflow-backed, leave intact
          workflow_id: 'wf_user_authored',
          state_json: {},
        },
      ],
      rowCount: 1,
    } as never)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

    const store = createDbJobStore()
    await store.markCompleted('job_1', new Date(0))

    expect(mockQuery).toHaveBeenCalledTimes(2)
    const sqls = mockQuery.mock.calls.map((c) => c[0] as string)
    expect(sqls[1]).toContain('DELETE FROM scheduled_jobs')
    expect(sqls.some((s) => s.includes('DELETE FROM workflows'))).toBe(false)
  })

  it('UPDATEs (does not delete) a recurring job', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          schedule: { type: 'daily', time: '09:00' },
          nag_interval_mins: null,
          channel_type: 'telegram',
          workflow_id: 'wf_1',
          state_json: {},
        },
      ],
      rowCount: 1,
    } as never)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

    const store = createDbJobStore()
    await store.markCompleted('job_1', new Date('2026-05-05T09:00:00Z'))

    const sqls = mockQuery.mock.calls.map((c) => c[0] as string)
    expect(sqls[1]).toContain('UPDATE scheduled_jobs')
    expect(sqls[1]).toContain('next_run_at = $2')
    expect(sqls.some((s) => s.includes('DELETE'))).toBe(false)
  })

  it('UPDATEs (does not delete) a nag-parent once-job — nag_interval_mins is non-null', async () => {
    // A `once` job WITH `nag_interval_mins` (theoretical edge case, but a
    // real safety guard) must not be reaped, because the nag cycle could
    // be live.
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          schedule: { type: 'once', datetime: '2026-05-04T10:00:00Z' },
          nag_interval_mins: 15,
          channel_type: 'telegram',
          workflow_id: 'wf_1',
          state_json: { activeNag: { openedAt: 'x', cycleDate: '2026-05-04' } },
        },
      ],
      rowCount: 1,
    } as never)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

    const store = createDbJobStore()
    await store.markCompleted('job_1', new Date(0))

    const sqls = mockQuery.mock.calls.map((c) => c[0] as string)
    expect(sqls.some((s) => s.includes('DELETE'))).toBe(false)
    // Open activeNag → don't overwrite next_run_at (preserve the
    // executor's `now + nagIntervalMins * 60_000` override).
    expect(sqls[1]).toContain('UPDATE scheduled_jobs')
    expect(sqls[1]).not.toContain('next_run_at = $2')
  })

  it('preserves next_run_at when activeNag is open (recurring + nag parent)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          schedule: { type: 'daily', time: '14:00' },
          nag_interval_mins: 15,
          channel_type: 'telegram',
          workflow_id: 'wf_1',
          state_json: { activeNag: { openedAt: 'x', cycleDate: '2026-05-04' } },
        },
      ],
      rowCount: 1,
    } as never)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

    const store = createDbJobStore()
    await store.markCompleted('job_1', new Date('2026-05-05T14:00:00Z'))

    const sqls = mockQuery.mock.calls.map((c) => c[0] as string)
    // markCompleted should NOT overwrite next_run_at when activeNag open.
    expect(sqls[1]).toContain('UPDATE scheduled_jobs')
    expect(sqls[1]).not.toContain('next_run_at = $2')
    expect(sqls[1]).toContain("last_status = 'completed'")
  })
})

describe('[COMP:db/job-store-claim] purgeDisabledOlderThan', () => {
  it('ages disabled rows by COALESCE(last_run_at, created_at) — NOT updated_at — so a migration bump cannot stall the GC', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 42 } as never)
    const store = createDbJobStore()
    const cutoff = new Date('2026-04-01T00:00:00Z')
    const n = await store.purgeDisabledOlderThan(cutoff)
    expect(n).toBe(42)
    expect(mockQuery).toHaveBeenCalledOnce()
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('DELETE FROM scheduled_jobs')
    expect(sql).toContain('enabled = false')
    expect(sql).toContain('COALESCE(last_run_at, created_at) < $1')
    // Regression guard: `updated_at` is bumped by table-wide migrations and
    // must never be the age column (2026-05-31 incident — the GC matched 0
    // rows while 146 disabled rows piled up).
    expect(sql).not.toContain('updated_at <')
    expect(params).toEqual([cutoff])
  })

  it('returns 0 when rowCount is null', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: null } as never)
    const store = createDbJobStore()
    expect(await store.purgeDisabledOlderThan(new Date())).toBe(0)
  })
})

describe('[COMP:db/job-store-claim] countEnabledRecurring', () => {
  it('counts enabled non-once jobs for a user', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '7' }], rowCount: 1 } as never)
    const store = createDbJobStore()
    const n = await store.countEnabledRecurring('user-1')
    expect(n).toBe(7)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('SELECT COUNT(*)')
    expect(sql).toContain('user_id = $1')
    expect(sql).toContain('enabled = true')
    expect(sql).toContain("schedule->>'type' != 'once'")
    expect(params).toEqual(['user-1'])
  })

  it('returns 0 when no rows', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    const store = createDbJobStore()
    expect(await store.countEnabledRecurring('user-1')).toBe(0)
  })
})

describe('[COMP:db/job-store-claim] getDueJobs lease semantics', () => {
  it('claims due jobs with an UPDATE that advances next_run_at by a 10-minute lease', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    const store = createDbJobStore()
    await store.getDueJobs()
    expect(mockQuery).toHaveBeenCalledOnce()
    const [sql] = mockQuery.mock.calls[0]
    // The claim must be a write, not a read — that's the bug fix.
    expect(sql).toContain('UPDATE scheduled_jobs')
    // The new next_run_at must be 10 minutes in the future. If anyone
    // shortens this without thinking, the runaway re-fire window opens
    // back up.
    expect(sql).toContain("next_run_at = now() + interval '10 minutes'")
    // FOR UPDATE SKIP LOCKED keeps the claim safe under future scale-out.
    expect(sql).toContain('FOR UPDATE SKIP LOCKED')
    // Only enabled, currently-due jobs are eligible.
    expect(sql).toContain('next_run_at <= now()')
    expect(sql).toContain('enabled = true')
    // The fields needed to construct a `ScheduledJob` must come back in
    // the same shape as before — keep RETURNING in sync with JOB_SELECT.
    expect(sql).toContain('RETURNING')
    expect(sql).toContain('schedule')
    expect(sql).toContain('"channelType"')
  })

  it('returns an array of jobs with leased state', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'j_1',
          assistantId: 'a_1',
          userId: 'u_1',
          schedule: { type: 'daily', time: '09:00' },
          timezone: 'Asia/Hong_Kong',
          mode: 'local',
          instructions: 'Do the thing',
          channelType: 'telegram',
          channelId: 'chat_1',
          enabled: true,
          nextRunAt: new Date(),
          lastRunAt: null,
          lastStatus: null,
          silentUntilFire: false,
          nagIntervalMins: null,
          nagUntilKeyword: null,
          state: null,
        },
      ],
      rowCount: 1,
    } as never)
    const store = createDbJobStore()
    const jobs = await store.getDueJobs()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].id).toBe('j_1')
    // null state is normalised to {} so the executor can `?.activeNag` safely.
    expect(jobs[0].state).toEqual({})
  })
})

describe('[COMP:db/job-store-claim] listEnabledByView (migration 229 — page schedule badge)', () => {
  it('filters to the page + owner + enabled, soonest first, and maps view_id', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'j_1',
          assistantId: 'a_1',
          userId: 'u_1',
          schedule: { type: 'daily', time: '07:00' },
          timezone: 'UTC',
          mode: 'local',
          instructions: 'Refresh the metrics',
          channelType: 'web',
          channelId: 'sess_1',
          enabled: true,
          nextRunAt: new Date(),
          lastRunAt: null,
          lastStatus: null,
          silentUntilFire: false,
          nagIntervalMins: null,
          nagUntilKeyword: null,
          state: null,
          workflowId: 'wf_1',
          workflowStepRunId: null,
          viewId: 'view_9',
        },
      ],
      rowCount: 1,
    } as never)

    const store = createDbJobStore()
    const jobs = await store.listEnabledByView('u_1', 'view_9')

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('view_id = $1')
    expect(sql).toContain('user_id = $2')
    expect(sql).toContain('enabled = true')
    expect(sql).toContain('ORDER BY next_run_at ASC')
    expect(params).toEqual(['view_9', 'u_1'])
    expect(jobs).toHaveLength(1)
    expect(jobs[0].viewId).toBe('view_9')
  })
})
