"use client";

/**
 * Brain page filter strip. Pill chips for primitive-type filters plus
 * a search input and a "pending changes" sticky toggle.
 *
 * Spec: docs/plans/company-brain/ui.md → §J3 + Brain page design.
 *
 * State is controlled by the parent (Brain page) — this component is
 * purely presentational so URL-state and analytics can live in one
 * place.
 */

import { ListFilter } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import type { BrainPrimitive } from "@/lib/api/brain";

type Props = {
  selectedPrimitives: BrainPrimitive[];
  onTogglePrimitive: (p: BrainPrimitive) => void;
  search: string;
  onSearch: (v: string) => void;
  pendingOnly: boolean;
  onTogglePending: () => void;
  /**
   * Chat-home flip: collapse the primitive chips + pending toggle behind a
   * single "Filter" popover so the Brain reads as a clean reading surface
   * (web-ui.md → Brain is a reading/trust surface). Search stays inline.
   * Only the horizontal FilterStrip honors this — the vertical FilterRail
   * is the flag-off rail and is left untouched.
   */
  collapsed?: boolean;
  /**
   * Hide the "Pending changes" toggle. The Brain's section IA replaced it
   * with the sidebar's Reviews row, so the strip mounted under the Entries
   * section never shows it. Only the horizontal FilterStrip honors this —
   * the vertical FilterRail is the flag-off rail and is left untouched.
   */
  hidePending?: boolean;
  /**
   * Which primitive types currently have ≥1 visible row in the brain.
   * Chips for absent primitives are hidden. `null`/`undefined` means
   * "not loaded yet / unknown" → the strip renders placeholder skeleton
   * chips instead of the real set, so a fresh load never flashes the full
   * primitive list and then visibly narrows it once the presence map
   * resolves (the old null→"show every chip" behavior). After it resolves,
   * only present primitives render. A currently-selected primitive is never
   * hidden even if reported absent, so the user is never stranded in a
   * filtered-but-invisible state.
   */
  presentPrimitives?: Partial<Record<BrainPrimitive, boolean>> | null;
};

const ALL: { key: BrainPrimitive | "all" }[] = [
  { key: "all" },
  { key: "people" },
  { key: "companies" },
  { key: "deals" },
  { key: "tasks" },
  { key: "knowledge" },
  { key: "memories" },
  { key: "files" },
  { key: "sessions" },
];

/**
 * Placeholder chip widths shown while the presence map loads. Varied so
 * the row reads as "filters loading", not a progress bar; the count and
 * widths are cosmetic — the real present-only chip set replaces them once
 * facets resolve. Kept small (~typical present count) so the swap to real
 * chips is a minor adjustment, not a jarring collapse.
 */
const SKELETON_CHIP_WIDTHS = [
  "2.5rem",
  "4rem",
  "5.5rem",
  "3.25rem",
  "4.75rem",
  "3.5rem",
];

/**
 * Whether a chip should render once the presence map has loaded. `all`
 * always renders. Otherwise show iff the primitive is present, or it's
 * currently selected (never hide an active filter). The loading state is
 * handled by the callers, which render skeleton chips while
 * `presentPrimitives` is null, so this never decides what to show during
 * load (the null guard below is purely defensive).
 */
function isChipVisible(
  key: BrainPrimitive | "all",
  presentPrimitives: Props["presentPrimitives"],
  selectedPrimitives: BrainPrimitive[],
): boolean {
  if (key === "all") return true;
  if (presentPrimitives == null) return true;
  if (presentPrimitives[key] === true) return true;
  return selectedPrimitives.includes(key);
}

/**
 * The wrap of primitive-type chips. Extracted so the collapsed FilterStrip's
 * Filter popover can reuse the exact chip rendering. The expanded FilterStrip
 * and the vertical FilterRail keep their own inline chip loops verbatim so the
 * flag-off paths stay unchanged.
 */
function PrimitiveChips({
  selectedPrimitives,
  onTogglePrimitive,
  presentPrimitives,
}: Pick<Props, "selectedPrimitives" | "onTogglePrimitive" | "presentPrimitives">) {
  const t = useT();
  const allActive = selectedPrimitives.length === 0;
  const loading = presentPrimitives == null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {loading
        ? SKELETON_CHIP_WIDTHS.map((w, i) => (
            <div
              key={i}
              aria-hidden
              className="h-[26px] rounded-full bg-muted animate-pulse"
              style={{ width: w }}
            />
          ))
        : ALL.filter(({ key }) =>
            isChipVisible(key, presentPrimitives, selectedPrimitives),
          ).map(({ key }) => {
            const active =
              key === "all" ? allActive : selectedPrimitives.includes(key);
            const label =
              t.brainPage.filters[key as keyof typeof t.brainPage.filters];
            return (
              <button
                key={key}
                type="button"
                onClick={() => {
                  if (key === "all") {
                    selectedPrimitives.forEach(onTogglePrimitive);
                  } else {
                    onTogglePrimitive(key);
                  }
                }}
                className={cn(
                  "px-2.5 py-1 text-xs rounded-full border transition-colors",
                  active
                    ? "bg-foreground text-background border-foreground"
                    : "bg-card text-muted-foreground border-border hover:bg-muted hover:text-foreground",
                )}
              >
                {label}
              </button>
            );
          })}
    </div>
  );
}

export function FilterStrip({
  selectedPrimitives,
  onTogglePrimitive,
  search,
  onSearch,
  pendingOnly,
  onTogglePending,
  presentPrimitives,
  collapsed,
  hidePending,
}: Props) {
  const t = useT();
  const allActive = selectedPrimitives.length === 0;
  const loading = presentPrimitives == null;

  // Chat-home flip: search stays inline, everything else collapses into a
  // single "Filter" popover with a selected-count badge.
  if (collapsed) {
    const activeCount =
      selectedPrimitives.length + (pendingOnly && !hidePending ? 1 : 0);
    return (
      <div className="flex items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={t.brainPage.search.placeholder}
          className={cn(
            "flex-1 min-w-0 px-3 py-1.5 text-sm bg-card border border-border rounded-md",
            "outline-none focus:ring-2 focus:ring-ring",
          )}
        />
        <Popover>
          <PopoverTrigger
            className={cn(
              "inline-flex items-center gap-1.5 shrink-0 px-3 py-1.5 text-xs rounded-md border transition-colors",
              activeCount > 0
                ? "bg-primary/10 text-primary border-primary/30"
                : "bg-card text-muted-foreground border-border hover:bg-muted hover:text-foreground",
            )}
            aria-label={t.brainPage.filters.filterButton}
          >
            <ListFilter className="w-3.5 h-3.5" />
            {t.brainPage.filters.filterButton}
            {activeCount > 0 && (
              <span className="ml-0.5 min-w-[1.1rem] h-[1.1rem] px-1 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-semibold">
                {activeCount}
              </span>
            )}
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72">
            <div className="px-1.5 pt-1 pb-1">
              <PrimitiveChips
                selectedPrimitives={selectedPrimitives}
                onTogglePrimitive={onTogglePrimitive}
                presentPrimitives={presentPrimitives}
              />
            </div>
            {!hidePending && (
              <div className="mt-2 border-t border-border pt-2 px-0.5">
                <button
                  type="button"
                  onClick={onTogglePending}
                  className={cn(
                    "w-full text-left px-2.5 py-1.5 text-xs rounded-md transition-colors",
                    pendingOnly
                      ? "bg-amber-500/10 text-amber-700 dark:text-amber-400 font-medium"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted",
                  )}
                >
                  {t.brainPage.filters.pendingOnly}
                </button>
              </div>
            )}
          </PopoverContent>
        </Popover>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <input
        type="search"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        placeholder={t.brainPage.search.placeholder}
        className={cn(
          "w-full px-3 py-2 text-sm bg-card border border-border rounded-md",
          "outline-none focus:ring-2 focus:ring-ring",
        )}
      />
      <div className="flex flex-wrap gap-1.5">
        {loading
          ? SKELETON_CHIP_WIDTHS.map((w, i) => (
              <div
                key={i}
                aria-hidden
                className="h-[26px] rounded-full bg-muted animate-pulse"
                style={{ width: w }}
              />
            ))
          : ALL.filter(({ key }) =>
              isChipVisible(key, presentPrimitives, selectedPrimitives),
            ).map(({ key }) => {
              const active =
                key === "all" ? allActive : selectedPrimitives.includes(key);
              const label =
                t.brainPage.filters[key as keyof typeof t.brainPage.filters];
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    if (key === "all") {
                      // Clear selection
                      selectedPrimitives.forEach(onTogglePrimitive);
                    } else {
                      onTogglePrimitive(key);
                    }
                  }}
                  className={cn(
                    "px-2.5 py-1 text-xs rounded-full border transition-colors",
                    active
                      ? "bg-foreground text-background border-foreground"
                      : "bg-card text-muted-foreground border-border hover:bg-muted hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              );
            })}
        {!hidePending && (
          <button
            type="button"
            onClick={onTogglePending}
            className={cn(
              "ml-auto px-2.5 py-1 text-xs rounded-full border transition-colors",
              pendingOnly
                ? "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30"
                : "bg-card text-muted-foreground border-border hover:bg-muted hover:text-foreground",
            )}
          >
            {t.brainPage.filters.pendingOnly}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Vertical variant of the filter strip, mounted inside the brain data
 * card as a left rail (~180px wide). Search at top, primitive filters
 * as a stacked nav list, pending toggle pinned at the bottom of the
 * column. Same controlled-state contract as FilterStrip so the parent
 * (Brain page) keeps its URL-state / analytics handling.
 */
export function FilterRail({
  selectedPrimitives,
  onTogglePrimitive,
  search,
  onSearch,
  pendingOnly,
  onTogglePending,
  presentPrimitives,
}: Props) {
  const t = useT();
  const allActive = selectedPrimitives.length === 0;
  const loading = presentPrimitives == null;

  return (
    <div className="hidden lg:flex flex-col gap-3 px-3 py-3 border-r border-border bg-muted/20 w-[180px] shrink-0 min-h-0 overflow-y-auto">
      <input
        type="search"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        placeholder={t.brainPage.search.placeholder}
        className={cn(
          "w-full px-2.5 py-1.5 text-[12px] bg-background border border-border rounded-md",
          "outline-none focus:ring-2 focus:ring-ring/50 placeholder:text-muted-foreground/60",
        )}
      />
      <div className="flex flex-col gap-0.5">
        {loading
          ? SKELETON_CHIP_WIDTHS.map((w, i) => (
              <div key={i} aria-hidden className="px-2.5 py-1.5">
                <div
                  className="h-4 rounded bg-muted animate-pulse"
                  style={{ width: w }}
                />
              </div>
            ))
          : ALL.filter(({ key }) =>
              isChipVisible(key, presentPrimitives, selectedPrimitives),
            ).map(({ key }) => {
              const active =
                key === "all" ? allActive : selectedPrimitives.includes(key);
              const label =
                t.brainPage.filters[key as keyof typeof t.brainPage.filters];
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    if (key === "all") {
                      selectedPrimitives.forEach(onTogglePrimitive);
                    } else {
                      onTogglePrimitive(key);
                    }
                  }}
                  className={cn(
                    "w-full text-left px-2.5 py-1.5 text-[12px] rounded-md transition-colors",
                    active
                      ? "bg-primary/10 text-primary font-medium"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted",
                  )}
                >
                  {label}
                </button>
              );
            })}
      </div>
      <div className="mt-auto pt-2 border-t border-border">
        <button
          type="button"
          onClick={onTogglePending}
          className={cn(
            "w-full text-left px-2.5 py-1.5 text-[12px] rounded-md transition-colors",
            pendingOnly
              ? "bg-amber-500/10 text-amber-700 dark:text-amber-400 font-medium"
              : "text-muted-foreground hover:text-foreground hover:bg-muted",
          )}
        >
          {t.brainPage.filters.pendingOnly}
        </button>
      </div>
    </div>
  );
}
