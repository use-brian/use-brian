/**
 * WhatsApp adapter — filter implementations.
 *
 * Pure `(window, params) → boolean` functions. Like Slack, WhatsApp
 * filters run on the raw assembled window rather than a normalized
 * Episode: `group_match` / `sender_match` need the raw JIDs, which the
 * Episode content pointer deliberately does not carry.
 *
 * The gate is "what enters the brain", not "who may talk to it" — there
 * are no replies. `group_match` is the enable mechanism: enabling a group
 * writes a `group_match` rule for its JID. With no rules the engine
 * default-drops (see default-rules.ts) so nothing is ingested until the
 * owner enables a group.
 *
 * `sender_match` shadows the universal sender filter with a window-aware
 * variant that matches any participant in the window (the universal one
 * only reads a single `sender`).
 *
 * Spec: docs/architecture/channels/whatsapp.md §"The gate".
 *
 * [COMP:brain/source-adapters/whatsapp]
 */

import { z } from 'zod'

import type { WhatsappGroupWindow } from './types.js'

// ── Param schemas (used at the agent tool layer for validation) ──────

const groupMatchParamsSchema = z.object({
  values: z.array(z.string().min(1)).min(1),
})
export type GroupMatchParams = z.infer<typeof groupMatchParamsSchema>

const senderMatchParamsSchema = z.object({
  values: z.array(z.string().min(1)).min(1),
})
export type SenderMatchParams = z.infer<typeof senderMatchParamsSchema>

/** `is_dm` takes no parameters. */
const isDmParamsSchema = z.object({}).strict()
export type IsDmParams = z.infer<typeof isDmParamsSchema>

// ── Filter implementations ───────────────────────────────────────────

/**
 * True when the window's chat is one of the given group JIDs. WhatsApp
 * group JIDs end in `@g.us`; matched exactly. This is the enable gate.
 */
export function groupMatch(
  window: WhatsappGroupWindow,
  params: GroupMatchParams,
): boolean {
  return params.values.includes(window.chat_jid)
}

/** True when any message author is one of the given sender JIDs. */
export function senderMatch(
  window: WhatsappGroupWindow,
  params: SenderMatchParams,
): boolean {
  const wanted = new Set(params.values)
  for (const msg of window.messages) {
    if (msg.sender_jid && wanted.has(msg.sender_jid)) return true
  }
  return false
}

/** A direct message — WhatsApp DM JIDs end in `@s.whatsapp.net`. */
export function isDm(window: WhatsappGroupWindow, _params: IsDmParams): boolean {
  return window.chat_jid.endsWith('@s.whatsapp.net')
}

// ── Registry exports ─────────────────────────────────────────────────

/**
 * WhatsApp's source-specific filter set. Each entry is keyed by the
 * `filter_type` string stored in `ingest_rules.filter_type`. Composed
 * over `universalFilters` at the engine-wiring layer; `sender_match`
 * intentionally shadows the universal variant with a window-aware one.
 */
export const whatsappFilterImplementations = {
  group_match: groupMatch,
  sender_match: senderMatch,
  is_dm: isDm,
} as const

export type WhatsappFilterType = keyof typeof whatsappFilterImplementations

export const whatsappFilterParamsSchemas = {
  group_match: groupMatchParamsSchema,
  sender_match: senderMatchParamsSchema,
  is_dm: isDmParamsSchema,
} as const
