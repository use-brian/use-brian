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
}: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent outline-none transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "data-[checked]:bg-primary data-[unchecked]:bg-input",
        "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        className,
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
  );
}

export { Switch };
