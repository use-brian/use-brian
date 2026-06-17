/**
 * [COMP:app-web/block-data] BlockData write-back helpers.
 *
 * vitest in app-web is node-only — no jsdom, no
 * @testing-library/react. The `onAction` handler in `block-data.tsx`
 * depends on React state + `useWorkspaceContext` + network helpers, so
 * it can't be unit-mounted here. Instead we assert the pure,
 * side-effect-free pieces the handler is built from — the same approach
 * `sortable-block-list.test.tsx` takes with `computeReorder`:
 *
 *   - `boardEntity`     — infers the entity from a board's groupBy axis
 *                         (move-card has no other entity hint).
 *   - `translateCommit` — maps the move-card group value onto the PATCH
 *                         allowlist (status / stage).
 *   - `applyOverrides`  — the optimistic layer: row-delete drops a row,
 *                         cell-update / move-card patch a field in place.
 *
 * The wiring around these (confirm dialog, optimistic state, refetch
 * trigger, error alert) is exercised manually / e2e per the
 * component-map row.
 */

import { describe, expect, it } from "vitest";
import {
  boardEntity,
  translateCommit,
  applyOverrides,
} from "../block-data";
import type { A2UIWidget, TableWidget } from "@sidanclaw/views-renderer";

const EMPTY = new Set<string>();

describe("[COMP:app-web/block-data] boardEntity", () => {
  it("maps the status axis to tasks", () => {
    expect(boardEntity("status")).toBe("tasks");
  });

  it("maps the stage axis to deals", () => {
    expect(boardEntity("stage")).toBe("deals");
  });

  it("returns null for an unrecognised axis", () => {
    expect(boardEntity("priority")).toBeNull();
  });
});

describe("[COMP:app-web/block-data] translateCommit (move-card group field)", () => {
  it("passes a status string through for a tasks board drop", () => {
    expect(translateCommit("status", "in_progress")).toEqual({
      status: "in_progress",
    });
  });

  it("passes a stage string through for a deals board drop", () => {
    expect(translateCommit("stage", "won")).toEqual({ stage: "won" });
  });

  it("unwraps a badge value to its text for a status field", () => {
    expect(
      translateCommit("status", { type: "badge", text: "done", tone: "success" }),
    ).toEqual({ status: "done" });
  });
});

describe("[COMP:app-web/block-data] applyOverrides", () => {
  const table: TableWidget = {
    type: "table",
    columns: [
      { field: "title", header: "Title" },
      { field: "status", header: "Status" },
    ],
    rows: [
      { id: "t1", title: "Alpha", status: "todo" },
      { id: "t2", title: "Bravo", status: "todo" },
      { id: "t3", title: "Charlie", status: "todo" },
    ],
  };

  it("returns the widget unchanged when there are no overrides or deletions", () => {
    expect(applyOverrides(table, {}, EMPTY)).toBe(table);
  });

  it("drops an optimistically deleted row", () => {
    const next = applyOverrides(table, {}, new Set(["t2"])) as TableWidget;
    expect(next.rows.map((r) => r.id)).toEqual(["t1", "t3"]);
  });

  it("patches a field in place for a cell-update / move-card override", () => {
    const next = applyOverrides(
      table,
      { t1: { status: "done" } },
      EMPTY,
    ) as TableWidget;
    const row = next.rows.find((r) => r.id === "t1");
    expect(row?.status).toBe("done");
    // Untouched rows pass through.
    expect(next.rows.find((r) => r.id === "t2")?.status).toBe("todo");
  });

  it("applies a delete and an override together", () => {
    const next = applyOverrides(
      table,
      { t3: { title: "Gamma" } },
      new Set(["t1"]),
    ) as TableWidget;
    expect(next.rows.map((r) => r.id)).toEqual(["t2", "t3"]);
    expect(next.rows.find((r) => r.id === "t3")?.title).toBe("Gamma");
  });

  it("leaves a non-table widget untouched", () => {
    const board: A2UIWidget = {
      type: "board",
      groupBy: "status",
      columns: [],
      cardSchema: { type: "text", text: "{{title}}", variant: "body" },
    };
    expect(applyOverrides(board, {}, new Set(["x"]))).toBe(board);
  });
});
