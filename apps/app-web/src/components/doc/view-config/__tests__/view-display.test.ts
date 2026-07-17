// [COMP:app-web/view-display]
/**
 * Unit tests for the pure `binding.display` <-> `ViewToolbarValue` conversions
 * and the `column-*` reducer that back the Notion-database view-state
 * persistence. No DOM, no network — just the mapping invariants.
 */

import { describe, expect, it } from "vitest";
import type { A2UIColumn } from "@use-brian/views-renderer";
import type { ViewDisplay } from "@/lib/api/views";
import {
  DEFAULT_FROZEN_COUNT,
  displayToToolbarValue,
  reduceColumnOp,
  toolbarValueToDisplay,
} from "../view-display";
import type { ViewToolbarValue } from "../view-toolbar";

const COLUMNS: A2UIColumn[] = [
  { field: "title", header: "Title" },
  { field: "status", header: "Status", kind: "select" },
  { field: "assignee", header: "Assignee", kind: "person" },
  { field: "due", header: "Due", kind: "date" },
];
const FIELDS = COLUMNS.map((c) => c.field);
const base = (): ViewToolbarValue => displayToToolbarValue(undefined, COLUMNS);

describe("[COMP:app-web/view-display] view display state", () => {
  describe("displayToToolbarValue", () => {
    it("seeds defaults from an absent display", () => {
      const v = displayToToolbarValue(undefined, COLUMNS);
      expect(v.visibleProperties).toEqual(FIELDS);
      expect(v.order).toEqual(FIELDS);
      expect(v.sort).toBeNull();
      expect(v.filters).toEqual([]);
      expect(v.columnWidths).toEqual({});
      expect(v.frozenCount).toBe(DEFAULT_FROZEN_COUNT);
    });

    it("maps a populated display", () => {
      const display: ViewDisplay = {
        columnWidths: { title: 320, status: 120 },
        order: ["status", "title", "assignee", "due"],
        hidden: ["due"],
        frozenCount: 2,
        sort: { field: "status", direction: "desc" },
        filters: [{ propertyName: "status", op: "is", value: "open" }],
      };
      const v = displayToToolbarValue(display, COLUMNS);
      expect(v.columnWidths).toEqual({ title: 320, status: 120 });
      expect(v.order).toEqual(["status", "title", "assignee", "due"]);
      expect(v.visibleProperties).toEqual(["title", "status", "assignee"]);
      expect(v.frozenCount).toBe(2);
      expect(v.sort).toEqual({ propertyName: "status", direction: "desc" });
      expect(v.filters).toEqual([{ propertyName: "status", op: "is", value: "open" }]);
    });

    it("drops state for columns that no longer exist and appends new columns", () => {
      const display: ViewDisplay = {
        columnWidths: { title: 200, ghost: 999 },
        order: ["status", "ghost", "title"],
        hidden: ["ghost"],
      };
      const v = displayToToolbarValue(display, COLUMNS);
      expect(v.columnWidths).toEqual({ title: 200 });
      // `ghost` dropped from order; `assignee` + `due` (absent from the saved
      // order) append at the end.
      expect(v.order).toEqual(["status", "title", "assignee", "due"]);
      // `ghost` dropped from hidden → every real column is visible.
      expect(v.visibleProperties).toEqual(FIELDS);
    });
  });

  describe("toolbarValueToDisplay", () => {
    it("persists nothing for a pristine value", () => {
      expect(toolbarValueToDisplay(base(), COLUMNS)).toEqual({});
    });

    it("persists only the non-default fields", () => {
      const v: ViewToolbarValue = {
        ...base(),
        columnWidths: { title: 280 },
        frozenCount: 2,
        sort: { propertyName: "due", direction: "asc" },
      };
      expect(toolbarValueToDisplay(v, COLUMNS)).toEqual({
        columnWidths: { title: 280 },
        frozenCount: 2,
        sort: { field: "due", direction: "asc" },
      });
    });

    it("persists hidden + reordered columns", () => {
      const v: ViewToolbarValue = {
        ...base(),
        visibleProperties: ["title", "status"],
        order: ["status", "title", "assignee", "due"],
      };
      const d = toolbarValueToDisplay(v, COLUMNS);
      expect(d.hidden).toEqual(["assignee", "due"]);
      expect(d.order).toEqual(["status", "title", "assignee", "due"]);
    });

    it("round-trips a populated display", () => {
      const display: ViewDisplay = {
        columnWidths: { title: 320 },
        hidden: ["due"],
        frozenCount: 2,
        sort: { field: "status", direction: "desc" },
        filters: [{ propertyName: "status", op: "is", value: "open" }],
      };
      const round = toolbarValueToDisplay(displayToToolbarValue(display, COLUMNS), COLUMNS);
      expect(round).toEqual(display);
    });
  });

  describe("reduceColumnOp", () => {
    it("column-resize records a rounded width", () => {
      const v = reduceColumnOp(base(), "column-resize", { field: "title", width: 251.6 });
      expect(v.columnWidths).toEqual({ title: 252 });
    });

    it("column-sort sets then clears the sort", () => {
      const sorted = reduceColumnOp(base(), "column-sort", { field: "due", direction: "asc" });
      expect(sorted.sort).toEqual({ propertyName: "due", direction: "asc" });
      const cleared = reduceColumnOp(sorted, "column-sort", { field: "due", direction: null });
      expect(cleared.sort).toBeNull();
    });

    it("column-hide removes the field from visibleProperties", () => {
      const v = reduceColumnOp(base(), "column-hide", { field: "status" });
      expect(v.visibleProperties).toEqual(["title", "assignee", "due"]);
    });

    it("column-freeze sets the frozen count", () => {
      const v = reduceColumnOp(base(), "column-freeze", { field: "status", frozenCount: 2 });
      expect(v.frozenCount).toBe(2);
    });

    it("column-reorder sets the order", () => {
      const order = ["due", "title", "status", "assignee"];
      const v = reduceColumnOp(base(), "column-reorder", { order });
      expect(v.order).toEqual(order);
    });

    it("is a no-op (same reference) for unknown actions and missing fields", () => {
      const b = base();
      // Schema-edit ops aren't display state — handled via entity tools.
      expect(reduceColumnOp(b, "column-rename", { field: "title" })).toBe(b);
      // A resize without a field can't be applied.
      expect(reduceColumnOp(b, "column-resize", { width: 100 })).toBe(b);
    });
  });
});
