"use client";

// [COMP:app-web/view-config-group-by-menu]
/**
 * Phase 3 — Group-by menu.
 *
 * Single-column grouping for table views (Phase 4 will graduate this to
 * the Board axis as well). The trigger button shows "Group by Status"
 * when active, "No grouping" otherwise.
 *
 * Only **groupable** property kinds appear in the picker —
 * `select` / `status` / `person` / `multi-select` (tags) / `relation`
 * / `created_by` / `last_edited_by`. Free-text, numbers, and dates are
 * not groupable in v1 (Notion's behavior — dates need a bucket strategy
 * and numbers need bins, both deferred).
 *
 * Stateless wrt the larger app — `value` is the property field name (or
 * null) and `onChange(next)` fires when the user commits a change.
 */

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { Layers } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import type { A2UIColumn } from "@use-brian/views-renderer";
import type { PropertyKind } from "./filter-bar";

/**
 * Kinds that are valid group axes. Exported so the toolbar / tests can
 * read the same source of truth.
 */
export const GROUPABLE_KINDS: ReadonlySet<PropertyKind> = new Set<PropertyKind>([
  "select",
  "status",
  "person",
  "tags",
  "relation",
  "created_by",
  "last_edited_by",
]);

export function isGroupableColumn(col: A2UIColumn): boolean {
  if (!col.kind) return false;
  return GROUPABLE_KINDS.has(col.kind);
}

export type GroupByMenuProps = {
  columns: readonly A2UIColumn[];
  value: string | null;
  onChange: (next: string | null) => void;
  className?: string;
};

export function GroupByMenu({
  columns,
  value,
  onChange,
  className,
}: GroupByMenuProps) {
  const t = useT().docPage.viewToolbar;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  const groupable = columns.filter(isGroupableColumn);

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

  const currentCol = value ? columns.find((c) => c.field === value) : null;
  const buttonLabel = currentCol
    ? `${t.groupByButton}: ${currentCol.header}`
    : t.groupByButton;

  const handleChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value;
    onChange(next === "" ? null : next);
  };

  const handleClear = () => {
    onChange(null);
    setOpen(false);
  };

  return (
    <div className={"relative " + (className ?? "")} ref={ref}>
      <button
        type="button"
        data-action="open-group-by"
        aria-label={t.groupByButtonAria}
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
        <Layers className="h-3.5 w-3.5" aria-hidden />
        <span>{buttonLabel}</span>
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label={t.groupByButton}
          data-popover="group-by"
          className="absolute left-0 top-full z-40 mt-1 w-64 rounded-md border border-border bg-popover p-3 text-sm shadow-lg"
        >
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                {t.groupByPickProperty}
              </span>
              <select
                data-field="property"
                value={value ?? ""}
                onChange={handleChange}
                className="h-8 rounded-md border border-border bg-background px-2 text-sm"
              >
                <option value="">{t.groupByEmpty}</option>
                {groupable.map((c) => (
                  <option key={c.field} value={c.field}>
                    {c.header}
                  </option>
                ))}
              </select>
            </label>
            {value ? (
              <button
                type="button"
                data-action="clear-group-by"
                onClick={handleClear}
                className="h-7 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {t.groupByClear}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
