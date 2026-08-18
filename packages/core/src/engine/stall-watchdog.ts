/**
 * Progress-based liveness for agentic work.
 *
 * An agentic step (a query loop, a delegated child loop, a long tool) is
 * bounded by COST (turns, tool calls) and by LIVENESS (is it still making
 * progress?), never by a default wall-clock. A wall-clock cap encodes a guess
 * about how fast the model is, and every guess so far has clipped legitimate
 * work on the slow end (30s -> 90s assistant_call, 180s -> 300s deep, the
 * doc editor's 300s on a 60-77s-per-call self-host provider) while catching
 * nothing a progress clock would not have caught sooner.
 *
 * The watchdog is a timer that every progress event resets: a provider chunk
 * (text, tool-input, or reasoning delta), a tool starting or finishing, a
 * loop event reaching the consumer. If NOTHING happens for `idleMs` the work
 * is stalled and the watchdog aborts its signal with a `StalledError`.
 *
 * Progress is HIERARCHICAL. A child loop's watchdog forwards every touch to
 * the parent clock it was created under (`ToolContext.progress`), so a parent
 * waiting on a slow-but-alive `delegateDocEdit` / `askAssistant` child sees
 * the child's progress as its own and does not fire; a long-running tool can
 * `context.progress?.touch()` while it works for the same effect. And a wait
 * on a HUMAN (a tool parked for confirmation) is not a stall: `pause()` holds
 * the timer (propagated upward) until `resume()`; the confirmation timeout
 * bounds that wait separately.
 *
 * Spec: docs/architecture/engine/query-loop.md -> "Liveness, not wall-clock".
 *
 * [COMP:engine/stall-watchdog]
 */

import { DEFAULT_FIRST_CHUNK_MS } from '../providers/wrappers.js'

/** The upward-facing face of a watchdog: what tools and child loops touch. */
export type ProgressClock = {
  /** Record progress. `kind` is a short label kept for the stall report. */
  touch(kind: string): void
  /** Hold the clock while waiting on a human (confirmation / approval). */
  pause(): void
  /** Release a `pause()`. Balanced: the clock runs when every pause is released. */
  resume(): void
}

export type StallInfo = {
  /** The idle window that elapsed with no progress. */
  idleMs: number
  /** The last progress kind seen before the stall (`start` when none). */
  lastProgress: string
  /** Wall-clock ms between the last progress and the stall. */
  sinceLastProgressMs: number
}

export type StallWatchdog = ProgressClock & {
  /** Aborts (with a `StalledError` reason) when the work stalls. */
  readonly signal: AbortSignal
  /** Set once the watchdog has fired; null while the work is alive. */
  readonly stalled: StallInfo | null
  /** The typed error for the stall, once fired. */
  readonly error: StalledError | null
  /** Stop the timer for good. Idempotent; call from the owner's `finally`. */
  dispose(): void
}

export class StalledError extends Error {
  readonly code = 'stalled' as const
  readonly info: StallInfo
  constructor(info: StallInfo) {
    super(
      `stalled: no progress for ${Math.round(info.idleMs / 1000)}s ` +
      `(last activity: ${info.lastProgress}, ${Math.round(info.sinceLastProgressMs / 1000)}s ago)`,
    )
    this.name = 'StalledError'
    this.info = info
  }
}

export function isStalledError(err: unknown): err is StalledError {
  return err instanceof StalledError
    || (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'stalled')
}

/**
 * The idle window is DERIVED, not configured. The provider idle wrapper
 * (`wrapIdleTimeout`) is the layer that defines "silence" - no deliverable
 * chunk for `DEFAULT_STREAM_IDLE_MS` between chunks, `DEFAULT_FIRST_CHUNK_MS`
 * through prefill / reasoning - and it gets one transient retry. The watchdog
 * sits beneath it and must never pre-empt it, so its window is the widest
 * silence that layer can legitimately produce: two consecutive first-chunk
 * windows (the cold prefill plus its warm retry) = 3 minutes with no provider
 * chunk, no tool activity, and no loop event. That is not a speed guess about
 * any model - a live provider emits reasoning deltas while it thinks - it is
 * "the layer that can retry has already given up". Nothing to tune: a slow
 * provider is slow *between* chunks it still emits, never silent past this.
 */
export const DEFAULT_STALL_IDLE_MS = DEFAULT_FIRST_CHUNK_MS * 2
/** Node's timer ceiling; a larger delay fires immediately. */
const MAX_TIMER_MS = 2_147_483_647

export type CreateStallWatchdogOptions = {
  idleMs: number
  /** The clock this watchdog reports into (a parent loop's watchdog). */
  parent?: ProgressClock
  /** Diagnostic label included in the console line when the watchdog fires. */
  label?: string
  onStall?: (info: StallInfo) => void
}

export function createStallWatchdog(options: CreateStallWatchdogOptions): StallWatchdog {
  const idleMs = Math.min(MAX_TIMER_MS, Math.max(1, Math.round(options.idleMs)))
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let pauses = 0
  let lastProgress = 'start'
  let lastProgressAt = Date.now()
  let stalled: StallInfo | null = null
  let error: StalledError | null = null

  const fire = () => {
    if (disposed || stalled) return
    stalled = {
      idleMs,
      lastProgress,
      sinceLastProgressMs: Date.now() - lastProgressAt,
    }
    error = new StalledError(stalled)
    console.warn(`[stall-watchdog]${options.label ? ` ${options.label}` : ''} ${error.message}`)
    try {
      options.onStall?.(stalled)
    } catch {
      // A reporter must not keep a stalled step alive.
    }
    controller.abort(error)
  }

  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (disposed || stalled || pauses > 0) return
    timer = setTimeout(fire, idleMs)
    // Never keep the process alive just to notice a stall.
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref()
    }
  }

  arm()

  return {
    get signal() {
      return controller.signal
    },
    get stalled() {
      return stalled
    },
    get error() {
      return error
    },
    touch(kind: string) {
      lastProgress = kind
      lastProgressAt = Date.now()
      options.parent?.touch(kind)
      arm()
    },
    pause() {
      pauses += 1
      options.parent?.pause()
      arm()
    },
    resume() {
      pauses = Math.max(0, pauses - 1)
      options.parent?.resume()
      // Waiting on a human was not idleness; the window restarts from now.
      lastProgressAt = Date.now()
      arm()
    },
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}

/**
 * Merge a parent abort signal with the watchdog's. `AbortSignal.any` keeps
 * the first reason, so an aborted watchdog surfaces its `StalledError`.
 */
export function withStallSignal(parent: AbortSignal | undefined, watchdog: StallWatchdog): AbortSignal {
  return parent ? AbortSignal.any([parent, watchdog.signal]) : watchdog.signal
}
