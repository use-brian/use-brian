/**
 * Notion-redesign of Q5 Views: page-block types.
 *
 * A view's content is a `Page = { blocks: Block[] }`. Blocks are a
 * discriminated union — most are *inline* (text, heading, divider) and
 * render directly as A2UI widgets; one — the `data` block — carries a
 * `BindingConfig` and resolves on read through the existing bindings
 * catalog. A future `chart` block is sketched out below; it lands with
 * Phase 4 of the plan.
 *
 * The `id` field on every block is the stable handle used by the
 * front-end drag-drop reorder loop and the PATCH route. Server-side
 * factories use `randomUUID()` so the ids are stable.
 *
 * See docs/architecture/features/views.md (Notion architecture) and
 * docs/architecture/features/views.md.
 *
 * [COMP:views/blocks]
 */

import { z } from 'zod'
import { aggregateBindingSchema, type AggregateBinding } from './aggregations.js'
import { bindingConfigSchema } from './schemas.js'
import type { BindingConfig } from './types.js'

// ── Block discriminated union ─────────────────────────────────────────

/**
 * A free-text block. Rendered as A2UI `TextWidget`. Variant maps to the
 * existing text variants: 'body' for a paragraph, 'muted' for ghost
 * notes, 'caption' for fine print. The Notion-feel inline editor wires
 * variant through the kebab menu (defaults to body).
 */
export type TextBlock = {
  kind: 'text'
  id: string
  text: string
  variant?: 'body' | 'muted' | 'caption'
}

/**
 * A heading block. Level 1 / 2 / 3 / 4 maps to `HeadingWidget.level`. The
 * Notion editor binds `#`/`##`/`###`/`####` markdown shorthand to it — level
 * 4 matches Notion's recently-added Heading 4 (the slash menu surfaces all
 * four; `####` is the inline shortcut).
 */
export type HeadingBlock = {
  kind: 'heading'
  id: string
  level: 1 | 2 | 3 | 4
  text: string
}

/**
 * A horizontal-rule block. No data; renders as A2UI `DividerWidget`.
 * Notion editor binds `---` markdown shorthand.
 */
export type DividerBlock = {
  kind: 'divider'
  id: string
}

/**
 * A data block — wraps a `BindingConfig`. The page renderer resolves
 * this through the existing `buildPayload()` so a draft / saved page
 * reflects current data on every read.
 */
export type DataBlock = {
  kind: 'data'
  id: string
  binding: BindingConfig
}

/**
 * Inline, model-authored chart data — the *static* chart source. The
 * assistant supplies the numbers directly (e.g. figures synthesised
 * during research), so the chart is a snapshot rather than a live
 * re-resolution. Mapped to the matching A2UI chart widget by
 * `chartWidgetFromData` (`block-widgets.ts`). Which field is consulted
 * depends on the block's `chartType`:
 *   - `bar` / `pie` → `points` (one bar / slice per entry)
 *   - `line`        → `series` (one line per named series)
 *   - `kpi`         → `value` (+ optional `delta`)
 */
export type ChartData = {
  /** Bar / pie categories — one entry per bar or slice. */
  points?: { label: string; value: number; color?: string }[]
  /** Line series — one or more named series over a shared x axis. */
  series?: { name: string; points: { x: string | number; y: number }[] }[]
  /** KPI headline value. */
  value?: number | string
  /** KPI period-over-period change (raw number, not a percentage). */
  delta?: number
  /** Value formatting (kpi) — mirrors the A2UI `KpiWidget.format`. */
  format?: 'plain' | 'currency' | 'percent' | 'integer'
  /** ISO 4217 code, only consulted when `format` is 'currency'. */
  currency?: string
  /** Bar fill tone. */
  tone?: 'default' | 'success' | 'warning' | 'danger'
  /** Bar orientation. Default 'vertical'. */
  orientation?: 'vertical' | 'horizontal'
}

/**
 * A chart block. Carries EXACTLY ONE of two sources:
 *   - `data`    — inline, model-authored values (the *static* path; a
 *     snapshot, used to visualise research findings). See `ChartData`.
 *   - `binding` — an `AggregateBinding` the resolver (`aggregations.ts`)
 *     collapses into a `{ groups, total }` shape on every read (the
 *     *live* path over workspace entities — tasks / deals / contacts /
 *     companies). Re-resolves on every page open.
 *
 * `chartType` picks the widget (kpi / bar / line / pie); `title`
 * (optional) is forwarded to the widget. The `binding` shape is
 * deliberately distinct from the entity-table `BindingConfig` (it speaks
 * aggregation `op` + `groupBy` + `measure`, not view-type / filters).
 */
export type ChartBlock = {
  kind: 'chart'
  id: string
  /** Picks which A2UI chart widget the block renders. */
  chartType: 'kpi' | 'bar' | 'line' | 'pie'
  /** Optional title rendered above the chart at heading-3 weight. */
  title?: string
  /** The *static* source — inline values authored by the model. */
  data?: ChartData
  /** The *live* source — an aggregation over a workspace entity. */
  binding?: AggregateBinding
}

/**
 * A diagram block — a model-authored node-link / flow graph. The model
 * writes the diagram as Mermaid source (`graph TD`, `sequenceDiagram`,
 * `erDiagram`, `mindmap`, `classDiagram`, …); the renderer compiles it
 * to SVG client-side (`views-renderer`'s `Diagram` widget). This is the
 * *static* diagram source — a snapshot, used to visualise relationships
 * and structure found during research. (A future *live* mode resolving a
 * graph projection over workspace-entity relations is the documented
 * second act — see `docs/architecture/features/doc.md`.)
 */
export type DiagramBlock = {
  kind: 'diagram'
  id: string
  /** Diagram grammar. v1: Mermaid only (covers the common families). */
  syntax: 'mermaid'
  /** The diagram source the renderer compiles to SVG. */
  code: string
  /** Optional title rendered above the diagram at heading-3 weight. */
  title?: string
}

/**
 * Media-block ref — points at a file in storage. v1 uses GCP Cloud Storage
 * paths; the renderer resolves via a signed-URL helper. `null` means the
 * block is in its empty/upload-zone state.
 */
export type MediaRef = {
  bucket: string
  path: string
  mimeType: string
  sizeBytes: number
  name: string
}

/**
 * Image block — uploads through the existing files layer, renders as a
 * lazy-loaded `<img>` with an optional caption.
 */
export type ImageBlock = {
  kind: 'image'
  id: string
  ref: MediaRef | null
  alt?: string
  caption?: string
}

/**
 * Generic file attachment — renders as a download pill (no inline preview).
 */
export type FileBlock = {
  kind: 'file'
  id: string
  ref: MediaRef | null
}

/**
 * Bookmark — paste a URL, server fetches OG tags via
 * `POST /api/doc/og-preview`, renders as a rich card. `meta` may be
 * absent while loading or if the upstream OG fetch fails (graceful fallback
 * to a URL-only card).
 */
export type BookmarkBlock = {
  kind: 'bookmark'
  id: string
  url: string
  meta?: {
    title?: string
    description?: string
    image?: string
    siteName?: string
    favicon?: string
  }
}

/**
 * Video block — an inline player from a URL (uploaded MP4/WebM in storage or
 * an external link the renderer wraps in a `<video controls>`). `url: ''` is
 * the empty/awaiting-URL state, mirroring how `ImageBlock.ref: null` means
 * "upload zone". `caption` is the optional figure caption.
 */
export type VideoBlock = {
  kind: 'video'
  id: string
  url: string
  caption?: string
}

/**
 * Audio block — an inline `<audio controls>` player from a URL (voice notes,
 * uploaded clips, external links). Same `url: ''` empty-state convention as
 * `VideoBlock`. Reuses the transcription layer separately when needed.
 */
export type AudioBlock = {
  kind: 'audio'
  id: string
  url: string
  caption?: string
}

/**
 * Child-page block — an inline link to a nested sub-page (a `saved_views`
 * row whose `nest_parent_id` is this page). Notion-style: the page tree
 * lives in the sidebar, but a parent page can also embed a clickable
 * reference to a child inline. The renderer resolves `childPageId` →
 * the child's title/icon at read time; the block itself stores only the
 * id (no denormalized title — it would drift when the child is renamed).
 *
 * Page nesting itself is tracked on the `saved_views.nest_parent_id`
 * column (migration 210), NOT in the block payload — this block is just
 * the optional inline pointer.
 */
export type ChildPageBlock = {
  kind: 'child_page'
  id: string
  childPageId: string
}

// ── Phase 2.5 rich text + structural blocks ───────────────────────────
//
// These render client-side (app-web `block-*.tsx`) and were authored
// there ahead of the server union. Phase 2.5 promotes them into the
// canonical `Block` union so `renderPage` / `patchPage` can author + Zod-
// validate them. `richText` is opaque Tiptap `JSONContent` — the server
// stores it verbatim and never inspects it.

export type RichTextContent = Record<string, unknown>

export type CalloutBlock = {
  kind: 'callout'
  id: string
  icon: string
  richText?: RichTextContent
  /**
   * Nested child blocks rendered inside the callout panel, after the
   * `richText` line — the Notion callout child model. Any block kind nests
   * (capped by `MAX_CONTAINER_DEPTH` / `MAX_CONTAINER_CHILDREN`). The
   * block↔ProseMirror mapping emits them as the callout node's trailing
   * content (first child = the `richText` line).
   */
  children?: Block[]
}

export type CodeBlock = {
  kind: 'code'
  id: string
  language: string
  code: string
}

export type QuoteBlock = {
  kind: 'quote'
  id: string
  richText?: RichTextContent
}

export type BulletedListItemBlock = {
  kind: 'bulleted_list_item'
  id: string
  richText?: RichTextContent
  /**
   * 0-based nesting depth; absent or 0 = a top-level bullet, 1 = a sub-bullet,
   * and so on. Carried by bulleted/numbered items and to-dos alike.
   * The block↔ProseMirror mapping turns a run of indent-tagged items into a
   * nested `bulletList`/`orderedList`/`taskList` tree. See `listIndentSchema`.
   */
  indent?: number
}

export type NumberedListItemBlock = {
  kind: 'numbered_list_item'
  id: string
  richText?: RichTextContent
  /** 0-based nesting depth; absent or 0 = top level. See {@link BulletedListItemBlock.indent}. */
  indent?: number
}

export type TodoBlock = {
  kind: 'to_do'
  id: string
  checked: boolean
  richText?: RichTextContent
  /** 0-based nesting depth; absent or 0 = top level. See {@link BulletedListItemBlock.indent}. */
  indent?: number
}

export type ToggleBlock = {
  kind: 'toggle'
  id: string
  richText?: RichTextContent
  expanded?: boolean
  /**
   * Nested child blocks hidden/shown by the disclosure — the Notion toggle
   * child model. `richText` is the always-visible summary line; `children`
   * collapse with the chevron. Any block kind nests (capped by
   * `MAX_CONTAINER_DEPTH` / `MAX_CONTAINER_CHILDREN`). Without this field a
   * toggle is an empty disclosure and the content the model meant to tuck
   * inside lands as SIBLINGS after it — the doc-editor parity audit's RC3.
   */
  children?: Block[]
}

/**
 * Native simple-table block (Notion's `/table`, NOT the bound `data`
 * database). `rows` is a row-major grid; each cell is opaque Tiptap rich-text
 * (the same `RichTextContent` shape `callout`/`quote`/list items store), so a
 * cell can hold marks + `@mentions` + a comment range. `hasHeaderRow` /
 * `hasHeaderColumn` map to `tableHeader` vs `tableCell` nodes in the shared
 * schema. The grid is rectangular — every row has the same column count
 * (Zod rejects ragged input; `canonicalizeBlock` pads defensively). Unlike
 * media/data blocks this never collapses to the opaque `embed` atom: the cells
 * are real CRDT nodes so they co-edit cell-by-cell through y-prosemirror.
 */
export type TableBlock = {
  kind: 'table'
  id: string
  rows: RichTextContent[][]
  hasHeaderRow?: boolean
  hasHeaderColumn?: boolean
}

export type Block =
  | TextBlock
  | HeadingBlock
  | DividerBlock
  | DataBlock
  | ChartBlock
  | DiagramBlock
  | CalloutBlock
  | CodeBlock
  | QuoteBlock
  | BulletedListItemBlock
  | NumberedListItemBlock
  | TodoBlock
  | ToggleBlock
  | TableBlock
  | ImageBlock
  | FileBlock
  | BookmarkBlock
  | VideoBlock
  | AudioBlock
  | ChildPageBlock
  | ExtractionSlotBlock

/**
 * Authoring-only block carrying a blueprint section's extraction instruction —
 * the text that says what fills this section when the synthesis engine runs.
 * Only appears in blueprint templates; never in a filled / distilled page. The
 * section heading is the nearest preceding `heading` block. See
 * docs/architecture/brain/structural-synthesis.md -> "The blueprint object".
 */
export type ExtractionSlotBlock = {
  kind: 'extraction_slot'
  id: string
  /** What fills this section when the blueprint runs. */
  instruction: string
  outputType?: 'prose' | 'list' | 'table'
  /**
   * Contract v2 (typed fields — structural-synthesis.md "The blueprint
   * object"). All optional so pre-v2 stored blueprints keep parsing; absent ⇒
   * a `markdown` field keyed by the slugified preceding heading.
   */
  fieldKey?: string
  fieldType?: 'markdown' | 'string' | 'number' | 'date' | 'boolean' | 'enum' | 'entityRef'
  /** Enum fields: the allowed values. */
  options?: string[]
  /** entityRef fields: which brain entity kind the value points at. */
  entityKind?: 'company' | 'contact' | 'deal' | 'task'
  /** Required fields gate the record's `complete` status. */
  required?: boolean
}

export type Page = {
  blocks: Block[]
}

// ── Zod schemas ───────────────────────────────────────────────────────
//
// Every block carries an `id` (1–128 chars — wide enough for `crypto.randomUUID()`
// and any front-end-generated nanoid alike). The block kinds are an enum
// discriminator on the parent union so Zod can route the right inner
// schema cleanly.

const blockId = z.string().min(1).max(128)

const textBlockSchema: z.ZodType<TextBlock> = z.object({
  kind: z.literal('text'),
  id: blockId,
  text: z.string().min(0).max(8192),
  variant: z.enum(['body', 'muted', 'caption']).optional(),
})

// Headings carry a numeric `level` (1–4), but models trained on Notion and
// Markdown reach for other shapes: a numeric string (`"2"`), an HTML/Notion
// tag (`"h2"`, `"heading_2"`), or Markdown hashes (`"##"`). Rejecting those
// outright makes a routine "reorganize this into proper headings" edit fail
// mid-flight, so we normalize every recognizable form into 1–4 (clamping
// out-of-range like `clampLevel` does for `####`) before validating. Truly
// unparseable input (`{}`, `null`) is returned untouched so the union below
// still rejects it with a `level`-named issue.
function headingLevelNumber(input: unknown): 1 | 2 | 3 | 4 | undefined {
  let n: number | undefined
  if (typeof input === 'number' && Number.isFinite(input)) {
    n = Math.round(input)
  } else if (typeof input === 'string') {
    const digits = input.match(/\d+/)
    if (digits) n = Number.parseInt(digits[0], 10)
    else if (input.includes('#')) n = input.replace(/[^#]/g, '').length
  }
  if (n === undefined || Number.isNaN(n)) return undefined
  return (n < 1 ? 1 : n > 4 ? 4 : n) as 1 | 2 | 3 | 4
}

/**
 * Coerce a model-supplied heading level into the canonical 1–4, falling back
 * to `fallback` when nothing parses. Exported for the `edit`-op merge path in
 * `doc/ops.ts`, which bypasses `blockSchema` and so needs the same
 * tolerance the `add` path gets for free via the schema below.
 */
export function coerceHeadingLevel(input: unknown, fallback: 1 | 2 | 3 | 4 = 2): 1 | 2 | 3 | 4 {
  return headingLevelNumber(input) ?? fallback
}

// `as unknown as` because the `level` preprocess takes `unknown` input, which
// a plain `z.ZodType<HeadingBlock>` annotation (input = output) won't accept.
// The runtime value stays a ZodObject, so the discriminated union below is happy.
const headingBlockSchema = z.object({
  kind: z.literal('heading'),
  id: blockId,
  level: z.preprocess(
    (raw) => headingLevelNumber(raw) ?? raw,
    z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  ),
  text: z.string().min(0).max(512),
}) as unknown as z.ZodType<HeadingBlock>

const dividerBlockSchema: z.ZodType<DividerBlock> = z.object({
  kind: z.literal('divider'),
  id: blockId,
})

const extractionSlotBlockSchema: z.ZodType<ExtractionSlotBlock> = z.object({
  kind: z.literal('extraction_slot'),
  id: blockId,
  instruction: z.string().min(0).max(2000),
  outputType: z.enum(['prose', 'list', 'table']).optional(),
  fieldKey: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/)
    .optional(),
  fieldType: z
    .enum(['markdown', 'string', 'number', 'date', 'boolean', 'enum', 'entityRef'])
    .optional(),
  options: z.array(z.string().min(1).max(120)).min(2).max(24).optional(),
  entityKind: z.enum(['company', 'contact', 'deal', 'task']).optional(),
  required: z.boolean().optional(),
})

const dataBlockSchema: z.ZodType<DataBlock> = z.object({
  kind: z.literal('data'),
  id: blockId,
  binding: bindingConfigSchema,
})

const chartDataSchema: z.ZodType<ChartData> = z.object({
  points: z
    .array(
      z.object({
        label: z.string().min(0).max(128),
        value: z.number().finite(),
        color: z.string().min(1).max(64).optional(),
      }),
    )
    .max(500)
    .optional(),
  series: z
    .array(
      z.object({
        name: z.string().min(0).max(128),
        points: z
          .array(
            z.object({
              x: z.union([z.string().min(0).max(128), z.number().finite()]),
              y: z.number().finite(),
            }),
          )
          .max(2000),
      }),
    )
    .max(20)
    .optional(),
  value: z.union([z.number().finite(), z.string().min(0).max(128)]).optional(),
  delta: z.number().finite().optional(),
  format: z.enum(['plain', 'currency', 'percent', 'integer']).optional(),
  currency: z.string().min(3).max(3).optional(),
  tone: z.enum(['default', 'success', 'warning', 'danger']).optional(),
  orientation: z.enum(['vertical', 'horizontal']).optional(),
})

// A chart carries EXACTLY ONE source: `data` (inline, model-authored —
// the static research path) XOR `binding` (a live entity aggregation).
// The base object below is a plain `z.object` (no `.superRefine`) so it can
// be a member of the `kind`-discriminated `blockSchema` union — Zod refuses a
// `ZodEffects` as a discriminated-union option. The xor + per-`chartType`
// shape checks live in `refineChartBlock`, applied at the union level so the
// acceptance set is identical to the old standalone `chartBlockSchema`.
const chartBlockBaseSchema = z.object({
  kind: z.literal('chart'),
  id: blockId,
  chartType: z.enum(['kpi', 'bar', 'line', 'pie']),
  title: z.string().min(0).max(256).optional(),
  data: chartDataSchema.optional(),
  binding: aggregateBindingSchema.optional(),
})

/**
 * The nudge appended to every "this chart has no numbers to plot" rejection.
 * A chart only means something with quantitative values, so when the model
 * hasn't got them we steer it to a block that fits prose / structured info
 * rather than letting it leave (or retry) an empty plot. This is the
 * forward-going half of the 2026-06-10 "nothing here except a heading" report:
 * the render guard (`chartDataIsRenderable`) stops an empty chart from drawing
 * blank, and this stops one from being authored in the first place.
 */
const CHART_NEEDS_DATA_NUDGE =
  'A chart only renders with numbers to plot. If you do not have quantitative values, present this information as a table, callout, or bulleted-list block instead of a chart.'

/**
 * Enforces a chart block's xor (`data` XOR `binding`) and the per-`chartType`
 * shape of an inline `data` payload (bar/pie need points, line needs a series
 * that actually carries points, kpi a value). Called from the union-level
 * `superRefine` in `blockSchema` when `block.kind === 'chart'`. The
 * "no plottable values" rejections carry `CHART_NEEDS_DATA_NUDGE` so the model
 * reaches for a different block type instead of re-emitting an empty chart.
 * The per-`chartType` acceptance set is kept in lockstep with the render-side
 * `chartDataIsRenderable` gate (`block-widgets.ts`) — the write boundary must
 * never accept a chart the renderer can only draw as a placeholder.
 */
function refineChartBlock(block: ChartBlock, ctx: z.RefinementCtx): void {
  const hasData = block.data !== undefined
  const hasBinding = block.binding !== undefined
  if (hasData === hasBinding) {
    // Neither source (an empty shell — the bug we prevent) gets the nudge;
    // both sources is a different, ambiguous-chart mistake.
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: hasData
        ? 'a chart block must carry exactly one of `data` (inline values) or `binding` (live entity aggregation), not both'
        : `a chart needs either inline \`data\` (numbers to plot) or a live \`binding\`. ${CHART_NEEDS_DATA_NUDGE}`,
      path: ['data'],
    })
    return
  }
  if (hasData) {
    const d = block.data!
    if (
      (block.chartType === 'bar' || block.chartType === 'pie') &&
      !(d.points && d.points.length > 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a "${block.chartType}" chart needs at least one entry in \`data.points\`. ${CHART_NEEDS_DATA_NUDGE}`,
        path: ['data', 'points'],
      })
    }
    // A `series: [{ points: [] }]` shell passes "has a series" but draws blank,
    // so require a series that actually carries points — matching the render
    // gate so a line chart that validates is always one the renderer can plot.
    if (
      block.chartType === 'line' &&
      !(d.series && d.series.some((s) => s.points && s.points.length > 0))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a "line" chart needs at least one series with points in \`data.series\`. ${CHART_NEEDS_DATA_NUDGE}`,
        path: ['data', 'series'],
      })
    }
    if (block.chartType === 'kpi' && d.value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a "kpi" chart needs a \`data.value\`. ${CHART_NEEDS_DATA_NUDGE}`,
        path: ['data', 'value'],
      })
    }
  }
}

/**
 * The standalone chart-block schema — `chartBlockBaseSchema` composed with
 * `refineChartBlock` (the xor + per-`chartType` shape checks). The *union*
 * member is the bare base object (Zod refuses a `ZodEffects` as a discriminated-
 * union option), so this composed schema is the one to validate a chart block in
 * ISOLATION: `applyOps`' `edit` guard merges an open `patch` record and must
 * re-check the result is still a legal chart (an `edit` that strips `data` to an
 * empty shell would otherwise slip through — the 2026-06-10 "nothing here except
 * a heading" report). Same acceptance set as an `add`-path chart.
 */
export const chartBlockSchema: z.ZodType<ChartBlock> = chartBlockBaseSchema.superRefine(
  (block, ctx) => refineChartBlock(block as ChartBlock, ctx),
) as unknown as z.ZodType<ChartBlock>

const diagramBlockSchema: z.ZodType<DiagramBlock> = z.object({
  kind: z.literal('diagram'),
  id: blockId,
  syntax: z.literal('mermaid'),
  code: z.string().min(1).max(20000),
  title: z.string().min(0).max(256).optional(),
})

const mediaRefSchema: z.ZodType<MediaRef> = z.object({
  bucket: z.string().min(1).max(256),
  path: z.string().min(1).max(2048),
  mimeType: z.string().min(1).max(256),
  sizeBytes: z.number().int().min(0).max(5_000_000_000),
  name: z.string().min(1).max(512),
})

const imageBlockSchema: z.ZodType<ImageBlock> = z.object({
  kind: z.literal('image'),
  id: blockId,
  ref: mediaRefSchema.nullable(),
  alt: z.string().min(0).max(1024).optional(),
  caption: z.string().min(0).max(2048).optional(),
})

const fileBlockSchema: z.ZodType<FileBlock> = z.object({
  kind: z.literal('file'),
  id: blockId,
  ref: mediaRefSchema.nullable(),
})

const bookmarkBlockSchema: z.ZodType<BookmarkBlock> = z.object({
  kind: z.literal('bookmark'),
  id: blockId,
  url: z.string().min(0).max(2048),
  meta: z
    .object({
      title: z.string().min(0).max(512).optional(),
      description: z.string().min(0).max(2048).optional(),
      image: z.string().min(0).max(2048).optional(),
      siteName: z.string().min(0).max(256).optional(),
      favicon: z.string().min(0).max(2048).optional(),
    })
    .optional(),
})

const videoBlockSchema: z.ZodType<VideoBlock> = z.object({
  kind: z.literal('video'),
  id: blockId,
  url: z.string().min(0).max(2048),
  caption: z.string().min(0).max(2048).optional(),
})

const audioBlockSchema: z.ZodType<AudioBlock> = z.object({
  kind: z.literal('audio'),
  id: blockId,
  url: z.string().min(0).max(2048),
  caption: z.string().min(0).max(2048).optional(),
})

const richTextContentSchema: z.ZodType<RichTextContent> = z.record(
  z.string(),
  z.unknown(),
)

/** Caps on container (toggle/callout) nesting — wide enough for any real
 *  outline, finite so a malformed AI emission can't author a pathological
 *  tree. Depth is enforced by `refineContainerDepth` in the top-level
 *  `blockSchema` superRefine (a `z.lazy` member can't carry its own refine
 *  inside a discriminated union). */
export const MAX_CONTAINER_DEPTH = 6
export const MAX_CONTAINER_CHILDREN = 200

/** Children of a toggle/callout — lazily recursive into the full block
 *  union (`blockSchema` is declared below; `z.lazy` defers the reference to
 *  parse time). */
const containerChildrenSchema = z
  .lazy(() => z.array(blockSchema).max(MAX_CONTAINER_CHILDREN))
  .optional()

const calloutBlockSchema: z.ZodType<CalloutBlock> = z.object({
  kind: z.literal('callout'),
  id: blockId,
  icon: z.string().min(0).max(64),
  richText: richTextContentSchema.optional(),
  children: containerChildrenSchema,
}) as unknown as z.ZodType<CalloutBlock>

const codeBlockSchema: z.ZodType<CodeBlock> = z.object({
  kind: z.literal('code'),
  id: blockId,
  language: z.string().min(0).max(64),
  code: z.string().min(0).max(100_000),
})

const quoteBlockSchema: z.ZodType<QuoteBlock> = z.object({
  kind: z.literal('quote'),
  id: blockId,
  richText: richTextContentSchema.optional(),
})

/** Cap on list nesting depth — wide enough for any real outline, finite so a
 *  malformed AI emission can't author a pathologically deep tree. */
export const MAX_LIST_INDENT = 12

/**
 * A list item's nesting depth — 0-based; absent or 0 = top level. Carried by
 * bulleted/numbered items and to-dos (`TaskItem({ nested: true })` in the doc
 * schema). Lenient by construction: 0 / negative / non-integer /
 * non-number all normalize to "no indent", and a value past the cap clamps, so
 * a stray model value can never reject a page. The block↔ProseMirror mapping
 * (`@sidanclaw/doc-model` `block-mapping.ts`) further clamps an illegal jump to
 * one level deeper than its predecessor when it builds the nested list tree.
 */
const listIndentSchema = z.preprocess((v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  const n = Math.floor(v)
  return n <= 0 ? undefined : Math.min(n, MAX_LIST_INDENT)
}, z.number().int().min(1).max(MAX_LIST_INDENT).optional())

// No `z.ZodType<…>` annotation (unlike its sibling block schemas): the `indent`
// preprocess takes `unknown` input, which a plain `z.ZodType<X>` (input =
// output) rejects — same reason `headingBlockSchema` drops it. The runtime
// value is still a ZodObject, so the discriminated union below is happy.
const bulletedListItemBlockSchema = z.object({
  kind: z.literal('bulleted_list_item'),
  id: blockId,
  richText: richTextContentSchema.optional(),
  indent: listIndentSchema,
})

const numberedListItemBlockSchema = z.object({
  kind: z.literal('numbered_list_item'),
  id: blockId,
  richText: richTextContentSchema.optional(),
  indent: listIndentSchema,
})

// No `z.ZodType<…>` annotation — same `indent` preprocess reason as the
// bulleted/numbered schemas above.
const todoBlockSchema = z.object({
  kind: z.literal('to_do'),
  id: blockId,
  checked: z.boolean(),
  richText: richTextContentSchema.optional(),
  indent: listIndentSchema,
})

const toggleBlockSchema: z.ZodType<ToggleBlock> = z.object({
  kind: z.literal('toggle'),
  id: blockId,
  richText: richTextContentSchema.optional(),
  expanded: z.boolean().optional(),
  children: containerChildrenSchema,
}) as unknown as z.ZodType<ToggleBlock>

/** Wide-but-finite table bounds — a malformed AI emission can't blow up the
 *  editor, but real tables fit comfortably. Mirrors `pageSchema`'s style. */
const TABLE_MAX_ROWS = 100
const TABLE_MAX_COLS = 32

/** Plain `z.object` member (no `.refine` — a `ZodEffects` can't sit in a
 *  `discriminatedUnion`). The rectangular-grid check moves to
 *  `refineTableBlock`, applied in the top-level `blockSchema` superRefine —
 *  the same split `refineChartBlock` uses for chart's xor checks. */
const tableBlockSchema: z.ZodType<TableBlock> = z.object({
  kind: z.literal('table'),
  id: blockId,
  rows: z
    .array(z.array(richTextContentSchema).min(1).max(TABLE_MAX_COLS))
    .min(1)
    .max(TABLE_MAX_ROWS),
  hasHeaderRow: z.boolean().optional(),
  hasHeaderColumn: z.boolean().optional(),
})

/** Reject a ragged grid (rows of unequal column count). Runs in the union-
 *  level superRefine so `tableBlockSchema` can stay a plain object. */
function refineTableBlock(block: TableBlock, ctx: z.RefinementCtx): void {
  const width = block.rows[0]?.length ?? 0
  block.rows.forEach((row, r) => {
    if (row.length !== width) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `table rows must all have ${width} cells (row ${r} has ${row.length})`,
        path: ['rows', r],
      })
    }
  })
}

const childPageBlockSchema: z.ZodType<ChildPageBlock> = z.object({
  kind: z.literal('child_page'),
  id: blockId,
  childPageId: z.string().min(1).max(128),
})

// `discriminatedUnion('kind')` — NOT a plain `z.union`. The discriminator
// routes a block to its one matching member by `kind` and reports THAT
// member's field-level issue (e.g. `to_do` → "checked: Required") instead of
// the union-wide, contentless "Invalid input" a `z.union` emits. That generic
// message is what left the chat model guessing and retrying `patchPage`
// blindly — the dominant driver of the 2026-06-04 doc token burst. Every
// member is a plain `z.object` (chart's xor/shape checks moved to
// `refineChartBlock`, applied below) because Zod refuses a `ZodEffects` as a
// discriminated-union option. The cast bridges the members' `z.ZodType<X>`
// annotations to the tuple `discriminatedUnion` expects; at runtime each is a
// real `ZodObject` with a `kind` literal, which is all Zod inspects.
const blockUnionMembers = [
  textBlockSchema,
  headingBlockSchema,
  dividerBlockSchema,
  dataBlockSchema,
  chartBlockBaseSchema,
  diagramBlockSchema,
  calloutBlockSchema,
  codeBlockSchema,
  quoteBlockSchema,
  bulletedListItemBlockSchema,
  numberedListItemBlockSchema,
  todoBlockSchema,
  toggleBlockSchema,
  tableBlockSchema,
  imageBlockSchema,
  fileBlockSchema,
  bookmarkBlockSchema,
  videoBlockSchema,
  audioBlockSchema,
  childPageBlockSchema,
  extractionSlotBlockSchema,
] as unknown as [
  z.ZodDiscriminatedUnionOption<'kind'>,
  ...z.ZodDiscriminatedUnionOption<'kind'>[],
]

/** Deepest container (toggle/callout) nesting under `block`, the block
 *  itself included. Non-containers are depth 0. */
function containerDepth(block: Block): number {
  if (block.kind !== 'toggle' && block.kind !== 'callout') return 0
  const children = block.children ?? []
  let deepest = 0
  for (const child of children) deepest = Math.max(deepest, containerDepth(child))
  return 1 + deepest
}

export const blockSchema: z.ZodType<Block> = z
  .discriminatedUnion('kind', blockUnionMembers)
  .superRefine((block, ctx) => {
    if ((block as { kind?: string }).kind === 'chart') {
      refineChartBlock(block as ChartBlock, ctx)
    }
    if ((block as { kind?: string }).kind === 'table') {
      refineTableBlock(block as TableBlock, ctx)
    }
    const kind = (block as { kind?: string }).kind
    if (
      (kind === 'toggle' || kind === 'callout') &&
      containerDepth(block as Block) > MAX_CONTAINER_DEPTH
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['children'],
        message: `container nesting exceeds ${MAX_CONTAINER_DEPTH} levels`,
      })
    }
  }) as unknown as z.ZodType<Block>

export const pageSchema: z.ZodType<Page> = z.object({
  blocks: z.array(blockSchema).max(1000), // wide bound — Notion pages exceed this
})

// ── Defaults / helpers ────────────────────────────────────────────────

/**
 * The empty page used when a new draft is created without seed content.
 * Tests + the create-draft route both depend on this shape.
 */
export const emptyPage: Page = { blocks: [] }

/**
 * Construct a one-block data page from a binding. Used by the
 * `renderView` chat tool when it creates a draft server-side so the
 * Notion editor opens with the requested view already present.
 */
export function dataPage(binding: BindingConfig, id: string): Page {
  return {
    blocks: [{ kind: 'data', id, binding }],
  }
}
