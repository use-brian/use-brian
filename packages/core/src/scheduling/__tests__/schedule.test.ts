import { describe, it, expect } from 'vitest'
import { computeNextRun, type StructuredSchedule } from '../schedule.js'

describe('[COMP:scheduling/schedule] computeNextRun', () => {
  it('daily: returns next occurrence of the time', () => {
    const schedule: StructuredSchedule = { type: 'daily', time: '09:00' }
    // Use a fixed "after" date: 2026-04-08 10:00 UTC
    const after = new Date('2026-04-08T10:00:00Z')
    const next = computeNextRun(schedule, 'UTC', after)

    // Should be tomorrow 09:00 UTC (since 10:00 > 09:00)
    expect(next.getUTCHours()).toBe(9)
    expect(next.getUTCDate()).toBe(9)
  })

  it('daily: returns today if time has not passed', () => {
    const schedule: StructuredSchedule = { type: 'daily', time: '15:00' }
    const after = new Date('2026-04-08T10:00:00Z')
    const next = computeNextRun(schedule, 'UTC', after)

    expect(next.getUTCHours()).toBe(15)
    expect(next.getUTCDate()).toBe(8) // today
  })

  it('weekly: returns correct next day', () => {
    const schedule: StructuredSchedule = { type: 'weekly', days: ['friday'], time: '09:00' }
    // 2026-04-08 is a Wednesday
    const after = new Date('2026-04-08T10:00:00Z')
    const next = computeNextRun(schedule, 'UTC', after)

    expect(next.getUTCDay()).toBe(5) // Friday
    expect(next.getUTCHours()).toBe(9)
  })

  it('monthly: returns next month if day passed', () => {
    const schedule: StructuredSchedule = { type: 'monthly', dayOfMonth: 1, time: '08:00' }
    const after = new Date('2026-04-08T10:00:00Z')
    const next = computeNextRun(schedule, 'UTC', after)

    expect(next.getUTCDate()).toBe(1)
    expect(next.getUTCMonth()).toBe(4) // May (0-indexed)
  })

  it('cron: basic hour:minute', () => {
    const schedule: StructuredSchedule = { type: 'cron', expression: '30 14 * * *' }
    const after = new Date('2026-04-08T10:00:00Z')
    const next = computeNextRun(schedule, 'UTC', after)

    expect(next.getUTCHours()).toBe(14)
    expect(next.getUTCMinutes()).toBe(30)
  })

  it('cron: step expression "*/15 * * * *" picks the next quarter-hour', () => {
    const schedule: StructuredSchedule = { type: 'cron', expression: '*/15 * * * *' }
    const after = new Date('2026-04-08T10:07:00Z')
    const next = computeNextRun(schedule, 'UTC', after)

    expect(next.toISOString()).toBe('2026-04-08T10:15:00.000Z')
  })

  it('cron: step expression "0 */2 * * *" picks the next even hour', () => {
    const schedule: StructuredSchedule = { type: 'cron', expression: '0 */2 * * *' }
    const after = new Date('2026-04-08T11:30:00Z')
    const next = computeNextRun(schedule, 'UTC', after)

    // Next even hour after 11:30 UTC is 12:00.
    expect(next.toISOString()).toBe('2026-04-08T12:00:00.000Z')
  })

  it('cron: throws UnsupportedCronExpressionError on malformed expressions', () => {
    const schedule: StructuredSchedule = { type: 'cron', expression: 'bogus' }
    expect(() => computeNextRun(schedule, 'UTC')).toThrow(/Unsupported cron expression/)
  })

  it('cron: never returns Invalid Date', () => {
    // Under the old parser, "*/15 * * * *" produced Invalid Date via
    // parseInt('*/15') = NaN → setUTCMinutes(NaN). The new parser must
    // either return a valid Date or throw — never produce Invalid Date.
    const schedule: StructuredSchedule = { type: 'cron', expression: '*/15 * * * *' }
    const next = computeNextRun(schedule, 'UTC', new Date('2026-04-19T01:30:00Z'))
    expect(Number.isNaN(next.getTime())).toBe(false)
  })

  it('once: returns the exact datetime when timezone is UTC', () => {
    const schedule: StructuredSchedule = { type: 'once', datetime: '2026-04-10T15:30:00Z' }
    const next = computeNextRun(schedule, 'UTC')

    // Z is stripped, interpreted as 15:30 UTC → 15:30 UTC
    expect(next.toISOString()).toBe('2026-04-10T15:30:00.000Z')
  })

  it('once: works with past datetime (poll worker picks it up)', () => {
    const schedule: StructuredSchedule = { type: 'once', datetime: '2026-04-01T08:00:00' }
    const next = computeNextRun(schedule, 'UTC')

    expect(next.toISOString()).toBe('2026-04-01T08:00:00.000Z')
  })

  it('once: bare datetime is interpreted in the user timezone, not UTC', () => {
    // "2026-04-14T17:43:00" without offset — user is in Asia/Hong_Kong (UTC+8)
    // Should be interpreted as 17:43 HKT = 09:43 UTC
    const schedule: StructuredSchedule = { type: 'once', datetime: '2026-04-14T17:43:00' }
    const next = computeNextRun(schedule, 'Asia/Hong_Kong')

    expect(next.toISOString()).toBe('2026-04-14T09:43:00.000Z')
  })

  it('once: Z suffix is stripped and datetime is interpreted in user timezone', () => {
    // LLM passes "04:01:00Z" but means 04:01 in Asia/Hong_Kong.
    // Z is stripped → 04:01 HKT = 20:01 UTC (previous day)
    const schedule: StructuredSchedule = { type: 'once', datetime: '2026-04-16T04:01:00Z' }
    const next = computeNextRun(schedule, 'Asia/Hong_Kong')

    expect(next.toISOString()).toBe('2026-04-15T20:01:00.000Z')
  })

  it('once: +HH:MM offset is stripped and datetime is interpreted in user timezone', () => {
    // 17:43 with +08:00 stripped → 17:43 HKT = 09:43 UTC
    const schedule: StructuredSchedule = { type: 'once', datetime: '2026-04-14T17:43:00+08:00' }
    const next = computeNextRun(schedule, 'Asia/Hong_Kong')

    expect(next.toISOString()).toBe('2026-04-14T09:43:00.000Z')
  })

  it('once: bare datetime with negative offset timezone', () => {
    // "2026-04-14T10:00:00" in America/New_York (UTC-4 in April)
    // Should be 14:00 UTC
    const schedule: StructuredSchedule = { type: 'once', datetime: '2026-04-14T10:00:00' }
    const next = computeNextRun(schedule, 'America/New_York')

    expect(next.toISOString()).toBe('2026-04-14T14:00:00.000Z')
  })
})
