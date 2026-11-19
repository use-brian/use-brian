"use client";

/**
 * On-brand toggle switch — a thin wrapper over `@base-ui/react`'s Switch,
 * mirroring the composition style of `dropdown-menu.tsx`. Used for the
 * page-header "Full width" row (Notion-style) and any future on/off setting.
 *
 * **Never use a native `<input type="checkbox">`** for a user-facing toggle
 * in this app — it ignores the theme tokens and breaks the cross-app visual
 * continuity (root CLAUDE.md anti-pattern). base-ui handles role/aria and
 * keyboard operation; we only paint it with theme tokens.
 *
 * Usage:
 *   <Switch checked={on} onCheckedChange={setOn} />
 *
 * [COMP:app-web/switch]
 */

import * as React from "react";
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "@/lib/utils";

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    // Allocate the hit area in flow without stretching the 36x20 track or
    // changing the thumb's 16px travel. No synthetic click forwarding.
    <span data-slot="switch-target" className="contents max-md:inline-flex [@media(pointer:coarse)]:inline-flex shrink-0 items-center justify-center align-middle max-md:min-h-11 max-md:min-w-11 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11">
      <SwitchPrimitive.Root
        data-slot="switch"
        className={(state) => cn(
          "peer relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent outline-none transition-colors",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "data-[checked]:bg-action data-[unchecked]:bg-input",
          "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
          "after:absolute after:top-1/2 after:left-1/2 after:-translate-x-1/2 after:-translate-y-1/2 max-md:after:size-[max(100%,44px)] [@media(pointer:coarse)]:after:size-[max(100%,44px)]",
          typeof className === "function" ? className(state) : className,
        )}
        {...props}
      >
        <SwitchPrimitive.Thumb
          data-slot="switch-thumb"
          className={cn(
            "pointer-events-none block size-4 rounded-full bg-background shadow-sm ring-0 transition-transform",
            "data-[checked]:translate-x-4 data-[unchecked]:translate-x-0",
          )}
        />
      </SwitchPrimitive.Root>
    </span>
  );
}

export { Switch };
