/**
 * A2UI v0.8 envelope — the wire format used by Q5 Views to carry a
 * structured UI description from server bindings to the React renderer.
 *
 * Spec: https://a2ui.org / https://github.com/google/A2UI (v0.8 stable
 * Public Preview at the time of writing). v0.9 is still draft.
 *
 * Design notes:
 *   * Q5 v1 implements a *subset* of the v0.8 widget catalog — Container,
 *     Heading, Text, Badge, Button, Image, Table, Board. Anything else
 *     renders via the renderer's <Fallback /> widget (soft fail, no throw).
 *   * The `a2ui: '0.8'` literal is a load-bearing version pin. Detection
 *     happens at validation time; mismatched payloads (e.g. a v0.9 payload
 *     mistakenly served) are rejected by the Zod schema before render.
 *   * Server-side bindings (packages/core/src/views/bindings.ts) produce
 *     these payloads. The renderer (packages/views-renderer) consumes them.
 *     Both ends share this contract; if a future Flutter / RN renderer
 *     ships, it consumes the same shape.
 *   * `Action.id` is a host-defined string (e.g. 'move-card', 'open-entity').
 *     The host's `onAction(id, params)` callback decides what to do; the
 *     renderer is action-agnostic.
 *
 * See docs/architecture/features/views.md → "A2UI v0.8 conformance" for
 * the full deviation list and the version-pin policy.
 */

import { z } from 'zod'

// ── Action ────────────────────────────────────────────────────────────

export type ActionRef = {
  id: string
  params?: Record<string, unknown>
}

export const actionRefSchema: z.ZodType<ActionRef> = z.object({
  id: z.string().min(1).max(128),
  params: z.record(z.unknown()).optional(),
})

// ── Primitive widgets ─────────────────────────────────────────────────

export type ContainerWidget = {
  type: 'container'
  direction: 'column' | 'row'
  children: A2UIWidget[]
}

export type HeadingWidget = {
  type: 'heading'
  level: 1 | 2 | 3 | 4
  text: string
}

export type TextWidget = {
  type: 'text'
  text: string
  variant?: 'body' | 'muted' | 'caption'
}

export type BadgeWidget = {
  type: 'badge'
  text: string
  tone?: 'default' | 'success' | 'warning' | 'danger'
}

export type ButtonWidget = {
  type: 'button'
  text: string
  action: ActionRef
}

export type ImageWidget = {
  type: 'image'
  src: string
  alt: string
}

/**
 * A horizontal-rule widget. No data — the renderer emits a thin
 * `<hr>` with neutral tailwind styling. Block-page redesign uses this
 * for `DividerBlock`; existing chat payloads never emit it.
 */
export type DividerWidget = {
  type: 'divider'
}

// ── Property-typed widgets (Phase 1 — Notion-feel) ────────────────────
//
// These widgets carry both render data and (in Phase 2) the affordance
// hooks for inline edit. They are the cell-level partner of `A2UIColumn.kind`:
// the column declares the kind; the cell value is the typed widget.

/**
 * A workspace member reference. Server pre-resolves
 * `workspace_members.id` → name/avatar in `bindings.ts` so the renderer
 * never holds a directory. Empty cells emit `null`, not a person with
 * blank fields.
 */
export type PersonWidget = {
  type: 'person'
  id: string
  name: string
  avatarUrl?: string
  /** 1–2 character fallback when avatarUrl is absent. */
  initials?: string
}

/**
 * A reference to another brain entity (company, contact, deal, task).
 * Server pre-resolves the label.
 */
export type RelationWidget = {
  type: 'relation'
  entityType: 'company' | 'contact' | 'deal' | 'task'
  id: string
  label: string
}

/**
 * A date cell. The widget exists even when the underlying value is null
 * so the column-kind dispatcher in the renderer can still pick the date
 * cell (placeholder dash, calendar icon) and — in Phase 2 — the date
 * editor popover.
 */
export type DateWidget = {
  type: 'date'
  iso: string | null
  /** Display style. Default 'relative' (e.g. "in 2 days"). */
  format?: 'relative' | 'absolute' | 'datetime'
}

/**
 * A numeric cell. As with DateWidget, value can be null while the widget
 * still ships so the column-kind dispatcher can render an empty-state
 * placeholder.
 */
export type NumberWidget = {
  type: 'number'
  value: number | null
  /** Default 'plain'. */
  format?: 'plain' | 'currency' | 'percent' | 'integer'
  /** ISO 4217 code, only consulted when format is 'currency'. */
  currency?: string
}

/**
 * A status cell — Notion-style grouped enum. `optionId` is the stable id
 * of one option inside one of the three groups (`pending` /
 * `in_progress` / `done`). The server pre-resolves the `groupId` + the
 * human-facing `label` so the renderer can tint the pill without
 * holding the schema. Empty cells emit `optionId: null` (the widget
 * itself is still shipped so the column-kind dispatcher can render the
 * empty-state placeholder).
 *
 * Mirrors the `PropertyKind = 'status'` entry in
 * `packages/core/src/entities/doc-types.ts` — that file owns the
 * schema-side `StatusGroup` shape; this widget is the wire-level
 * partner.
 */
export type StatusWidget = {
  type: 'status'
  optionId: string | null
  /** Server-resolved group bucket. Drives the Cell tone. */
  groupId?: 'pending' | 'in_progress' | 'done'
  /** Server-resolved option label. Falls back to optionId. */
  label?: string
}

/**
 * One file reference inside a `FilesWidget`. Mirrors the shape carried by
 * `CellValue.kind = 'files'` in `packages/core/src/entities/doc-types.ts`
 * — the per-instance JSONB shape and the wire-level partner share the
 * same fields so server bindings round-trip without coercion.
 *
 * `bucket` is the GCS bucket name; `path` is the object key inside that
 * bucket. The renderer uses `mimeType` to decide whether the file is a
 * candidate cover image, and `sizeBytes` + `name` are displayed in the
 * file-pill cell.
 */
export type FileRef = {
  bucket: string
  path: string
  mimeType: string
  sizeBytes: number
  name: string
}

/**
 * A file attachment cell — one or more `FileRef`s. Empty list is a valid
 * empty state (renders as a drop affordance in the Editor and an em-dash
 * in the Cell). Server bindings emit this for `PropertyKind = 'files'`
 * columns; the Gallery view also consumes it via `getCoverImageRef()` to
 * pick a card cover image.
 */
export type FilesWidget = {
  type: 'files'
  files: FileRef[]
}

// ── Chart widgets (Phase 4 — Infographics) ────────────────────────────
//
// Server-side aggregation collapses brain rows into the small,
// renderer-ready shapes below. The renderer never reaches back into
// the brain — it consumes the resolved widget. Every chart accepts a
// title that the host renders at heading-3 weight above the chart
// surface (Recharts has no built-in title slot we want to lean on).

/**
 * A "big number" tile — the KPI surface above a chart row. Value is
 * either a pre-formatted string or a raw number paired with the
 * `format` hint (so the renderer can pick the right decimal /
 * currency / percent treatment). `delta` is optional and the host
 * picks an up/down arrow tone via `deltaTone`.
 */
export type KpiWidget = {
  type: 'kpi'
  label: string
  value: number | string
  /** Period-over-period change. Raw number, not a percentage. */
  delta?: number
  /** Default 'neutral'. */
  deltaTone?: 'positive' | 'negative' | 'neutral'
  /** Default 'plain'. */
  format?: 'plain' | 'currency' | 'percent' | 'integer'
  /** ISO 4217 code, only consulted when format is 'currency'. */
  currency?: string
}

/**
 * A bar chart — one bar per `data[]` point. Vertical orientation is
 * the default (the most common case for status counts). Tone tints
 * the bar fill to match the rest of the design system.
 */
export type BarChartWidget = {
  type: 'chart_bar'
  /** Optional title rendered above the chart at heading-3 weight. */
  title?: string
  data: { label: string; value: number }[]
  /** Default 'vertical' (bars rise from the x-axis). */
  orientation?: 'vertical' | 'horizontal'
  /** Default 'default'. Maps to chart palette in the renderer. */
  tone?: 'default' | 'success' | 'warning' | 'danger'
}

/**
 * A line chart — one line per `series[]` entry. `x` values are
 * commonly date strings; the renderer treats them as categories
 * (no time-axis math). Multi-series charts emit a legend.
 */
export type LineChartWidget = {
  type: 'chart_line'
  /** Optional title rendered above the chart at heading-3 weight. */
  title?: string
  series: {
    name: string
    points: { x: string | number; y: number }[]
  }[]
  xAxisLabel?: string
  yAxisLabel?: string
}

/**
 * A pie chart — one slice per `slices[]` entry. `color` is optional
 * (the renderer cycles through a palette of design-system tokens
 * when absent).
 */
export type PieChartWidget = {
  type: 'chart_pie'
  /** Optional title rendered above the chart at heading-3 weight. */
  title?: string
  slices: { label: string; value: number; color?: string }[]
}

/**
 * A diagram — a node-link / flow graph the renderer compiles to SVG from
 * a diagram-as-code source. v1 carries Mermaid (`graph TD`,
 * `sequenceDiagram`, `erDiagram`, `mindmap`, `classDiagram`, …); the
 * `views-renderer` `Diagram` widget lazy-loads mermaid and renders the
 * SVG client-side (`securityLevel: 'strict'`). The host renders `title`
 * at heading-3 weight above the diagram. Unlike the chart widgets, the
 * source is opaque to the server — it is passed through verbatim and only
 * compiled in the browser.
 */
export type DiagramWidget = {
  type: 'diagram'
  /** Diagram grammar. v1: Mermaid only. */
  syntax: 'mermaid'
  /** The diagram source compiled to SVG by the renderer. */
  code: string
  /** Optional title rendered above the diagram at heading-3 weight. */
  title?: string
}

// ── Table widget ──────────────────────────────────────────────────────

/**
 * Column-level property-type hint. Drives:
 *   * which property module the renderer dispatches through
 *     (`packages/views-renderer/src/properties/<kind>.tsx`)
 *   * the icon glyph in the column header
 *   * sort behavior on header click
 *   * (Phase 2) inline edit affordance
 *
 * Omitted/undefined falls through to legacy `renderRowValue` (text-ish).
 */
export type PropertyKind =
  | 'text'
  | 'select'
  | 'tags'
  | 'person'
  | 'relation'
  | 'date'
  | 'number'
  | 'status'
  | 'files'
  | 'checkbox'
  | 'url'
  | 'email'
  | 'phone'
  | 'created_time'
  | 'created_by'
  | 'last_edited_time'
  | 'last_edited_by'

/** One option in a `status` group on a column (mirrors the renderer's
 *  `StatusGroupHint` so the inline editor can render grouped choices). */
export type ColumnStatusGroup = {
  id: 'pending' | 'in_progress' | 'done'
  label: string
  options: { id: string; name: string; color?: string }[]
}

export type A2UIColumn = {
  field: string
  header: string
  /** Optional pixel width hint for the renderer. */
  width?: number
  /** Property-type hint — see PropertyKind. */
  kind?: PropertyKind
  /**
   * Marks this column as the cover-image source for Gallery view (P3F).
   * The Gallery picks the first column with `cover: true`, or falls back
   * to the first `kind: 'files'` column. `coverColumnId` on `GalleryWidget`
   * overrides both. Has no effect on Table/Board rendering.
   */
  cover?: boolean
  /**
   * Inline-editor choice lists. `options` is the allowed-value list for a
   * `select` / `multi_select` cell editor; `statusGroups` is the grouped
   * option schema for a `status` editor. The server (`buildPayload`) emits
   * these from the entity's property schema so the renderer's inline
   * dropdowns render the option popover. Absent → the editor degrades
   * (select → free-text input; status → read-only / not inline-editable).
   */
  options?: string[]
  statusGroups?: ColumnStatusGroup[]
}

/**
 * A row is a record keyed by `column.field` → renderable value. Values can
 * be primitives (string/number/null) or nested widgets (e.g. a Badge for a
 * status column, an Image for an avatar). The renderer walks the value:
 * primitive → render as text, widget → recurse.
 */
export type A2UIRow = Record<string, A2UIRowValue>

export type A2UIRowValue = string | number | null | A2UIWidget

export type TableWidget = {
  type: 'table'
  columns: A2UIColumn[]
  rows: A2UIRow[]
  /** Action fired on row click. Receives `{ rowId }` in params. */
  rowAction?: ActionRef
  /**
   * Notion-database view-state (doc surface). All optional + backward
   * compatible — chat-inline tables (apps/web) omit them and keep the legacy
   * local-sort behavior. The doc host stamps these from the data block's
   * persisted `binding.display` (see `views/types.ts` → ViewDisplay) so the
   * renderer paints frozen columns, the active-sort indicator, and the
   * editable-column menu without re-fetching.
   *
   * Freeze the first N columns (sticky left). Default 1 (the host's
   * `freezeFirstColumn`). 0 disables freezing.
   */
  frozenColumnCount?: number
  /**
   * Host-controlled active sort. When present, the renderer treats `rows` as
   * already sorted by the host and routes header-menu sort changes through
   * `onAction('column-sort', { field, direction })` instead of sorting
   * locally. `null` = explicitly unsorted.
   */
  sort?: { field: string; direction: 'asc' | 'desc' } | null
  /**
   * When true, the column header menu offers schema edits (rename / retype /
   * insert / delete) — only user-defined entity tables set this; built-in
   * entity tables (frozen column set) leave it false/undefined.
   */
  editableColumns?: boolean
}

// ── List widget (P3E — doc-v1) ─────────────────────────────────────
//
// Notion-feel List view (see `docs/research/notion/databases-and-views.md`
// §2.5): a single tall stack of compact one-line rows. The first
// `columns[]` entry is the title (primary, left-aligned, medium font
// weight, truncated). The rest render right-aligned as secondary
// "pills" in muted color. No column headers, no inline edit — opening
// the row (via `rowAction`) is the edit surface.
//
// Reuses the same `A2UIRow + A2UIColumn` shape as Table so saved views
// can switch between Table and List without re-shaping the payload —
// the renderer reads the same data; the difference is presentational.

export type ListWidget = {
  type: 'list'
  columns: A2UIColumn[]
  rows: A2UIRow[]
  /** Action fired on row click. Receives `{ rowId }` in params. */
  rowAction?: ActionRef
  /** Localized "no rows" copy. Default 'No rows.'. */
  emptyMessage?: string
}

// ── Board widget ──────────────────────────────────────────────────────

export type A2UIBoardColumn = {
  /** Column id — must match the value of `groupBy` field on each card. */
  id: string
  /** Display title at the top of the column. */
  title: string
  /** Cards in this column, in display order. */
  cards: A2UIBoardCard[]
}

export type A2UIBoardCard = {
  /** Stable id used by the host's drop handler (`{ cardId, fromCol, toCol }`). */
  id: string
  /** Per-card data dict; the renderer walks `cardSchema` to render. */
  data: Record<string, A2UIRowValue>
}

export type BoardWidget = {
  type: 'board'
  /** Field on each card whose value determines column membership. */
  groupBy: string
  columns: A2UIBoardColumn[]
  /** Schema rendered for each card. The card's `data` keys are referenced. */
  cardSchema: A2UIWidget
}

// ── Gallery widget (P3F) ──────────────────────────────────────────────
//
// Card-grid surface for Files-heavy entities (assets, deal collateral,
// inbound attachments). Reuses Table's `rows + columns` shape so a
// saved-view can flip between Table and Gallery without re-shaping the
// payload — the renderer reads the same data; the difference is
// purely presentational.
//
// Cover-image resolution: server can either tag a column with
// `cover: true`, or the renderer falls back to the first column with
// `kind: 'files'`. `coverColumnId` overrides both for ad-hoc payloads.
// The cell at the cover column is passed through `getCoverImageRef`
// (shared with the Files property's Cell) to pick the first image-mime
// `FileRef`; non-image / empty cells render the placeholder gradient.
//
// Card body: first column is the title (medium font weight, 2-line
// truncate); remaining columns render as secondary muted lines below
// the title in column order. The host caps body rendering at three
// secondary fields to keep cards visually consistent — extra columns
// are silently dropped from card chrome (still available via the
// underlying row data when the host opens the entity).

export type GalleryWidget = {
  type: 'gallery'
  /** Rows — same shape as TableWidget.rows; each is one card. */
  rows: A2UIRow[]
  /**
   * Columns — first is rendered as the card title. Columns flagged
   * `cover: true` (or matched by `coverColumnId`) supply the cover image
   * via `getCoverImageRef`. Remaining columns appear as secondary fields.
   */
  columns: A2UIColumn[]
  /**
   * Explicit override for which column supplies the cover image. Wins
   * over `column.cover === true`. Useful when a row has multiple
   * `files` columns and the server picks one.
   */
  coverColumnId?: string
  /** Action fired on card click. Receives `{ rowId }` in params. */
  rowAction?: ActionRef
  /** Localized "no rows" copy. Default 'No items.'. */
  emptyMessage?: string
}

// ── Calendar widget (P3G) ─────────────────────────────────────────────
//
// Month-grid surface for date-driven entities (events, scheduled jobs,
// task due dates, RSVPs). Reuses Table's `rows + columns` shape so a
// saved-view can flip between Table, Board, Gallery, and Calendar
// without re-shaping the payload — the renderer reads the same data;
// the difference is purely presentational.
//
// Date resolution: server points `dateColumnId` at the column that
// carries the row's date. The renderer accepts the cell as a
// `DateWidget` (`{ type: 'date', iso, format }`) or as a plain ISO
// string — the same coercion the Date property module uses. Rows whose
// resolved date falls outside the visible month (or week) are simply
// not placed; rows with null/unparseable dates are dropped from the
// grid.
//
// v1 is all-day only — no time-of-day grid. Week view is a 7-column
// strip of the week containing the navigated cursor; month view is a
// 7×(5–6) Mon-first grid spanning the month plus the leading/trailing
// days needed to fill the grid corners.

export type CalendarWidget = {
  type: 'calendar'
  /** Rows — same shape as TableWidget.rows; each is one event/item. */
  rows: A2UIRow[]
  /** Includes a date column (column.kind === 'date'). */
  columns: A2UIColumn[]
  /** Which `column.field` carries the row's date. */
  dateColumnId: string
  /** Action fired on row-chip click. Receives `{ rowId }` in params. */
  rowAction?: ActionRef
  /** Localized "no items in this range" copy. Default 'No items.'. */
  emptyMessage?: string
  /** Default 'month'. */
  initialView?: 'month' | 'week'
}

// ── Timeline widget (P3H) ─────────────────────────────────────────────
//
// Gantt-style horizontal-bar surface for date-range entities (projects,
// campaigns, sprints, deal close windows). Reuses Table's `rows +
// columns` shape so a saved-view can flip between Table, Board, Gallery,
// Calendar, and Timeline without re-shaping the payload — the renderer
// reads the same data; the difference is purely presentational.
//
// Date resolution: server points `startColumnId` and `endColumnId` at
// the two columns carrying each row's range. The renderer accepts cell
// values either as `DateWidget` (`{ type: 'date', iso, format }`) or as
// plain ISO strings — the same coercion the Date property module uses.
// Rows with null/unparseable dates render the row label but no bar.
//
// Zoom: `day` / `week` / `month` / `quarter`. Defaults to `week`. The
// renderer's zoom bar lets the user switch interactively; saved-view
// persistence of the user's last zoom is a follow-up. The visible
// window is derived from "today" + zoom (see `defaultRange` in the
// renderer) — a date-picker control to scroll the window is a Phase 4
// polish item.

export type TimelineWidget = {
  type: 'timeline'
  /** Rows — same shape as TableWidget.rows; each is one bar. */
  rows: A2UIRow[]
  /** Includes the start + end date columns (`column.kind === 'date'`). */
  columns: A2UIColumn[]
  /** Which `column.field` carries each row's start date. */
  startColumnId: string
  /** Which `column.field` carries each row's end date. */
  endColumnId: string
  /** Action fired on bar click. Receives `{ rowId }` in params. */
  rowAction?: ActionRef
  /** Localized "nothing to plot" copy. Default 'No items to plot.'. */
  emptyMessage?: string
  /** Default 'week'. */
  zoomLevel?: 'day' | 'week' | 'month' | 'quarter'
}

// ── Discriminated union ───────────────────────────────────────────────

export type A2UIWidget =
  | ContainerWidget
  | HeadingWidget
  | TextWidget
  | BadgeWidget
  | ButtonWidget
  | ImageWidget
  | DividerWidget
  | PersonWidget
  | RelationWidget
  | DateWidget
  | NumberWidget
  | StatusWidget
  | FilesWidget
  | TableWidget
  | ListWidget
  | BoardWidget
  | GalleryWidget
  | CalendarWidget
  | TimelineWidget
  | KpiWidget
  | BarChartWidget
  | LineChartWidget
  | PieChartWidget
  | DiagramWidget

export type ViewPayload = {
  /** Version pin. Drift detection at the schema boundary. */
  a2ui: '0.8'
  root: A2UIWidget
}

// ── Zod schemas ───────────────────────────────────────────────────────
//
// Recursive: TableWidget rows + BoardCard data can carry nested widgets,
// and BoardWidget.cardSchema is itself a widget. We declare schemas in
// dependency order; the recursive points inline `z.lazy(() => a2uiWidgetSchema)`
// so the forward reference resolves at parse time, not module-load time.
//
// The final `as unknown as z.ZodType<A2UIWidget>` cast is necessary because
// the structural type of `z.union(...)` doesn't satisfy the hand-written
// `A2UIWidget` discriminated union shape; runtime behavior is correct and
// is verified by the schema tests.

const propertyKindSchema = z.enum([
  'text',
  'select',
  'tags',
  'person',
  'relation',
  'date',
  'number',
  'status',
  'files',
  'checkbox',
  'url',
  'email',
  'phone',
  'created_time',
  'created_by',
  'last_edited_time',
  'last_edited_by',
])

const columnStatusGroupSchema = z.object({
  id: z.enum(['pending', 'in_progress', 'done']),
  label: z.string().min(0).max(128),
  options: z.array(
    z.object({
      id: z.string().min(1).max(128),
      name: z.string().min(0).max(128),
      color: z.string().max(64).optional(),
    }),
  ),
})

const columnSchema = z.object({
  field: z.string().min(1).max(128),
  header: z.string().min(0).max(256),
  width: z.number().int().positive().optional(),
  kind: propertyKindSchema.optional(),
  cover: z.boolean().optional(),
  /** Inline-editor choice lists (P-inline-edit): `select`/`multi_select`
   *  allowed values; `status` grouped options. Absent → the cell's editor
   *  falls back (select → free text; status → not inline-editable). */
  options: z.array(z.string().max(256)).optional(),
  statusGroups: z.array(columnStatusGroupSchema).optional(),
})

const headingSchema = z.object({
  type: z.literal('heading'),
  level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  text: z.string().min(0).max(256),
})

const textSchema = z.object({
  type: z.literal('text'),
  text: z.string().min(0).max(2048),
  variant: z.enum(['body', 'muted', 'caption']).optional(),
})

const badgeSchema = z.object({
  type: z.literal('badge'),
  text: z.string().min(0).max(128),
  tone: z.enum(['default', 'success', 'warning', 'danger']).optional(),
})

const buttonSchema = z.object({
  type: z.literal('button'),
  text: z.string().min(1).max(128),
  action: actionRefSchema,
})

const imageSchema = z.object({
  type: z.literal('image'),
  src: z.string().min(1).max(2048),
  alt: z.string().min(0).max(256),
})

const dividerSchema = z.object({
  type: z.literal('divider'),
})

const personSchema = z.object({
  type: z.literal('person'),
  id: z.string().min(1).max(128),
  name: z.string().min(0).max(256),
  avatarUrl: z.string().min(1).max(2048).optional(),
  initials: z.string().min(0).max(2).optional(),
})

const relationSchema = z.object({
  type: z.literal('relation'),
  entityType: z.enum(['company', 'contact', 'deal', 'task']),
  id: z.string().min(1).max(128),
  label: z.string().min(0).max(256),
})

const dateSchema = z.object({
  type: z.literal('date'),
  iso: z.string().min(1).max(64).nullable(),
  format: z.enum(['relative', 'absolute', 'datetime']).optional(),
})

const numberSchema = z.object({
  type: z.literal('number'),
  value: z.number().finite().nullable(),
  format: z.enum(['plain', 'currency', 'percent', 'integer']).optional(),
  currency: z.string().min(3).max(3).optional(),
})

const statusSchema = z.object({
  type: z.literal('status'),
  optionId: z.string().min(1).max(128).nullable(),
  groupId: z.enum(['pending', 'in_progress', 'done']).optional(),
  label: z.string().min(0).max(128).optional(),
})

const fileRefSchema = z.object({
  bucket: z.string().min(1).max(256),
  path: z.string().min(1).max(1024),
  mimeType: z.string().min(1).max(256),
  sizeBytes: z.number().int().nonnegative(),
  name: z.string().min(1).max(512),
})

const filesSchema = z.object({
  type: z.literal('files'),
  files: z.array(fileRefSchema).max(50),
})

// ── Chart widget schemas (Phase 4) ───────────────────────────────────

const kpiSchema = z.object({
  type: z.literal('kpi'),
  label: z.string().min(0).max(256),
  value: z.union([z.number().finite(), z.string().min(0).max(128)]),
  delta: z.number().finite().optional(),
  deltaTone: z.enum(['positive', 'negative', 'neutral']).optional(),
  format: z.enum(['plain', 'currency', 'percent', 'integer']).optional(),
  currency: z.string().min(3).max(3).optional(),
})

const barChartPointSchema = z.object({
  label: z.string().min(0).max(128),
  value: z.number().finite(),
})

const barChartSchema = z.object({
  type: z.literal('chart_bar'),
  title: z.string().min(0).max(256).optional(),
  data: z.array(barChartPointSchema).max(500),
  orientation: z.enum(['vertical', 'horizontal']).optional(),
  tone: z.enum(['default', 'success', 'warning', 'danger']).optional(),
})

const lineChartPointSchema = z.object({
  x: z.union([z.string().min(0).max(128), z.number().finite()]),
  y: z.number().finite(),
})

const lineChartSeriesSchema = z.object({
  name: z.string().min(0).max(128),
  points: z.array(lineChartPointSchema).max(2000),
})

const lineChartSchema = z.object({
  type: z.literal('chart_line'),
  title: z.string().min(0).max(256).optional(),
  series: z.array(lineChartSeriesSchema).max(20),
  xAxisLabel: z.string().min(0).max(128).optional(),
  yAxisLabel: z.string().min(0).max(128).optional(),
})

const pieChartSliceSchema = z.object({
  label: z.string().min(0).max(128),
  value: z.number().finite(),
  color: z.string().min(1).max(64).optional(),
})

const pieChartSchema = z.object({
  type: z.literal('chart_pie'),
  title: z.string().min(0).max(256).optional(),
  slices: z.array(pieChartSliceSchema).max(200),
})

const diagramSchema = z.object({
  type: z.literal('diagram'),
  syntax: z.literal('mermaid'),
  code: z.string().min(1).max(20000),
  title: z.string().min(0).max(256).optional(),
})

// Forward-declared lazy schema reference. Bound below — branches that carry
// nested widgets close over this name, deferring resolution to parse time.
const widgetLazy: z.ZodType<A2UIWidget> = z.lazy(() => a2uiWidgetSchema)

const rowValueSchema: z.ZodType<A2UIRowValue> = z.union([
  z.string(),
  z.number(),
  z.null(),
  widgetLazy,
])

const containerSchema = z.object({
  type: z.literal('container'),
  direction: z.enum(['column', 'row']),
  children: z.array(widgetLazy),
})

const tableSortSchema = z.object({
  field: z.string().min(1).max(128),
  direction: z.enum(['asc', 'desc']),
})

const tableSchema = z.object({
  type: z.literal('table'),
  columns: z.array(columnSchema),
  rows: z.array(z.record(rowValueSchema)),
  rowAction: actionRefSchema.optional(),
  // Notion-database view-state (doc surface). Optional — see TableWidget.
  frozenColumnCount: z.number().int().nonnegative().max(50).optional(),
  sort: tableSortSchema.nullable().optional(),
  editableColumns: z.boolean().optional(),
})

const listSchema = z.object({
  type: z.literal('list'),
  columns: z.array(columnSchema),
  rows: z.array(z.record(rowValueSchema)),
  rowAction: actionRefSchema.optional(),
  emptyMessage: z.string().min(0).max(256).optional(),
})

const boardCardSchema = z.object({
  id: z.string().min(1),
  data: z.record(rowValueSchema),
})

const boardColumnSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(0).max(128),
  cards: z.array(boardCardSchema),
})

const boardSchema = z.object({
  type: z.literal('board'),
  groupBy: z.string().min(1),
  columns: z.array(boardColumnSchema),
  cardSchema: widgetLazy,
})

const gallerySchema = z.object({
  type: z.literal('gallery'),
  rows: z.array(z.record(rowValueSchema)),
  columns: z.array(columnSchema),
  coverColumnId: z.string().min(1).max(128).optional(),
  rowAction: actionRefSchema.optional(),
  emptyMessage: z.string().min(0).max(256).optional(),
})

const calendarSchema = z.object({
  type: z.literal('calendar'),
  rows: z.array(z.record(rowValueSchema)),
  columns: z.array(columnSchema),
  dateColumnId: z.string().min(1).max(128),
  rowAction: actionRefSchema.optional(),
  emptyMessage: z.string().min(0).max(256).optional(),
  initialView: z.enum(['month', 'week']).optional(),
})

const timelineSchema = z.object({
  type: z.literal('timeline'),
  rows: z.array(z.record(rowValueSchema)),
  columns: z.array(columnSchema),
  startColumnId: z.string().min(1).max(128),
  endColumnId: z.string().min(1).max(128),
  rowAction: actionRefSchema.optional(),
  emptyMessage: z.string().min(0).max(256).optional(),
  zoomLevel: z.enum(['day', 'week', 'month', 'quarter']).optional(),
})

export const a2uiWidgetSchema = z.union([
  containerSchema,
  headingSchema,
  textSchema,
  badgeSchema,
  buttonSchema,
  imageSchema,
  dividerSchema,
  personSchema,
  relationSchema,
  dateSchema,
  numberSchema,
  statusSchema,
  filesSchema,
  tableSchema,
  listSchema,
  boardSchema,
  gallerySchema,
  calendarSchema,
  timelineSchema,
  kpiSchema,
  barChartSchema,
  lineChartSchema,
  pieChartSchema,
  diagramSchema,
]) as unknown as z.ZodType<A2UIWidget>

export const viewPayloadSchema: z.ZodType<ViewPayload> = z.object({
  a2ui: z.literal('0.8'),
  root: a2uiWidgetSchema,
})
