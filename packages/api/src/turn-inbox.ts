/**
 * Mid-turn input registry — the server half of "send while the assistant is
 * working". A message that arrives during a live turn is handed to the
 * *running* `queryLoop` instead of starting a second turn; this module is what
 * carries it there, including when the enqueueing request and the running turn
 * land on different Cloud Run instances.
 *
 * Deliberately NOT a table, and deliberately NOT the session event bus:
 *
 * - **No table.** A queued message becomes part of the transcript only when the
 *   turn drains it. Persisting at enqueue would create user rows that nothing
 *   will ever answer whenever a turn dies mid-flight, and repairing those needs
 *   its own sweeper. The client is already the durable holder of an unsent
 *   message — it keeps the queued bubble until `input_applied`, and sends it as
 *   an ordinary turn if the stream ends without one. That makes delivery here
 *   allowed to be lossy, which is what buys the in-memory map.
 * - **Not the session bus.** Subscribing there joins the presence set, and a
 *   server-internal listener is not a viewer.
 *
 * **Rooms (chat-parity D3, section 6).** A room message is a durable post: it
 * is saved the instant it is sent, and when it addresses the assistant whose
 * turn is running it is ALSO handed to that turn here, carrying the saved
 * row's id (`persistedMessageId`) so the drain reuses the row instead of
 * writing it twice. The enqueueing request then waits for the outcome
 * (`awaitTurnInputOutcome`): taken (`acknowledgeTurnInputs`, fanned out on
 * the same NOTIFY channel), or the turn ended first, in which case the room's
 * follow-up-turn path (arm or fold) answers it. An inbox owned by another
 * assistant's turn never takes it (`assistantId`).
 *
 * Spec: docs/architecture/engine/mid-turn-input.md. `[COMP:api/turn-inbox]`
 */

import type { PendingTurnInput, TurnInboxPort } from '@use-brian/core'
import { query } from './db/client.js'
import { registerNotifyChannel, startNotifyListener } from './db/notify-listener.js'

const CHANNEL = 'turn_input'

/**
 * Single-process mode (the OSS local boot). There is no second instance to
 * reach, so the local dispatch below is the whole mechanism and the pg_notify
 * round-trip would only contend the single PGLite connection.
 */
const SINGLE_PROCESS = process.env.USEBRIAN_SINGLE_PROCESS === '1'

/** Soft cap on a NOTIFY payload — Postgres hard limit is 8000 bytes. */
const NOTIFY_PAYLOAD_BUDGET = 6_500

type Inbox = {
  /** Keyed by input id so a steer for an already-queued message upgrades it. */
  waiting: Map<string, PendingTurnInput>
  /** The assistant running this turn. A room input addressed to another one is refused. */
  assistantId: string | null
}

const inboxes = new Map<string, Inbox>()
let channelRegistered = false

export type TurnInboxHandle = {
  /** Hand this to `queryLoop({ turnInbox })`. */
  port: TurnInboxPort
  /** Tear down. Idempotent, and a no-op once a later turn has taken over. */
  close(): void
}

/**
 * Open an inbox for a turn about to run. The chat route calls this once it
 * owns the session's turn slot and closes it in its `finally` — no inbox means
 * nothing is held, which is exactly what a client's `delivered: false` needs to
 * mean.
 *
 * A pre-existing inbox for the same session is replaced: it belongs to a turn
 * that no longer exists (crash, instance rotation), and its contents were
 * already resent by their client.
 */
export function registerTurnInbox(
  sessionId: string,
  owner: { assistantId?: string | null } = {},
): TurnInboxHandle {
  if (!channelRegistered && !SINGLE_PROCESS) {
    registerNotifyChannel(CHANNEL, handleTurnInputNotification)
    startNotifyListener()
    channelRegistered = true
  }
  if (inboxes.has(sessionId)) {
    console.warn(`[turn-inbox] replacing a stale inbox for session ${sessionId}`)
  }
  const inbox: Inbox = { waiting: new Map(), assistantId: owner.assistantId ?? null }
  inboxes.set(sessionId, inbox)

  return {
    port: {
      peek: () => {
        let steer = false
        for (const input of inbox.waiting.values()) {
          if (input.mode === 'steer') { steer = true; break }
        }
        return { pending: inbox.waiting.size > 0, steer }
      },
      drain: () => {
        const out = [...inbox.waiting.values()].sort((a, b) => a.receivedAt - b.receivedAt)
        inbox.waiting.clear()
        return out
      },
    },
    close: () => {
      // Identity-guarded: a successor turn may already own the slot.
      if (inboxes.get(sessionId) === inbox) inboxes.delete(sessionId)
    },
  }
}

/** Is a turn on this instance currently holding an inbox for this session? */
export function hasTurnInbox(sessionId: string): boolean {
  return inboxes.has(sessionId)
}

/**
 * The assistant whose turn holds this session's inbox ON THIS INSTANCE:
 * `undefined` when no local turn holds one (it may run elsewhere), `null`
 * when the local turn did not say.
 */
export function localTurnInboxAssistant(sessionId: string): string | null | undefined {
  const inbox = inboxes.get(sessionId)
  return inbox ? inbox.assistantId : undefined
}

/**
 * Hand a message to whichever running turn owns this session.
 *
 * Returns `true` when a LOCAL inbox took it — the common case, since the
 * producer and the running turn are often the same instance. When it does, the
 * NOTIFY is skipped: only one turn runs per session, so a local hit means there
 * is no remote inbox to reach. A `false` return means "not delivered here" and
 * is honest, not authoritative: a remote instance may still take it, which is
 * why the caller reports it to the client as a hint rather than a verdict.
 */
export function deliverTurnInput(params: {
  sessionId: string
  input: PendingTurnInput
}): boolean {
  const local = dispatchLocal(params.sessionId, params.input)
  if (local) return true
  void notifyRemote(params.sessionId, params.input)
  return false
}

function dispatchLocal(sessionId: string, input: PendingTurnInput): boolean {
  const inbox = inboxes.get(sessionId)
  if (!inbox) return false
  // A room input addressed to another assistant is not this turn's to take:
  // it stays on the room's follow-up-turn path (section 6).
  if (input.assistantId && inbox.assistantId && input.assistantId !== inbox.assistantId) return false
  const existing = inbox.waiting.get(input.id)
  if (existing) {
    // Same message, steered after the fact: upgrade in place. Mode only ever
    // escalates — a later plain re-post must not demote a pending steer.
    inbox.waiting.set(input.id, {
      ...existing,
      text: input.text,
      mode: existing.mode === 'steer' || input.mode === 'steer' ? 'steer' : 'queued',
    })
    return true
  }
  inbox.waiting.set(input.id, input)
  return true
}

async function notifyRemote(sessionId: string, input: PendingTurnInput): Promise<void> {
  if (SINGLE_PROCESS) return
  try {
    const json = JSON.stringify({ sessionId, input })
    if (json.length > NOTIFY_PAYLOAD_BUDGET) {
      // Oversized mid-turn message. There is no pointer to hydrate from (the
      // whole point is that nothing is persisted yet), so drop the cross-
      // instance hop and let the client's end-of-stream fallback send it as an
      // ordinary turn — which handles arbitrary length.
      console.warn('[turn-inbox] input too large to NOTIFY; leaving it to the client fallback')
      return
    }
    await query('SELECT pg_notify($1, $2)', [CHANNEL, json])
  } catch (err) {
    // Non-fatal by design: the client fallback covers a dropped delivery.
    console.warn('[turn-inbox] notify failed (non-fatal):', err)
  }
}

function handleTurnInputNotification(payload: string): void {
  try {
    const parsed = JSON.parse(payload) as { sessionId?: string; input?: PendingTurnInput; applied?: unknown }
    if (!parsed.sessionId) return
    if (Array.isArray(parsed.applied)) {
      markApplied(parsed.sessionId, parsed.applied.filter((id): id is string => typeof id === 'string'))
      return
    }
    if (!parsed.input?.id || typeof parsed.input.text !== 'string') return
    dispatchLocal(parsed.sessionId, parsed.input)
  } catch (err) {
    console.warn('[turn-inbox] malformed notification payload:', err)
  }
}

// --- Room inputs: drain acknowledgement (section 6) -------------------------

/** How long an applied id is remembered, for an acknowledgement that beats its waiter. */
const APPLIED_MEMORY_MS = 60_000

const appliedRecently = new Map<string, number>()
const appliedWaiters = new Map<string, Set<() => void>>()
const appliedKey = (sessionId: string, inputId: string) => `${sessionId}:${inputId}`

function markApplied(sessionId: string, inputIds: readonly string[]): void {
  const now = Date.now()
  for (const [key, at] of appliedRecently) {
    if (now - at > APPLIED_MEMORY_MS) appliedRecently.delete(key)
  }
  for (const inputId of inputIds) {
    const key = appliedKey(sessionId, inputId)
    appliedRecently.set(key, now)
    const waiters = appliedWaiters.get(key)
    if (waiters) {
      appliedWaiters.delete(key)
      for (const wake of waiters) wake()
    }
  }
}

/**
 * The running turn took these room inputs (each already a saved row). Wakes
 * their enqueueing requests here and, through the NOTIFY channel, on every
 * other instance, so none of them arms a follow-up turn for a message the
 * running turn already answered.
 */
export function acknowledgeTurnInputs(sessionId: string, inputIds: readonly string[]): void {
  if (inputIds.length === 0) return
  markApplied(sessionId, inputIds)
  if (SINGLE_PROCESS) return
  void query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify({ sessionId, applied: inputIds })])
    .catch((err) => console.warn('[turn-inbox] applied notify failed (non-fatal):', err))
}

type TurnInputOutcome = 'applied' | 'turn_ended' | 'timeout'

/**
 * Wait for a room input handed to the running turn: `applied` once the turn
 * took it, `turn_ended` when the turn finished first (the caller then takes
 * the follow-up-turn path), `timeout` past the queue budget. `isRunning` is
 * the session's turn-slot read (`sessions.status`); after it reports the turn
 * over, a short grace lets a cross-instance acknowledgement land, because the
 * turn acknowledges at its drain, before its slot is released.
 */
export async function awaitTurnInputOutcome(params: {
  sessionId: string
  inputId: string
  isRunning: () => Promise<boolean>
  timeoutMs: number
  pollMs?: number
  graceMs?: number
}): Promise<TurnInputOutcome> {
  const key = appliedKey(params.sessionId, params.inputId)
  if (appliedRecently.has(key)) return 'applied'
  const pollMs = params.pollMs ?? 1_000
  const graceMs = params.graceMs ?? 750
  let applied = false
  let wake: () => void = () => {}
  const wakeup = new Promise<void>((resolve) => { wake = () => { applied = true; resolve() } })
  const waiters = appliedWaiters.get(key) ?? new Set<() => void>()
  waiters.add(wake)
  appliedWaiters.set(key, waiters)
  const sleep = (ms: number) => Promise.race([wakeup, new Promise<void>((r) => setTimeout(r, ms))])
  try {
    const deadline = Date.now() + params.timeoutMs
    for (;;) {
      if (applied || appliedRecently.has(key)) return 'applied'
      if (!(await params.isRunning())) {
        await sleep(graceMs)
        return applied || appliedRecently.has(key) ? 'applied' : 'turn_ended'
      }
      if (Date.now() >= deadline) return 'timeout'
      await sleep(pollMs)
    }
  } finally {
    const set = appliedWaiters.get(key)
    set?.delete(wake)
    if (set && set.size === 0) appliedWaiters.delete(key)
  }
}

/**
 * Where an ADDRESSED room message goes (chat-parity section 6), mirroring
 * `roomTurnAdmission` with the inbox branch in front of it:
 *
 *   - `run`   no turn is running: this message starts one;
 *   - `inbox` the client sent it mid-turn (`midTurn`) and it addresses the
 *             running turn's assistant (or that assistant is not known on
 *             this instance, and the inbox decides): hand it to that turn,
 *             never arming a follow-up for it;
 *   - `wait`  arm the one follow-up turn (queue depth one, T5);
 *   - `fold`  a follow-up is already armed: fold into its backlog.
 *
 * A silent post never reaches this decision; it never enters the inbox.
 */
type RoomInputAdmission = 'run' | 'inbox' | 'wait' | 'fold'
export function roomInputAdmission(params: {
  status: string
  waiterArmed: boolean
  /** The client set `midTurn`: it watched a live turn when it sent. */
  clientMidTurn: boolean
  /** `sessionPolicy(kind).queue`. */
  queue: boolean
  /** `localTurnInboxAssistant`: the local running turn's assistant, `undefined` if not local. */
  runningAssistantId: string | null | undefined
  addressedAssistantId: string
}): RoomInputAdmission {
  if (params.status !== 'running') return 'run'
  if (
    params.clientMidTurn
    && params.queue
    && (params.runningAssistantId === undefined
      || params.runningAssistantId === null
      || params.runningAssistantId === params.addressedAssistantId)
  ) return 'inbox'
  return params.waiterArmed ? 'fold' : 'wait'
}

/** Test helper — drop every inbox. */
export function _resetTurnInboxes(): void {
  inboxes.clear()
  appliedRecently.clear()
  appliedWaiters.clear()
}
