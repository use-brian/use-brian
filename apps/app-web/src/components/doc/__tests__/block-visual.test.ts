/**
 * [COMP:app-web/block-visual] Static visual-block → A2UI widget mappers
 * (the app-web copy of `packages/core/src/views/block-widgets.ts`).
 */

import { describe, expect, it } from "vitest";
import {
  chartBlockToWidget,
  chartDataIsRenderable,
  chartWidgetFromData,
  diagramBlockToWidget,
} from "../block-visual";
import type { ChartBlock, DiagramBlock } from "@/lib/api/views";

describe("[COMP:app-web/block-visual] chartBlockToWidget", () => {
  it("returns null for a binding-only chart (live path not resolved in the editor yet)", () => {
    const block: ChartBlock = {
      kind: "chart",
      id: "c1",
      chartType: "bar",
      binding: { entity: "tasks", op: "count_by", groupBy: "status" },
    };
    expect(chartBlockToWidget(block)).toBeNull();
  });

  it("builds a chart_bar widget from inline data", () => {
    const block: ChartBlock = {
      kind: "chart",
      id: "c1",
      chartType: "bar",
      title: "X",
      data: { points: [{ label: "A", value: 2 }] },
    };
    expect(chartBlockToWidget(block)).toEqual({
      type: "chart_bar",
      title: "X",
      data: [{ label: "A", value: 2 }],
    });
  });

  it("returns null for a chart shell with empty points (renders the EmptyDataStub, not a blank plot)", () => {
    // The 2026-06-10 "nothing here except a heading" report: a chart authored
    // with a title but no data points must NOT project a bare axes-only plot.
    const block: ChartBlock = {
      kind: "chart",
      id: "c1",
      chartType: "bar",
      title: "Average Accounting/Audit Fees",
      data: { points: [] },
    };
    expect(chartBlockToWidget(block)).toBeNull();
  });

  it("returns null for a chart with no data and no binding", () => {
    const block = { kind: "chart", id: "c1", chartType: "pie" } as ChartBlock;
    expect(chartBlockToWidget(block)).toBeNull();
  });
});

describe("[COMP:app-web/block-visual] chartDataIsRenderable", () => {
  it("bar/pie need ≥1 point", () => {
    expect(chartDataIsRenderable("bar", { points: [{ label: "A", value: 1 }] })).toBe(true);
    expect(chartDataIsRenderable("bar", { points: [] })).toBe(false);
    expect(chartDataIsRenderable("pie", undefined)).toBe(false);
  });

  it("line needs ≥1 series carrying ≥1 point", () => {
    expect(
      chartDataIsRenderable("line", { series: [{ name: "r", points: [{ x: "Q1", y: 2 }] }] }),
    ).toBe(true);
    expect(chartDataIsRenderable("line", { series: [{ name: "r", points: [] }] })).toBe(false);
    expect(chartDataIsRenderable("line", { series: [] })).toBe(false);
  });

  it("kpi needs a value (0 counts, null/undefined does not)", () => {
    expect(chartDataIsRenderable("kpi", { value: 0 })).toBe(true);
    expect(chartDataIsRenderable("kpi", { value: undefined })).toBe(false);
    expect(chartDataIsRenderable("kpi", {})).toBe(false);
  });
});

describe("[COMP:app-web/block-visual] diagramBlockToWidget", () => {
  it("passes mermaid code through to a diagram widget", () => {
    const block: DiagramBlock = {
      kind: "diagram",
      id: "d1",
      syntax: "mermaid",
      code: "graph TD; A-->B",
      title: "Flow",
    };
    expect(diagramBlockToWidget(block)).toEqual({
      type: "diagram",
      syntax: "mermaid",
      code: "graph TD; A-->B",
      title: "Flow",
    });
  });
});

describe("[COMP:app-web/block-visual] core/app-web parity", () => {
  it("maps kpi inline value the same way the core copy does", () => {
    expect(chartWidgetFromData("kpi", { value: 9 }, "N")).toEqual({
      type: "kpi",
      label: "N",
      value: 9,
    });
  });
});
