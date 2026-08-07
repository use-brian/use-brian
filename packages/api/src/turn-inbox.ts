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
export function registerTurnInbox(sessionId: string): TurnInboxHandle {
  if (!channelRegistered && !SINGLE_PROCESS) {
    registerNotifyChannel(CHANNEL, handleTurnInputNotification)
    startNotifyListener()
    channelRegistered = true
  }
  if (inboxes.has(sessionId)) {
    console.warn(`[turn-inbox] replacing a stale inbox for session ${sessionId}`)
  }
  const inbox: Inbox = { waiting: new Map() }
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
    const parsed = JSON.parse(payload) as { sessionId?: string; input?: PendingTurnInput }
    if (!parsed.sessionId || !parsed.input?.id || typeof parsed.input.text !== 'string') return
    dispatchLocal(parsed.sessionId, parsed.input)
  } catch (err) {
    console.warn('[turn-inbox] malformed notification payload:', err)
  }
}

/** Test helper — drop every inbox. */
export function _resetTurnInboxes(): void {
  inboxes.clear()
}
