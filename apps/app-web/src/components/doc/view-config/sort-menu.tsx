"use client";

// [COMP:app-web/view-config-sort-menu]
/**
 * Phase 3 — Sort menu.
 *
 * Single-column sort affordance. The trigger button shows the current
 * sort ("Sort by Title ↓") or a placeholder ("Sort"). Clicking opens a
 * popover with a property picker + asc/desc toggle + clear.
 *
 * Stateless wrt the larger app — `value` is the current sort (or null
 * for unsorted), and `onChange(next)` fires when the user commits a
 * change.
 *
 * The popover is the project `Popover` primitive (base-ui Positioner), so it
 * flips and clamps inside a 360px viewport (responsive contract M5; report B
 * row 35), and the property picker is the project `Select` (never a native
 * `<select>`; report B row 54).
 */

import { useCallback, useMemo, useState } from "react";
import { ArrowDownNarrowWide, ArrowUpNarrowWide } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/lib/i18n/client";
import type { A2UIColumn } from "@use-brian/views-renderer";

/** The "No sort" row's value (`Select` treats `null` as no value, so the
 *  explicit clear row needs a real string). */
const NO_SORT = "__none__";

export type SortDirection = "asc" | "desc";

export type Sort = {
  propertyName: string;
  direction: SortDirection;
};

export type SortMenuProps = {
  columns: readonly A2UIColumn[];
  value: Sort | null;
  onChange: (next: Sort | null) => void;
  className?: string;
};

export function SortMenu({ columns, value, onChange, className }: SortMenuProps) {
  const t = useT().docPage.viewToolbar;
  const [open, setOpen] = useState(false);

  const currentCol = value ? columns.find((c) => c.field === value.propertyName) : null;
  const buttonLabel = value && currentCol
    ? `${currentCol.header} ${value.direction === "asc" ? "↑" : "↓"}`
    : t.sortButton;

  const propertyItems = useMemo(
    () =>
      ({
        [NO_SORT]: t.sortEmpty,
        ...Object.fromEntries(columns.map((c) => [c.field, c.header])),
      }) as Record<string, string>,
    [columns, t.sortEmpty],
  );

  const handlePropertyChange = (next: unknown) => {
    const propertyName = typeof next === "string" ? next : "";
    if (!propertyName || propertyName === NO_SORT) {
      onChange(null);
      return;
    }
    onChange({ propertyName, direction: value?.direction ?? "asc" });
  };

  const handleDirection = useCallback(
    (direction: SortDirection) => {
      if (!value) {
        const first = columns[0];
        if (!first) return;
        onChange({ propertyName: first.field, direction });
      } else {
        onChange({ ...value, direction });
      }
    },
    [columns, onChange, value],
  );

  const handleClear = () => {
    onChange(null);
    setOpen(false);
  };

  return (
    <div className={"relative " + (className ?? "")}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              data-action="open-sort"
              aria-label={t.sortButtonAria}
              aria-haspopup="dialog"
              aria-expanded={open}
              className={
                "inline-flex h-9 items-center gap-1 rounded-md border border-border px-2 text-xs md:h-7 " +
                (value
                  ? "bg-muted text-foreground"
                  : "bg-background text-muted-foreground hover:bg-muted hover:text-foreground")
              }
            >
              {value?.direction === "desc" ? (
                <ArrowDownNarrowWide className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <ArrowUpNarrowWide className="h-3.5 w-3.5" aria-hidden />
              )}
              <span>{buttonLabel}</span>
            </button>
          }
        />
        <PopoverContent
          align="start"
          role="dialog"
          aria-label={t.sortButton}
          data-popover="sort"
          className="w-[min(18rem,calc(100vw-1rem))] p-3 text-sm"
        >
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t.sortPickProperty}
              </span>
              <Select
                value={value?.propertyName ?? NO_SORT}
                items={propertyItems}
                onValueChange={handlePropertyChange}
              >
                <SelectTrigger
                  data-field="property"
                  aria-label={t.sortPickProperty}
                  className="h-11 w-full md:h-8"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start">
                  <SelectItem value={NO_SORT}>{t.sortEmpty}</SelectItem>
                  {columns.map((c) => (
                    <SelectItem key={c.field} value={c.field}>
                      {c.header}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-1.5">
              <button
                type="button"
                data-action="set-asc"
                aria-pressed={value?.direction === "asc"}
                onClick={() => handleDirection("asc")}
                className={
                  "inline-flex h-9 flex-1 items-center justify-center gap-1 rounded-md border px-2 text-xs md:h-7 " +
                  (value?.direction === "asc"
                    ? "border-interaction/35 bg-interaction/10 text-foreground"
                    : "border-border bg-background text-muted-foreground hover:bg-muted")
                }
              >
                <ArrowUpNarrowWide className="h-3.5 w-3.5" aria-hidden />
                <span>{t.sortAsc}</span>
              </button>
              <button
                type="button"
                data-action="set-desc"
                aria-pressed={value?.direction === "desc"}
                onClick={() => handleDirection("desc")}
                className={
                  "inline-flex h-9 flex-1 items-center justify-center gap-1 rounded-md border px-2 text-xs md:h-7 " +
                  (value?.direction === "desc"
                    ? "border-interaction/35 bg-interaction/10 text-foreground"
                    : "border-border bg-background text-muted-foreground hover:bg-muted")
                }
              >
                <ArrowDownNarrowWide className="h-3.5 w-3.5" aria-hidden />
                <span>{t.sortDesc}</span>
              </button>
            </div>
            {value ? (
              <button
                type="button"
                data-action="clear-sort"
                onClick={handleClear}
                className="mt-1 h-9 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground md:h-7"
              >
                {t.sortClear}
              </button>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
