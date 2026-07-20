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
 * Popover is a plain absolutely-positioned div + outside-click handler
 * — matches the FilterBar / slash-menu pattern in this app.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { ArrowDownNarrowWide, ArrowUpNarrowWide } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import type { A2UIColumn } from "@use-brian/views-renderer";

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
  const ref = useRef<HTMLDivElement | null>(null);

  // Outside click → close
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (typeof document !== "undefined") {
      document.addEventListener("mousedown", onDocClick);
      return () => document.removeEventListener("mousedown", onDocClick);
    }
    return undefined;
  }, [open]);

  // Esc → close
  useEffect(() => {
    if (!open) return;
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    if (typeof document !== "undefined") {
      document.addEventListener("keydown", onKey);
      return () => document.removeEventListener("keydown", onKey);
    }
    return undefined;
  }, [open]);

  const currentCol = value ? columns.find((c) => c.field === value.propertyName) : null;
  const buttonLabel = value && currentCol
    ? `${currentCol.header} ${value.direction === "asc" ? "↑" : "↓"}`
    : t.sortButton;

  const handlePropertyChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const propertyName = e.target.value;
    if (!propertyName) {
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
    <div className={"relative " + (className ?? "")} ref={ref}>
      <button
        type="button"
        data-action="open-sort"
        aria-label={t.sortButtonAria}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={
          "inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs " +
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

      {open ? (
        <div
          role="dialog"
          aria-label={t.sortButton}
          data-popover="sort"
          className="absolute left-0 top-full z-40 mt-1 w-64 rounded-md border border-border bg-popover p-3 text-sm shadow-lg"
        >
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t.sortPickProperty}
              </span>
              <select
                data-field="property"
                value={value?.propertyName ?? ""}
                onChange={handlePropertyChange}
                className="h-8 rounded-md border border-border bg-background px-2 text-sm"
              >
                <option value="">{t.sortEmpty}</option>
                {columns.map((c) => (
                  <option key={c.field} value={c.field}>
                    {c.header}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-1.5">
              <button
                type="button"
                data-action="set-asc"
                aria-pressed={value?.direction === "asc"}
                onClick={() => handleDirection("asc")}
                className={
                  "inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-md border px-2 text-xs " +
                  (value?.direction === "asc"
                    ? "border-primary bg-primary/10 text-foreground"
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
                  "inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-md border px-2 text-xs " +
                  (value?.direction === "desc"
                    ? "border-primary bg-primary/10 text-foreground"
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
                className="mt-1 h-7 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {t.sortClear}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
