/**
 * Q5 Views — public exports.
 *
 * See docs/architecture/features/views.md for the feature spec and
 * docs/plans/company-brain.md §16.
 */

export {
  // A2UI v0.8 envelope
  type ActionRef,
  type ContainerWidget,
  type HeadingWidget,
  type TextWidget,
  type BadgeWidget,
  type ButtonWidget,
  type ImageWidget,
  type DividerWidget,
  type TableWidget,
  type ListWidget,
  type BoardWidget,
  type GalleryWidget,
  type CalendarWidget,
  type TimelineWidget,
  // Chart widgets (Phase 4 — Infographics)
  type KpiWidget,
  type BarChartWidget,
  type LineChartWidget,
  type PieChartWidget,
  // Diagram widget (model-authored node-link / flow graph)
  type DiagramWidget,
  type A2UIWidget,
  type A2UIColumn,
  type A2UIRow,
  type A2UIRowValue,
  type A2UIBoardCard,
  type A2UIBoardColumn,
  type ViewPayload,
  // Schemas
  actionRefSchema,
  viewPayloadSchema,
  a2uiWidgetSchema,
} from './a2ui.js'

export {
  // Page-block model (Notion redesign)
  type Block,
  type Page,
  type TextBlock,
  type HeadingBlock,
  type DividerBlock,
  type DataBlock,
  type ChartBlock,
  type ChartData,
  type DiagramBlock,
  // Schemas
  blockSchema,
  pageSchema,
  // Helpers
  emptyPage,
  dataPage,
} from './blocks.js'

export {
  // Static visual-block → A2UI widget mappers (model-authored path)
  chartWidgetFromData,
  diagramWidgetFromBlock,
} from './block-widgets.js'

export {
  renderBlock,
  renderPage,
} from './page-render.js'

export {
  // Enums
  VIEW_ENTITIES,
  VIEW_TYPES,
  VIEW_STATES,
  TASK_COLUMN_IDS,
  CONTACT_COLUMN_IDS,
  COMPANY_COLUMN_IDS,
  DEAL_COLUMN_IDS,
  WORKFLOW_RUN_COLUMN_IDS,
  // Types
  type ViewEntity,
  type ViewType,
  type ViewState,
  type NameOrigin,
  NAME_ORIGINS,
  type TaskColumnId,
  type ContactColumnId,
  type CompanyColumnId,
  type DealColumnId,
  type WorkflowRunColumnId,
  // BindingConfig discriminated union
  type BindingConfig,
  type TasksTableBinding,
  type TasksBoardBinding,
  type TasksCalendarBinding,
  type ContactsTableBinding,
  type CompaniesTableBinding,
  type DealsTableBinding,
  type DealsBoardBinding,
  type WorkflowRunsTableBinding,
  // SavedView records / store
  type SavedView,
  type SavedViewListRow,
  type SavedViewListFilters,
  type SavedViewUpdateFields,
  type SavedViewStore,
  type CreateDraftInput,
  type PageWriteActor,
} from './types.js'

export {
  bindingConfigSchema,
  viewEntitySchema,
  viewTypeSchema,
  savedViewCreateInputSchema,
  savedViewUpdateInputSchema,
} from './schemas.js'

export {
  buildPayload,
  bindingCtx,
  buildPublicAccessContext,
  PUBLIC_SHARE_PRINCIPAL,
  type BindingDeps,
} from './bindings.js'

export {
  neutralizeBlocksForPublic,
  neutralizePublicPayload,
} from './public-sanitize.js'

export {
  // Aggregations (Phase 4 — Infographics)
  resolveAggregation,
  countBy,
  sumBy,
  avgBy,
  seriesByDate,
  aggregateBindingSchema,
  type AggregateBinding,
  type AggregateEntity,
  type AggregateOp,
  type AggregateResult,
  type AggregateGroup,
  type AggregationDeps,
  type DateBucket,
} from './aggregations.js'

export {
  createViewTools,
  createRenderViewTool,
  createRenderChartTool,
  createSaveViewTool,
  type ViewToolDeps,
  type ViewToolEvent,
  type ViewToolEventContext,
} from './tools.js'
