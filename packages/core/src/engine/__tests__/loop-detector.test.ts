import { describe, it, expect } from 'vitest'
import { createLoopDetector } from '../loop-detector.js'

describe('[COMP:engine/loop-detector] createLoopDetector', () => {
  it('allows the first call to a tool', () => {
    const det = createLoopDetector()
    expect(det.check('weather', { city: 'Tokyo' })).toBe('allow')
    expect(det.totalToolCalls).toBe(1)
  })

  it('nudges at the 3rd identical call', () => {
    const det = createLoopDetector()
    expect(det.check('weather', { city: 'Tokyo' })).toBe('allow')
    expect(det.check('weather', { city: 'Tokyo' })).toBe('allow')
    expect(det.check('weather', { city: 'Tokyo' })).toBe('nudge')
  })

  it('blocks at the 5th identical call', () => {
    const det = createLoopDetector()
    for (let i = 0; i < 4; i++) det.check('weather', { city: 'Tokyo' })
    expect(det.check('weather', { city: 'Tokyo' })).toBe('block')
  })

  it('does not escalate when inputs differ', () => {
    const det = createLoopDetector()
    // Same tool, different input = different key
    expect(det.check('weather', { city: 'Tokyo' })).toBe('allow')
    expect(det.check('weather', { city: 'Paris' })).toBe('allow')
    expect(det.check('weather', { city: 'Berlin' })).toBe('allow')
    expect(det.check('weather', { city: 'Madrid' })).toBe('allow')
  })

  it('hard-stops after 10 total calls regardless of key diversity', () => {
    const det = createLoopDetector()
    // 9 unique calls — should all return non-hard-stop
    for (let i = 0; i < 9; i++) {
      expect(det.check('weather', { city: `City${i}` })).toBe('allow')
    }
    // 10th call → hard_stop
    expect(det.check('weather', { city: 'City9' })).toBe('hard_stop')
  })

  it('reset() clears both counters', () => {
    const det = createLoopDetector()
    for (let i = 0; i < 5; i++) det.check('weather', { city: 'Tokyo' })
    expect(det.totalToolCalls).toBe(5)
    det.reset()
    expect(det.totalToolCalls).toBe(0)
    expect(det.check('weather', { city: 'Tokyo' })).toBe('allow')
  })

  it('treats different tool names as independent keys', () => {
    const det = createLoopDetector()
    det.check('weather', { city: 'Tokyo' })
    det.check('weather', { city: 'Tokyo' })
    det.check('weather', { city: 'Tokyo' })  // weather → nudge
    // getTime is a different tool, different key, should still allow
    expect(det.check('getTime', { city: 'Tokyo' })).toBe('allow')
  })

  it('peek() returns action without incrementing counters', () => {
    const det = createLoopDetector()
    det.check('weather', { city: 'Tokyo' })
    det.check('weather', { city: 'Tokyo' })
    det.check('weather', { city: 'Tokyo' }) // count = 3, nudge threshold
    expect(det.totalToolCalls).toBe(3)

    // peek should return nudge (count is 3, which is >= NUDGE_THRESHOLD)
    expect(det.peek('weather', { city: 'Tokyo' })).toBe('nudge')
    // totalToolCalls should NOT have changed
    expect(det.totalToolCalls).toBe(3)
    // A subsequent check should still work correctly (count goes to 4)
    expect(det.check('weather', { city: 'Tokyo' })).toBe('nudge')
    expect(det.totalToolCalls).toBe(4)
  })

  it('peek() returns allow for unseen tools', () => {
    const det = createLoopDetector()
    expect(det.peek('weather', { city: 'Tokyo' })).toBe('allow')
    expect(det.totalToolCalls).toBe(0)
  })

  it('is deterministic across calls with same input (hash stability)', () => {
    const det = createLoopDetector()
    const input = { city: 'Tokyo', units: 'metric' }
    det.check('weather', input)
    det.check('weather', input)
    // 3rd call with a semantically-equal object should still hit the same key
    det.check('weather', { city: 'Tokyo', units: 'metric' })
    // One of these should have bumped to nudge — not critical which,
    // but a reused key is required for nudge@3 to ever trigger
    const count = det.totalToolCalls
    expect(count).toBe(3)
  })

  it('respects a raised hardLimit — deep-research budget', () => {
    const det = createLoopDetector({ hardLimit: 35 })
    // 34 distinct calls stay below the cap
    for (let i = 0; i < 34; i++) {
      expect(det.check('webSearch', { q: `query-${i}` })).toBe('allow')
    }
    // 35th call trips the hard stop
    expect(det.check('webSearch', { q: 'query-34' })).toBe('hard_stop')
  })

  it('respects a lowered hardLimit', () => {
    const det = createLoopDetector({ hardLimit: 2 })
    expect(det.check('webSearch', { q: 'a' })).toBe('allow')
    expect(det.check('webSearch', { q: 'b' })).toBe('hard_stop')
  })

  it('defaults to a hard limit of 10 when no option is given', () => {
    const det = createLoopDetector({})
    for (let i = 0; i < 9; i++) det.check('webSearch', { q: `q-${i}` })
    expect(det.check('webSearch', { q: 'q-9' })).toBe('hard_stop')
  })

  it('peek() honours the configured hardLimit', () => {
    const det = createLoopDetector({ hardLimit: 3 })
    det.check('webSearch', { q: 'a' })
    det.check('webSearch', { q: 'b' })
    // totalCalls is 2; peek does not increment, so still below the cap of 3
    expect(det.peek('webSearch', { q: 'c' })).toBe('allow')
    det.check('webSearch', { q: 'c' })
    // totalCalls is now 3 — peek reports the hard stop
    expect(det.peek('webSearch', { q: 'd' })).toBe('hard_stop')
  })

  // ── Consecutive-failure breaker (input-agnostic) ──────────────────────────

  it('hard-stops after FAIL_STREAK_LIMIT consecutive failures of one tool, even with varied inputs', () => {
    const det = createLoopDetector({ hardLimit: 100 }) // raise the call cap out of the way
    // Mirror the 2026-06-04 doc incident: patchPage fails with DIFFERENT
    // args each time, so the (name,input) block@5 never fires.
    for (let i = 0; i < 5; i++) {
      expect(det.check('patchPage', { ops: [{ op: 'add', block: { id: `b${i}` } }] })).toBe('allow')
      det.recordOutcome('patchPage', true)
    }
    // The 6th attempt — any tool — is force-stopped by the latched fuse.
    expect(det.check('patchPage', { ops: [{ op: 'add', block: { id: 'b6' } }] })).toBe('hard_stop')
    expect(det.failureStopTool()).toBe('patchPage')
  })

  it('a tool success resets its own consecutive failure streak', () => {
    const det = createLoopDetector({ hardLimit: 100 })
    for (let i = 0; i < 4; i++) {
      det.check('patchPage', { n: i })
      det.recordOutcome('patchPage', true) // true = isError
    }
    // Success resets — consecutive streak goes back to 0.
    det.recordOutcome('patchPage', false)
    expect(det.failureStopTool()).toBeNull()
    // Three more failures still don't trip: streak is 3 (< 5) and the
    // cumulative total is 7 (< FAIL_TOTAL_LIMIT 8).
    for (let i = 0; i < 3; i++) {
      expect(det.check('patchPage', { n: 10 + i })).toBe('allow')
      det.recordOutcome('patchPage', true)
    }
    expect(det.failureStopTool()).toBeNull()
  })

  it('hard-stops at FAIL_TOTAL_LIMIT cumulative failures despite interleaved successes', () => {
    // The 2026-06-04 doc burst pattern: patchPage rejects at a high rate
    // with occasional successes resetting the consecutive streak, so block@5
    // and fail-streak@5 never fire — but each failure still re-sends the full
    // turn context. 4 fails, a success (streak→0), then 4 more fails = 8 total
    // failures, max streak 4, which trips the cumulative cap on the 8th.
    const det = createLoopDetector({ hardLimit: 100 })
    for (let i = 0; i < 4; i++) {
      det.check('patchPage', { n: i })
      det.recordOutcome('patchPage', true)
    }
    det.recordOutcome('patchPage', false) // interleaved success — streak resets
    expect(det.failureStopTool()).toBeNull()
    for (let i = 0; i < 4; i++) {
      det.check('patchPage', { n: 10 + i })
      det.recordOutcome('patchPage', true)
    }
    // 8th failure (total) latches the fuse even though the streak never hit 5.
    expect(det.failureStopTool()).toBe('patchPage')
    expect(det.check('patchPage', { n: 99 })).toBe('hard_stop')
  })

  it("another tool's outcomes do not reset or feed a tool's failure streak", () => {
    const det = createLoopDetector({ hardLimit: 100 })
    for (let i = 0; i < 4; i++) {
      det.check('patchPage', { n: i })
      det.recordOutcome('patchPage', true) // patchPage failing
      det.recordOutcome('search', false) // search succeeding in between
    }
    // patchPage's streak is 4 (search's successes didn't reset it); 5th trips.
    det.check('patchPage', { n: 99 })
    det.recordOutcome('patchPage', true)
    expect(det.failureStopTool()).toBe('patchPage')
  })

  it('the fuse is global once latched — every tool hard-stops', () => {
    const det = createLoopDetector({ hardLimit: 100 })
    for (let i = 0; i < 5; i++) {
      det.check('patchPage', { n: i })
      det.recordOutcome('patchPage', true)
    }
    // A different, never-failed tool is also stopped.
    expect(det.check('getCurrentPage', {})).toBe('hard_stop')
    expect(det.peek('search', { q: 'x' })).toBe('hard_stop')
  })

  it('does not trip on scattered (non-consecutive) failures under the limit', () => {
    const det = createLoopDetector({ hardLimit: 100 })
    // fail, fail, success, fail, fail, success, fail — never 5 in a row
    const outcomes = [true, true, false, true, true, false, true]
    for (const isError of outcomes) {
      det.check('patchPage', {})
      det.recordOutcome('patchPage', isError)
    }
    expect(det.failureStopTool()).toBeNull()
    expect(det.check('patchPage', {})).not.toBe('hard_stop')
  })

  it('reset() clears the failure fuse', () => {
    const det = createLoopDetector({ hardLimit: 100 })
    for (let i = 0; i < 5; i++) {
      det.check('patchPage', { n: i })
      det.recordOutcome('patchPage', true)
    }
    expect(det.failureStopTool()).toBe('patchPage')
    det.reset()
    expect(det.failureStopTool()).toBeNull()
    expect(det.check('patchPage', { n: 0 })).toBe('allow')
  })
})
