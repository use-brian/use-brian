// [COMP:api/generate-blueprint-tool] — the model-callable tool that fills a
// blueprint from the brain (structural-synthesis, GENERATE mode) mid-chat or in
// a workflow consult. A thin wrapper over `generateSynthesize` (the BootContext
// callback): resolve the blueprint by id-or-name, then run the fill under the
// caller's actor (from the ToolContext, never widened).
//
// `requiresConfirmation` so the assistant confirms before spending the bounded
// model run + writing a page/entities. Billing: the cost rides the chat turn's
// own per-message credit (the engine records `overhead:synthesis` COGS) — there
// is NO separate `synthesis_surcharge`, unlike the standalone Blueprints-UI
// route which has no parent turn to ride. This is a BRAIN base tool (built with
// deps + injected into chat.ts / executor.ts), NOT a connector tool — it never
// belongs in OFFICIAL_CONNECTOR_TOOLS.
//
// See docs/architecture/brain/structural-synthesis.md -> "Generate is user-surfaced".

import { z } from 'zod'
import { buildTool, type Tool } from '@sidanclaw/core'
import type { GenerateSynthesizeFn } from './generate-synthesizer.js'
import type { PageTemplateStore } from '../db/page-templates-store.js'

const fillBlueprintSchema = z.object({
  blueprint: z.string().min(1).describe('The blueprint to fill — its name or id.'),
  subject: z
    .string()
    .min(1)
    .describe('What the draft is about (an entity, account, or topic). Scopes the page + the brain gather.'),
})

export function createGenerateBlueprintTool(deps: {
  generateSynthesize: GenerateSynthesizeFn
  pageTemplateStore: PageTemplateStore
}): Tool {
  return buildTool({
    name: 'fillBlueprintFromBrain',
    description:
      'Fill a workspace BLUEPRINT from the company brain, producing a structured brief page plus captured entities. ' +
      'Use when the user asks to draft or generate a known structured document (a proposal, account brief, report, or shop/contact list) from what the brain already holds — NOT for free-form writing. ' +
      'Pass the blueprint by name (or id) and a subject (the account/topic it is about). Returns the filled page id. ' +
      'Requires confirmation because it spends a bounded model run and writes to the brain.',
    inputSchema: fillBlueprintSchema,
    requiresConfirmation: true,
    async execute(input, context) {
      const workspaceId = context.workspaceId
      if (!workspaceId) {
        return { data: { error: 'Generating from a blueprint needs a workspace context.' }, isError: true }
      }
      // Resolve among the workspace's RUNNABLE blueprints (page templates that
      // carry an extraction spec). Exact id, then exact name, then a contains
      // match so the model can pass a loose name.
      const needle = input.blueprint.trim().toLowerCase()
      const blueprints = (await deps.pageTemplateStore.list(context.userId, workspaceId)).filter(
        (t) => t.extraction != null,
      )
      const match =
        blueprints.find((t) => t.id === input.blueprint) ??
        blueprints.find((t) => t.name.trim().toLowerCase() === needle) ??
        blueprints.find((t) => t.name.trim().toLowerCase().includes(needle))
      if (!match) {
        const names = blueprints.map((t) => t.name).slice(0, 8).join(', ')
        return {
          data: { error: `No blueprint matching "${input.blueprint}". Available: ${names || '(none)'}` },
          isError: true,
        }
      }
      const result = await deps.generateSynthesize({
        blueprintSlug: match.id,
        subject: input.subject.trim(),
        workspaceId,
        userId: context.userId,
        assistantId: context.assistantId,
      })
      if (!result) {
        return { data: { error: `Blueprint "${match.name}" could not be resolved.` }, isError: true }
      }
      return { data: { pageId: result.pageId, blueprint: match.name, subject: input.subject.trim() } }
    },
  })
}
