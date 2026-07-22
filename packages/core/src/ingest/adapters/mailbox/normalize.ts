/**
 * Mailbox (imap connector) message → EpisodeEnvelope normalizer.
 *
 * Pure sibling of the email adapter's `normalizeEmailMessage`: same
 * `email_thread` source kind + `EmailThreadContentRef`, but shaped for a
 * SYNCED corporate mailbox — provider ids are `folder:uid`, there is no
 * webhook sender gate, and the bulk/noreply markers the imap default rules
 * key off ride the normalized event instead. Bodies are spotlight-delimited
 * at the Pipeline B boundary (inbound mail is attacker-controlled text).
 *
 * [COMP:brain/source-adapters/mailbox]
 */

import type {
  EmailThreadContentRef,
  EpisodeAttachment,
  EpisodeEnvelope,
} from '../../types.js'
import type { EmailIngestContext } from '../email/types.js'
import { collectEmailActors } from '../email/normalize.js'

export type MailboxIngestMessage = {
  /** The connected account address. */
  account_email: string
  folder: string
  /** Provider message id (`folder:uid`, D13). */
  provider_message_id: string
  /** RFC 5322 Message-ID, when present. */
  rfc_message_id?: string | null
  from: string
  to?: ReadonlyArray<string>
  cc?: ReadonlyArray<string>
  subject?: string | null
  /** Plain-text body (text/plain part, stripped-HTML fallback). */
  text?: string | null
  /** ISO 8601 sent time. */
  timestamp?: string | null
  /** RFC References chain, oldest first. */
  references?: ReadonlyArray<string>
  /** Newsletter/bulk markers (List-Unsubscribe / Precedence: bulk). */
  is_bulk?: boolean
  attachments?: ReadonlyArray<{ filename: string; mime: string; size: number }>
}

/** The body Pipeline B extracts from — From/Subject header context + body. */
export function mailboxEpisodeText(input: MailboxIngestMessage): string {
  const body = (input.text ?? '').trim()
  const subject = (input.subject ?? '').trim()
  if (!body && !subject) return ''
  const fromLine = `From: ${input.from.trim()}`
  const subjectLine = subject ? `Subject: ${subject}` : null
  return [fromLine, subjectLine, '', body].filter((l) => l !== null).join('\n').trim()
}

export function normalizeMailboxMessage(
  input: MailboxIngestMessage,
  ctx: EmailIngestContext,
): EpisodeEnvelope {
  const chain = [
    ...(input.references ?? []),
    input.rfc_message_id ?? input.provider_message_id,
  ]
  const sourceRef: EmailThreadContentRef = {
    source_kind: 'email_thread',
    message_id_chain: chain,
  }

  const occurredAt = input.timestamp ? new Date(input.timestamp) : new Date()

  const attachments: EpisodeAttachment[] = (input.attachments ?? []).map((a) => ({
    kind: 'file',
    ref: a.filename,
    mime: a.mime,
    size: a.size,
  }))

  return {
    source_kind: 'email_thread',
    source_ref: sourceRef as unknown as Record<string, unknown>,
    occurred_at: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,

    actors: collectEmailActors({ from: input.from, to: input.to, cc: input.cc }),
    content: {
      raw: { ref: `imap:${input.account_email}/${input.provider_message_id}` },
      attachments,
    },

    // Default tier; the async sensitivity classifier reclassifies during
    // Pipeline B based on extracted content.
    sensitivity: 'internal',

    user_id: ctx.user_id,
    assistant_id: ctx.assistant_id,
    workspace_id: ctx.workspace_id,

    created_by_user_id: ctx.created_by_user_id,
    created_by_assistant_id: ctx.created_by_assistant_id,
  }
}
