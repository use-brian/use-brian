/**
 * Pure mappers from *model-authored* visual blocks to their A2UI widget.
 *
 * These are the **static** render paths — the block already carries the
 * values (a chart's inline `data`, a diagram's Mermaid `code`), so there is
 * no store call and no aggregation: the widget is a direct projection. The
 * renderer (`@use-brian/views-renderer`) consumes the result.
 *
 * Used by `page-render.ts` (the server payload path for `apps/web` / the
 * `GET /api/views/:id/payload` endpoint). The collaborative doc editor
 * holds its own byte-identical copy at
 * `apps/app-web/src/components/doc/block-visual.ts` (app-web does
 * not depend on `@use-brian/core`; the SDK types are duplicated there for the
 * same reason — see `apps/app-web/CLAUDE.md`). **Keep the two in sync.**
 *
 * The *live* chart path (an `AggregateBinding` resolved against workspace
 * entities) is NOT here — that runs through `resolveAggregation`
 * (`aggregations.ts`) in `page-render.ts`.
 *
 * Pure — no DB, no I/O, no React. Safe to import from server, client, tests.
 *
 * [COMP:views/block-widgets]
 */

import type {
  A2UIWidget,
  BarChartWidget,
  DiagramWidget,
  KpiWidget,
  LineChartWidget,
  PieChartWidget,
} from './a2ui.js'
import type { ChartData, ChartBlock, DiagramBlock } from './blocks.js'

/**
 * Does a chart block's inline `data` carry anything actually renderable?
 * bar/pie need ≥1 point, line needs ≥1 series with ≥1 point, kpi needs a
 * value. Absent or empty data → `false`, so the host paints a placeholder
 * (the editor's `EmptyDataStub`, the server's muted text widget) instead of a
 * bare axes-only plot that reads as broken — the 2026-06-10 "nothing here
 * except a heading" report, where a chart shell was authored before its points
 * landed. Pure; the app-web copy in `block-visual.ts` must match byte-for-byte.
 */
export function chartDataIsRenderable(
  chartType: ChartBlock['chartType'],
  data: ChartData | undefined,
): boolean {
  if (!data) return false
  switch (chartType) {
    case 'bar':
    case 'pie':
      return (data.points?.length ?? 0) > 0
    case 'line':
      return !!data.series && data.series.some((s) => (s.points?.length ?? 0) > 0)
    case 'kpi':
      return data.value !== undefined && data.value !== null
  }
}

/**
 * Project a chart block's inline `data` onto the matching A2UI chart
 * widget. Which `data` field is consulted is decided by `chartType`:
 * bar/pie read `points`, line reads `series`, kpi reads `value`. Missing
 * data degrades gracefully (an empty chart) rather than throwing — the
 * Zod schema is what rejects a malformed block at the tool boundary.
 */
export function chartWidgetFromData(
  chartType: ChartBlock['chartType'],
  data: ChartData,
  title?: string,
): A2UIWidget {
  switch (chartType) {
    case 'kpi': {
      const widget: KpiWidget = {
        type: 'kpi',
        label: title ?? '',
        value: data.value ?? 0,
        ...(data.delta !== undefined ? { delta: data.delta } : {}),
        ...(data.format ? { format: data.format } : {}),
        ...(data.currency ? { currency: data.currency } : {}),
      }
      return widget
    }
    case 'bar': {
      const widget: BarChartWidget = {
        type: 'chart_bar',
        ...(title ? { title } : {}),
        data: (data.points ?? []).map((p) => ({ label: p.label, value: p.value })),
        ...(data.orientation ? { orientation: data.orientation } : {}),
        ...(data.tone ? { tone: data.tone } : {}),
      }
      return widget
    }
    case 'pie': {
      const widget: PieChartWidget = {
        type: 'chart_pie',
        ...(title ? { title } : {}),
        slices: (data.points ?? []).map((p) => ({
          label: p.label,
          value: p.value,
          ...(p.color ? { color: p.color } : {}),
        })),
      }
      return widget
    }
    case 'line': {
      const widget: LineChartWidget = {
        type: 'chart_line',
        ...(title ? { title } : {}),
        series: data.series ?? [],
      }
      return widget
    }
  }
}

/** Project a diagram block onto its A2UI `DiagramWidget` (pass-through). */
export function diagramWidgetFromBlock(
  block: Pick<DiagramBlock, 'syntax' | 'code' | 'title'>,
): DiagramWidget {
  return {
    type: 'diagram',
    syntax: block.syntax,
    code: block.code,
    ...(block.title ? { title: block.title } : {}),
  }
}
