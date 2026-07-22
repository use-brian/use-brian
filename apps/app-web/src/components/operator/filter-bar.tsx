"use client";

/**
 * Operator filter bar — the Notion-style database toolbar shared by the
 * Tasks + CRM operator surfaces. Instead of a row of always-visible
 * labeled dropdowns, the resting state is quiet: a ghost **Filter**
 * button (funnel), a ghost **View** button (per-surface group/sort/reveal
 * options in a popover), and an **expanding search** icon. An applied
 * filter materializes as a removable pill (`Stage · Proposal ×`) whose
 * body reopens its option list; the funnel opens a two-step
 * property → value picker.
 *
 * Pure presentation over the surfaces' URL-codec view state — the bar
 * owns no state beyond popover/openness; every change lands in
 * `onSet(key, value | null)` and flows through the existing codecs
 * (`crm-view.ts` / `tasks-view.ts`), so deep links and the sidebar stay
 * the source of truth.
 *
 * [COMP:app-web/operator-filter-bar]
 */

import { useRef, useState } from "react";
import { ChevronLeft, ListFilter, Search, SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

type FilterOption = {
  value: string;
  label: string;
  /** Optional status-dot tint class rendered before the label. */
  dot?: string;
};

export type FilterDef = {
  key: string;
  label: string;
  options: FilterOption[];
};

// The Brain filter-strip's collapsed-Filter button language: bordered card
// chrome, muted at rest, foreground on hover.
const GHOST_BTN =
  "inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 " +
  "text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

function OptionRow({
  option,
  selected,
  onPick,
}: {
  option: FilterOption;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-muted",
        selected && "bg-muted/60",
      )}
    >
      {option.dot && (
        <span className={cn("size-2 shrink-0 rounded-full", option.dot)} aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate">{option.label}</span>
    </button>
  );
}

/** One applied filter as a removable pill; the body reopens the picker. */
function FilterPill({
  def,
  value,
  onSet,
}: {
  def: FilterDef;
  value: string;
  onSet: (value: string | null) => void;
}) {
  const t = useT().filterBar;
  const [open, setOpen] = useState(false);
  const current = def.options.find((o) => o.value === value);
  return (
    <span className="inline-flex h-7 items-center overflow-hidden rounded-full border border-primary/30 bg-primary/10 text-xs transition-colors">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger className="inline-flex h-full items-center gap-1 pl-2.5 pr-1">
          <span className="text-muted-foreground">{def.label}</span>
          {current?.dot && (
            <span className={cn("size-2 rounded-full", current.dot)} aria-hidden />
          )}
          <span className="font-medium text-foreground">
            {current?.label ?? value}
          </span>
        </PopoverTrigger>
        <PopoverContent align="start" className="max-h-72 w-56 overflow-y-auto p-1">
          {def.options.map((o) => (
            <OptionRow
              key={o.value}
              option={o}
              selected={o.value === value}
              onPick={() => {
                setOpen(false);
                onSet(o.value === value ? null : o.value);
              }}
            />
          ))}
        </PopoverContent>
      </Popover>
      <button
        type="button"
        aria-label={`${t.clearFilter}: ${def.label}`}
        onClick={() => onSet(null)}
        className="inline-flex h-full items-center pl-0.5 pr-2 text-muted-foreground/60 hover:text-foreground"
      >
        <X className="size-3" aria-hidden />
      </button>
    </span>
  );
}

/** The funnel — a two-step property → value picker in one popover. */
function AddFilterButton({
  defs,
  onSet,
}: {
  defs: FilterDef[];
  onSet: (key: string, value: string) => void;
}) {
  const t = useT().filterBar;
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<FilterDef | null>(null);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setPicked(null);
      }}
    >
      <PopoverTrigger className={GHOST_BTN}>
        <ListFilter className="size-3.5" aria-hidden />
        {t.filter}
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-72 w-56 overflow-y-auto p-1">
        {picked === null ? (
          defs.map((def) => (
            <button
              key={def.key}
              type="button"
              onClick={() => setPicked(def)}
              className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-muted"
            >
              <span className="min-w-0 flex-1 truncate">{def.label}</span>
            </button>
          ))
        ) : (
          <>
            <button
              type="button"
              onClick={() => setPicked(null)}
              className="mb-1 flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-[12px] text-muted-foreground transition-colors hover:bg-muted"
            >
              <ChevronLeft className="size-3.5" aria-hidden />
              {picked.label}
            </button>
            {picked.options.map((o) => (
              <OptionRow
                key={o.value}
                option={o}
                selected={false}
                onPick={() => {
                  setOpen(false);
                  const key = picked.key;
                  setPicked(null);
                  onSet(key, o.value);
                }}
              />
            ))}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Magnifier that expands into an input; collapses again when emptied. */
function ExpandingSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const [openEmpty, setOpenEmpty] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const open = openEmpty || value.length > 0;
  if (!open) {
    return (
      <button
        type="button"
        aria-label={placeholder}
        onClick={() => {
          setOpenEmpty(true);
          // Focus after the input mounts.
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        className={cn(GHOST_BTN, "px-1.5")}
      >
        <Search className="size-3.5" aria-hidden />
      </button>
    );
  }
  return (
    <label className="relative">
      <Search
        className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60"
        aria-hidden
      />
      <input
        ref={inputRef}
        type="text"
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          if (value.length === 0) setOpenEmpty(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            onChange("");
            setOpenEmpty(false);
          }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-7 w-44 rounded-md border border-border bg-card pl-7 pr-2 text-[13px] outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
      />
    </label>
  );
}

/** Ghost button hosting per-surface view options (group / sort / reveal). */
function ViewOptionsButton({ children }: { children: React.ReactNode }) {
  const t = useT().filterBar;
  return (
    <Popover>
      <PopoverTrigger className={GHOST_BTN}>
        <SlidersHorizontal className="size-3.5" aria-hidden />
        {t.view}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 p-1.5">
        {children}
      </PopoverContent>
    </Popover>
  );
}

/** Section label + option rows for the View popover (surface-supplied). */
export function ViewOptionSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-1.5 last:mb-0">
      <div className="px-2 pb-0.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
        {label}
      </div>
      {children}
    </div>
  );
}

export function ViewOptionRow({
  label,
  selected,
  onPick,
}: {
  label: string;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        "flex w-full items-center rounded-md px-2 py-1 text-left text-[13px] transition-colors hover:bg-muted",
        selected && "bg-muted/60 font-medium",
      )}
    >
      {label}
    </button>
  );
}

/**
 * The bar: applied-filter pills + the funnel on the left; view options +
 * search hugging the right edge. Render inside the surface's toolbar strip
 * (after the preset chips).
 */
export function FilterBar({
  defs,
  active,
  onSet,
  search,
  onSearch,
  searchPlaceholder,
  viewOptions,
}: {
  defs: FilterDef[];
  /** key → applied value (absent / null = inactive). */
  active: Record<string, string | null | undefined>;
  onSet: (key: string, value: string | null) => void;
  search: string;
  onSearch: (value: string) => void;
  searchPlaceholder: string;
  /** Popover content for the View button; omit to hide the button. */
  viewOptions?: React.ReactNode;
}) {
  const applied = defs.filter(
    (def) => active[def.key] !== null && active[def.key] !== undefined,
  );
  const addable = defs.filter(
    (def) => active[def.key] === null || active[def.key] === undefined,
  );
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
      {applied.map((def) => (
        <FilterPill
          key={def.key}
          def={def}
          value={active[def.key] as string}
          onSet={(value) => onSet(def.key, value)}
        />
      ))}
      {addable.length > 0 && (
        <AddFilterButton defs={addable} onSet={onSet} />
      )}
      <span className="ml-auto flex items-center gap-1">
        {viewOptions !== undefined && (
          <ViewOptionsButton>{viewOptions}</ViewOptionsButton>
        )}
        <ExpandingSearch
          value={search}
          onChange={onSearch}
          placeholder={searchPlaceholder}
        />
      </span>
    </div>
  );
}
