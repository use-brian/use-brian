/**
 * Custom (user-authored), workspace-shared doc-page templates — the pure
 * types + validation + the block-id refresh helper.
 *
 * This is the persistence counterpart to the built-in `PAGE_TEMPLATES` catalog
 * in `./templates.ts`. A built-in template is Markdown (`body`) instantiated
 * via `instantiatePageTemplate`; a CUSTOM template is a snapshot of a page's
 * block list (`blocks`), authored by a user and stored per-workspace
 * (`workspace_page_templates`, migration 281). Both converge on a `Block[]`
 * before insertion.
 *
 * Kept DB-free and browser-safe on purpose: this leaf is re-exported (types)
 * through `@sidanclaw/doc-model`, so the gallery / editor can consume it
 * client-side. The persistence lives in `packages/api/src/db/page-templates-store.ts`,
 * the routes in `packages/api/src/routes/views.ts`.
 *
 * Spec: docs/architecture/features/doc-templates.md -> "Custom templates".
 */

import { z } from 'zod'
import type { Block } from '../views/blocks.js'
import { blockSchema } from '../views/blocks.js'
import type { PageTemplateCategory } from './templates.js'

/** The same gallery groupings the built-in catalog uses. */
export const PAGE_TEMPLATE_CATEGORIES = [
  'meeting',
  'planning',
  'team',
  'personal',
  'knowledge',
] as const satisfies readonly PageTemplateCategory[]

export const pageTemplateCategorySchema = z.enum(PAGE_TEMPLATE_CATEGORIES)

/**
 * A custom template, stored in `workspace_page_templates`. Mirrors a built-in
 * `PageTemplate` (name / description / icon / category) but carries a concrete
 * block snapshot instead of a Markdown `body`.
 */
export type CustomPageTemplate = {
  id: string
  workspaceId: string
  createdBy: string
  name: string
  description: string | null
  /** Emoji glyph; seeds `saved_views.icon` on a template-created page. */
  icon: string | null
  category: PageTemplateCategory
  /** The page skeleton — a canonical block list. */
  blocks: Block[]
  createdAt: string
  updatedAt: string
}

/**
 * The list-row projection (no `blocks`) returned to the gallery — kept compact,
 * the heavy block list is fetched only when a template is instantiated.
 */
export type CustomPageTemplateSummary = Omit<CustomPageTemplate, 'blocks'>

/**
 * Route-boundary input for creating a custom template. Serves BOTH authoring
 * paths: "Save as template" sends a live page's `page.blocks`; "New template"
 * sends the authored draft's blocks. `blocks` is validated with the canonical
 * `blockSchema` the doc editor stores.
 */
export const customTemplateCreateInputSchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(2000).nullish(),
  icon: z.string().max(16).nullish(),
  category: pageTemplateCategorySchema,
  blocks: z.array(blockSchema).min(1).max(1000),
})

export type CustomTemplateCreateInput = z.infer<typeof customTemplateCreateInputSchema>

/**
 * Return a structurally-identical block list with every block id (and any
 * nested `children` ids on callout / toggle containers) replaced by a fresh id
 * from `genId`. Instantiating a stored-blocks template into a live page must
 * mint new ids so the inserted blocks never collide with the source page's
 * (or each other, if inserted twice). This is the stored-blocks analog of the
 * `genId` threading `instantiatePageTemplate` does for Markdown templates.
 *
 * (`healBlockIds` in `@sidanclaw/doc-model` operates on a `Y.XmlFragment`, not
 * a plain block array, so it is not the right seam here.)
 */
export function withFreshBlockIds(blocks: Block[], genId: () => string): Block[] {
  return blocks.map((b) => {
    if ((b.kind === 'callout' || b.kind === 'toggle') && b.children) {
      return { ...b, id: genId(), children: withFreshBlockIds(b.children, genId) }
    }
    return { ...b, id: genId() }
  })
}
