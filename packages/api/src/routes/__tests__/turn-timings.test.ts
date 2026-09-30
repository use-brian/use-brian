import { describe, expect, it } from 'vitest'
import { createTurnTiming } from '../turn-timings.js'

function clock(start = 1_000) {
  let t = start
  return { now: () => t, tick: (ms: number) => { t += ms } }
}

describe('[COMP:api/turn-timings] per-phase turn accounting', () => {
  it('closes contiguous phases at each mark and totals the request', () => {
    const c = clock()
    const timing = createTurnTiming(c.now)
    c.tick(900); timing.mark('admission')
    c.tick(1300); timing.mark('context')
    c.tick(50); timing.mark('prompt')
    c.tick(6900); timing.mark('loop')
    expect(timing.snapshot()).toEqual({
      total_ms: 9150, admission_ms: 900, context_ms: 1300, prompt_ms: 50, loop_ms: 6900,
    })
  })

  it('sums recurring work with a count, including a call that throws', async () => {
    const c = clock()
    const timing = createTurnTiming(c.now)
    await timing.time('audience_check', async () => { c.tick(40) })
    await expect(timing.time('audience_check', async () => { c.tick(60); throw new Error('refused') }))
      .rejects.toThrow('refused')
    timing.add('tool_exec', 500)
    timing.count('text_delta')
    timing.count('text_delta')
    expect(timing.snapshot()).toMatchObject({
      audience_check_ms: 100, audience_check_count: 2,
      tool_exec_ms: 500, tool_exec_count: 1,
      text_delta_count: 2,
    })
  })

  it('accumulates a phase that is marked twice and rounds to integers', () => {
    const c = clock()
    const timing = createTurnTiming(c.now)
    c.tick(10.4); timing.mark('flush')
    c.tick(5.4); timing.mark('flush')
    expect(timing.snapshot()).toEqual({ total_ms: 16, flush_ms: 16 })
  })
})
