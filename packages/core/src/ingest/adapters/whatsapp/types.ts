/**
 * Input shapes for the WhatsApp group-window normalizer.
 *
 * WhatsApp ingest is the Slack-ingest use case on a linked companion
 * device: a real person's number silently reads enabled team groups into
 * the brain and never replies. Unlike Slack (where the route resolves a
 * whole thread up front), WhatsApp messages stream in one at a time — the
 * intake builds a single-message window for the engine's routing decision,
 * and the per-group `pending_ingest_batches` window is assembled later at
 * batch-drain time. Both feed `normalizeWhatsappGroup`.
 *
 * The adapter is pure: callers (the inbound relay intake, the batch drain)
 * assemble the message list and hand it here. Real Baileys payloads carry
 * many more fields; the normalizer reads only what is declared here.
 *
 * Spec: docs/architecture/channels/whatsapp.md §"How they combine";
 * docs/architecture/brain/ingest-pipeline.md §Source adapters (WhatsApp).
 *
 * [COMP:brain/source-adapters/whatsapp]
 */

export type WhatsappMessage = {
  /** WhatsApp message id, unique within the chat. */
  message_id: string
  /**
   * Sender JID — the real participant. Group senders are
   * `<phone>@s.whatsapp.net`; the chat itself is `<id>@g.us`. Absent only
   * for system messages, which are skipped.
   */
  sender_jid?: string
  /** Push name of the sender, when WhatsApp supplied one. */
  sender_name?: string
  /** Message body. May be empty for media-only messages. */
  text?: string
  /** Epoch milliseconds the message was sent. */
  timestamp: number
  /**
   * True when the message author is a bot / our own connected number.
   * Bots aren't people — skipped from actors, same posture as Slack.
   */
  is_bot?: boolean
}

export type WhatsappGroupWindow = {
  /** Group chat JID, e.g. `<id>@g.us` (or `<phone>@s.whatsapp.net` for a DM). */
  chat_jid: string
  /** Group subject (display name), when known. */
  subject?: string
  messages: ReadonlyArray<WhatsappMessage>
}

/**
 * Ingest-context fields the adapter cannot infer from a WhatsApp payload
 * alone. Resolved upstream from the matching `connector_instance` row and
 * the workspace owner.
 *
 * Visibility-double invariant (at least one of `user_id` / `assistant_id`
 * non-null) is enforced by `episodeEnvelopeSchema.superRefine` at the
 * Pipeline B trust boundary, not here.
 */
export type WhatsappIngestContext = {
  workspace_id: string
  user_id: string | null
  assistant_id: string | null
  created_by_user_id: string
  created_by_assistant_id: string | null
}
