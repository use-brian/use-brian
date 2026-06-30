import { describe, it, expect } from 'vitest'
import {
  backoffSeconds,
  decideContinuation,
  type ContinuationInput,
} from '../continuation.js'

const NOW = '2026-06-30T12:00:00.000Z'

function input(over: Partial<ContinuationInput> = {}): ContinuationInput {
  return {
    verdict: { met: false },
    budget: {},
    state: { iteration: 1, spend: 0, now: NOW, progressed: true, noProgressStreak: 0 },
    acting: true,
    meteringAvailable: true,
    ...over,
  }
}

describe('[COMP:goals/continuation-gate] continuation gate', () => {
  it('met done_when -> done', () => {
    expect(decideContinuation(input({ verdict: { met: true } }))).toEqual({ decision: 'done' })
  })

  it('done wins even when a budget is also exhausted', () => {
    const d = decideContinuation(
      input({ verdict: { met: true }, budget: { maxIterations: 1 }, state: { iteration: 9, spend: 0, now: NOW, progressed: false, noProgressStreak: 5 } }),
    )
    expect(d).toEqual({ decision: 'done' })
  })

  it('BARRIER: an acting goal with no metering blocks (cannot run cost-blind)', () => {
    expect(decideContinuation(input({ acting: true, meteringAvailable: false }))).toEqual({
      decision: 'blocked',
      reason: 'metering_unavailable',
    })
  })

  it('a non-acting (structural) goal is exempt from the metering barrier', () => {
    const d = decideContinuation(input({ acting: false, meteringAvailable: false }))
    expect(d).toMatchObject({ decision: 'continue' })
  })

  it('deadline passed -> blocked', () => {
    const d = decideContinuation(
      input({ budget: { deadline: '2026-06-30T11:00:00.000Z' } }), // before NOW
    )
    expect(d).toEqual({ decision: 'blocked', reason: 'deadline' })
  })

  it('maxIterations reached -> blocked', () => {
    const d = decideContinuation(
      input({ budget: { maxIterations: 5 }, state: { iteration: 5, spend: 0, now: NOW, progressed: true, noProgressStreak: 0 } }),
    )
    expect(d).toEqual({ decision: 'blocked', reason: 'max_iterations' })
  })

  it('maxSpend reached -> blocked', () => {
    const d = decideContinuation(
      input({ budget: { maxSpend: 10 }, state: { iteration: 2, spend: 10, now: NOW, progressed: true, noProgressStreak: 0 } }),
    )
    expect(d).toEqual({ decision: 'blocked', reason: 'max_spend' })
  })

  it('progress -> resume now', () => {
    expect(decideContinuation(input({ state: { iteration: 1, spend: 0, now: NOW, progressed: true, noProgressStreak: 0 } }))).toEqual({
      decision: 'continue',
      resume: { kind: 'now' },
    })
  })

  it('no progress -> resume after, growing with the streak', () => {
    const d1 = decideContinuation(input({ state: { iteration: 2, spend: 0, now: NOW, progressed: false, noProgressStreak: 0 } }))
    const d3 = decideContinuation(input({ state: { iteration: 4, spend: 0, now: NOW, progressed: false, noProgressStreak: 2 } }))
    expect(d1).toEqual({ decision: 'continue', resume: { kind: 'after', seconds: 60 } })
    expect(d3).toEqual({ decision: 'continue', resume: { kind: 'after', seconds: 240 } })
  })

  it('awaiting an event -> resume until(event), regardless of progress', () => {
    const event = { source: 'slack', match: { keywords: ['approved'] } }
    const d = decideContinuation(input({ state: { iteration: 2, spend: 0, now: NOW, progressed: false, noProgressStreak: 3, awaitingEvent: event } }))
    expect(d).toEqual({ decision: 'continue', resume: { kind: 'until', event } })
  })

  it('backoffSeconds grows exponentially, clamped to max', () => {
    expect(backoffSeconds(0)).toBe(60)
    expect(backoffSeconds(1)).toBe(120)
    expect(backoffSeconds(4)).toBe(960)
    expect(backoffSeconds(100)).toBe(3600) // clamped to the default max
    expect(backoffSeconds(2, { baseSeconds: 30, maxSeconds: 100 })).toBe(100) // 30*4=120 -> clamp 100
  })
})
