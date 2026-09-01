/**
 * Provider-independent draft-cardboard tool.
 *
 * The tool has no database or network side effects. Its input is emitted in
 * the chat stream and persisted with the session message so every edition can
 * render the same draft alternatives.
 *
 * [COMP:feed/content-planning-tool]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '@use-brian/core'

/** Long-form manual drafts remain bounded without inheriting a post limit. */
export const MAX_PROPOSED_DRAFT_CHARS = 100_000

const draftItemSchema = z.object({
  index: z.number().int().min(1).max(99).describe(
    '1-based draft identifier. Reuse an index to revise that alternative.',
  ),
  text: z.string().min(1).max(MAX_PROPOSED_DRAFT_CHARS).describe(
    'The exact post body. Do not add an Option N prefix or surrounding quotes.',
  ),
  label: z.string().max(30).optional().describe(
    'Optional short tone or angle label shown above the draft.',
  ),
  imageBrief: z.string().max(2_000).optional().describe(
    'Optional written visual brief: subject, composition, and mood. Plain text, never a URL.',
  ),
})

const proposeDraftsInputSchema = z.object({
  rationale: z.string().max(800).describe(
    'A short explanation of the alternatives or their tradeoffs.',
  ),
  drafts: z.array(draftItemSchema).min(1).max(5).refine(
    (drafts) => new Set(drafts.map((draft) => draft.index)).size === drafts.length,
    { message: 'Each draft in one call must use a unique index.' },
  ),
})

export const PROPOSE_DRAFTS_TOOL_NAME = 'proposeDrafts'

export function buildProposeDraftsTool(): Tool {
  return buildTool({
    name: PROPOSE_DRAFTS_TOOL_NAME,
    description:
      'Surface draft alternatives in the content-planning cardboard. Put the ' +
      'post bodies in this tool, not in the chat message. Reuse an index to ' +
      'revise an alternative and use the next unused index to add one.',
    inputSchema: proposeDraftsInputSchema,
    isReadOnly: true,
    isConcurrencySafe: true,
    requiresConfirmation: false,
    timeoutMs: 1_000,
    async execute(input) {
      return {
        data: {
          ok: true,
          count: input.drafts.length,
          indices: input.drafts.map((draft) => draft.index),
        },
      }
    },
  })
}
