/**
 * Slack adapter — filter implementations.
 *
 * Pure `(thread, params) → boolean` functions. Unlike the Calendar
 * adapter, Slack filters run on the raw resolved `SlackThreadInput`
 * rather than a normalized Episode: `is_mention` needs the raw message
 * text, which the Episode content pointer deliberately does not carry.
 *
 * Spec: docs/plans/company-brain/ingest.md §Filter library →
 * "Source-specific filters per canonical adapter at launch" (Slack,
 * line 518): `channel_match`, `is_dm`, `is_mention`, `user_match`.
 *
 * Placeholder param values (`:workspace_members`, `:crm_contacts`) are
 * resolved upstream by the engine before reaching these implementations.
 *
 * [COMP:brain/source-adapters/slack]
 */

import { z } from 'zod'

import type { SlackThreadInput } from './types.js'

// ── Param schemas (used at the agent tool layer for validation) ──────

export const channelMatchParamsSchema = z.object({
  values: z.array(z.string().min(1)).min(1),
})
export type ChannelMatchParams = z.infer<typeof channelMatchParamsSchema>

/** `is_dm` takes no parameters. */
export const isDmParamsSchema = z.object({}).strict()
export type IsDmParams = z.infer<typeof isDmParamsSchema>

export const isMentionParamsSchema = z.object({
  values: z.array(z.string().min(1)).min(1),
})
export type IsMentionParams = z.infer<typeof isMentionParamsSchema>

export const userMatchParamsSchema = z.object({
  values: z.array(z.string().min(1)).min(1),
})
export type UserMatchParams = z.infer<typeof userMatchParamsSchema>

// ── Filter implementations ───────────────────────────────────────────

/**
 * Slack channel ids are case-sensitive ('C…' channel, 'D…' DM, 'G…'
 * legacy private group) — matched exactly.
 */
export function channelMatch(
  thread: SlackThreadInput,
  params: ChannelMatchParams,
): boolean {
  return params.values.includes(thread.channel_id)
}

/** A direct-message thread — Slack DM channel ids are prefixed 'D'. */
export function isDm(thread: SlackThreadInput, _params: IsDmParams): boolean {
  return thread.channel_id.startsWith('D')
}

/**
 * True when any message @-mentions one of the given user ids. Slack
 * encodes mentions inline as `<@U…>`.
 */
export function isMention(
  thread: SlackThreadInput,
  params: IsMentionParams,
): boolean {
  const tokens = params.values.map((id) => `<@${id}>`)
  for (const msg of thread.messages) {
    if (!msg.text) continue
    for (const token of tokens) {
      if (msg.text.includes(token)) return true
    }
  }
  return false
}

/** True when any message author is one of the given user ids. */
export function userMatch(
  thread: SlackThreadInput,
  params: UserMatchParams,
): boolean {
  const wanted = new Set(params.values)
  for (const msg of thread.messages) {
    if (msg.user && wanted.has(msg.user)) return true
  }
  return false
}

// ── Registry exports ─────────────────────────────────────────────────

/**
 * Slack's source-specific filter set per ingest.md:518. Each entry is
 * keyed by the `filter_type` string stored in `ingest_rules.filter_type`
 * (migration 130).
 */
export const slackFilterImplementations = {
  channel_match: channelMatch,
  is_dm: isDm,
  is_mention: isMention,
  user_match: userMatch,
} as const

export type SlackFilterType = keyof typeof slackFilterImplementations

export const slackFilterParamsSchemas = {
  channel_match: channelMatchParamsSchema,
  is_dm: isDmParamsSchema,
  is_mention: isMentionParamsSchema,
  user_match: userMatchParamsSchema,
} as const
