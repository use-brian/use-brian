/**
 * worker_runs cleanup sweep — Phase 5 hardening follow-up.
 *
 * Component tag: [COMP:api/worker-runs-cleanup].
 * Spec: docs/architecture/engine/askquestion-suspend-resume.md.
 *
 * Asserts:
 *   - calls deleteTerminalOlderThan with a cutoff in the past
 *   - uses the default retention (30 days) when no override is passed
 *   - honors the retentionDays override
 *   - returns the deleted row count
 */

import { describe, it, expect, vi } from 'vitest'
import {
  sweepStaleWorkerRuns,
  WORKER_RUNS_RETENTION_DAYS,
} from '../worker-runs-cleanup.js'
import type { WorkerRunsStore } from '@use-brian/core'

function makeStore(): WorkerRunsStore & {
  spy: ReturnType<typeof vi.fn>
} {
  const spy = vi.fn(async (_cutoff: Date) => 5)
  return {
    spy,
    recordSpawn: vi.fn(),
    recordTurn: vi.fn(),
    recordCompletion: vi.fn(),
    loadForSession: vi.fn(async () => []),
    deleteTerminalOlderThan: spy,
    listRecentForWorkspace: vi.fn(async () => []),
  }
}

describe('[COMP:api/worker-runs-cleanup] sweepStaleWorkerRuns', () => {
  it('uses 30-day retention by default', async () => {
    const store = makeStore()
    const before = Date.now()
    const n = await sweepStaleWorkerRuns(store)
    expect(n).toBe(5)
    expect(store.spy).toHaveBeenCalledTimes(1)
    const cutoff = store.spy.mock.calls[0]?.[0] as Date
    const cutoffAgeMs = before - cutoff.getTime()
    const expectedAgeMs = WORKER_RUNS_RETENTION_DAYS * 24 * 60 * 60 * 1000
    // Allow a few ms of clock drift between the test's `before` and the
    // sweep helper's internal `Date.now()`.
    expect(cutoffAgeMs).toBeGreaterThanOrEqual(expectedAgeMs - 1000)
    expect(cutoffAgeMs).toBeLessThanOrEqual(expectedAgeMs + 1000)
  })

  it('honors a custom retentionDays override', async () => {
    const store = makeStore()
    const before = Date.now()
    await sweepStaleWorkerRuns(store, { retentionDays: 7 })
    const cutoff = store.spy.mock.calls[0]?.[0] as Date
    const cutoffAgeMs = before - cutoff.getTime()
    const expectedAgeMs = 7 * 24 * 60 * 60 * 1000
    expect(cutoffAgeMs).toBeGreaterThanOrEqual(expectedAgeMs - 1000)
    expect(cutoffAgeMs).toBeLessThanOrEqual(expectedAgeMs + 1000)
  })

  it('propagates the deleted row count', async () => {
    const store = makeStore()
    store.spy.mockResolvedValueOnce(42)
    const n = await sweepStaleWorkerRuns(store)
    expect(n).toBe(42)
  })
})
