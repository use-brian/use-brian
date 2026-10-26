"use client";
import type { ComponentProps } from "react";
import { Popover, PopoverTrigger, PopoverContent as SharedPopoverContent } from "@use-brian/chat-ui";
import { useAppPopupBoundary } from "@/lib/app-viewport";
function PopoverContent(props: ComponentProps<typeof SharedPopoverContent>) {
  const collisionBoundary = useAppPopupBoundary();
  return <SharedPopoverContent {...props} collisionBoundary={collisionBoundary} />;
}
export { Popover, PopoverContent, PopoverTrigger };
