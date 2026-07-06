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

/** Brain primitives a blueprint can declare it captures from a source. */
export const BLUEPRINT_CAPTURE_KINDS = ['company', 'contact', 'deal', 'task'] as const
export type BlueprintCaptureKind = (typeof BLUEPRINT_CAPTURE_KINDS)[number]

/** One section of a blueprint: a heading plus the instruction that fills it. */
export const extractionSectionSchema = z.object({
  heading: z.string().min(1).max(200),
  instruction: z.string().min(1).max(2000),
  outputType: z.enum(['prose', 'list', 'table']).default('prose'),
})
export type ExtractionSection = z.infer<typeof extractionSectionSchema>

/**
 * The `extraction` spec that turns a plain page template into a BLUEPRINT — the
 * sections (each a heading + extraction instruction) plus which brain entities to
 * capture. A template with no extraction spec is just a skeleton; add the spec and
 * the synthesis engine can fill it from a source. See
 * docs/architecture/brain/structural-synthesis.md -> "The blueprint object".
 */
export const extractionSpecSchema = z.object({
  sections: z.array(extractionSectionSchema).min(1).max(20),
  capture: z.array(z.enum(BLUEPRINT_CAPTURE_KINDS)).default([]),
})
export type ExtractionSpec = z.infer<typeof extractionSpecSchema>

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
  /**
   * Present → this template is a BLUEPRINT the synthesis engine can fill from a
   * source. Null → a plain page skeleton. See structural-synthesis.md.
   */
  extraction: ExtractionSpec | null
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
  /** Optional — present turns the saved template into a blueprint. */
  extraction: extractionSpecSchema.nullish(),
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

/**
 * Derive a blueprint's extraction spec from authored blocks: each
 * `extraction_slot` block pairs with its nearest preceding `heading` to form a
 * section. Returns null when the blocks carry no extraction slots (a plain
 * template skeleton). `capture` is a template-level choice supplied by the
 * caller (the editor's capture toggles). This is the WYSIWYG authoring half —
 * the spec the gallery sends + the store persists is derived from the doc.
 * See docs/architecture/brain/structural-synthesis.md -> "The blueprint object".
 */
export function blocksToExtractionSpec(
  blocks: Block[],
  capture: BlueprintCaptureKind[] = [],
): ExtractionSpec | null {
  const sections: ExtractionSection[] = []
  let heading: string | null = null
  for (const b of blocks) {
    if (b.kind === 'heading') {
      const t = b.text.trim()
      if (t) heading = t
    } else if (b.kind === 'extraction_slot') {
      sections.push({
        heading: heading ?? 'Section',
        instruction: b.instruction.trim(),
        outputType: b.outputType ?? 'prose',
      })
    }
  }
  return sections.length > 0 ? { sections, capture } : null
}

/**
 * The inverse of {@link blocksToExtractionSpec}: build a blueprint's page skeleton
 * from an extraction spec, one `heading` + `extraction_slot` pair per section.
 * Used when a spec is minted programmatically (structural-synthesis Phase 2: a
 * skill's `extraction` is turned into a `workspace_page_templates` blueprint on
 * save), so the result opens in the WYSIWYG editor and round-trips back through
 * `blocksToExtractionSpec`. Deterministic block ids keep re-mints stable.
 */
export function extractionSpecToBlocks(spec: ExtractionSpec): Block[] {
  const blocks: Block[] = []
  spec.sections.forEach((section, i) => {
    blocks.push({ kind: 'heading', id: `bp-sec-${i}-h`, level: 2, text: section.heading })
    blocks.push({
      kind: 'extraction_slot',
      id: `bp-sec-${i}-s`,
      instruction: section.instruction,
      outputType: section.outputType,
    })
  })
  return blocks
}
