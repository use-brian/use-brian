/**
 * Session live-event bus PORT — the seam over the real-time session-event bus.
 *
 * The bus (`session-event-bus.ts`) is an in-process + cross-instance
 * (LISTEN/NOTIFY) pub/sub over a session's turn lifecycle. It is generic
 * session infra: the **open** doc-comment live-reconnect feature subscribes to
 * it (`doc_thread` turns — `GET /api/sessions/:id/stream`), and the closed
 * feed-distribution draft feature also rides it. This module owns the shared
 * event TYPES + the injectable function shapes + safe no-op defaults so a route
 * builder can take the bus as an injected dependency (the default no-op keeps
 * unit tests DB-free; the composition root injects the real bus). See
 * docs/plans/oss-local-brain-wedge.md §12.5.
 */

export type SessionEvent =
  | {
      kind: 'user_message_saved'
      sessionId: string
      payload: {
        id: string
        sequenceNum: number
        senderUserId: string | null
        content: unknown
      }
    }
  | {
      kind: 'assistant_message_saved'
      sessionId: string
      payload: {
        id: string
        sequenceNum: number
        content: unknown
      }
    }
  | {
      kind: 'tool_input'
      sessionId: string
      payload: { name: string; input: unknown }
    }
  | {
      /**
       * A live snapshot of an in-flight turn's assistant text, for a client
       * that **reconnected** to a running turn after a page refresh (the doc
       * comment reconnect — `GET /api/sessions/:id/stream`). `text` is the full
       * reply-so-far (not a delta), capped to the NOTIFY budget at the producer,
       * so a reconnecting subscriber has no missed-prefix gap. `activity` is the
       * raw tool name the turn is currently running (the client maps it to a
       * friendly label), or null once reply text is flowing. Published throttled
       * (~150ms) by the chat route for `channel_type='doc_thread'` turns only.
       * See docs/architecture/features/doc-comments.md → "Live turn reconnect".
       */
      kind: 'turn_stream'
      sessionId: string
      payload: { text: string; activity: string | null }
    }
  | {
      kind: 'turn_started'
      sessionId: string
      payload: { senderUserId: string }
    }
  | {
      kind: 'turn_completed'
      sessionId: string
      payload: { senderUserId: string }
    }
  | {
      kind: 'presence'
      sessionId: string
      payload: { viewers: ViewerPresence[] }
    }

export type ViewerPresence = {
  userId: string
  name: string | null
  isTyping: boolean
  lastSeen: string
}

/** Publish a session event. Composition root injects the real bus; default = no-op. */
export type PublishSessionEvent = (event: SessionEvent) => void

/** Subscribe to a session's live events; returns an unsubscribe fn. */
export type SubscribeSessionEvents = (params: {
  sessionId: string
  userId: string
  name: string | null
  cb: (event: SessionEvent) => void
}) => () => void

/** Default — no bus wired (e.g. unit tests); events go nowhere. */
export const noopPublishSessionEvent: PublishSessionEvent = () => {}

/** Default — nothing to subscribe to; the unsubscribe is a no-op. */
export const noopSubscribeSessionEvents: SubscribeSessionEvents = () => () => {}
