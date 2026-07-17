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
 * Entity kinds an `entityRef` FIELD can point at (rows a record value can
 * reference). Distinct from the capture declaration below: a memory is
 * capturable but not referenceable, so it must never appear here.
 */
export const ENTITY_REF_KINDS = ['company', 'contact', 'deal', 'task'] as const
export type EntityRefKind = (typeof ENTITY_REF_KINDS)[number]

/**
 * Brain primitives a blueprint can declare it captures from a source —
 * `ENTITY_REF_KINDS` plus `memory` (blueprint-directed memories via the
 * synthesis `saveMemory` binding; see structural-synthesis.md → "Capture").
 */
export const BLUEPRINT_CAPTURE_KINDS = ['company', 'contact', 'deal', 'task', 'memory'] as const
export type BlueprintCaptureKind = (typeof BLUEPRINT_CAPTURE_KINDS)[number]

/**
 * Typed field kinds a blueprint contract can demand (contract v2). `markdown`
 * is the v1 prose/list/table section; the rest make the record a real handoff
 * contract (workflows read values, not prose). See structural-synthesis.md ->
 * "The blueprint object" and docs/architecture/brain/structural-synthesis.md §3.
 */
export const EXTRACTION_FIELD_TYPES = [
  'markdown',
  'string',
  'number',
  'date',
  'boolean',
  'enum',
  'entityRef',
] as const
export type ExtractionFieldType = (typeof EXTRACTION_FIELD_TYPES)[number]

/** One section of a v1 blueprint (pre-typed wire shape; lifted to a field on parse). */
export const extractionSectionSchema = z.object({
  heading: z.string().min(1).max(200),
  instruction: z.string().min(1).max(2000),
  outputType: z.enum(['prose', 'list', 'table']).default('prose'),
})
export type ExtractionSection = z.infer<typeof extractionSectionSchema>

/**
 * One field of the blueprint contract: a stable `key` (the handoff address —
 * `{{lastRun.output.<key>}}`, `getBlueprintRecord` reads), a display heading,
 * the fill instruction, and a value type. `enum` fields carry `options`;
 * `entityRef` fields carry `entityKind`. `outputType` survives as the
 * presentation hint for `markdown` fields.
 */
export const extractionFieldSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_-]*$/, 'lowercase slug (a-z, 0-9, -, _)'),
    heading: z.string().min(1).max(200),
    instruction: z.string().min(1).max(2000),
    type: z.enum(EXTRACTION_FIELD_TYPES).default('markdown'),
    options: z.array(z.string().min(1).max(120)).min(2).max(24).optional(),
    entityKind: z.enum(ENTITY_REF_KINDS).optional(),
    required: z.boolean().default(false),
    outputType: z.enum(['prose', 'list', 'table']).optional(),
  })
  .superRefine((field, ctx) => {
    if (field.type === 'enum' && !field.options) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'enum fields need `options`' })
    }
    if (field.type === 'entityRef' && !field.entityKind) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'entityRef fields need `entityKind`' })
    }
  })
export type ExtractionField = z.infer<typeof extractionFieldSchema>

/** Slugify a heading into a field key; `taken` de-dupes with -2, -3, … suffixes. */
export function fieldKeyFromHeading(heading: string, taken?: Set<string>): string {
  const base =
    heading
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'field'
  if (!taken) return base
  let key = base
  for (let i = 2; taken.has(key); i += 1) key = `${base}-${i}`
  taken.add(key)
  return key
}

/**
 * Lift a v1 spec (`sections`, untyped) into the v2 wire shape (`fields`, typed)
 * WITHOUT rewriting stored JSONB: every parse boundary runs this, so old rows,
 * old clients, and the skill-draft LLM (which still emits `sections`) all land
 * on the same typed contract. v1 sections become `markdown` fields keyed by
 * their slugified heading.
 */
function liftExtractionSpecInput(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj.sections) || Array.isArray(obj.fields)) return raw
  const taken = new Set<string>()
  const fields = obj.sections.map((s) => {
    const sec = (s ?? {}) as Record<string, unknown>
    const heading = typeof sec.heading === 'string' ? sec.heading : 'Section'
    return {
      key: fieldKeyFromHeading(heading, taken),
      heading,
      instruction: sec.instruction,
      type: 'markdown',
      outputType: sec.outputType ?? 'prose',
      required: false,
    }
  })
  return { fields, capture: obj.capture, captureInstructions: obj.captureInstructions }
}

/**
 * The `extraction` spec that turns a plain page template into a BLUEPRINT — the
 * typed field contract (each field a key + heading + fill instruction + type)
 * plus which brain entities to capture. A template with no extraction spec is
 * just a skeleton; add the spec and the synthesis engine can fill it from a
 * source into a `blueprint_records` row (+ an optional page projection). Accepts
 * the v1 `sections` wire shape and lifts it. See
 * docs/architecture/brain/structural-synthesis.md -> "The blueprint object".
 */
export const extractionSpecSchema = z.preprocess(
  liftExtractionSpecInput,
  z
    .object({
      fields: z.array(extractionFieldSchema).min(1).max(30),
      capture: z.array(z.enum(BLUEPRINT_CAPTURE_KINDS)).default([]),
      /**
       * Optional per-kind guidance for the capture declaration — HOW to write
       * the enabled kind from this blueprint's sources (e.g. task: "break
       * maintenance items into one task each, titled imperatively"). Keys are
       * capture kinds; unknown keys are tolerated and ignored by renderers.
       * Rendered as bullets under the recipe's "## Capture" section.
       */
      captureInstructions: z.record(z.string(), z.string().max(2000)).optional(),
    })
    .superRefine((spec, ctx) => {
      const seen = new Set<string>()
      for (const f of spec.fields) {
        if (seen.has(f.key)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate field key "${f.key}"` })
        }
        seen.add(f.key)
      }
    }),
)
export type ExtractionSpec = z.infer<typeof extractionSpecSchema>

/**
 * Normalize a stored/foreign extraction value (v1 or v2 JSONB, or null) into
 * the v2 contract. Store reads run through this so every consumer downstream
 * of `PageTemplateStore` sees `fields`, never `sections`. Invalid specs
 * normalize to null (a plain skeleton) rather than throwing — a corrupt spec
 * must never take down a template list.
 */
export function normalizeExtractionSpec(raw: unknown): ExtractionSpec | null {
  if (raw == null) return null
  const parsed = extractionSpecSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

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
 * Route-boundary input for updating a custom template — every field optional,
 * at least one present. Serves the blueprint detail editor (name / description
 * / icon / extraction patches) and the WYSIWYG re-save path (blocks +
 * extraction together). When a patch carries `extraction` but no `blocks`, the
 * route regenerates the authoring skeleton via `extractionSpecToBlocks` so the
 * doc round-trip stays consistent. See structural-synthesis.md ->
 * "The blueprint detail editor".
 */
export const customTemplateUpdateInputSchema = z
  .object({
    name: z.string().min(1).max(256).optional(),
    description: z.string().max(2000).nullish(),
    icon: z.string().max(16).nullish(),
    category: pageTemplateCategorySchema.optional(),
    blocks: z.array(blockSchema).min(1).max(1000).optional(),
    extraction: extractionSpecSchema.nullish(),
  })
  .refine((patch) => Object.values(patch).some((v) => v !== undefined), {
    message: 'empty patch',
  })

export type CustomTemplateUpdateInput = z.infer<typeof customTemplateUpdateInputSchema>

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
  captureInstructions?: Partial<Record<BlueprintCaptureKind, string>>,
): ExtractionSpec | null {
  const fields: ExtractionField[] = []
  const taken = new Set<string>()
  let heading: string | null = null
  for (const b of blocks) {
    if (b.kind === 'heading') {
      const t = b.text.trim()
      if (t) heading = t
    } else if (b.kind === 'extraction_slot') {
      const displayHeading = heading ?? 'Section'
      const explicitKey = b.fieldKey?.trim()
      const key =
        explicitKey && !taken.has(explicitKey)
          ? (taken.add(explicitKey), explicitKey)
          : fieldKeyFromHeading(displayHeading, taken)
      fields.push({
        key,
        heading: displayHeading,
        instruction: b.instruction.trim(),
        type: b.fieldType ?? 'markdown',
        ...(b.options ? { options: b.options } : {}),
        ...(b.entityKind ? { entityKind: b.entityKind } : {}),
        required: b.required ?? false,
        outputType: b.outputType ?? 'prose',
      })
    }
  }
  if (fields.length === 0) return null
  const instructions = Object.fromEntries(
    Object.entries(captureInstructions ?? {}).filter(([, v]) => typeof v === 'string' && v.trim()),
  )
  return {
    fields,
    capture,
    ...(Object.keys(instructions).length > 0 ? { captureInstructions: instructions } : {}),
  }
}

/**
 * The inverse of {@link blocksToExtractionSpec}: build a blueprint's page skeleton
 * from an extraction spec, one `heading` + `extraction_slot` pair per field.
 * Used when a spec is minted programmatically (structural-synthesis Phase 2: a
 * skill's `extraction` is turned into a `workspace_page_templates` blueprint on
 * save), so the result opens in the WYSIWYG editor and round-trips back through
 * `blocksToExtractionSpec`. Deterministic block ids keep re-mints stable.
 */
export function extractionSpecToBlocks(spec: ExtractionSpec): Block[] {
  const blocks: Block[] = []
  spec.fields.forEach((field, i) => {
    blocks.push({ kind: 'heading', id: `bp-sec-${i}-h`, level: 2, text: field.heading })
    blocks.push({
      kind: 'extraction_slot',
      id: `bp-sec-${i}-s`,
      instruction: field.instruction,
      outputType: field.outputType,
      fieldKey: field.key,
      fieldType: field.type,
      ...(field.options ? { options: field.options } : {}),
      ...(field.entityKind ? { entityKind: field.entityKind } : {}),
      ...(field.required ? { required: true } : {}),
    })
  })
  return blocks
}
