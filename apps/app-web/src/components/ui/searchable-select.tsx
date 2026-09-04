"use client";

/**
 * Searchable single-select combobox (app-web).
 *
 * Ported from `apps/web/src/components/ui/searchable-select.tsx` as part of
 * the app consolidation (docs/architecture/features/doc.md §5a
 * "Foundation" / Phase 0 — the shared UI primitives surfaces depend on).
 * Same `@base-ui/react/combobox` base, and the API was identical until the
 * app-web copy grew the optional CREATABLE props (`onCreate` / `createLabel`,
 * for the skill-group pickers). `apps/web` does not have them; add them there
 * only if a surface needs one, rather than assuming the two are in sync. The
 * theme tokens (`border`, `muted`, `popover`, `accent`, `ring`) resolve against
 * app-web's palette the same way the existing `select.tsx` does.
 *
 * The workflow surface's per-step delivery-destination picker is the first
 * consumer; settings will reuse it. Never reach for a native `<select>` —
 * this is the themed, i18n-aware, searchable dropdown.
 *
 * [COMP:app-web/searchable-select]
 */

import * as React from "react";
import { Combobox } from "@base-ui/react/combobox";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export type SearchableSelectItem = {
  value: string;
  label: string;
  hint?: string;
  /** Small pill rendered after the label (trigger + list row), e.g. "default". */
  badge?: string;
};

type SearchableSelectProps = {
  value: string;
  onValueChange: (value: string) => void;
  items: SearchableSelectItem[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  className?: string;
  /** Width/positioning overrides for the popup. By default the popup matches
   *  the trigger width (`w-(--anchor-width)`); a COMPACT trigger (e.g. a
   *  composer-footer pill) should pass a wider class here (`w-72`) so item
   *  labels aren't crushed to ellipses. */
  popupClassName?: string;
  id?: string;
  "aria-label"?: string;
  /**
   * Makes the select CREATABLE: typing a value no item matches offers a
   * create row, and picking it calls this instead of `onValueChange`. The
   * created item is injected into the list rather than rendered beside it, so
   * base-ui's own highlight and Enter-to-select handle it like any other row
   * (the pattern base-ui documents for creatable comboboxes).
   */
  onCreate?: (value: string) => void;
  /** Label for the create row, e.g. `(q) => \`Create "\${q}"\``. */
  createLabel?: (query: string) => string;
};

/** Marks the injected create row; never a real item value. */
const CREATE_VALUE_PREFIX = "__create__:";

export function SearchableSelect({
  value,
  onValueChange,
  items,
  placeholder = "Select...",
  searchPlaceholder = "Search...",
  emptyMessage = "No results found.",
  disabled,
  className,
  popupClassName,
  id,
  "aria-label": ariaLabel,
  onCreate,
  createLabel,
}: SearchableSelectProps) {
  const [query, setQuery] = React.useState("");

  // The create row is a real item so base-ui highlights and selects it like
  // any other; its label contains the query, so the built-in filter keeps it.
  const typed = query.trim();
  const alreadyExists = items.some(
    (i) => i.label.trim().toLocaleLowerCase() === typed.toLocaleLowerCase(),
  );
  const itemsForView =
    onCreate && createLabel && typed !== "" && !alreadyExists
      ? [
          ...items,
          { value: `${CREATE_VALUE_PREFIX}${typed}`, label: createLabel(typed) },
        ]
      : items;

  const selected = items.find((i) => i.value === value) ?? null;

  return (
    <Combobox.Root
      items={itemsForView}
      itemToStringLabel={(item: SearchableSelectItem) => item.label}
      itemToStringValue={(item: SearchableSelectItem) => item.value}
      value={selected}
      inputValue={query}
      onInputValueChange={setQuery}
      // Controlling `inputValue` means the query is ours to clear: without
      // this the popup reopens still filtered by the last search.
      onOpenChange={(open: boolean) => {
        if (!open) setQuery("");
      }}
      onValueChange={(next) => {
        const picked = next ? (next as SearchableSelectItem).value : "";
        setQuery("");
        if (onCreate && picked.startsWith(CREATE_VALUE_PREFIX)) {
          onCreate(picked.slice(CREATE_VALUE_PREFIX.length));
          return;
        }
        onValueChange(picked);
      }}
    >
      <Combobox.Trigger
        id={id}
        aria-label={ariaLabel}
        disabled={disabled}
        className={cn(
          "group flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-border bg-muted/50 px-3 text-sm text-left transition-colors outline-none focus-visible:border-ring focus-visible:shadow-none",
          "hover:bg-muted",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "data-[popup-open]:border-ring",
          className,
        )}
      >
        <Combobox.Value>
          {(current: SearchableSelectItem | null) =>
            current ? (
              <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                <span className="truncate">{current.label}</span>
                {current.badge && (
                  <span className="shrink-0 rounded-full border border-border bg-muted px-1.5 py-px text-[10px] font-medium leading-4 text-muted-foreground">
                    {current.badge}
                  </span>
                )}
              </span>
            ) : (
              <span className="flex-1 truncate text-muted-foreground">{placeholder}</span>
            )
          }
        </Combobox.Value>
        <Combobox.Icon
          render={
            <ChevronDownIcon className="pointer-events-none size-4 shrink-0 text-muted-foreground transition-transform group-data-[popup-open]:rotate-180" />
          }
        />
      </Combobox.Trigger>

      <Combobox.Portal>
        <Combobox.Positioner
          sideOffset={4}
          className={cn(
            "isolate z-50 w-(--anchor-width) min-w-[min(18rem,var(--available-width))]",
            popupClassName,
          )}
        >
          <Combobox.Popup
            className={cn(
              "relative isolate z-50 max-h-[min(18rem,var(--available-height))] w-(--anchor-width) min-w-[min(18rem,var(--available-width))] origin-(--transform-origin) overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10",
              "data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2",
              "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
              popupClassName,
            )}
          >
            <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
              <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              {/* `focus-visible:shadow-none` — the popup row is already the
                  focus context; the global blue halo on this inner input
                  reads as a misplaced second border. */}
              <Combobox.Input
                placeholder={searchPlaceholder}
                className="h-5 w-full bg-transparent text-sm text-foreground outline-none focus-visible:shadow-none placeholder:text-muted-foreground"
              />
            </div>

            <Combobox.Empty className="empty:hidden px-3 py-6 text-center text-xs text-muted-foreground">
              {emptyMessage}
            </Combobox.Empty>

            <Combobox.List className="max-h-[14rem] overflow-y-auto p-1">
              {(item: SearchableSelectItem) => (
                <Combobox.Item
                  key={item.value}
                  value={item}
                  className={cn(
                    "relative flex cursor-default items-center gap-2 rounded-md py-1.5 pr-8 pl-3 text-sm outline-none select-none",
                    "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
                    "data-disabled:pointer-events-none data-disabled:opacity-50",
                  )}
                >
                  {/* The LABEL is the primary information and shrinks last: it
                      sizes to its content (capped at 65% of the row when a hint
                      shares the line) while the hint takes the remainder and
                      truncates. A `shrink-0` hint instead crushes the label to
                      nothing and pushes the `shrink-0` badge out of its own
                      box, so label and hint render on top of each other. */}
                  <span
                    className={cn(
                      "flex min-w-0 items-center gap-1.5 overflow-hidden",
                      item.hint ? "max-w-[65%] shrink-0" : "flex-1",
                    )}
                  >
                    <span className="truncate">{item.label}</span>
                    {item.badge && (
                      <span className="shrink-0 rounded-full border border-border bg-muted px-1.5 py-px text-[10px] font-medium leading-4 text-muted-foreground">
                        {item.badge}
                      </span>
                    )}
                  </span>
                  {item.hint && (
                    <span
                      title={item.hint}
                      className="min-w-0 flex-1 truncate text-right text-[11px] text-muted-foreground"
                    >
                      {item.hint}
                    </span>
                  )}
                  <Combobox.ItemIndicator
                    render={
                      <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center">
                        <CheckIcon className="size-4" />
                      </span>
                    }
                  />
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
