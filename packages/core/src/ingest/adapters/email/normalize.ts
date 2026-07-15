/**
 * Email message → EpisodeEnvelope normalizer (assistant inboxes).
 *
 * Pure function: no vendor API calls, no DB. Reuses the pre-existing
 * `email_thread` source kind + `EmailThreadContentRef` (the shapes minted for
 * the retired Gmail poller — the AgentMail channel is their first live
 * producer). Validation happens at the Pipeline B trust boundary via
 * `episodeEnvelopeSchema`; email bodies are additionally spotlight-delimited
 * there (`spotlightContent` in pipeline-b.ts) — inbound mail is
 * attacker-controlled text.
 *
 * Spec: docs/architecture/integrations/agentmail.md → "Ingest source".
 *
 * [COMP:brain/source-adapters/email]
 */

import type {
  EmailThreadContentRef,
  EpisodeActor,
  EpisodeAttachment,
  EpisodeEnvelope,
} from '../../types.js'
import type { EmailIngestContext, EmailMessageInput } from './types.js'

function mailboxAddress(mailbox: string): string {
  const angled = mailbox.match(/<([^<>\s]+@[^<>\s]+)>/)
  return (angled ? angled[1] : mailbox).trim().toLowerCase()
}

function collectActors(input: EmailMessageInput): EpisodeActor[] {
  const seen = new Set<string>()
  const actors: EpisodeActor[] = []
  const push = (role: EpisodeActor['role'], mailbox: string) => {
    const address = mailboxAddress(mailbox)
    if (!address || seen.has(address)) return
    seen.add(address)
    actors.push({ role, external_id: address })
  }
  push('sender', input.from)
  for (const to of input.to ?? []) push('recipient', to)
  for (const cc of input.cc ?? []) push('recipient', cc)
  return actors
}

function collectAttachments(input: EmailMessageInput): EpisodeAttachment[] {
  return (input.attachments ?? []).map((a) => ({
    kind: 'file',
    ref: a.attachment_id,
    mime: a.content_type ?? 'application/octet-stream',
    size: a.size ?? 0,
  }))
}

/** The body Pipeline B extracts from: subject + reply-extracted text.
 *  Empty string when there is nothing to extract (no body AND no subject) —
 *  the producer treats that as a no-op. */
export function emailEpisodeText(input: EmailMessageInput): string {
  const body = (input.extracted_text ?? input.text ?? '').trim()
  const subject = (input.subject ?? '').trim()
  if (!body && !subject) return ''
  const fromLine = `From: ${input.from.trim()}`
  const subjectLine = subject ? `Subject: ${subject}` : null
  return [fromLine, subjectLine, '', body].filter((l) => l !== null).join('\n').trim()
}

export function normalizeEmailMessage(
  input: EmailMessageInput,
  ctx: EmailIngestContext,
): EpisodeEnvelope {
  const sourceRef: EmailThreadContentRef = {
    source_kind: 'email_thread',
    message_id_chain: [...(input.prior_message_ids ?? []), input.message_id],
  }

  const occurredAt = input.timestamp ? new Date(input.timestamp) : new Date()

  return {
    source_kind: 'email_thread',
    source_ref: sourceRef as unknown as Record<string, unknown>,
    occurred_at: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,

    actors: collectActors(input),
    content: {
      raw: { ref: `email:${input.inbox_address}/${input.thread_id}/${input.message_id}` },
      attachments: collectAttachments(input),
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
