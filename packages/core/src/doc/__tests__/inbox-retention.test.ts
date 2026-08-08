/**
 * [COMP:core/inbox-types] Doc Inbox retention window.
 *
 * `resolveInboxCutoff` turns a workspace's retention setting into the instant
 * both Inbox lanes filter on. The cases that matter are the ones where "no
 * cutoff" is the right answer — a missing or nonsensical setting must show too
 * much rather than hide live items.
 *
 * Spec: docs/architecture/features/doc-inbox.md → "Retention".
 */

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_INBOX_RETENTION_DAYS,
  MAX_INBOX_RETENTION_DAYS,
  MIN_INBOX_RETENTION_DAYS,
  resolveInboxCutoff,
} from '../inbox-types.js'

const NOW = new Date('2026-03-01T12:00:00.000Z')

describe('[COMP:core/inbox-types] resolveInboxCutoff', () => {
  it('subtracts the window from now', () => {
    expect(resolveInboxCutoff(30, NOW)?.toISOString()).toBe('2026-01-30T12:00:00.000Z')
    expect(resolveInboxCutoff(7, NOW)?.toISOString()).toBe('2026-02-22T12:00:00.000Z')
  })

  it('defaults to a 30-day window', () => {
    expect(DEFAULT_INBOX_RETENTION_DAYS).toBe(30)
    expect(resolveInboxCutoff(DEFAULT_INBOX_RETENTION_DAYS, NOW)?.toISOString()).toBe(
      '2026-01-30T12:00:00.000Z',
    )
  })

  it('returns null (never prune) for null or undefined', () => {
    expect(resolveInboxCutoff(null, NOW)).toBeNull()
    expect(resolveInboxCutoff(undefined, NOW)).toBeNull()
  })

  it('returns null rather than a nonsense cutoff for zero, negatives, and NaN', () => {
    // A bad value must NOT resolve to "now" — that would hide every item in the
    // Inbox and read as data loss. Showing too much is the safe direction.
    expect(resolveInboxCutoff(0, NOW)).toBeNull()
    expect(resolveInboxCutoff(-5, NOW)).toBeNull()
    expect(resolveInboxCutoff(Number.NaN, NOW)).toBeNull()
    expect(resolveInboxCutoff(Number.POSITIVE_INFINITY, NOW)).toBeNull()
  })

  it('handles the accepted range bounds', () => {
    expect(MIN_INBOX_RETENTION_DAYS).toBe(1)
    expect(MAX_INBOX_RETENTION_DAYS).toBe(3650)
    expect(resolveInboxCutoff(MIN_INBOX_RETENTION_DAYS, NOW)?.toISOString()).toBe(
      '2026-02-28T12:00:00.000Z',
    )
    expect(resolveInboxCutoff(MAX_INBOX_RETENTION_DAYS, NOW)!.getTime()).toBeLessThan(NOW.getTime())
  })

  it('is pure — the same inputs give the same cutoff and `now` is never mutated', () => {
    const now = new Date(NOW)
    const a = resolveInboxCutoff(30, now)
    const b = resolveInboxCutoff(30, now)
    expect(a?.toISOString()).toBe(b?.toISOString())
    expect(now.toISOString()).toBe(NOW.toISOString())
  })
})
