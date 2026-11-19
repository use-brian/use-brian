"use client";

/**
 * Themed checkbox primitive (app-web).
 *
 * A polished replacement for the raw native `<input type="checkbox">`, built on
 * `@base-ui/react/checkbox` the same way `searchable-select.tsx` wraps the
 * combobox. Native checkboxes render OS chrome that ignores the app palette and
 * reads "unfinished" next to the base-ui / shadcn surfaces — this gives a soft
 * rounded box that fills with `--action` on check, animates the tick in/out,
 * and supports the `indeterminate` (partial select-all) state.
 *
 * The tick and minus scale with the box: the Root carries a 2px inset and the
 * icon is `w-full h-full`, so passing a smaller `size-*` in `className`
 * (e.g. the compact `size-3.5` rows in the Brain reviews list) keeps the glyph
 * proportional with no extra props.
 *
 * Never reach for a native `<input type="checkbox">` — this is the themed,
 * keyboard-accessible box (see `apps/web/CLAUDE.md` on the primitives rule).
 *
 * [COMP:app-web/checkbox]
 */

import * as React from "react";
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { CheckIcon, MinusIcon } from "lucide-react";

import { cn } from "@/lib/utils";

type CheckboxProps = React.ComponentProps<typeof BaseCheckbox.Root>;

export function Checkbox({
  className,
  indeterminate,
  ...props
}: CheckboxProps) {
  return (
    // Reserve the expanded area in flow: two adjacent controls must not have
    // overlapping invisible targets. The wrapper is not a second control.
    <span data-slot="checkbox-target" className="contents max-md:inline-flex [@media(pointer:coarse)]:inline-flex shrink-0 items-center justify-center align-middle max-md:min-h-11 max-md:min-w-11 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11">
      <BaseCheckbox.Root
        {...props}
        indeterminate={indeterminate}
        data-slot="checkbox"
        className={(state) => cn(
          // Box — soft rounded square that fills with neutral ink on check.
          "relative inline-flex size-4 shrink-0 items-center justify-center rounded-[5px] border p-[2px]",
          "border-muted-foreground/35 bg-background text-action-foreground",
          "shadow-sm outline-none transition-[background-color,border-color,box-shadow,opacity]",
          "hover:border-muted-foreground/55",
          "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
          "data-[checked]:border-action data-[checked]:bg-action",
          "data-[indeterminate]:border-action data-[indeterminate]:bg-action",
          "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
          // The transparent pseudo-element belongs to the Base UI root, so
          // pointer, keyboard, disabled state and hidden-input refs stay native
          // to Base UI. Keep paint (including consumer size-* classes) compact.
          "cursor-pointer after:absolute after:top-1/2 after:left-1/2 after:-translate-x-1/2 after:-translate-y-1/2 max-md:after:size-[max(100%,44px)] [@media(pointer:coarse)]:after:size-[max(100%,44px)]",
          typeof className === "function" ? className(state) : className,
        )}
      >
        <BaseCheckbox.Indicator
          className={cn(
            "flex size-full items-center justify-center",
            "transition-[transform,opacity] duration-150 ease-out",
            "data-[starting-style]:scale-50 data-[starting-style]:opacity-0",
            "data-[ending-style]:scale-50 data-[ending-style]:opacity-0",
          )}
        >
          {indeterminate ? (
            <MinusIcon className="size-full" strokeWidth={3.5} aria-hidden />
          ) : (
            <CheckIcon className="size-full" strokeWidth={3.5} aria-hidden />
          )}
        </BaseCheckbox.Indicator>
      </BaseCheckbox.Root>
    </span>
  );
}
