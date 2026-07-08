/**
 * WhatsApp group window → EpisodeEnvelope normalizer.
 *
 * Pure function: no WhatsApp/Baileys calls, no signature verification, no
 * DB. The caller has already assembled the window (single-message at intake
 * time, the full per-group batch at drain time).
 *
 * Attribution is the point: `actors` is collected per real participant JID
 * (bots skipped), so every fact Pipeline B extracts is attributed to the
 * actual sender rather than smeared onto one `userId` — the fix for the old
 * WhatsApp responder path's memory defect.
 *
 * Output validation happens at the Pipeline B trust boundary via
 * `episodeEnvelopeSchema` (see `../../schemas.ts`); this normalizer trusts
 * its typed inputs. Uses the existing `channel_window` source kind — a
 * windowed slice of a channel is exactly what a WhatsApp group ingest is.
 *
 * Spec: docs/architecture/channels/whatsapp.md §Defect 1;
 * data-model.md §ChannelWindowContentRef.
 *
 * [COMP:brain/source-adapters/whatsapp]
 */

import type {
  ChannelWindowContentRef,
  EpisodeActor,
  EpisodeEnvelope,
} from '../../types.js'

import type {
  WhatsappGroupWindow,
  WhatsappIngestContext,
  WhatsappMessage,
} from './types.js'

function collectActors(messages: ReadonlyArray<WhatsappMessage>): EpisodeActor[] {
  const seen = new Set<string>()
  const actors: EpisodeActor[] = []
  for (const msg of messages) {
    // Bots / our own connected number aren't people — skip, same posture
    // as the Slack adapter's `collectActors`.
    if (msg.is_bot) continue
    if (!msg.sender_jid) continue
    if (seen.has(msg.sender_jid)) continue
    seen.add(msg.sender_jid)
    actors.push({ role: 'sender', external_id: msg.sender_jid })
  }
  return actors
}

function windowBounds(messages: ReadonlyArray<WhatsappMessage>): {
  start: Date
  end: Date
} {
  let min = Infinity
  let max = -Infinity
  for (const msg of messages) {
    if (msg.timestamp < min) min = msg.timestamp
    if (msg.timestamp > max) max = msg.timestamp
  }
  // Empty window (defensive) — collapse to the epoch so the envelope stays
  // valid; the engine never routes a zero-message window in practice.
  const start = Number.isFinite(min) ? new Date(min) : new Date(0)
  const end = Number.isFinite(max) ? new Date(max) : start
  return { start, end }
}

export function normalizeWhatsappGroup(
  input: WhatsappGroupWindow,
  ctx: WhatsappIngestContext,
): EpisodeEnvelope {
  const { start, end } = windowBounds(input.messages)

  const sourceRef: ChannelWindowContentRef = {
    source_kind: 'channel_window',
    channel_id: input.chat_jid,
    window_start: start,
    window_end: end,
    message_count: input.messages.length,
  }

  return {
    source_kind: 'channel_window',
    source_ref: sourceRef as unknown as Record<string, unknown>,
    occurred_at: start,

    actors: collectActors(input.messages),
    content: {
      raw: { ref: `whatsapp:${input.chat_jid}/${start.getTime()}-${end.getTime()}` },
      attachments: [],
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
