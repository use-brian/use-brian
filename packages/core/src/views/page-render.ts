/**
 * Page renderer — walks a Notion-style page of blocks and produces a
 * single A2UI v0.8 `ViewPayload` whose root is a column-direction
 * `ContainerWidget` holding one rendered child per block.
 *
 * Inline blocks (text / heading / divider) trivially become their A2UI
 * widget counterparts. `data` blocks call into the existing
 * `buildPayload(binding, deps)` and extract its `root` widget so the
 * resolved table / board appears in-place. `chart` blocks are wrapped
 * in a placeholder fallback until Phase 4 ships the chart resolvers.
 *
 * The page renderer is the read-side counterpart of `blocks.ts`: it
 * doesn't know about the DB, doesn't mutate anything, and is the only
 * route into A2UI from a `Page` value. The routes layer calls this on
 * every `GET /api/views/:id/payload`.
 *
 * [COMP:views/page-render]
 */

import type { Block, Page } from './blocks.js'
import type {
  A2UIWidget,
  BarChartWidget,
  ContainerWidget,
  DividerWidget,
  HeadingWidget,
  KpiWidget,
  LineChartWidget,
  PieChartWidget,
  TextWidget,
} from './a2ui.js'
import type { ViewPayload } from './a2ui.js'
import {
  resolveAggregation,
  type AggregateBinding,
  type AggregateResult,
  type AggregationDeps,
} from './aggregations.js'
import {
  chartDataIsRenderable,
  chartWidgetFromData,
  diagramWidgetFromBlock,
} from './block-widgets.js'
import { bindingCtx, buildPayload, type BindingDeps } from './bindings.js'

function renderTextBlock(block: Extract<Block, { kind: 'text' }>): TextWidget {
  return {
    type: 'text',
    text: block.text,
    ...(block.variant ? { variant: block.variant } : {}),
  }
}

function renderHeadingBlock(block: Extract<Block, { kind: 'heading' }>): HeadingWidget {
  return {
    type: 'heading',
    level: block.level,
    text: block.text,
  }
}

function renderDividerBlock(): DividerWidget {
  return { type: 'divider' }
}

async function renderDataBlock(
  block: Extract<Block, { kind: 'data' }>,
  deps: BindingDeps,
): Promise<A2UIWidget> {
  const payload = await buildPayload(block.binding, deps)
  return payload.root
}

/**
 * Resolve a chart block to its A2UI chart widget. Two sources:
 *
 *   - **Static** (`block.data`) — the model authored the values inline
 *     (e.g. research findings). Projected directly, no store call.
 *   - **Live** (`block.binding`) — an aggregation over workspace entities,
 *     run through `resolveAggregation` and projected on every read.
 *
 * On error (store throws, misconfigured binding) we fall back to a
 * muted text widget so the page payload remains a valid A2UI tree —
 * the editor and chat surface still render the rest of the page.
 */
async function renderChartBlock(
  block: Extract<Block, { kind: 'chart' }>,
  deps: BindingDeps,
): Promise<A2UIWidget> {
  // Static path — inline, model-authored values. No store call. Empty/absent
  // inline data (a chart shell authored before its points landed, or a legacy
  // row that predates the `refineChartBlock` guard) falls THROUGH to the
  // placeholder below rather than projecting a bare axes-only plot.
  if (block.data && chartDataIsRenderable(block.chartType, block.data)) {
    return chartWidgetFromData(block.chartType, block.data, block.title)
  }
  // Live path — resolve the aggregation binding against workspace entities.
  // No renderable inline data AND no binding → a muted placeholder, not a blank
  // chart (mirrors the editor's `EmptyDataStub`).
  if (!block.binding) {
    return {
      type: 'text',
      text: block.title
        ? `${block.title} — no chart data yet`
        : `[chart — no data yet]`,
      variant: 'muted',
    }
  }
  const binding = block.binding
  const aggregationDeps: AggregationDeps = {
    taskStore: deps.taskStore,
    crmStore: deps.crmStore,
    // Reuse the binding access context so the public-share render path's
    // pinned clearance:'public' flows into chart aggregations too (a chart
    // binding must not see more than a data-table binding on the same page).
    accessContext: bindingCtx(deps),
  }
  try {
    const result = await resolveAggregation(binding, aggregationDeps)
    return chartWidgetFromResult(block, binding, result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      type: 'text',
      text: `[chart error — ${block.chartType}: ${message}]`,
      variant: 'muted',
    }
  }
}

function chartWidgetFromResult(
  block: Extract<Block, { kind: 'chart' }>,
  binding: AggregateBinding,
  result: AggregateResult,
): A2UIWidget {
  switch (block.chartType) {
    case 'kpi': {
      const widget: KpiWidget = {
        type: 'kpi',
        label: block.title ?? binding.groupBy,
        value: result.total,
        format: 'integer',
      }
      return widget
    }
    case 'bar': {
      const widget: BarChartWidget = {
        type: 'chart_bar',
        ...(block.title ? { title: block.title } : {}),
        data: result.groups.map((g) => ({ label: g.label, value: g.value })),
      }
      return widget
    }
    case 'line': {
      const widget: LineChartWidget = {
        type: 'chart_line',
        ...(block.title ? { title: block.title } : {}),
        series: [
          {
            name: binding.measure ?? 'count',
            points: result.groups.map((g) => ({ x: g.label, y: g.value })),
          },
        ],
      }
      return widget
    }
    case 'pie': {
      const widget: PieChartWidget = {
        type: 'chart_pie',
        ...(block.title ? { title: block.title } : {}),
        slices: result.groups.map((g) => ({ label: g.label, value: g.value })),
      }
      return widget
    }
  }
}

/**
 * Render a single block to an A2UI widget. Exported for tests + the
 * chat-tool fast path (which renders one block to keep the inline
 * preview close to the old single-widget shape).
 */
export async function renderBlock(block: Block, deps: BindingDeps): Promise<A2UIWidget> {
  switch (block.kind) {
    case 'text':
      return renderTextBlock(block)
    case 'heading':
      return renderHeadingBlock(block)
    case 'divider':
      return renderDividerBlock()
    case 'data':
      return await renderDataBlock(block, deps)
    case 'chart':
      return await renderChartBlock(block, deps)
    case 'diagram':
      // Model-authored diagram — the mermaid source passes through to the
      // renderer verbatim (compiled to SVG client-side). No store call.
      return diagramWidgetFromBlock(block)
    case 'image':
    case 'file':
    case 'bookmark':
    case 'video':
    case 'audio':
    case 'callout':
    case 'code':
    case 'quote':
    case 'bulleted_list_item':
    case 'numbered_list_item':
    case 'to_do':
    case 'toggle':
    case 'table':
    case 'child_page':
      // Doc-native blocks have no A2UI widget mapping — chat-inline /
      // non-doc consumers show a muted placeholder; the full block UI
      // lives in app-web's block-*.tsx. Keeps the exhaustive switch total.
      return renderDocNativePlaceholder(block)
  }
}

/**
 * Stub renderer for media blocks. The full UI is in app-web's per-block
 * components (image / file / bookmark). For non-doc A2UI consumers we
 * emit a muted text widget so the page stays renderable.
 */
function renderDocNativePlaceholder(
  block: {
    kind:
      | 'image'
      | 'file'
      | 'bookmark'
      | 'video'
      | 'audio'
      | 'callout'
      | 'code'
      | 'quote'
      | 'bulleted_list_item'
      | 'numbered_list_item'
      | 'to_do'
      | 'toggle'
      | 'table'
      | 'child_page'
  } & Record<string, unknown>,
): A2UIWidget {
  return {
    type: 'text',
    text: `(${block.kind} — open in doc to view)`,
    variant: 'muted',
  }
}

/**
 * Render a whole page to a ViewPayload. The root is always a column
 * container so the front-end always knows where to insert / re-order /
 * trim block children. Empty pages render as an empty container.
 */
export async function renderPage(page: Page, deps: BindingDeps): Promise<ViewPayload> {
  const children: A2UIWidget[] = []
  for (const block of page.blocks) {
    children.push(await renderBlock(block, deps))
  }
  const root: ContainerWidget = {
    type: 'container',
    direction: 'column',
    children,
  }
  return { a2ui: '0.8', root }
}
