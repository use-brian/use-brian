/**
 * Doc v1 — Zod schemas for the wire-format types declared in
 * `./page-types.ts`. HTTP routes and chat tools (`renderPage`,
 * `patchPage`, `getBlock`, `queryDataBlock`) validate against these.
 *
 * Re-exports the existing block / page / binding schemas from
 * `../views/schemas.js` + `../views/blocks.js` and adds:
 *
 *   - `opSchema` / `opsSchema`        — `patchPage` input vocabulary
 *   - `outlineEntrySchema` / `outlineSchema` — outline projection round-trip
 *
 * Inferred Zod types must round-trip with the TS types in `./page-types.ts`.
 * This is enforced by the satisfies-style `z.ZodType<…>` annotations.
 *
 * Spec: `docs/plans/doc-v1-execution.md` §4.1.
 *
 * [COMP:doc/page-types]
 */

import { z } from 'zod'
import { blockSchema, pageSchema } from '../views/blocks.js'
import { bindingConfigSchema, pageIconValueSchema } from '../views/schemas.js'
import { liftListItemText } from './markdown.js'
import type { Block, Op, Outline, OutlineEntry, Page } from './page-types.js'

// Re-export the existing surface so callers can grab everything from one place.
export { blockSchema, pageSchema, bindingConfigSchema }

// ── Lifted (model-tolerant) block / page schemas ──────────────────────
//
// The chat model routinely authors list / quote / callout / toggle blocks
// with a plain `text` field (the shape `text`/`heading` blocks use) instead
// of the opaque Tiptap `richText` those kinds store. Zod's `z.object` strips
// the unknown `text` key, leaving a content-less block that renders as an
// empty bullet. `liftListItemText` (./markdown.ts) lifts that stray `text`
// into a canonical `richText` doc — but it must run BEFORE validation, hence
// `z.preprocess`. Every chat-tool write path (`renderPage`, `createSubPage`,
// and `patchPage`'s `add` op) parses through these instead of the raw
// `blockSchema` / `pageSchema`. The REST editor path sends real `richText`,
// so it keeps the raw schema. See `docs/architecture/features/doc.md` →
// "Markdown normalization".

/** `blockSchema` with the pre-parse list-item `text`→`richText` lift. */
export const liftedBlockSchema: z.ZodType<Block> = z.preprocess(
  liftListItemText,
  blockSchema,
) as z.ZodType<Block>

/** `pageSchema` built on the lifted block schema. */
export const liftedPageSchema: z.ZodType<Page> = z.object({
  blocks: z.array(liftedBlockSchema).max(1000),
}) as z.ZodType<Page>

// ── ID schemas ────────────────────────────────────────────────────────

const blockIdSchema = z.string().min(1).max(128)

/**
 * Reserved within-patch temp ids: `tmp-<freeform>`. Used in `add` ops
 * so a follow-up `move` / `edit` in the same patch can reference the
 * not-yet-real block.
 */
const tmpIdSchema = z.string().regex(/^tmp-[\w-]+$/, {
  message: 'temp id must match /^tmp-[\\w-]+$/',
})

/** A real block id OR a temp id — accepted on `add` op's `block.id`. */
const blockIdOrTmpSchema = z.union([blockIdSchema, tmpIdSchema])

const afterAnchorSchema = z.union([
  blockIdSchema,
  z.literal('start'),
  z.literal('end'),
])

// ── Op union ──────────────────────────────────────────────────────────

/**
 * `add` accepts a block whose id is either a real `BlockId` (rare;
 * usually the client lets the server mint one) or a `tmp-*` id. The
 * underlying `blockSchema` already accepts any string in [1..128], so
 * we re-validate the id field after the inner block parses.
 */
/**
 * The `add` path lets the model omit `block.id` and have the server mint one
 * — exactly what the `patchPage` / `renderPage` tool descriptions instruct.
 * But every block kind requires `id` (1+ chars), so a model that follows that
 * guidance produced a content-less `ops.N.block: Invalid input` and retried
 * blindly — a primary driver of the 2026-06-04 doc token burst. Inject a
 * unique `tmp-auto-*` placeholder BEFORE validation when `id` is absent; the
 * id is then a normal `tmp-*`, so `applyOps` mints the real id from the tmp
 * map (the model never referenced this synthetic tmp, so the `idMap` entry is
 * harmless). The lift order is inject → `liftListItemText` → `blockSchema`.
 */
let autoBlockIdCounter = 0
const addBlockSchema: z.ZodType<Block> = z.preprocess((raw) => {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const b = raw as Record<string, unknown>
    if (b.id === undefined || b.id === null || b.id === '') {
      autoBlockIdCounter += 1
      return { ...b, id: `tmp-auto-${autoBlockIdCounter}` }
    }
  }
  return raw
}, liftedBlockSchema) as z.ZodType<Block>

const addOpSchema = z.object({
  op: z.literal('add'),
  // Optional: omitted → append at the end of the page (see `insertionIndex`
  // in `ops.ts`). Lets the model build a page by listing `add` ops in order
  // without chaining `after: tmp-*` anchors.
  after: afterAnchorSchema.optional(),
  // `addBlockSchema` (lifted + id-optional) so a list/quote/callout block the
  // model authored with a stray `text` field keeps its content AND an
  // id-less block is accepted (server mints) — same lift the `renderPage`
  // page schema applies, plus the id injection above.
  block: addBlockSchema.superRefine((block, ctx) => {
    const parsed = blockIdOrTmpSchema.safeParse(block.id)
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'block.id must be a real id or a tmp-* placeholder',
        path: ['id'],
      })
    }
  }),
})

const editOpSchema = z.object({
  op: z.literal('edit'),
  blockId: blockIdSchema,
  // `Partial<Block>` is intentionally open at the schema layer — the
  // executor (`ops.ts`, Agent F) validates that the merged result is a
  // legal block. Zod can't express "any subset of a discriminated
  // union" cleanly, so we accept a record + leave invariant checks to
  // application code.
  patch: z.record(z.string(), z.unknown()),
})

const deleteOpSchema = z.object({
  op: z.literal('delete'),
  blockId: blockIdSchema,
})

const moveOpSchema = z.object({
  op: z.literal('move'),
  blockId: blockIdSchema,
  after: afterAnchorSchema,
})

const setTitleOpSchema = z.object({
  op: z.literal('setTitle'),
  title: z.string().min(0).max(512),
})

const setIconOpSchema = z.object({
  op: z.literal('setIcon'),
  // An emoji grapheme (≤16 chars) OR an `img:<workspaceId>/<fileId>` image
  // token from the `fetchSiteIcon` tool — matches the REST
  // `PATCH /saved-views/:id` contract (`pageIconValueSchema` in
  // `views/schemas.ts`) — or `null` to clear back to the derived glyph.
  icon: pageIconValueSchema.nullable(),
})

export const opSchema: z.ZodType<Op> = z.discriminatedUnion('op', [
  addOpSchema,
  editOpSchema,
  deleteOpSchema,
  moveOpSchema,
  setTitleOpSchema,
  setIconOpSchema,
]) as unknown as z.ZodType<Op>

export const opsSchema: z.ZodType<Op[]> = z.array(opSchema).max(256)

// ── Outline ───────────────────────────────────────────────────────────

const outlineDataMetaSchema = z.object({
  entityTypeRef: z.string().min(1).max(256),
  rowCount: z.number().int().nonnegative().optional(),
  propertyList: z.array(z.string().min(1).max(128)).max(64).optional(),
})

export const outlineEntrySchema: z.ZodType<OutlineEntry> = z.object({
  id: blockIdSchema,
  // Must enumerate EVERY Block kind that `buildOutline` can emit —
  // otherwise the outline round-trip rejects pages containing those
  // blocks. Keep this in lockstep with the `Block` union in
  // `../views/blocks.ts` (`child_page` added with migration 210).
  kind: z.enum([
    'text',
    'heading',
    'divider',
    'data',
    'chart',
    'diagram',
    'callout',
    'code',
    'quote',
    'bulleted_list_item',
    'numbered_list_item',
    'to_do',
    'toggle',
    'image',
    'file',
    'bookmark',
    'video',
    'audio',
    'child_page',
  ]),
  positionLabel: z.string().min(1).max(128),
  preview: z.string().min(0).max(512),
  dataMeta: outlineDataMetaSchema.optional(),
})

export const outlineSchema: z.ZodType<Outline> = z.object({
  pageId: z.string().min(1).max(128),
  pageVersion: z.number().int().nonnegative(),
  title: z.string().min(0).max(512),
  blocks: z.array(outlineEntrySchema).max(1000),
})
