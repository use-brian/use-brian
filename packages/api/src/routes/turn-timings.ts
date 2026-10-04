/**
 * Per-phase wall-clock accounting for one chat turn.
 *
 * A turn is a chain of contiguous phases (admission → context → tools_inject →
 * prompt → loop → flush → post); `mark(phase)` closes the phase that has been
 * running since the previous mark. Work that recurs inside a phase (audience
 * checks, tool executions) is summed by `time` / `add`, so the snapshot says
 * both where a slow turn spent its time and how many times it paid for what.
 *
 * Numbers only: the snapshot goes straight into the `turn_timings` analytics
 * event (docs/architecture/platform/analytics.md), which never carries content.
 */
export interface TurnTiming {
  /** Close the running phase under `phase` (`<phase>_ms`). */
  mark(phase: string): void
  /** Add `ms` to `<counter>_ms` and 1 to `<counter>_count`. */
  add(counter: string, ms: number): void
  /** Add 1 to `<counter>_count` without a duration. */
  count(counter: string): void
  /** Run `fn`, charging its wall-clock to `counter` even when it throws. */
  time<T>(counter: string, fn: () => Promise<T>): Promise<T>
  /** Every phase, counter and `total_ms` so far, as integers. */
  snapshot(): Record<string, number>
}

export function createTurnTiming(now: () => number = Date.now): TurnTiming {
  const startedAt = now()
  let phaseStartedAt = startedAt
  const phases: Record<string, number> = {}
  const sums: Record<string, number> = {}
  const counts: Record<string, number> = {}
  const timing: TurnTiming = {
    mark(phase) {
      const at = now()
      phases[phase] = (phases[phase] ?? 0) + (at - phaseStartedAt)
      phaseStartedAt = at
    },
    add(counter, ms) {
      sums[counter] = (sums[counter] ?? 0) + ms
      counts[counter] = (counts[counter] ?? 0) + 1
    },
    count(counter) {
      counts[counter] = (counts[counter] ?? 0) + 1
    },
    async time(counter, fn) {
      const at = now()
      try {
        return await fn()
      } finally {
        timing.add(counter, now() - at)
      }
    },
    snapshot() {
      const out: Record<string, number> = { total_ms: Math.round(now() - startedAt) }
      for (const [phase, ms] of Object.entries(phases)) out[`${phase}_ms`] = Math.round(ms)
      for (const [counter, ms] of Object.entries(sums)) out[`${counter}_ms`] = Math.round(ms)
      for (const [counter, n] of Object.entries(counts)) out[`${counter}_count`] = n
      return out
    },
  }
  return timing
}
