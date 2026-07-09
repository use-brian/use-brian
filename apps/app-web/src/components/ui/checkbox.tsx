"use client";

/**
 * Themed checkbox primitive (app-web).
 *
 * A polished replacement for the raw native `<input type="checkbox">`, built on
 * `@base-ui/react/checkbox` the same way `searchable-select.tsx` wraps the
 * combobox. Native checkboxes render OS chrome that ignores the app palette and
 * reads "unfinished" next to the base-ui / shadcn surfaces — this gives a soft
 * rounded box that fills with `--primary` on check, animates the tick in/out,
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

type CheckboxProps = {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  /** Partial state — renders a minus instead of a tick (e.g. select-all when
   *  only some rows are selected). Visually filled like `checked`. */
  indeterminate?: boolean;
  disabled?: boolean;
  id?: string;
  name?: string;
  className?: string;
  "aria-label"?: string;
};

export function Checkbox({
  checked,
  defaultChecked,
  onCheckedChange,
  indeterminate,
  disabled,
  id,
  name,
  className,
  "aria-label": ariaLabel,
}: CheckboxProps) {
  return (
    <BaseCheckbox.Root
      id={id}
      name={name}
      checked={checked}
      defaultChecked={defaultChecked}
      indeterminate={indeterminate}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        // Box — soft rounded square that fills with the primary on check.
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[5px] border p-[2px]",
        "border-muted-foreground/35 bg-background text-primary-foreground",
        "shadow-sm outline-none transition-[background-color,border-color,box-shadow,opacity]",
        "hover:border-muted-foreground/55",
        "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        "data-[checked]:border-primary data-[checked]:bg-primary",
        "data-[indeterminate]:border-primary data-[indeterminate]:bg-primary",
        "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        "cursor-pointer",
        className,
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
  );
}
