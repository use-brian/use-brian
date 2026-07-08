/**
 * WhatsApp adapter — default rule templates.
 *
 * Deliberately EMPTY. Default-drop is the WhatsApp gate: a linked device
 * receives the entire account stream (every group + DM), and WhatsApp
 * gives us no per-group subscription. With no rules the engine returns
 * `matched=false` and drops without a row, so nothing is ingested until
 * the owner enables a specific group — which appends a `group_match` rule
 * to this connector instance's `ingest_rules`.
 *
 * Contrast with Slack, whose `always → scheduled` catch-all ingests every
 * channel by default. WhatsApp must NOT have a catch-all: the number sits
 * in personal DMs and unrelated groups the owner never meant to share.
 *
 * Spec: docs/architecture/channels/whatsapp.md §"The gate" (1.
 * Default-drop), §"Decisions (locked)" 3.
 *
 * [COMP:brain/source-adapters/whatsapp]
 */

export type WhatsappDefaultRule = {
  filter_type: string
  filter_params: Record<string, unknown>
  routing_mode: 'realtime' | 'scheduled' | 'drop'
  routing_schedule?: string
  alert?: boolean
}

/** Empty by construction — default-drop. See file header. */
export const whatsappDefaultRules: readonly WhatsappDefaultRule[] = [] as const
