// [COMP:app-web/view-display]
/**
 * Pure conversions between the persisted `binding.display` (the durable
 * Notion-database view-state on a data block) and the live `ViewToolbarValue`
 * the toolbar + column header menu drive, plus a reducer that folds a renderer
 * `column-*` action into a new toolbar value.
 *
 * Kept dependency-light (no React, no network) so it unit-tests standalone and
 * so `embed-view.tsx` can seed from / persist to the block without inlining the
 * mapping. The two halves are each other's inverse for the fields they share
 * (widths / order / hidden / frozenCount / sort / filters); `search` and
 * `groupBy` are intentionally ephemeral (never persisted).
 */

import type { A2UIColumn } from "@sidanclaw/views-renderer";
import type { ViewDisplay } from "@/lib/api/views";
import type { ViewToolbarValue } from "./view-toolbar";
import type { Filter } from "./filter-bar";
import type { Sort } from "./sort-menu";

/** Default frozen-column count — the first column (the title), Notion-style. */
export const DEFAULT_FROZEN_COUNT = 1;

/**
 * Seed a live toolbar value from a block's persisted display state. New
 * columns (not in a saved order) append after the saved order; widths / hidden
 * / filter entries for columns that no longer exist are dropped.
 */
export function displayToToolbarValue(
  display: ViewDisplay | undefined,
  columns: readonly A2UIColumn[],
): ViewToolbarValue {
  const allFields = columns.map((c) => c.field);
  const known = new Set(allFields);
  const hidden = new Set((display?.hidden ?? []).filter((f) => known.has(f)));
  const visibleProperties = allFields.filter((f) => !hidden.has(f));
  const savedOrder = (display?.order ?? []).filter((f) => known.has(f));
  const order = [...savedOrder, ...allFields.filter((f) => !savedOrder.includes(f))];
  const sort: Sort | null = display?.sort
    ? { propertyName: display.sort.field, direction: display.sort.direction }
    : null;
  const filters: Filter[] = (display?.filters ?? [])
    .filter((f) => known.has(f.propertyName))
    .map((f) => ({ propertyName: f.propertyName, op: f.op, value: f.value }));
  const columnWidths: Record<string, number> = {};
  for (const [field, w] of Object.entries(display?.columnWidths ?? {})) {
    if (known.has(field) && typeof w === "number") columnWidths[field] = w;
  }
  return {
    search: "",
    filters,
    sort,
    groupBy: null,
    visibleProperties,
    order,
    columnWidths,
    frozenCount: display?.frozenCount ?? DEFAULT_FROZEN_COUNT,
  };
}

/**
 * Project a live toolbar value down to the durable display shape — dropping
 * the ephemeral `search` / `groupBy` and any default-valued field so a pristine
 * table persists an empty `{}` (and the data block stays clean).
 */
export function toolbarValueToDisplay(
  value: ViewToolbarValue,
  columns: readonly A2UIColumn[],
): ViewDisplay {
  const allFields = columns.map((c) => c.field);
  const known = new Set(allFields);
  const hidden = allFields.filter((f) => !value.visibleProperties.includes(f));
  const isDefaultOrder =
    value.order.length === allFields.length &&
    value.order.every((f, i) => allFields[i] === f);
  const widths: Record<string, number> = {};
  for (const [field, w] of Object.entries(value.columnWidths)) {
    if (known.has(field) && typeof w === "number") widths[field] = w;
  }
  const display: ViewDisplay = {};
  if (Object.keys(widths).length > 0) display.columnWidths = widths;
  if (!isDefaultOrder) display.order = [...value.order];
  if (hidden.length > 0) display.hidden = hidden;
  if (value.frozenCount !== DEFAULT_FROZEN_COUNT) display.frozenCount = value.frozenCount;
  if (value.sort) display.sort = { field: value.sort.propertyName, direction: value.sort.direction };
  if (value.filters.length > 0) {
    display.filters = value.filters.map((f) => ({
      propertyName: f.propertyName,
      op: f.op,
      value: f.value,
    }));
  }
  return display;
}

/**
 * Fold a renderer `column-*` display action into a new toolbar value. Returns
 * the same value (no-op) for unknown or schema-edit actions — those (rename /
 * retype / insert / duplicate / delete) are handled by the host's entity-tool
 * path, not by display state.
 */
export function reduceColumnOp(
  value: ViewToolbarValue,
  actionId: string,
  params: Record<string, unknown>,
): ViewToolbarValue {
  const field = typeof params.field === "string" ? params.field : null;
  switch (actionId) {
    case "column-resize": {
      if (!field) return value;
      const width = typeof params.width === "number" ? params.width : null;
      if (width == null) return value;
      return { ...value, columnWidths: { ...value.columnWidths, [field]: Math.round(width) } };
    }
    case "column-sort": {
      if (!field) return value;
      const dir = params.direction;
      if (dir === "asc" || dir === "desc") {
        return { ...value, sort: { propertyName: field, direction: dir } };
      }
      return { ...value, sort: null };
    }
    case "column-hide": {
      if (!field) return value;
      return {
        ...value,
        visibleProperties: value.visibleProperties.filter((f) => f !== field),
      };
    }
    case "column-freeze": {
      const n =
        typeof params.frozenCount === "number"
          ? Math.max(0, Math.floor(params.frozenCount))
          : value.frozenCount;
      return { ...value, frozenCount: n };
    }
    case "column-reorder": {
      const order = Array.isArray(params.order)
        ? params.order.filter((x): x is string => typeof x === "string")
        : null;
      if (!order || order.length === 0) return value;
      return { ...value, order };
    }
    default:
      return value;
  }
}
