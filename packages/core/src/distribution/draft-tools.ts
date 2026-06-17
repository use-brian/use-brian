/**
 * Draft-session tools.
 *
 * `proposeDrafts` is a UI-signal tool — its only purpose is to surface
 * draft alternatives to the operator's cardboard. It performs no DB
 * writes, no external API calls, and no side effects. The act of calling
 * the tool IS the contract: the chat route's SSE stream emits a
 * `tool_input` event the frontend subscribes to, and the persisted
 * `tool_use` block in `session_messages.content` is what history-replay
 * walks on session reload.
 *
 * Upsert semantics by index — see docs/architecture/feed/draft-sessions.md.
 *
 * Injected only when `session.mode === 'draft'`. The chat route gates the
 * injection so tuning chat / personal assistants never see this tool.
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'

const draftItemSchema = z.object({
  index: z
    .number()
    .int()
    .min(1)
    .max(99)
    .describe(
      '1-based identifier for this draft alternative. Reuse the same index ' +
        'across calls to revise an existing draft; pick the next unused ' +
        'index to add a new alternative.',
    ),
  text: z
    .string()
    .min(1)
    .max(4_000)
    .describe(
      'The post body, exactly as it should appear on the platform. No ' +
        'markdown, no leading "Option N:" prefix, no surrounding quotes.',
    ),
  label: z
    .string()
    .max(30)
    .optional()
    .describe(
      'Optional short tag for this alternative — e.g. "punchy", "long-form", ' +
        '"sarcastic". Surfaced in the operator UI above the draft text.',
    ),
})

const proposeDraftsInputSchema = z.object({
  rationale: z
    .string()
    .max(800)
    .describe(
      'One or two sentences for the operator about WHY these alternatives ' +
        'or what tradeoff each one makes. Shown as a muted caption above ' +
        'the cards.',
    ),
  drafts: z
    .array(draftItemSchema)
    .min(1)
    .max(5)
    .refine(
      (drafts) => new Set(drafts.map((d) => d.index)).size === drafts.length,
      { message: 'Each draft in a single call must have a unique index.' },
    )
    .describe(
      'One to five draft alternatives. Indices identify each draft; ' +
        'see the index field for upsert semantics.',
    ),
})

export const PROPOSE_DRAFTS_TOOL_NAME = 'proposeDrafts'

/**
 * Build the `proposeDrafts` tool. No-arg factory because the tool is
 * stateless (no API callbacks needed — it's purely a UI signal).
 */
export function buildProposeDraftsTool(): Tool {
  return buildTool({
    name: PROPOSE_DRAFTS_TOOL_NAME,
    description:
      'Surface draft post alternatives to the operator\'s draft cardboard. ' +
      'Use this whenever you have one or more candidate drafts ready for the ' +
      'operator to consider — DO NOT write draft post text in your message ' +
      'body, the cardboard is the only place drafts are reviewed and saved.\n\n' +
      'Indices identify each draft. To revise an existing alternative, call ' +
      'this tool again with the same index. To add a new alternative, use ' +
      'the next unused index. To leave an existing alternative unchanged, ' +
      'simply don\'t include it in the call (the cardboard preserves ' +
      'unmentioned indices). The tool is upsert-only — there is no remove ' +
      'operation; the operator dismisses unwanted alternatives via UI.\n\n' +
      'Free-form text in your message body — rationale, follow-up questions, ' +
      'clarifications — stays in the chat thread and is fine. Reserve the ' +
      'tool call exclusively for the post bodies themselves.',
    inputSchema: proposeDraftsInputSchema,
    isReadOnly: true,
    isConcurrencySafe: true,
    requiresConfirmation: false,
    timeoutMs: 1_000,
    async execute(input) {
      // Pure UI signal — the act of being called is the side effect.
      // The frontend reads input.drafts from the SSE tool_input event;
      // history replay walks the persisted tool_use block on reload.
      return {
        data: {
          ok: true,
          count: input.drafts.length,
          indices: input.drafts.map((d) => d.index),
        },
      }
    },
  })
}
