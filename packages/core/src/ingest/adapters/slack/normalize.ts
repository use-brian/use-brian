/**
 * Slack thread → EpisodeEnvelope normalizer (WU-7.2).
 *
 * Pure function: no Slack API calls, no signature verification, no DB. The
 * caller has already resolved the full thread via `conversations.replies`.
 *
 * Validation of the output happens at the Pipeline B trust boundary via
 * `episodeEnvelopeSchema` (see `../../schemas.ts`); this normalizer trusts
 * its typed inputs.
 *
 * Spec: docs/plans/company-brain/ingest.md §Slack; data-model.md
 * §EpisodeContentRef (pointer rule — manual_paste is the inline exception).
 *
 * [COMP:brain/source-adapters/slack]
 */

import type {
  EpisodeActor,
  EpisodeAttachment,
  EpisodeEnvelope,
  SlackThreadContentRef,
} from '../../types.js'

import type {
  SlackFileInput,
  SlackIngestContext,
  SlackMessageInput,
  SlackThreadInput,
} from './types.js'

/** Slack ts is "<unix-seconds>.<microseconds>"; convert to a JS Date. */
function tsToDate(ts: string): Date {
  return new Date(parseFloat(ts) * 1000)
}

function collectActors(messages: ReadonlyArray<SlackMessageInput>): EpisodeActor[] {
  const seen = new Set<string>()
  const actors: EpisodeActor[] = []
  for (const msg of messages) {
    // Bot-only messages have `bot_id` and no `user` — skip; bots aren't people.
    if (!msg.user) continue
    if (seen.has(msg.user)) continue
    seen.add(msg.user)
    actors.push({ role: 'sender', external_id: msg.user })
  }
  return actors
}

function fileToAttachment(file: SlackFileInput): EpisodeAttachment {
  return {
    kind: 'file',
    ref: file.url_private ?? file.id,
    mime: file.mimetype ?? 'application/octet-stream',
    size: file.size ?? 0,
  }
}

function collectAttachments(
  messages: ReadonlyArray<SlackMessageInput>,
): EpisodeAttachment[] {
  const out: EpisodeAttachment[] = []
  for (const msg of messages) {
    if (!msg.files?.length) continue
    for (const f of msg.files) out.push(fileToAttachment(f))
  }
  return out
}

export function normalizeSlackThread(
  input: SlackThreadInput,
  ctx: SlackIngestContext,
): EpisodeEnvelope {
  const sourceRef: SlackThreadContentRef = {
    source_kind: 'slack_thread',
    slack_workspace_id: input.team_id,
    channel_id: input.channel_id,
    thread_ts: input.thread_ts,
    message_count: input.messages.length,
  }

  const firstTs = input.messages[0]?.ts ?? input.thread_ts
  const occurredAt = tsToDate(firstTs)

  return {
    source_kind: 'slack_thread',
    source_ref: sourceRef as unknown as Record<string, unknown>,
    occurred_at: occurredAt,

    actors: collectActors(input.messages),
    content: {
      raw: { ref: `slack:${input.team_id}/${input.channel_id}/${input.thread_ts}` },
      attachments: collectAttachments(input.messages),
    },

    // Default tier; the async sensitivity classifier (WU-3.10) reclassifies
    // during Pipeline B based on extracted content.
    sensitivity: 'internal',

    user_id: ctx.user_id,
    assistant_id: ctx.assistant_id,
    workspace_id: ctx.workspace_id,

    created_by_user_id: ctx.created_by_user_id,
    created_by_assistant_id: ctx.created_by_assistant_id,
  }
}
