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
 * the open-core split (repo CLAUDE.md; plan in git history) §12.5.
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
       * comment reconnect — `GET /api/sessions/:id/stream`) or a room VIEWER
       * watching a teammate's turn (multiplayer chat, T13). `text` is the full
       * reply-so-far (not a delta), capped to the NOTIFY budget at the producer,
       * so a reconnecting subscriber has no missed-prefix gap. `activity` is the
       * raw tool name the turn is currently running (the client maps it to a
       * friendly label), or null once reply text is flowing. `reasoning` is the
       * tail of the model's live thinking text (same snapshot semantics as
       * `text`; viewers fold it through the same reducer the sender uses).
       * `senderUserId` lets a subscriber ignore its own turn's mirror.
       * Published throttled (~150ms) by the chat route for
       * `channel_type='doc_thread'` turns and workspace-shared chat sessions.
       * See docs/architecture/features/chat-app.md → "Shared live activity".
       */
      kind: 'turn_stream'
      sessionId: string
      payload: {
        text: string
        activity: string | null
        reasoning?: string | null
        senderUserId?: string
        /** The ANSWERING assistant (multi-assistant rooms, T9) — viewers
         *  render the right avatar for the live turn. */
        assistantId?: string
      }
    }
  | {
      /**
       * One discrete activity event of a live shared-session turn, mirrored
       * onto the bus so every cleared viewer renders the SAME feed the sender
       * sees (multiplayer chat T13): `event` is the SSE event name
       * (`tool_start` | `tool_input` | `tool_result` | `tool_dropped` |
       * `status` | `tool_confirmation_required`), and the rest of the payload
       * is that event's (size-capped) data. Signals + small data only — a
       * viewer refetches the persisted transcript at settle; oversized tool
       * inputs degrade to `{}` so the client falls back to its static label.
       */
      kind: 'turn_activity'
      sessionId: string
      payload: { event: string; senderUserId?: string } & Record<string, unknown>
    }
  | {
      kind: 'turn_started'
      sessionId: string
      payload: { senderUserId: string; assistantId?: string }
    }
  | {
      kind: 'turn_completed'
      sessionId: string
      /**
       * `reason` says HOW the turn ended, so a viewer can explain an ending
       * nobody asked for rather than just silently clearing the "Working"
       * card. Omitted for an ordinary completion (the overwhelmingly common
       * case, and what every pre-migration-424 publisher sends). See
       * `TurnEndReason` in `db/sessions.ts`.
       */
      payload: {
        senderUserId: string
        reason?: 'stopped_by_user' | 'stalled_reclaimed' | 'timeout'
        /** Display name of whoever pressed stop, when `reason` is a stop. */
        stoppedByName?: string | null
      }
    }
  | {
      /**
       * The room's pin set changed (multiplayer chat P1b, T14) — added or
       * removed. A SIGNAL: every viewer's chip row refetches through its own
       * authed loader; the payload carries no pin data. Exactly one author
       * id is set: a member pinned (`byUserId`) or the room's assistant did
       * through the room pin tools (`byAssistantId`, migration 421).
       */
      kind: 'pins_changed'
      sessionId: string
      payload: { byUserId?: string; byAssistantId?: string }
    }
  | {
      /**
       * The room's bound (default) assistant changed — `PATCH
       * /api/sessions/:id/assistant`. Unlike `pins_changed` this carries the
       * new `assistantId` rather than being a bare refetch signal: every
       * viewer's composer chip, Ask label and `@` default resolve from it
       * off a roster the client already holds, so there is nothing to fetch
       * and no clearance-sensitive data in the payload. `byUserId` is
       * whoever moved it, so a viewer can skip its own echo.
       */
      kind: 'session_assistant_changed'
      sessionId: string
      payload: { assistantId: string; byUserId: string }
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

/**
 * Update a viewer's typing state on a session's presence set (the room
 * typing beacon — docs/architecture/features/chat-app.md → "Typing
 * presence"). The bus broadcasts a `presence` event on transitions only.
 */
export type SetSessionTyping = (params: {
  sessionId: string
  userId: string
  isTyping: boolean
}) => void

/** Snapshot of a session's viewer presence — the follow stream's hello. */
export type GetSessionPresence = (sessionId: string) => ViewerPresence[]

/** Default — no bus wired (e.g. unit tests); events go nowhere. */
export const noopPublishSessionEvent: PublishSessionEvent = () => {}

/** Default — nothing to subscribe to; the unsubscribe is a no-op. */
export const noopSubscribeSessionEvents: SubscribeSessionEvents = () => () => {}

/** Default — no presence tracked; typing beacons go nowhere. */
export const noopSetSessionTyping: SetSessionTyping = () => {}

/** Default — nobody present. */
export const emptySessionPresence: GetSessionPresence = () => []
