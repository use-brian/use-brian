/**
 * Input shapes for the email message normalizer (assistant inboxes,
 * docs/architecture/integrations/agentmail.md → "Ingest source").
 *
 * The adapter is pure: the webhook route has already verified the delivery
 * signature and enriched attachments; this file declares only the fields the
 * normalizer reads.
 *
 * [COMP:brain/source-adapters/email]
 */

export type EmailAttachmentInput = {
  attachment_id: string
  filename?: string | null
  content_type?: string | null
  size?: number | null
}

export type EmailMessageInput = {
  /** The assistant inbox the mail arrived at (address = vendor inbox id). */
  inbox_address: string
  thread_id: string
  message_id: string
  /** RFC-5322 mailbox string ("Name <addr>") or bare address. */
  from: string
  to?: ReadonlyArray<string>
  cc?: ReadonlyArray<string>
  subject?: string | null
  /** Reply-extracted body (quoted history stripped) — preferred. */
  extracted_text?: string | null
  /** Raw plain-text body — fallback. */
  text?: string | null
  /** ISO 8601 receive time. */
  timestamp?: string | null
  /** Prior message ids on the thread, oldest first (for the content ref chain). */
  prior_message_ids?: ReadonlyArray<string>
  attachments?: ReadonlyArray<EmailAttachmentInput>
  /**
   * The webhook route's sender-gate verdict — how this mail reached ingest.
   * `gate_match` rules key off it (realtime for allowlisted senders is the
   * seeded default).
   */
  gate: 'allowlisted' | 'stranger' | 'noreply' | 'at_cap' | 'rate_capped'
}

/**
 * Ingest-context fields the adapter cannot infer from the payload alone.
 * Resolved upstream from the inbox's paired `connector_instance` row.
 */
export type EmailIngestContext = {
  workspace_id: string
  user_id: string | null
  assistant_id: string | null
  created_by_user_id: string
  created_by_assistant_id: string | null
}
