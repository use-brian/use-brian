/**
 * Shared reply-text resolver for the four channel routes.
 *
 * Channel reply IDs are heterogeneous (Telegram: number; Slack:
 * thread_ts string; WhatsApp: quotedMessageId string; Web: our UUID)
 * but the resolved TEXT is what every downstream consumer needs (topic
 * classifier, system-prompt reply anchor). This helper centralizes the
 * per-channel lookup.
 *
 * All lookups are scoped to the current session — a reply cannot cross
 * session boundaries. Telegram carries the replied-to text in its
 * webhook so no DB hit is needed; other channels fall through to
 * `session_messages.channel_message_id` / `id` lookups.
 *
 * Returns null when the target cannot be resolved. Callers treat null
 * as "no reply context" — graceful degradation, never an error.
 */

import type { Session, SessionMessage } from '../db/sessions.js'
import { findSessionMessageByChannelId, getSessionMessages } from '../db/sessions.js'

export type ResolveReplyParams = {
  channelType: 'telegram' | 'slack' | 'whatsapp' | 'web' | string
  replyToMessageId: string | number | null | undefined
  session: Session
  /**
   * Optional raw channel payload — Telegram uses this to read the
   * replied-to text directly from the webhook without a DB lookup.
   */
  raw?: unknown
  /**
   * Optional user-selected snippet from the client (web only today).
   * When the user highlights a phrase inside a message bubble and clicks
   * Reply, we want the model's reply context to be that exact phrase
   * — not the full stored message. The DB lookup still runs (so we
   * keep `fromAssistant` and the existence check); the snippet just
   * overrides the resolved `text` when present.
   */
  clientSnippet?: string | null
}

export type ResolvedReply = {
  text: string
  /** The resolved channel-native ID (stringified). */
  messageId: string
  /** Whether the replied-to message was authored by the assistant. */
  fromAssistant: boolean
  /**
   * Topic label stored on the replied-to message, if available (DB-resolved
   * cases only — Telegram's webhook-carried text won't have this). Used as
   * a strong prior by the topic classifier.
   */
  topicLabel: string | null
}

export async function resolveReplyText(
  params: ResolveReplyParams,
): Promise<ResolvedReply | null> {
  if (params.replyToMessageId === null || params.replyToMessageId === undefined) {
    return null
  }
  const idStr = String(params.replyToMessageId)
  if (!idStr || idStr === 'null') return null

  if (params.channelType === 'telegram') {
    return resolveTelegramReply(params.raw, idStr)
  }
  if (params.channelType === 'web') {
    return applySnippet(
      await resolveByUuid(idStr, params.session.id),
      params.clientSnippet,
    )
  }
  // Slack / WhatsApp / other messaging channels: lookup by channel_message_id.
  return applySnippet(
    await resolveByChannelId(idStr, params.session.id),
    params.clientSnippet,
  )
}

/**
 * Override the resolved reply text with the client-supplied snippet when one
 * is present. Falls back to the full message text if the snippet is empty
 * or only whitespace. We trust the snippet rather than substring-validating
 * against the stored message: rendered Markdown / list bullets / link-text
 * substitutions mean the user's selection often won't match the source
 * verbatim, and the user can already type any text into their message body
 * — there's no extra trust boundary to enforce here.
 */
function applySnippet(
  resolved: ResolvedReply | null,
  snippet: string | null | undefined,
): ResolvedReply | null {
  if (!resolved) return resolved
  const trimmed = snippet?.trim()
  if (!trimmed) return resolved
  return { ...resolved, text: trimmed }
}

function resolveTelegramReply(raw: unknown, idStr: string): ResolvedReply | null {
  const r = raw as
    | {
        reply_to_message?: {
          text?: string
          from?: { is_bot?: boolean }
        }
      }
    | undefined
  const text = r?.reply_to_message?.text?.trim()
  if (!text) return null
  return {
    text,
    messageId: idStr,
    fromAssistant: r?.reply_to_message?.from?.is_bot === true,
    topicLabel: null,
  }
}

async function resolveByUuid(
  id: string,
  sessionId: string,
): Promise<ResolvedReply | null> {
  // UUID format check — bail early if we got a non-UUID (e.g. client
  // sent a channel-native ID by mistake on the web route).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return null
  }
  // getSessionMessages doesn't support by-id lookup directly; fetch a
  // bounded window and find the match. For the web route this is cheap
  // because the replied-to message is almost always in the recent window.
  const recent = await getSessionMessages(sessionId, { limit: 500 })
  const hit = recent.find((m) => m.id === id)
  if (!hit) return null
  return makeResolved(hit, id)
}

async function resolveByChannelId(
  channelMessageId: string,
  sessionId: string,
): Promise<ResolvedReply | null> {
  const hit = await findSessionMessageByChannelId(sessionId, channelMessageId)
  if (!hit) return null
  return makeResolved(hit, channelMessageId)
}

function makeResolved(msg: SessionMessage, messageId: string): ResolvedReply | null {
  const text = extractMessageText(msg.content)
  if (!text) return null
  return {
    text,
    messageId,
    fromAssistant: msg.role === 'assistant',
    topicLabel: msg.topicLabel,
  }
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content as Array<{ type?: string; text?: string }>) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join(' ').trim()
}
