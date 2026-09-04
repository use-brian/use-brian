/**
 * Session live publisher — the ONE discipline for mirroring an in-flight
 * turn onto the per-session event bus, extracted from `routes/chat.ts`
 * so the background lanes (channel pipeline, callee executor) publish
 * with exactly the chat route's throttle/cap/snapshot semantics instead
 * of growing their own (docs/architecture/features/live-work.md §5.2).
 *
 * Two pieces, both lifted verbatim:
 *
 *  - `createTurnStreamPublisher` — the throttled `turn_stream` snapshot:
 *    full reply-so-far (never deltas — a subscriber joining mid-turn has
 *    no missed-prefix gap), ~150ms throttle so a streamed reply can't
 *    NOTIFY-storm the bus, tail caps keeping the payload under the NOTIFY
 *    budget, and the current tool name as `activity` until reply text
 *    flows. When `attribution` resolves, the snapshot also carries the
 *    reasoning tail + sender/assistant ids (rooms; background lanes).
 *
 *  - `publishRoomTurnActivity` — one discrete activity event, mirrored
 *    so every cleared viewer renders the SAME feed the sender sees;
 *    oversized tool inputs degrade to `{}` (the client falls back to its
 *    static label). The `mirror` gate is evaluated by the CALLER per
 *    call (rooms mirror throughout; personal-chat high-volume activity only
 *    once the direct stream is dead; rare human-control activity mirrors
 *    throughout so a parallel Live client can intervene; background lanes
 *    always — they have no direct stream at all).
 *
 * Publishing is unconditionally safe: the bus is server-side and the only
 * exits are the `gateSessionRead`-gated relays. Do NOT add a "publish
 * only if someone is watching" optimization — presence-conditional
 * emission is a cache-invalidation bug factory; the throttle + the bus
 * coalescer are the cost control.
 *
 * [COMP:api/session-live-publisher]
 */
import type { PublishSessionEvent } from './session-event-port.js'

/** Min interval between turn_stream snapshots (unforced). */
export const STREAM_PUBLISH_THROTTLE_MS = 150
/** Reply-so-far tail cap — keeps the NOTIFY payload under budget. */
export const STREAM_TEXT_CAP = 4_000
/** Live reasoning tail cap (same budget reasoning). */
export const STREAM_REASONING_CAP = 1_500
/** Tool-input JSON cap for mirrored activity events. */
const ROOM_ACTIVITY_INPUT_CAP = 4_000

export type TurnStreamAttribution = { senderUserId: string; assistantId: string }

export type TurnStreamPublisher = {
  /** Reply text flowed: accumulate, clear the activity label, publish throttled. */
  onTextDelta(text: string): void
  /** Live reasoning flowed: accumulate the tail, publish throttled. */
  onReasoningDelta(text: string): void
  /** A tool started before any reply text: surface its raw name, publish now. */
  onToolStart(name: string): void
  /** Publish the current snapshot; `force` bypasses the throttle window. */
  publish(force: boolean): void
}

/**
 * The chat route's `publishTurnStream` closure, lifted. State (reply
 * text, activity, reasoning) lives here; the caller feeds deltas and the
 * publisher decides when a snapshot actually goes out. `shouldPublish`
 * is re-evaluated per call because its inputs flip mid-turn (`clientGone`
 * flips thousands of lines below the closure's creation in chat.ts);
 * omit it for lanes that publish unconditionally (D6).
 */
export function createTurnStreamPublisher(params: {
  sessionId: string
  publishSessionEvent: PublishSessionEvent
  shouldPublish?: () => boolean
  /**
   * When non-null the snapshot carries reasoning + sender/assistant ids
   * (rooms: viewers fold the reasoning tail through the sender's reducer
   * and render the right avatar). Null = the bare `{text, activity}`
   * snapshot the personal reconnect stream expects.
   */
  attribution?: () => TurnStreamAttribution | null
  now?: () => number
}): TurnStreamPublisher {
  const now = params.now ?? Date.now
  let text = ''
  let activity: string | null = null
  let reasoning = ''
  let lastPublishAt = 0

  const publish = (force: boolean): void => {
    if (params.shouldPublish && !params.shouldPublish()) return
    const t = now()
    if (!force && t - lastPublishAt < STREAM_PUBLISH_THROTTLE_MS) return
    lastPublishAt = t
    const attribution = params.attribution?.() ?? null
    params.publishSessionEvent({
      kind: 'turn_stream',
      sessionId: params.sessionId,
      payload: {
        text: text.slice(-STREAM_TEXT_CAP),
        activity,
        ...(attribution
          ? {
              reasoning: reasoning.slice(-STREAM_REASONING_CAP),
              senderUserId: attribution.senderUserId,
              assistantId: attribution.assistantId,
            }
          : {}),
      },
    })
  }

  return {
    onTextDelta(delta: string): void {
      text += delta
      activity = null
      publish(false)
    },
    onReasoningDelta(delta: string): void {
      reasoning += delta
      publish(false)
    },
    onToolStart(name: string): void {
      if (!text) {
        activity = name
        publish(true)
      }
    },
    publish,
  }
}

/**
 * Publish one live-turn activity event onto the per-session bus (rooms:
 * multiplayer chat T13; personal turns after a disconnect; background
 * lanes throughout). Keeping the mirror gate, sender attribution, and
 * NOTIFY-size cap in one seam prevents any lane's stream from silently
 * becoming sender-only.
 *
 * Tool inputs are the only unbounded activity field. Direct-stream
 * clients still receive the complete input; bus subscribers get an empty
 * object when the JSON representation exceeds the bus budget, which
 * makes their UI fall back to the tool's static narration.
 */
export function publishRoomTurnActivity(params: {
  mirror: boolean
  sessionId: string
  senderUserId: string
  event: string
  data: Record<string, unknown>
  publishSessionEvent: PublishSessionEvent
}): void {
  if (!params.mirror) return

  let data = params.data
  if ('input' in data) {
    let input: unknown = {}
    try {
      input = JSON.stringify(data.input).length > ROOM_ACTIVITY_INPUT_CAP
        ? {}
        : data.input
    } catch {
      input = {}
    }
    data = { ...data, input }
  }

  params.publishSessionEvent({
    kind: 'turn_activity',
    sessionId: params.sessionId,
    payload: {
      event: params.event,
      senderUserId: params.senderUserId,
      ...data,
    },
  })
}

/**
 * Terminal bus event for a lane-published turn: viewers clear their
 * "Working" card; `reason` explains an ending nobody asked for. The chat
 * route publishes its own `turn_completed`s inline (they are entangled
 * with its stop/refusal exits); the background lanes use this.
 */
export function publishTurnCompleted(params: {
  sessionId: string
  senderUserId: string
  publishSessionEvent: PublishSessionEvent
  reason?: 'stopped_by_user' | 'stalled_reclaimed' | 'timeout'
}): void {
  params.publishSessionEvent({
    kind: 'turn_completed',
    sessionId: params.sessionId,
    payload: {
      senderUserId: params.senderUserId,
      ...(params.reason ? { reason: params.reason } : {}),
    },
  })
}
