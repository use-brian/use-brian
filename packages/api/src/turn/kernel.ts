/**
 * The turn kernel: ONE lifecycle for every assistant turn (unified-sessions
 * D14). Every runner (web chat, messaging channels, the public API, A2A /
 * workflow `assistant_call`, resume replay) is a thin adapter: it parses its
 * inbound request, names its principal, assembles its prompt and tools, and
 * hands the kernel a SINK. The kernel owns everything else:
 *
 *   1. admission + the turn lease, per `sessionPolicy(kind).admission`,
 *      heart-beaten and released in `finally` on success, throw and abort;
 *   2. the budget gate;
 *   3. model servability (`ensureServableModel` against the deployment's
 *      configured providers, unless a workspace custom endpoint serves);
 *   4. `queryLoop` under the stall watchdog (`stallIdleMs`, never a wall
 *      clock; CLAUDE.md "Bounding agentic work");
 *   5. final-text selection (`TurnOutputCollector`), sanitized with
 *      `sanitizeDeliveryText` for final-only sinks;
 *   6. the payer/actor of every usage row (`turnUsageRow`).
 *
 * Sinks:
 *   - `sse`     the web chat stream (renders every event itself);
 *   - `adapter` a messaging channel (final text only, sanitized);
 *   - `json`    the public API response (final text only, sanitized);
 *   - `return`  an A2A / workflow callee (final text returned, sanitized);
 *   - `none`    resume replay (persists, delivers nothing).
 *
 * `queryLoop(` is called from here and nowhere else a turn runs (graded by
 * `invariants/turn-kernel`).
 *
 * Spec: docs/architecture/engine/turn-kernel.md.
 *
 * [COMP:api/turn-kernel]
 */
import {
  createTurnOutputCollector,
  DEFAULT_STALL_IDLE_MS,
  queryLoop,
  type QueryEvent,
  type QueryLoopOptions,
  type TurnOutputSelection,
} from '@use-brian/core'
import { sanitizeDeliveryText } from '@use-brian/shared'
import type { ProviderAvailability } from '@use-brian/shared/model-registry'
import type { ResolvedWorkspaceCustomLlm } from '../custom-llm-runtime.js'
import { ensureServableModel } from '../model-resolution.js'
import type { SessionPolicy } from '../session-kind.js'
import { hasTurnAbort, registerTurnAbort, releaseTurn, startLeaseHeartbeat, takeTurnLease, unregisterTurnAbort } from './lease.js'
import type { TurnBilling } from './billing.js'

export type TurnSinkKind = 'sse' | 'adapter' | 'json' | 'return' | 'none'

/** Sinks that deliver only the final text, outside any client render layer. */
const FINAL_ONLY_SINKS: ReadonlySet<TurnSinkKind> = new Set(['adapter', 'json', 'return'])

export type TurnSink = {
  kind: TurnSinkKind
  /** Every engine event, in order. The `sse` sink renders them; others may observe. */
  onEvent?: (event: QueryEvent) => void | Promise<void>
  /**
   * Runs after a clean loop while the lease is still held: flush buffered
   * turns, persist the reply. A throw here still releases the lease.
   */
  afterLoop?: (result: TurnLoopResult) => void | Promise<void>
}

/** The kernel's typed refusal: render it on the sink; nothing ran. */
export class TurnRefusal extends Error {
  constructor(readonly code: 'turn_in_flight' | 'room_turn_wait_timeout' | 'budget_blocked', message?: string) {
    super(message ?? code)
    this.name = 'TurnRefusal'
  }
}

export type TurnModel = {
  provider: QueryLoopOptions['provider']
  model: string
  /**
   * The deployment's configured providers, or `undefined` in a test harness.
   * A REQUIRED key: a runner that forgets it lets the kernel serve a model no
   * configured provider can serve (the executor's hard-coded `gemini-flash`).
   */
  configuredProviders: ProviderAvailability | undefined
  /**
   * What `resolveWorkspaceCustomLlm` returned for this turn (`null` = none
   * applies). A REQUIRED key, so a runner cannot silently skip the workspace
   * custom endpoint (CLAUDE.md "Workspace custom LLM must reach every channel
   * turn").
   */
  customLlm: ResolvedWorkspaceCustomLlm | null
}

export type TurnLoopResult = {
  /** The final-text selection, before sanitization. */
  selection: TurnOutputSelection
  /** The sanitized final text for a final-only sink; null otherwise or when empty. */
  finalText: string | null
  aborted: boolean
}

export type RunAssistantTurnParams = {
  sessionId: string
  policy: Pick<SessionPolicy, 'admission'>
  sink: TurnSink
  abortController: AbortController
  model: TurnModel
  /** The assembled loop, minus what the kernel owns (model, liveness, abort). */
  loop: Omit<QueryLoopOptions, 'provider' | 'model' | 'stallIdleMs'>
  /**
   * `kernel` (default): admit, lease, heartbeat and release the session.
   * `held`: the runner took the lease itself through `takeTurnLease`
   * (`turn/lease.ts`), because its admission choreography (the web room's
   * queue-and-fold) and its post-loop work (flush, catch-path recovery) must
   * run under the lease; the kernel heartbeats it and the runner releases it
   * in its own `finally` with `releaseTurn`. `none`: there is no sessions row
   * to lock (a workflow-executor turn on a run id).
   */
  lease?:
    | { mode: 'kernel'; waitForSlot?: (sessionId: string) => Promise<boolean>; onTaken?: (token: string) => void }
    | { mode: 'held'; token: string }
    | { mode: 'none' }
  /** Throws `TurnRefusal('budget_blocked')` (or anything) to stop before the loop. */
  budget?: () => Promise<void>
  /** Output collector format for the final-only selection. */
  outputFormat?: 'compact' | 'channel'
  /** The stall window; defaults to `DEFAULT_STALL_IDLE_MS`. Derived, never an env knob. */
  stallIdleMs?: number
}

/** The served model: the custom endpoint as resolved, else a servable registry model. */
export function servedTurnModel(model: TurnModel): string {
  if (model.customLlm || !model.configuredProviders) return model.model
  return ensureServableModel(model.model, model.configuredProviders)
}

/**
 * Run one assistant turn. Resolves with the loop result after the lease is
 * released; rejects with `TurnRefusal` when admission or budget refuse, and
 * re-throws a loop or sink failure after releasing.
 */
export async function runAssistantTurn(params: RunAssistantTurnParams): Promise<TurnLoopResult> {
  const lease = params.lease ?? { mode: 'kernel' as const }
  let token: string | null = null
  if (lease.mode === 'kernel') {
    const slot = await takeTurnLease({
      sessionId: params.sessionId,
      admission: params.policy.admission,
      waitForSlot: lease.waitForSlot,
    })
    if (!slot.taken) throw new TurnRefusal(slot.code)
    token = slot.token
    lease.onTaken?.(token)
  } else if (lease.mode === 'held') {
    token = lease.token
  }

  // Register the in-process abort handle unless the runner already did (a
  // held lease whose runner keeps it through its post-loop work).
  const ownsAbortHandle = !!token && !hasTurnAbort(params.sessionId, token)
  if (ownsAbortHandle) registerTurnAbort(params.sessionId, token!, () => params.abortController.abort())
  const stopHeartbeat = token
    ? startLeaseHeartbeat({
        sessionId: params.sessionId,
        token,
        onLost: () => {
          // Our lease was reclaimed while we were away: another turn may own
          // this session now, so stop before writing into it.
          console.warn(`[turn-kernel] lease lost for session ${params.sessionId}; aborting orphaned turn`)
          params.abortController.abort()
        },
        onCancelRequested: () => {
          console.log(`[turn-kernel] stop requested for session ${params.sessionId}; aborting turn`)
          params.abortController.abort()
        },
      })
    : () => {}

  const collector = createTurnOutputCollector({ format: params.outputFormat ?? 'compact' })
  try {
    if (params.budget) await params.budget()
    // Loop and sink failures propagate unchanged: the runner's own error path
    // renders them. The lease is released in `finally` either way.
    for await (const event of queryLoop({
      ...params.loop,
      provider: params.model.provider,
      model: servedTurnModel(params.model),
      stallIdleMs: params.stallIdleMs ?? DEFAULT_STALL_IDLE_MS,
    })) {
      // An aborted turn stops consuming: nothing after a stop reaches a sink.
      if (params.abortController.signal.aborted) break
      collector.observe(event)
      await params.sink.onEvent?.(event)
    }
    const selection = collector.select()
    const finalText = FINAL_ONLY_SINKS.has(params.sink.kind) && selection.kind === 'text'
      ? sanitizeDeliveryText(selection.text) || null
      : null
    const result: TurnLoopResult = { selection, finalText, aborted: params.abortController.signal.aborted }
    await params.sink.afterLoop?.(result)
    return result
  } finally {
    stopHeartbeat()
    if (ownsAbortHandle) unregisterTurnAbort(params.sessionId, token!)
    if (token && lease.mode === 'kernel') await releaseTurn(params.sessionId, token, 'completed')
  }
}

/** A usage row's identity columns, from the turn's resolved billing (D2). */
export function turnUsageIdentity(billing: TurnBilling): { userId: string; actorUserId?: string } {
  return billing.actorUserId
    ? { userId: billing.payerUserId, actorUserId: billing.actorUserId }
    : { userId: billing.payerUserId }
}
