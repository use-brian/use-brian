/**
 * Home dock — the `setHomeDock` curation tool.
 *
 * Writes the workspace's `HomeDockLayout` artifact: the assistant's freeform
 * note plus the ordering/captions of the "Needs you" action cards. It carries
 * NO counts (those are read live at GET time — the freshness contract).
 *
 * Injected ONLY in the home-refresh turn (packages/api/src/home/refresh.ts),
 * never in normal chat — so it never bloats the everyday tool surface and is
 * never named in Layer 1. See docs/architecture/features/home-dock.md.
 *
 * [COMP:home/tools]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import { NEED_CARD_KINDS, type HomeDockLayout, type HomeDockStore } from './types.js'

export const setHomeDockInputSchema = z.object({
  note: z
    .string()
    .max(280)
    .nullable()
    .optional()
    .describe(
      'A short, warm, specific note to the user for the top of the home dock (≤280 chars), or null for none. Reference something concrete from the signals. No greeting prefix.',
    ),
  needsYou: z
    .array(
      z.object({
        kind: z.enum(NEED_CARD_KINDS),
        caption: z
          .string()
          .max(120)
          .optional()
          .describe('Optional one-line caption override for this action card.'),
      }),
    )
    .max(6)
    .optional()
    .describe(
      'The "Needs you" action cards in priority order. Include only the kinds worth surfacing today; counts are filled in live, so a kind whose count is 0 is dropped automatically. The attention kinds (connector_attention, workflow_attention) are appended automatically while live even when omitted — list one only to change its position or caption.',
    ),
})

export type HomeToolDeps = {
  store: HomeDockStore
}

export function createHomeTools(deps: HomeToolDeps): { setHomeDock: Tool } {
  const setHomeDock = buildTool({
    name: 'setHomeDock',
    description:
      'Curate the workspace home "Suggested for you" dock: set an optional note and order the "Needs you" action cards. Call once. Do not invent counts — they are filled in live.',
    inputSchema: setHomeDockInputSchema,
    isReadOnly: false,
    isConcurrencySafe: false,
    async execute(input, context) {
      if (!context.workspaceId) {
        return {
          data: 'The home dock is workspace-scoped, and this turn is not bound to a workspace.',
          isError: true,
        }
      }
      const layout: HomeDockLayout = {
        version: 1,
        note: input.note ?? null,
        needsYou: (input.needsYou ?? []).map((c) => ({
          kind: c.kind,
          ...(c.caption ? { caption: c.caption } : {}),
        })),
        generatedAt: new Date().toISOString(),
        generatedByAssistantId: context.assistantId ?? null,
      }
      await deps.store.put(context.userId, context.workspaceId, layout)
      const noteBit = layout.note ? ' and a note' : ''
      return {
        data: `Home dock updated: ${layout.needsYou.length} action card(s)${noteBit}.`,
      }
    },
  })
  return { setHomeDock }
}
