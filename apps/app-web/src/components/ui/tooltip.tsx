"use client";

/**
 * Hover/focus tooltip with an optional keyboard shortcut chip. The persistent
 * sidebar uses the larger rail appearance; other controls keep the compact
 * default. Wraps `@base-ui/react/tooltip`, like the other base-ui primitives.
 *
 * Icon-only buttons reveal their name + shortcut on hover. Pass the trigger
 * element as the single child; it is rendered as the
 * tooltip trigger (base-ui merges the hover/focus handlers onto it).
 *
 * [COMP:app-web/tooltip]
 */

import { useAppPopupBoundary } from "@/lib/app-viewport";

import * as React from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

import { cn } from "@/lib/utils";

export function Tooltip({
  children,
  label,
  shortcut,
  side = "bottom",
  sideOffset = 6,
  delay = 350,
  appearance = "default",
  closeOnClick = true,
  open,
  onOpenChange,
}: {
  /** The trigger element (an icon button / link). Rendered as the tooltip anchor. */
  children: React.ReactElement;
  label: React.ReactNode;
  /** Optional keyboard shortcut, shown as a dim chip after the label (e.g. "⌘1"). */
  shortcut?: string;
  side?: "top" | "right" | "bottom" | "left";
  sideOffset?: number;
  delay?: number;
  /** Larger label popup for the persistent desktop navigation rail. */
  appearance?: "default" | "rail";
  /** Keep the popup open when the trigger is clicked and retains focus. */
  closeOnClick?: boolean;
  /** Optional controlled state for triggers that also disclose on press. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  // Base UI distinguishes an omitted `open` prop from `open={undefined}`.
  // Only pass the controlled contract when a caller actually controls it;
  // otherwise hover/focus tooltips must remain uncontrolled for their whole
  // lifetime.
  const rootControlProps =
    open === undefined ? {} : { open, onOpenChange };
  const collisionBoundary = useAppPopupBoundary();
  return (
    <TooltipPrimitive.Provider delay={delay} closeDelay={0}>
      <TooltipPrimitive.Root {...rootControlProps}>
        <TooltipPrimitive.Trigger render={children} closeOnClick={closeOnClick} />
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Positioner
            collisionBoundary={collisionBoundary}
            side={side}
            sideOffset={sideOffset}
            className="z-50"
          >
            <TooltipPrimitive.Popup
              data-app-tooltip
              className={cn(
                "z-50 inline-flex items-center gap-1.5",
                appearance === "rail"
                  ? "rounded-[14px] bg-[#1a1d1e] px-3.5 py-1.5 text-sm font-normal leading-5 text-[#f5f5f5] shadow-[0_8px_24px_-4px_rgb(0_0_0/0.22),0_0_0_1px_rgb(255_255_255/0.08)]"
                  : "rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background shadow-md",
                "origin-(--transform-origin) duration-100",
                "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
                "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
              )}
            >
              <span>{label}</span>
              {shortcut ? (
                <kbd className={cn("font-sans", appearance === "rail" ? "text-white/55" : "text-background/55")}>{shortcut}</kbd>
              ) : null}
            </TooltipPrimitive.Popup>
          </TooltipPrimitive.Positioner>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
