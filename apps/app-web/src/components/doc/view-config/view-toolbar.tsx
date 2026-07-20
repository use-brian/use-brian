"use client";

// [COMP:app-web/view-config-toolbar]
/**
 * Phase 3 — View toolbar container.
 *
 * Hosts the four view-config affordances (search, filter, sort, group,
 * properties) and renders them in a single row above the table. Each
 * affordance is stateless — `value` + `onChange` props — and this
 * container is itself stateless: it relays the surrounding view-state
 * down through the affordances unchanged.
 *
 * Used by `block-data.tsx` in Phase 4 — that wiring lands in a follow-up
 * batch (do not modify block-data.tsx here).
 */

import { Search } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import type { A2UIColumn } from "@use-brian/views-renderer";

import { FilterBar, type Filter } from "./filter-bar";
import { SortMenu, type Sort } from "./sort-menu";
import { GroupByMenu } from "./group-by-menu";
import { PropertyToggleMenu } from "./property-toggle-menu";

export type ViewToolbarValue = {
  search: string;
  filters: readonly Filter[];
  sort: Sort | null;
  groupBy: string | null;
  visibleProperties: readonly string[];
  order: readonly string[];
  /**
   * Notion-database persisted view-state carried alongside the toolbar's own
   * controls (the column header menu writes these; the toolbar passes them
   * through untouched). `columnWidths` is keyed by column `field`; `frozenCount`
   * is the number of sticky-left columns. Both round-trip to `binding.display`.
   */
  columnWidths: Readonly<Record<string, number>>;
  frozenCount: number;
};

export type ViewToolbarProps = {
  columns: readonly A2UIColumn[];
  value: ViewToolbarValue;
  onChange: (next: ViewToolbarValue) => void;
  className?: string;
};

export function ViewToolbar({
  columns,
  value,
  onChange,
  className,
}: ViewToolbarProps) {
  const t = useT().docPage.viewToolbar;

  const patch = (delta: Partial<ViewToolbarValue>) => {
    onChange({ ...value, ...delta });
  };

  return (
    <div
      data-component="view-toolbar"
      className={
        // Single non-wrapping row — the host (`embed-view`) reveals this
        // inline beside the table title via opacity, so it must keep a
        // constant height (no wrap → no reflow). No bottom border: the
        // table's own column-header rule provides the separation.
        "flex flex-nowrap items-center gap-2 " + (className ?? "")
      }
    >
      {/* Search */}
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          type="search"
          data-field="search"
          aria-label={t.searchAria}
          placeholder={t.searchPlaceholder}
          value={value.search}
          onChange={(e) => patch({ search: e.target.value })}
          className="h-7 w-44 rounded-md border border-border bg-background pl-7 pr-2 text-xs outline-none focus-visible:shadow-none"
        />
      </div>

      <FilterBar
        columns={columns}
        value={value.filters}
        onChange={(filters) => patch({ filters })}
      />

      <SortMenu
        columns={columns}
        value={value.sort}
        onChange={(sort) => patch({ sort })}
      />

      <GroupByMenu
        columns={columns}
        value={value.groupBy}
        onChange={(groupBy) => patch({ groupBy })}
      />

      <div className="ml-auto">
        <PropertyToggleMenu
          columns={columns}
          visibleProperties={value.visibleProperties}
          order={value.order}
          onChange={(visibleProperties, order) =>
            patch({ visibleProperties, order })
          }
        />
      </div>
    </div>
  );
}

/**
 * Default toolbar value derived from a column list — every column
 * visible, in declared order, no filters / sort / group. Callers can
 * `{ ...defaultViewToolbarValue(columns), sort: ... }` to seed state.
 */
export function defaultViewToolbarValue(
  columns: readonly A2UIColumn[],
): ViewToolbarValue {
  const fields = columns.map((c) => c.field);
  return {
    search: "",
    filters: [],
    sort: null,
    groupBy: null,
    visibleProperties: fields,
    order: fields,
    columnWidths: {},
    frozenCount: 1,
  };
}
