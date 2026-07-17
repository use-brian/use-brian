/**
 * Public types for @use-brian/views-renderer.
 *
 * The A2UI v0.8 envelope types are owned by @use-brian/core (so server
 * bindings + renderer share one contract). This file re-exports them and
 * adds renderer-host-facing types like `OnActionHandler`.
 */

// Import directly from views/a2ui (not the core barrel) so client
// bundles don't transitively pull in `skills/loader` and its `fs`
// dependency. Type-only imports are erased at compile time, but
// turbopack still resolves the source module when bundling — so the
// import path matters for what ends up in the bundle.
export type {
  ActionRef,
  A2UIWidget,
  A2UIColumn,
  A2UIRow,
  A2UIRowValue,
  A2UIBoardCard,
  A2UIBoardColumn,
  ContainerWidget,
  HeadingWidget,
  TextWidget,
  BadgeWidget,
  ButtonWidget,
  ImageWidget,
  PersonWidget,
  RelationWidget,
  DateWidget,
  NumberWidget,
  StatusWidget,
  FileRef,
  FilesWidget,
  PropertyKind,
  TableWidget,
  ListWidget,
  BoardWidget,
  GalleryWidget,
  CalendarWidget,
  TimelineWidget,
  KpiWidget,
  BarChartWidget,
  LineChartWidget,
  PieChartWidget,
  DiagramWidget,
  ViewPayload,
} from '@use-brian/core/dist/views/a2ui.js'

/**
 * Host-supplied action callback. Fired by Button widgets, Table row
 * clicks, and Board card drops. Action ids are host-defined; the
 * renderer is action-agnostic.
 */
export type OnActionHandler = (actionId: string, params?: Record<string, unknown>) => void

/**
 * Localized copy for the Notion-database column / row menus. The pure renderer
 * has no i18n; the doc host (`apps/app-web`) builds this from its
 * dictionary and passes it via `renderWidget`'s `opts.tableLabels`. Every
 * field is required so a host can't half-localize the menu — the renderer
 * ships English defaults for any host that enables the menu without copy.
 */
export type ColumnMenuLabels = {
  sortAsc: string
  sortDesc: string
  clearSort: string
  filter: string
  hide: string
  freeze: string
  unfreeze: string
  rename: string
  editType: string
  insertLeft: string
  insertRight: string
  duplicateColumn: string
  deleteColumn: string
  duplicateRow: string
  deleteRow: string
  openRow: string
}

/**
 * Per-render host options threaded through `renderWidget` to the Table widget.
 * Lets the doc host enable the database chrome + supply localized menu copy
 * without polluting the A2UI payload with UI strings. Omitted → legacy table
 * (no menu), so apps/web's read-only inline tables are unaffected.
 */
export type RenderWidgetOpts = {
  /** Turn on the Notion-database column menu / resize-persist / reorder /
   *  frozen-N / row numbers. */
  enableColumnMenu?: boolean
  /** Localized menu copy. */
  tableLabels?: Partial<ColumnMenuLabels>
}

export type ViewRendererProps = {
  /** A2UI v0.8 payload. Already-validated payloads can pass `validated: true` to skip re-validation. */
  payload: unknown
  /** Optional host action handler. Buttons / row clicks / board drops dispatch through this. */
  onAction?: OnActionHandler
  /** Skip Zod re-validation. Use only when the payload was just validated upstream. */
  validated?: boolean
  /** Optional className applied to the outermost wrapper div. */
  className?: string
}
