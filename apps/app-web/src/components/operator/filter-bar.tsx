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
 * **Every property holds a SET of values** — OR within a property, AND
 * across properties ("Alice or Bob, and status Todo"). That is why the
 * value list toggles in place and stays open: picking a second assignee
 * must not cost a second trip through the funnel. `onSet` always hands
 * back the complete next selection (`[]` = cleared), so a surface never
 * diffs. Spec: docs/architecture/features/tasks.md → "Every filter is
 * multi-select".
 *
 * Pure presentation over the surfaces' URL-codec view state — the bar
 * owns no state beyond popover/openness; every change lands in
 * `onSet(key, values)` and flows through the existing codecs
 * (`crm-view.ts` / `tasks-view.ts`), so deep links and the sidebar stay
 * the source of truth.
 *
 * [COMP:app-web/operator-filter-bar]
 */

import { useRef, useState } from "react";
import { Check, ChevronLeft, ListFilter, Search, SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
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
  /**
   * Optional leading art (avatar, glyph) rendered before the label. Takes the
   * diameter in px so one option reads right at both sizes it appears at —
   * 20 in the picker list, 14 inside the applied pill — which a fixed node
   * cannot do (`UserAvatar` sizes itself with inline styles a class can't
   * override).
   */
  icon?: (size: number) => React.ReactNode;
};

export type FilterDef = {
  key: string;
  label: string;
  options: FilterOption[];
};

/** key → applied values (absent / null / empty = inactive). */
export type FilterActive = Record<string, readonly string[] | null | undefined>;

/** The applied set for one property, always a fresh array. */
function valuesOf(active: FilterActive, key: string): string[] {
  const v = active[key];
  return v ? [...v] : [];
}

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
      role="menuitemcheckbox"
      aria-checked={selected}
      onClick={onPick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-muted",
        selected && "bg-muted/60",
      )}
    >
      {option.icon?.(20)}
      {option.dot && (
        <span className={cn("size-2 shrink-0 rounded-full", option.dot)} aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate">{option.label}</span>
      {selected && (
        <Check className="size-3.5 shrink-0 text-foreground/70" aria-hidden />
      )}
    </button>
  );
}

/**
 * One property's value list — a checklist, not a radio group. Toggling
 * never closes the popover, so a multi-value set is built in one gesture.
 */
function OptionList({
  def,
  values,
  onSet,
}: {
  def: FilterDef;
  values: readonly string[];
  onSet: (values: string[]) => void;
}) {
  return (
    <>
      {def.options.map((o) => {
        const selected = values.includes(o.value);
        return (
          <OptionRow
            key={o.value}
            option={o}
            selected={selected}
            onPick={() =>
              onSet(
                selected
                  ? values.filter((v) => v !== o.value)
                  : [...values, o.value],
              )
            }
          />
        );
      })}
    </>
  );
}

/**
 * One applied filter as a removable pill; the body reopens the checklist.
 * Multiple values read as `Assignee · Alice +2`, the full set in the
 * trigger's title — a pill has to stay pill-sized however many are picked.
 */
function FilterPill({
  def,
  values,
  onSet,
}: {
  def: FilterDef;
  values: readonly string[];
  onSet: (values: string[]) => void;
}) {
  const t = useT().filterBar;
  const [open, setOpen] = useState(false);
  // Selection order (= URL order), so the lead label is stable across
  // reloads. A value with no matching option (a since-renamed project)
  // still renders, as itself.
  const chosen = values.map(
    (v) => def.options.find((o) => o.value === v) ?? { value: v, label: v },
  );
  const lead = chosen[0];
  const extra = chosen.length - 1;
  return (
    <span className="inline-flex h-7 items-center overflow-hidden rounded-full border border-primary/30 bg-primary/10 text-xs transition-colors">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className="inline-flex h-full items-center gap-1 pl-2.5 pr-1"
          title={chosen.map((c) => c.label).join(", ")}
        >
          <span className="text-muted-foreground">{def.label}</span>
          {lead?.icon?.(14)}
          {lead?.dot && (
            <span className={cn("size-2 rounded-full", lead.dot)} aria-hidden />
          )}
          <span className="font-medium text-foreground">{lead?.label}</span>
          {extra > 0 && (
            <span className="rounded-full bg-primary/20 px-1 text-[11px] font-medium tabular-nums text-foreground/80">
              {format(t.more, { count: String(extra) })}
            </span>
          )}
        </PopoverTrigger>
        <PopoverContent align="start" className="max-h-72 w-56 overflow-y-auto p-1">
          <OptionList def={def} values={values} onSet={onSet} />
        </PopoverContent>
      </Popover>
      <button
        type="button"
        aria-label={`${t.clearFilter}: ${def.label}`}
        onClick={() => onSet([])}
        className="inline-flex h-full items-center pl-0.5 pr-2 text-muted-foreground/60 hover:text-foreground"
      >
        <X className="size-3" aria-hidden />
      </button>
    </span>
  );
}

/**
 * The funnel — a two-step property → value picker in one popover. The
 * property step lists EVERY def, applied ones carrying their count: the
 * funnel is the full filter menu, not just the unused half. (It also can't
 * be the unused half — dropping a property from the list the moment its
 * first value lands would unmount the popover mid-selection.)
 */
function AddFilterButton({
  defs,
  active,
  onSet,
}: {
  defs: FilterDef[];
  active: FilterActive;
  onSet: (key: string, values: string[]) => void;
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
          defs.map((def) => {
            const count = valuesOf(active, def.key).length;
            return (
              <button
                key={def.key}
                type="button"
                onClick={() => setPicked(def)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-muted"
              >
                <span className="min-w-0 flex-1 truncate">{def.label}</span>
                {count > 0 && (
                  <span className="shrink-0 rounded-full bg-primary/20 px-1.5 text-[11px] font-medium tabular-nums text-foreground/80">
                    {count}
                  </span>
                )}
              </button>
            );
          })
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
            <OptionList
              def={picked}
              values={valuesOf(active, picked.key)}
              onSet={(values) => onSet(picked.key, values)}
            />
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
  /** key → applied values (absent / null / empty = inactive). */
  active: FilterActive;
  /** The COMPLETE next selection for `key`; `[]` clears the property. */
  onSet: (key: string, values: string[]) => void;
  search: string;
  onSearch: (value: string) => void;
  searchPlaceholder: string;
  /** Popover content for the View button; omit to hide the button. */
  viewOptions?: React.ReactNode;
}) {
  const applied = defs.filter((def) => valuesOf(active, def.key).length > 0);
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
      {applied.map((def) => (
        <FilterPill
          key={def.key}
          def={def}
          values={valuesOf(active, def.key)}
          onSet={(values) => onSet(def.key, values)}
        />
      ))}
      {defs.length > 0 && (
        <AddFilterButton defs={defs} active={active} onSet={onSet} />
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
