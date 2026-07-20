/**
 * Pure mappers from *model-authored* visual blocks to their A2UI widget —
 * the client copy of `packages/core/src/views/block-widgets.ts`.
 *
 * app-web does not depend on `@use-brian/core` (the core barrel pulls in
 * `skills/loader` + `fs`, which breaks client bundles — the same reason the
 * `views` SDK is duplicated here), so this small, stable mapper is duplicated
 * rather than imported. **Keep it byte-for-byte in sync with the core copy.**
 *
 * Only the *static* sources are mapped here: a chart's inline `data` and a
 * diagram's Mermaid `code`. A chart's *live* `binding` (an entity aggregation)
 * is resolved server-side and is NOT handled in the collab editor yet —
 * `chartBlockToWidget` returns `null` for a binding-only chart so the embed
 * shows its stub instead of mis-resolving.
 *
 * [COMP:app-web/block-visual]
 */

import type {
  A2UIWidget,
  BarChartWidget,
  DiagramWidget,
  KpiWidget,
  LineChartWidget,
  PieChartWidget,
} from "@use-brian/views-renderer";
import type { ChartBlock, ChartData, DiagramBlock } from "@/lib/api/views";

/**
 * Does a chart block's inline `data` carry anything actually renderable?
 * bar/pie need ≥1 point, line needs ≥1 series with ≥1 point, kpi needs a
 * value. Absent or empty data → `false`, so `chartBlockToWidget` returns null
 * and the embed shows its `EmptyDataStub` placeholder instead of a bare
 * axes-only plot (the 2026-06-10 "nothing here except a heading" report, where
 * a chart shell was authored before its points landed). Pure; must match the
 * core copy in `packages/core/src/views/block-widgets.ts` byte-for-byte.
 */
export function chartDataIsRenderable(
  chartType: ChartBlock["chartType"],
  data: ChartData | undefined,
): boolean {
  if (!data) return false;
  switch (chartType) {
    case "bar":
    case "pie":
      return (data.points?.length ?? 0) > 0;
    case "line":
      return !!data.series && data.series.some((s) => (s.points?.length ?? 0) > 0);
    case "kpi":
      return data.value !== undefined && data.value !== null;
  }
}

/** Project a chart block's inline `data` onto its A2UI chart widget. */
export function chartWidgetFromData(
  chartType: ChartBlock["chartType"],
  data: ChartData,
  title?: string,
): A2UIWidget {
  switch (chartType) {
    case "kpi": {
      const widget: KpiWidget = {
        type: "kpi",
        label: title ?? "",
        value: data.value ?? 0,
        ...(data.delta !== undefined ? { delta: data.delta } : {}),
        ...(data.format ? { format: data.format } : {}),
        ...(data.currency ? { currency: data.currency } : {}),
      };
      return widget;
    }
    case "bar": {
      const widget: BarChartWidget = {
        type: "chart_bar",
        ...(title ? { title } : {}),
        data: (data.points ?? []).map((p) => ({ label: p.label, value: p.value })),
        ...(data.orientation ? { orientation: data.orientation } : {}),
        ...(data.tone ? { tone: data.tone } : {}),
      };
      return widget;
    }
    case "pie": {
      const widget: PieChartWidget = {
        type: "chart_pie",
        ...(title ? { title } : {}),
        slices: (data.points ?? []).map((p) => ({
          label: p.label,
          value: p.value,
          ...(p.color ? { color: p.color } : {}),
        })),
      };
      return widget;
    }
    case "line": {
      const widget: LineChartWidget = {
        type: "chart_line",
        ...(title ? { title } : {}),
        series: data.series ?? [],
      };
      return widget;
    }
  }
}

/**
 * Build the chart widget for a chart block, or `null` when there's nothing to
 * render statically — a binding-only chart (live path not resolved in the
 * editor yet) OR a chart whose inline `data` is absent / empty
 * (`chartDataIsRenderable`). Either way the embed shows its `EmptyDataStub`.
 */
export function chartBlockToWidget(block: ChartBlock): A2UIWidget | null {
  if (!chartDataIsRenderable(block.chartType, block.data)) return null;
  return chartWidgetFromData(block.chartType, block.data!, block.title);
}

/** Project a diagram block onto its A2UI `DiagramWidget`. */
export function diagramBlockToWidget(block: DiagramBlock): DiagramWidget {
  return {
    type: "diagram",
    syntax: block.syntax,
    code: block.code,
    ...(block.title ? { title: block.title } : {}),
  };
}
