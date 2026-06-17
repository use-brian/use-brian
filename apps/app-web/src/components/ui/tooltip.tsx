"use client";

/**
 * Hover/focus tooltip — a Notion-style label popup with an optional keyboard
 * shortcut chip. Wraps `@base-ui/react/tooltip`, mirroring the project's other
 * base-ui primitives (see `popover.tsx`).
 *
 * Used by the sidebar's horizontal icon nav (`doc-sidebar.tsx`): icon-only
 * buttons reveal their name + shortcut on hover, the way Notion's top toolbar
 * does. Pass the trigger element as the single child; it is rendered as the
 * tooltip trigger (base-ui merges the hover/focus handlers onto it).
 *
 * [COMP:app-web/tooltip]
 */

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
}: {
  /** The trigger element (an icon button / link). Rendered as the tooltip anchor. */
  children: React.ReactElement;
  label: React.ReactNode;
  /** Optional keyboard shortcut, shown as a dim chip after the label (e.g. "⌘1"). */
  shortcut?: string;
  side?: "top" | "right" | "bottom" | "left";
  sideOffset?: number;
  delay?: number;
}) {
  return (
    <TooltipPrimitive.Provider delay={delay} closeDelay={0}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger render={children} />
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Positioner
            side={side}
            sideOffset={sideOffset}
            className="z-50"
          >
            <TooltipPrimitive.Popup
              className={cn(
                "z-50 inline-flex items-center gap-1.5 rounded-md bg-foreground px-2 py-1",
                "text-xs font-medium text-background shadow-md",
                "origin-(--transform-origin) duration-100",
                "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
                "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
              )}
            >
              <span>{label}</span>
              {shortcut ? (
                <kbd className="font-sans text-background/55">{shortcut}</kbd>
              ) : null}
            </TooltipPrimitive.Popup>
          </TooltipPrimitive.Positioner>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
