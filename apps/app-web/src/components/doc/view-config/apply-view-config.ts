/**
 * Pure client-side transform that applies a `ViewToolbarValue` (search /
 * filter / sort / visible-properties) to a resolved A2UI `TableWidget`. Kept
 * dependency-light (no React, no network) so it unit-tests standalone and so
 * the data-embed node-view can pipe `renderBinding`'s payload through it
 * before handing the widget to `renderWidget`.
 *
 * Scope (v1):
 *   - **search** — case-insensitive substring over every cell's text form.
 *   - **filters** — per-operator predicate keyed by `Filter.op` (the same op
 *     ids the FilterBar's `OPERATORS_BY_KIND` catalogue produces).
 *   - **sort** — single-column asc/desc by the cell's comparable form.
 *   - **visibleProperties / order** — column projection + reorder.
 *   - **groupBy** — carried in the value but NOT transformed here: a flat
 *     table has no group rendering in the renderer (grouping is a Board
 *     concern), so the toolbar surfaces the control while the table stays
 *     flat. Documented so the no-op is intentional, not a gap.
 *
 * Only `table` widgets are transformed; any other root passes through
 * untouched (a board/kpi/chart embed shows its toolbar-less self).
 *
 * [COMP:app-web/apply-view-config]
 */

import type {
  A2UIRow,
  A2UIRowValue,
  A2UIWidget,
  TableWidget,
} from "@use-brian/views-renderer";
import type { ViewToolbarValue } from "./view-toolbar";
import type { Filter } from "./filter-bar";

/** Flatten a cell value to a comparable string for search / sort / text ops. */
function cellText(value: A2UIRowValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  // Nested widget — pull the most label-like field, else stringify.
  const w = value as Record<string, unknown>;
  if (typeof w.text === "string") return w.text;
  if (typeof w.name === "string") return w.name;
  if (typeof w.value === "string" || typeof w.value === "number") {
    return String(w.value);
  }
  if (typeof w.iso === "string") return w.iso;
  return "";
}

/** Numeric coercion for number operators; NaN when not comparable. */
function cellNumber(value: A2UIRowValue): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  const w = value as Record<string, unknown> | null;
  if (w && typeof w.value === "number") return w.value;
  return Number.NaN;
}

function matchesFilter(row: A2UIRow, filter: Filter): boolean {
  const raw = row[filter.propertyName] ?? null;
  const text = cellText(raw).toLowerCase();
  const v = filter.value;
  const vs = typeof v === "string" ? v.toLowerCase() : "";

  switch (filter.op) {
    // ── text-shaped ──
    case "contains":
      return text.includes(vs);
    case "equals":
      return text === vs;
    case "starts_with":
      return text.startsWith(vs);
    // ── number ──
    case "eq":
      return cellNumber(raw) === Number(v);
    case "neq":
      return cellNumber(raw) !== Number(v);
    case "gt":
      return cellNumber(raw) > Number(v);
    case "gte":
      return cellNumber(raw) >= Number(v);
    case "lt":
      return cellNumber(raw) < Number(v);
    case "lte":
      return cellNumber(raw) <= Number(v);
    // ── select / status / tags / person / relation ──
    case "is":
      return text === vs;
    case "is_not":
      return text !== vs;
    case "is_any_of":
      return Array.isArray(v)
        ? v.map((x) => String(x).toLowerCase()).includes(text)
        : false;
    // ── date (lexicographic on ISO is chronological) ──
    case "before":
      return text !== "" && text < vs;
    case "after":
      return text !== "" && text > vs;
    case "between": {
      if (!Array.isArray(v) || v.length < 2) return true;
      const [from, to] = v.map((x) => String(x).toLowerCase());
      return text >= from && text <= to;
    }
    // ── checkbox / files presence ──
    case "is_checked":
      return text === "true" || text === "1" || text === "yes";
    case "is_unchecked":
      return !(text === "true" || text === "1" || text === "yes");
    default:
      return true;
  }
}

export function applyViewConfig(
  widget: A2UIWidget,
  value: ViewToolbarValue,
  /** Marks the table's columns as user-editable (custom entity tables) so the
   *  renderer's column menu offers rename / retype / insert / delete. */
  editableColumns = false,
): A2UIWidget {
  if (widget.type !== "table") return widget;
  const table = widget as TableWidget;

  let rows = table.rows;

  // ── search ──
  const q = value.search.trim().toLowerCase();
  if (q) {
    rows = rows.filter((row) =>
      Object.values(row).some((v) => cellText(v).toLowerCase().includes(q)),
    );
  }

  // ── filters (AND across chips) ──
  if (value.filters.length > 0) {
    rows = rows.filter((row) =>
      value.filters.every((filter) => matchesFilter(row, filter)),
    );
  }

  // ── sort ──
  if (value.sort) {
    const { propertyName, direction } = value.sort;
    const dir = direction === "asc" ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      const av = cellText(a[propertyName] ?? null);
      const bv = cellText(b[propertyName] ?? null);
      const an = Number(av);
      const bn = Number(bv);
      const bothNumeric =
        av !== "" && bv !== "" && !Number.isNaN(an) && !Number.isNaN(bn);
      const cmp = bothNumeric ? an - bn : av.localeCompare(bv);
      return cmp * dir;
    });
  }

  // ── column projection + reorder ──
  const visibleSet = new Set(value.visibleProperties);
  const orderedFields = value.order.filter((f) => visibleSet.has(f));
  // Only reproject when the toolbar actually narrows / reorders; an
  // all-visible-in-declared-order value passes the columns through as-is.
  const isAllInOrder =
    orderedFields.length === table.columns.length &&
    orderedFields.every((f, i) => table.columns[i]?.field === f);

  const columns = isAllInOrder
    ? table.columns
    : orderedFields
        .map((f) => table.columns.find((c) => c.field === f))
        .filter((c): c is TableWidget["columns"][number] => c !== undefined);

  // ── persisted per-column widths ──
  // The renderer reads `col.width` as the initial TanStack size, so a saved
  // width rehydrates here. Only columns with a stored width are cloned.
  const widths = value.columnWidths;
  const sizedColumns =
    Object.keys(widths).length === 0
      ? columns
      : columns.map((c) =>
          typeof widths[c.field] === "number" ? { ...c, width: widths[c.field] } : c,
        );

  // Stamp the doc-database view-state onto the widget so the renderer can
  // paint the frozen columns + the active-sort arrow + (for custom tables) the
  // editable-column menu. The rows above are already projected/sorted, so the
  // renderer treats them as pre-sorted (it reads `sort` only for the indicator).
  return {
    ...table,
    columns: sizedColumns,
    rows,
    frozenColumnCount: value.frozenCount,
    sort: value.sort
      ? { field: value.sort.propertyName, direction: value.sort.direction }
      : null,
    ...(editableColumns ? { editableColumns: true } : {}),
  };
}
