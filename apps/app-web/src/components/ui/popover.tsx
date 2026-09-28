"use client";

import { useAppPopupBoundary } from "@/lib/app-viewport";

import * as React from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { cn } from "@/lib/utils";

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  align = "center",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  anchor,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<
    PopoverPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset" | "anchor"
  >) {
  const collisionBoundary = useAppPopupBoundary();
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        collisionBoundary={collisionBoundary}
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        anchor={anchor}
        className="isolate z-50"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            // App-width clamp (responsive contract M5), including native docking:
            // never taller than what fits below the trigger - a 320px switcher menu
            // clipped its footer in 375px-tall landscape with no way to scroll
            // (the SelectContent shape). Graded: invariants/popover-width-clamp.
            "z-50 flex max-w-[calc(var(--native-app-width,100vw)-1rem)] max-h-[min(80dvh,var(--available-height))] origin-(--transform-origin) flex-col gap-2.5 overflow-y-auto rounded-lg bg-popover p-2.5 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverContent, PopoverTrigger };
