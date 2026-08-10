/**
 * Provider-independent plan-cardboard tool.
 *
 * The exact `proposeDrafts` idiom, one level up: no database or network side
 * effects, its input is emitted in the chat stream and persisted with the
 * session message, and the Plan surface renders it as a cardboard the
 * operator accepts slot by slot. Persistence stays with the UI so a proposal
 * never silently rewrites a month (docs/plans/feed-revamp.md D9).
 *
 * [COMP:feed/content-plan-tool]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '@use-brian/core'

const planSlotSchema = z.object({
  index: z.number().int().min(1).max(99).describe(
    '1-based slot identifier. Reuse an index to revise that slot.',
  ),
  slotId: z.string().uuid().optional().describe(
    'The id of an EXISTING empty slot this proposal fills. Set it only when '
    + 'the operator supplied that slot in the conversation; accepting then '
    + 'updates that slot in place instead of creating a new one. Omit to '
    + 'propose a brand new slot.',
  ),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe(
    'The calendar day for this post, YYYY-MM-DD. Must fall inside the month being planned.',
  ),
  platform: z.enum(['instagram', 'threads', 'twitter', 'xhs', 'linkedin']).describe(
    'Which platform this slot targets.',
  ),
  title: z.string().min(1).max(200).describe(
    'A short label for the day cell, e.g. "Launch recap" or "Customer proof".',
  ),
  brief: z.string().max(2_000).optional().describe(
    'What this post should say and why it belongs on this day. Becomes the seed for its draft session.',
  ),
})

const proposePlanInputSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/).describe(
    'The month being planned, YYYY-MM.',
  ),
  rationale: z.string().max(800).describe(
    'A short explanation of the cadence and mix across the month.',
  ),
  slots: z.array(planSlotSchema).min(1).max(31).refine(
    (slots) => new Set(slots.map((slot) => slot.index)).size === slots.length,
    { message: 'Each slot in one call must use a unique index.' },
  ),
})

export const PROPOSE_PLAN_TOOL_NAME = 'proposePlan'

export function buildProposePlanTool(): Tool {
  return buildTool({
    name: PROPOSE_PLAN_TOOL_NAME,
    description:
      'Surface a proposed month of posts in the plan cardboard. Put the slots '
      + 'in this tool, not in the chat message. Reuse an index to revise a slot '
      + 'and use the next unused index to add one. When the operator asked to '
      + 'fill existing empty slots, carry each one\'s slotId so accepting '
      + 'updates that slot rather than creating a duplicate beside it. Propose '
      + 'briefs, not finished copy. The operator accepts slots before anything '
      + 'is scheduled.',
    inputSchema: proposePlanInputSchema,
    isReadOnly: true,
    isConcurrencySafe: true,
    requiresConfirmation: false,
    timeoutMs: 1_000,
    async execute(input) {
      return {
        data: {
          ok: true,
          month: input.month,
          count: input.slots.length,
          indices: input.slots.map((slot) => slot.index),
          filled: input.slots.filter((slot) => slot.slotId).length,
        },
      }
    },
  })
}
