import { createHash } from 'node:crypto'

/**
 * Circuit breaker for tool loop detection.
 *
 * Keyed by `(name, input)` — repeated *identical* calls:
 *   Level 1 (nudge at 3x): inject "try a different approach" system message
 *   Level 2 (block at 5x): stop tool execution, force model to respond
 *   Level 3 (hard limit, default 10x): force response to user regardless.
 *     The hard limit is configurable per detector — a deep-research run raises
 *     it via `createLoopDetector({ hardLimit })`. See
 *     `packages/core/src/engine/research-depth.ts`.
 *
 * Keyed by tool *name* only — repeated FAILURES, input-agnostic:
 *   Level 4 (fail-streak at 5x): one tool erroring `FAIL_STREAK_LIMIT` times in
 *     a row latches a turn-ending `hard_stop`. The (name, input) levels above
 *     miss this because the model *varies* its arguments each retry (the
 *     2026-06-04 doc incident: `patchPage` looped ~15× with different ops,
 *     never tripping block@5, so the turn ran 371s and blew the 300s Cloud Run
 *     request timeout → the browser showed "Network error"). `recordOutcome`
 *     feeds this from the executor's real tool results.
 *   Level 5 (fail-total at 8x): one tool erroring `FAIL_TOTAL_LIMIT` times in
 *     a turn *regardless of interleaved successes* latches the same fuse. The
 *     streak cap above is reset by any success, so a tool failing at a high
 *     rate WITH occasional successes (the 2026-06-04 patchPage burst: 71/130
 *     rejected, only 1 of 39 failure-runs reached 5-in-a-row) never trips it
 *     yet still re-sends the full turn context on every failure. This cap
 *     bounds that slow leak.
 */

export type LoopAction = 'allow' | 'nudge' | 'block' | 'hard_stop'

const NUDGE_THRESHOLD = 3
const BLOCK_THRESHOLD = 5
/** Default absolute tool-call cap. Overridable via `createLoopDetector`. */
export const DEFAULT_HARD_LIMIT = 10
/**
 * Consecutive same-tool failure cap. A tool's own success resets its streak;
 * other tools' outcomes don't touch it. Tripping it latches a `hard_stop` for
 * the rest of the `queryLoop` invocation (a blown fuse), so the model can't
 * keep churning other tools while one capability is hopelessly stuck. Not
 * raised for deep-research runs — 5 consecutive failures of the *same* tool is
 * pathological regardless of budget.
 */
export const FAIL_STREAK_LIMIT = 5
/**
 * Cumulative same-tool failure cap for a single `queryLoop` turn,
 * input-agnostic and NOT reset by interleaved successes. Catches the
 * pathological "high reject rate with occasional successes" pattern that slips
 * past both the consecutive `FAIL_STREAK_LIMIT` (a success resets it) and the
 * (name, input) `BLOCK_THRESHOLD` (the model varies its args each retry). Set
 * well above the failures a healthy multi-op page build incurs so it fires
 * only on a genuine storm.
 */
export const FAIL_TOTAL_LIMIT = 8

export function createLoopDetector(opts?: { hardLimit?: number }) {
  const hardLimit = opts?.hardLimit ?? DEFAULT_HARD_LIMIT
  const callCounts = new Map<string, number>() // hash(name+input) → count
  const failStreaks = new Map<string, number>() // toolName → consecutive errors
  const failTotals = new Map<string, number>() // toolName → total errors this turn
  let totalCalls = 0
  // Latched once any tool hits FAIL_STREAK_LIMIT consecutive errors. Names the
  // tripping tool so the executor can quote it in the stop message; never
  // un-latches for the life of this detector (one per queryLoop invocation).
  let trippedTool: string | null = null

  function makeKey(toolName: string, input: unknown): string {
    const hash = createHash('md5')
      .update(toolName + JSON.stringify(input))
      .digest('hex')
    return hash
  }

  return {
    check(toolName: string, input: unknown, opts?: { repeatTolerant?: boolean }): LoopAction {
      totalCalls++

      // Latched fail-streak fuse takes precedence — the turn is over for every
      // tool, not just the one that tripped it.
      if (trippedTool !== null) {
        return 'hard_stop'
      }

      if (totalCalls >= hardLimit) {
        return 'hard_stop'
      }

      // Repeat-tolerant tools (Tool.allowsRepeatCalls — polling/re-read tools
      // whose input is empty by design) skip the identical-input thresholds:
      // still bounded by the hard limit above and the failure fuses below.
      if (opts?.repeatTolerant) return 'allow'

      const key = makeKey(toolName, input)
      const count = (callCounts.get(key) ?? 0) + 1
      callCounts.set(key, count)

      if (count >= BLOCK_THRESHOLD) return 'block'
      if (count >= NUDGE_THRESHOLD) return 'nudge'
      return 'allow'
    },

    /** Read-only check — returns the action without incrementing counters. */
    peek(toolName: string, input: unknown, opts?: { repeatTolerant?: boolean }): LoopAction {
      if (trippedTool !== null) {
        return 'hard_stop'
      }

      if (totalCalls >= hardLimit) {
        return 'hard_stop'
      }

      if (opts?.repeatTolerant) return 'allow'

      const key = makeKey(toolName, input)
      const count = callCounts.get(key) ?? 0

      if (count >= BLOCK_THRESHOLD) return 'block'
      if (count >= NUDGE_THRESHOLD) return 'nudge'
      return 'allow'
    },

    /**
     * Feed a tool's real execution outcome (after it ran). An error bumps that
     * tool's consecutive-failure streak; a success resets it. Crossing
     * `FAIL_STREAK_LIMIT` latches the turn-ending fuse. Call ONLY for genuine
     * execution outcomes — never for the breaker's own block/hard_stop results
     * (that would feed the fuse back into itself).
     */
    recordOutcome(toolName: string, isError: boolean): void {
      if (!isError) {
        // A success resets the CONSECUTIVE streak but deliberately NOT the
        // cumulative total — that's what lets the fail-total cap catch a
        // fail/succeed/fail leak the streak cap is blind to.
        failStreaks.set(toolName, 0)
        return
      }
      const streak = (failStreaks.get(toolName) ?? 0) + 1
      failStreaks.set(toolName, streak)
      const total = (failTotals.get(toolName) ?? 0) + 1
      failTotals.set(toolName, total)
      if (
        trippedTool === null &&
        (streak >= FAIL_STREAK_LIMIT || total >= FAIL_TOTAL_LIMIT)
      ) {
        trippedTool = toolName
      }
    },

    /** The tool that tripped the consecutive-failure fuse, or `null` if the
     *  turn ended for another reason (e.g. the absolute call cap). Lets the
     *  executor name it in the stop message. */
    failureStopTool(): string | null {
      return trippedTool
    },

    reset() {
      callCounts.clear()
      failStreaks.clear()
      failTotals.clear()
      trippedTool = null
      totalCalls = 0
    },

    get totalToolCalls() {
      return totalCalls
    },
  }
}

export type LoopDetector = ReturnType<typeof createLoopDetector>
