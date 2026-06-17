/**
 * [COMP:app-web/apply-view-config] applyViewConfig — client-side
 * search / filter / sort / property projection over a resolved table widget.
 */

import { describe, expect, it } from "vitest";
import type { A2UIColumn, TableWidget } from "@sidanclaw/views-renderer";
import { applyViewConfig } from "../apply-view-config";
import { defaultViewToolbarValue, type ViewToolbarValue } from "../view-toolbar";

const COLUMNS: A2UIColumn[] = [
  { field: "title", header: "Title", kind: "text" },
  { field: "status", header: "Status", kind: "status" },
  { field: "amount", header: "Amount", kind: "number" },
];

const TABLE: TableWidget = {
  type: "table",
  columns: COLUMNS,
  rows: [
    { title: "Alpha", status: "open", amount: 30 },
    { title: "Beta", status: "done", amount: 10 },
    { title: "Gamma", status: "open", amount: 20 },
  ],
};

function value(overrides: Partial<ViewToolbarValue>): ViewToolbarValue {
  return { ...defaultViewToolbarValue(COLUMNS), ...overrides };
}

function rows(w: ReturnType<typeof applyViewConfig>): Record<string, unknown>[] {
  return (w as TableWidget).rows;
}

describe("[COMP:app-web/apply-view-config] applyViewConfig", () => {
  it("passes a non-table widget through untouched", () => {
    const board = { type: "board", groupBy: "status", columns: [], cards: [] } as never;
    expect(applyViewConfig(board, defaultViewToolbarValue(COLUMNS))).toBe(board);
  });

  it("default value is a no-op (same columns, same rows)", () => {
    const out = applyViewConfig(TABLE, defaultViewToolbarValue(COLUMNS));
    expect((out as TableWidget).columns).toBe(TABLE.columns);
    expect(rows(out)).toHaveLength(3);
  });

  it("search filters rows by a case-insensitive substring over any cell", () => {
    const out = applyViewConfig(TABLE, value({ search: "alp" }));
    expect(rows(out).map((r) => r.title)).toEqual(["Alpha"]);
  });

  it("text filter `is` matches an exact status", () => {
    const out = applyViewConfig(
      TABLE,
      value({ filters: [{ propertyName: "status", op: "is", value: "open" }] }),
    );
    expect(rows(out).map((r) => r.title)).toEqual(["Alpha", "Gamma"]);
  });

  it("number filter `gt` keeps rows above the threshold", () => {
    const out = applyViewConfig(
      TABLE,
      value({ filters: [{ propertyName: "amount", op: "gt", value: 15 }] }),
    );
    expect(rows(out).map((r) => r.title)).toEqual(["Alpha", "Gamma"]);
  });

  it("multiple filters AND together", () => {
    const out = applyViewConfig(
      TABLE,
      value({
        filters: [
          { propertyName: "status", op: "is", value: "open" },
          { propertyName: "amount", op: "lt", value: 25 },
        ],
      }),
    );
    expect(rows(out).map((r) => r.title)).toEqual(["Gamma"]);
  });

  it("sort by a numeric column ascending / descending", () => {
    const asc = applyViewConfig(
      TABLE,
      value({ sort: { propertyName: "amount", direction: "asc" } }),
    );
    expect(rows(asc).map((r) => r.amount)).toEqual([10, 20, 30]);
    const desc = applyViewConfig(
      TABLE,
      value({ sort: { propertyName: "amount", direction: "desc" } }),
    );
    expect(rows(desc).map((r) => r.amount)).toEqual([30, 20, 10]);
  });

  it("sort by a text column uses locale compare", () => {
    const out = applyViewConfig(
      TABLE,
      value({ sort: { propertyName: "title", direction: "desc" } }),
    );
    expect(rows(out).map((r) => r.title)).toEqual(["Gamma", "Beta", "Alpha"]);
  });

  it("hiding + reordering properties reprojects the columns", () => {
    const out = applyViewConfig(
      TABLE,
      value({ visibleProperties: ["amount", "title"], order: ["amount", "title", "status"] }),
    );
    expect((out as TableWidget).columns.map((c) => c.field)).toEqual([
      "amount",
      "title",
    ]);
    // Rows are untouched by a pure projection (renderer ignores extra keys).
    expect(rows(out)).toHaveLength(3);
  });

  it("search + filter + sort compose", () => {
    const out = applyViewConfig(
      TABLE,
      value({
        search: "a", // Alpha + Gamma + Beta all contain 'a'
        filters: [{ propertyName: "status", op: "is", value: "open" }],
        sort: { propertyName: "amount", direction: "desc" },
      }),
    );
    expect(rows(out).map((r) => r.title)).toEqual(["Alpha", "Gamma"]);
  });

  // ── Notion-database view-state (widths + stamped chrome) ──

  it("applies persisted column widths onto the matching columns", () => {
    const out = applyViewConfig(
      TABLE,
      value({ columnWidths: { title: 320, amount: 90 } }),
    ) as TableWidget;
    const byField = new Map(out.columns.map((c) => [c.field, c.width]));
    expect(byField.get("title")).toBe(320);
    expect(byField.get("amount")).toBe(90);
    expect(byField.get("status")).toBeUndefined();
  });

  it("stamps frozen count + sort + editableColumns onto the widget", () => {
    const out = applyViewConfig(
      TABLE,
      value({ frozenCount: 2, sort: { propertyName: "amount", direction: "desc" } }),
      true,
    ) as TableWidget;
    expect(out.frozenColumnCount).toBe(2);
    expect(out.sort).toEqual({ field: "amount", direction: "desc" });
    expect(out.editableColumns).toBe(true);
  });

  it("omits editableColumns by default (built-in tables stay non-editable)", () => {
    const out = applyViewConfig(TABLE, defaultViewToolbarValue(COLUMNS)) as TableWidget;
    expect(out.editableColumns).toBeUndefined();
    expect(out.frozenColumnCount).toBe(1);
    expect(out.sort).toBeNull();
  });
});
