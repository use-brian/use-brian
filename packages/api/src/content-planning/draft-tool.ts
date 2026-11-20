/**
 * Provider-independent draft-cardboard tool.
 *
 * Legacy use emits a read-only UI signal. Upgraded Feed drafts inject a
 * capture callback that saves each alternative in immutable proposal storage
 * before returning the signal. No provider call is made by this tool.
 *
 * [COMP:feed/content-planning-tool]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '@use-brian/agent-runtime/tools/types.js'

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
  threadSegments: z.array(z.string().max(MAX_PROPOSED_DRAFT_CHARS)).min(1).max(100).optional().describe('For a whole X Thread alternative, supply the complete ordered bodies with the same number of segments as the current draft.'),
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

export function buildProposeDraftsTool(options: { capture?: (input: z.infer<typeof proposeDraftsInputSchema>) => Promise<unknown> } = {}): Tool {
  return buildTool({
    requiresCapability: 'feed',
    homeAppToolSet: { app: 'feed', set: 'write' },
    name: PROPOSE_DRAFTS_TOOL_NAME,
    description:
      'Surface draft alternatives in the content-planning cardboard. Put the ' +
      'post bodies in this tool, not in the chat message. Reuse an index to ' +
      'revise an alternative and use the next unused index to add one.',
    inputSchema: proposeDraftsInputSchema,
    isReadOnly: !options.capture,
    isConcurrencySafe: !options.capture,
    requiresConfirmation: false,
    timeoutMs: options.capture ? 15_000 : 1_000,
    async execute(input) {
      const capture = options.capture ? await options.capture(input) : undefined
      return {
        data: {
          ok: true,
          ...(capture ? { capture } : {}),
          count: input.drafts.length,
          indices: input.drafts.map((draft) => draft.index),
        },
      }
    },
  })
}
