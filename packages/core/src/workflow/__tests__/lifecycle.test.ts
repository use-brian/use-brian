import { describe, it, expect } from 'vitest'
import {
  WORKFLOW_LIFECYCLE_DEFAULTS,
  decideLifecycle,
  isArmedListener,
  isOneOffWorkflow,
  isSpentOnceSchedule,
  isRecurringTrigger,
  lastActivityAt,
  pickDigestBatch,
  type WorkflowLifecycleRow,
} from '../lifecycle.js'
import type { WorkflowTrigger } from '../types.js'

const NOW = new Date('2026-07-07T12:00:00Z')

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)
}

const MANUAL: WorkflowTrigger = { kind: 'manual' }
const ONCE: WorkflowTrigger = {
  kind: 'schedule',
  schedule: { type: 'once', datetime: '2026-06-01T09:00:00Z' },
}
const DAILY: WorkflowTrigger = { kind: 'schedule', schedule: { type: 'daily', time: '09:00' } }
const EVENT: WorkflowTrigger = { kind: 'event', event: { sources: [{ source: { type: 'task' } }] } }
const WEBHOOK: WorkflowTrigger = { kind: 'webhook' }

function row(overrides: Partial<WorkflowLifecycleRow> = {}): WorkflowLifecycleRow {
  return {
    id: 'wf-1',
    workspaceId: 'ws-1',
    name: 'Scheduled reminder',
    description: 'Migrated from a legacy scheduled job (migration 159).',
    trigger: MANUAL,
    enabled: true,
    pinned: false,
    lifecycleState: 'active',
    lifecycleTransitionedAt: null,
    digestedAt: null,
    createdAt: daysAgo(120),
    updatedAt: daysAgo(120),
    lastRunAt: null,
    runCount: 0,
    hasLiveFire: false,
    ...overrides,
  }
}

describe('[COMP:workflow/lifecycle] Workflow lifecycle policy', () => {
  describe('isRecurringTrigger', () => {
    it('classifies event/webhook/recurring-schedule as recurring', () => {
      expect(isRecurringTrigger(EVENT)).toBe(true)
      expect(isRecurringTrigger(WEBHOOK)).toBe(true)
      expect(isRecurringTrigger(DAILY)).toBe(true)
    })

    it('classifies manual, schedule-once, and absent trigger as one-shot', () => {
      expect(isRecurringTrigger(MANUAL)).toBe(false)
      expect(isRecurringTrigger(ONCE)).toBe(false)
      expect(isRecurringTrigger(undefined)).toBe(false)
    })
  })

  describe('lastActivityAt', () => {
    it('takes the newest of last run and last edit', () => {
      expect(lastActivityAt({ updatedAt: daysAgo(50), lastRunAt: daysAgo(10) })).toEqual(daysAgo(10))
      expect(lastActivityAt({ updatedAt: daysAgo(5), lastRunAt: daysAgo(10) })).toEqual(daysAgo(5))
      expect(lastActivityAt({ updatedAt: daysAgo(5), lastRunAt: null })).toEqual(daysAgo(5))
    })
  })

  describe('isArmedListener', () => {
    it('treats enabled event/webhook workflows as armed', () => {
      expect(isArmedListener(row({ trigger: EVENT }))).toBe(true)
      expect(isArmedListener(row({ trigger: WEBHOOK }))).toBe(true)
    })

    it('treats a live scheduled fire as armed regardless of trigger kind', () => {
      expect(isArmedListener(row({ trigger: ONCE, hasLiveFire: true }))).toBe(true)
      expect(isArmedListener(row({ trigger: DAILY, hasLiveFire: true }))).toBe(true)
    })

    it('disabled workflows are never armed', () => {
      expect(isArmedListener(row({ trigger: EVENT, enabled: false }))).toBe(false)
      expect(isArmedListener(row({ trigger: DAILY, enabled: false, hasLiveFire: false }))).toBe(false)
    })

    it('an enabled manual workflow with no pending fire is not armed', () => {
      expect(isArmedListener(row({ trigger: MANUAL }))).toBe(false)
    })
  })

  describe('isOneOffWorkflow', () => {
    it('manual/once triggers with at most one run are one-offs', () => {
      expect(isOneOffWorkflow(row({ trigger: MANUAL, runCount: 0 }))).toBe(true)
      expect(isOneOffWorkflow(row({ trigger: ONCE, runCount: 1 }))).toBe(true)
    })

    it('recurring triggers or real run history are never one-offs', () => {
      expect(isOneOffWorkflow(row({ trigger: DAILY, runCount: 0 }))).toBe(false)
      expect(isOneOffWorkflow(row({ trigger: EVENT, runCount: 1 }))).toBe(false)
      expect(isOneOffWorkflow(row({ trigger: MANUAL, runCount: 2 }))).toBe(false)
    })
  })

  describe('isSpentOnceSchedule', () => {
    it('a schedule-once workflow with no live fire is spent', () => {
      expect(isSpentOnceSchedule(row({ trigger: ONCE, hasLiveFire: false }))).toBe(true)
    })

    it('a schedule-once workflow with a live fire pending is NOT spent (still armed)', () => {
      expect(isSpentOnceSchedule(row({ trigger: ONCE, hasLiveFire: true }))).toBe(false)
    })

    it('manual / recurring / event / webhook are never spent one-offs', () => {
      expect(isSpentOnceSchedule(row({ trigger: MANUAL, hasLiveFire: false }))).toBe(false)
      expect(isSpentOnceSchedule(row({ trigger: DAILY, hasLiveFire: false }))).toBe(false)
      expect(isSpentOnceSchedule(row({ trigger: EVENT, hasLiveFire: false }))).toBe(false)
      expect(isSpentOnceSchedule(row({ trigger: WEBHOOK, hasLiveFire: false }))).toBe(false)
    })
  })

  describe('decideLifecycle — transitions', () => {
    it('leaves a recently active workflow alone', () => {
      expect(decideLifecycle(row({ updatedAt: daysAgo(3) }), NOW)).toEqual({ action: 'none' })
    })

    it('marks an idle manual workflow stale after staleAfterDays', () => {
      const decision = decideLifecycle(row({ updatedAt: daysAgo(34) }), NOW)
      expect(decision.action).toBe('mark_stale')
      expect(decision).toMatchObject({ reason: 'no activity for 34 days' })
    })

    it('recent run activity counts as activity even when the row is old', () => {
      const decision = decideLifecycle(
        row({ updatedAt: daysAgo(120), lastRunAt: daysAgo(2), runCount: 5 }),
        NOW,
      )
      expect(decision).toEqual({ action: 'none' })
    })

    it('never stales an armed event listener however idle', () => {
      const decision = decideLifecycle(row({ trigger: EVENT, updatedAt: daysAgo(200) }), NOW)
      expect(decision).toEqual({ action: 'none' })
    })

    it('never stales a workflow with a live future fire (quarterly cron / far-future once)', () => {
      const decision = decideLifecycle(
        row({ trigger: DAILY, hasLiveFire: true, updatedAt: daysAgo(200) }),
        NOW,
      )
      expect(decision).toEqual({ action: 'none' })
    })

    it('a DISABLED event workflow does age out', () => {
      const decision = decideLifecycle(
        row({ trigger: EVENT, enabled: false, updatedAt: daysAgo(45) }),
        NOW,
      )
      expect(decision.action).toBe('mark_stale')
    })

    it('archives a stale workflow only after the full stale wait (archive − stale window)', () => {
      // Default wait in stale = 90 − 30 = 60 days.
      const staleRow = row({
        lifecycleState: 'stale',
        updatedAt: daysAgo(95),
        lifecycleTransitionedAt: daysAgo(65),
      })
      const decision = decideLifecycle(staleRow, NOW)
      expect(decision.action).toBe('archive')
      expect(decision).toMatchObject({ reason: 'no activity for at least 95 days' })

      // Long-idle but only just marked stale — degrades in two visible steps.
      const freshlyStale = row({
        lifecycleState: 'stale',
        updatedAt: daysAgo(400),
        lifecycleTransitionedAt: daysAgo(2),
      })
      expect(decideLifecycle(freshlyStale, NOW)).toEqual({ action: 'none' })

      // Mid-wait — stays stale.
      const midStale = row({
        lifecycleState: 'stale',
        updatedAt: daysAgo(60),
        lifecycleTransitionedAt: daysAgo(20),
      })
      expect(decideLifecycle(midStale, NOW)).toEqual({ action: 'none' })
    })

    it("the sweep's own transition write (updated_at == transitioned_at) is not a touch", () => {
      // The set_updated_at trigger bumps updated_at on the stale-mark UPDATE
      // itself, so both stamps are equal — the row must keep ageing, not
      // ping-pong back to active.
      const marked = row({
        lifecycleState: 'stale',
        updatedAt: daysAgo(65),
        lifecycleTransitionedAt: daysAgo(65),
      })
      expect(decideLifecycle(marked, NOW).action).toBe('archive')
    })

    it('reactivates a stale workflow that RAN after the transition', () => {
      const ran = decideLifecycle(
        row({
          lifecycleState: 'stale',
          updatedAt: daysAgo(9),
          lifecycleTransitionedAt: daysAgo(9),
          lastRunAt: daysAgo(2),
          runCount: 1,
        }),
        NOW,
      )
      expect(ran.action).toBe('reactivate')
    })

    it('a bare updated_at bump on a stale row is NOT a touch (system writes)', () => {
      // The digest stamp / storm pause bump updated_at via the set_updated_at
      // trigger; user edits un-stale synchronously in the store instead. The
      // sweep must keep ageing the row.
      const stamped = decideLifecycle(
        row({
          lifecycleState: 'stale',
          updatedAt: daysAgo(1),
          lifecycleTransitionedAt: daysAgo(65),
          lastRunAt: null,
        }),
        NOW,
      )
      expect(stamped.action).toBe('archive')
    })

    it('reactivates a stale listener whose trigger is armed again', () => {
      const decision = decideLifecycle(
        row({
          lifecycleState: 'stale',
          trigger: EVENT,
          updatedAt: daysAgo(60),
          lifecycleTransitionedAt: daysAgo(10),
        }),
        NOW,
      )
      expect(decision.action).toBe('reactivate')
    })

    it('deletes an archived one-off after the delete grace period', () => {
      const decision = decideLifecycle(
        row({
          lifecycleState: 'archived',
          trigger: MANUAL,
          runCount: 1,
          updatedAt: daysAgo(150),
          lifecycleTransitionedAt: daysAgo(31),
        }),
        NOW,
      )
      expect(decision.action).toBe('delete')
    })

    it('never deletes an archived recurring or multi-run workflow', () => {
      const recurring = row({
        lifecycleState: 'archived',
        trigger: DAILY,
        enabled: false,
        runCount: 40,
        lifecycleTransitionedAt: daysAgo(200),
      })
      expect(decideLifecycle(recurring, NOW)).toEqual({ action: 'none' })

      const multiRun = row({
        lifecycleState: 'archived',
        trigger: MANUAL,
        runCount: 7,
        lifecycleTransitionedAt: daysAgo(200),
      })
      expect(decideLifecycle(multiRun, NOW)).toEqual({ action: 'none' })
    })

    it('holds an archived one-off inside the grace period', () => {
      const decision = decideLifecycle(
        row({
          lifecycleState: 'archived',
          trigger: MANUAL,
          runCount: 0,
          lifecycleTransitionedAt: daysAgo(10),
        }),
        NOW,
      )
      expect(decision).toEqual({ action: 'none' })
    })

    it('pinned exempts from every transition and restores a degraded row', () => {
      expect(decideLifecycle(row({ pinned: true, updatedAt: daysAgo(400) }), NOW)).toEqual({
        action: 'none',
      })
      expect(
        decideLifecycle(
          row({ pinned: true, lifecycleState: 'stale', updatedAt: daysAgo(400) }),
          NOW,
        ).action,
      ).toBe('reactivate')
      expect(
        decideLifecycle(
          row({
            pinned: true,
            lifecycleState: 'archived',
            trigger: MANUAL,
            runCount: 0,
            lifecycleTransitionedAt: daysAgo(400),
          }),
          NOW,
        ).action,
      ).toBe('reactivate')
    })

    it('walks the ladder one step at a time (no active → archived jump)', () => {
      // 200 days idle but still 'active': first sweep only marks stale.
      const decision = decideLifecycle(row({ updatedAt: daysAgo(200) }), NOW)
      expect(decision.action).toBe('mark_stale')
    })

    it('archives a spent one-off schedule on the FIRST sweep (skips the stale dwell)', () => {
      // A fired reminder — schedule-once, no live fire — is unambiguously done,
      // so it jumps straight to archived even though it just "ran".
      const decision = decideLifecycle(
        row({ trigger: ONCE, hasLiveFire: false, updatedAt: daysAgo(1), runCount: 1 }),
        NOW,
      )
      expect(decision.action).toBe('archive')
    })

    it('does NOT fast-archive a still-armed future one-off reminder', () => {
      // hasLiveFire → an enabled trigger row is still pending; it has not fired.
      const decision = decideLifecycle(
        row({ trigger: ONCE, hasLiveFire: true, updatedAt: daysAgo(1) }),
        NOW,
      )
      expect(decision).toEqual({ action: 'none' })
    })

    it('a pinned spent one-off is exempt from the fast-archive', () => {
      const decision = decideLifecycle(
        row({ trigger: ONCE, hasLiveFire: false, pinned: true, updatedAt: daysAgo(1) }),
        NOW,
      )
      expect(decision).toEqual({ action: 'none' })
    })

    it('does NOT fast-archive a fresh idle manual workflow (only schedule-once qualifies)', () => {
      const decision = decideLifecycle(row({ trigger: MANUAL, hasLiveFire: false, updatedAt: daysAgo(3) }), NOW)
      expect(decision).toEqual({ action: 'none' })
    })

    it('honors custom thresholds', () => {
      const config = { ...WORKFLOW_LIFECYCLE_DEFAULTS, staleAfterDays: 5 }
      expect(decideLifecycle(row({ updatedAt: daysAgo(6) }), NOW, config).action).toBe('mark_stale')
      expect(decideLifecycle(row({ updatedAt: daysAgo(4) }), NOW, config).action).toBe('none')
    })
  })

  describe('pickDigestBatch', () => {
    it('picks never-digested stale rows, oldest activity first, capped', () => {
      const a = row({ id: 'a', lifecycleState: 'stale', updatedAt: daysAgo(50) })
      const b = row({ id: 'b', lifecycleState: 'stale', updatedAt: daysAgo(90) })
      const c = row({ id: 'c', lifecycleState: 'archived', updatedAt: daysAgo(200) })
      const active = row({ id: 'd', lifecycleState: 'active', updatedAt: daysAgo(2) })
      const digested = row({ id: 'e', lifecycleState: 'stale', digestedAt: daysAgo(1) })
      const pinned = row({ id: 'f', lifecycleState: 'stale', pinned: true })

      const batch = pickDigestBatch([a, b, c, active, digested, pinned], 2)
      expect(batch.map((r) => r.id)).toEqual(['c', 'b'])
    })
  })
})
