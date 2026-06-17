"use client";

/**
 * Renders a `TextBlock` as a read-only paragraph. Phase 2 swaps this
 * for an inline-editable textarea + debounced PATCH. For now the
 * variant flag maps onto utility colours and the block flows in the
 * page column.
 *
 * [COMP:app-web/page-renderer]
 */

import type { TextBlock } from "@/lib/api/views";

export function BlockText({ block }: { block: TextBlock }) {
  const variant = block.variant ?? "body";
  const className =
    variant === "muted"
      ? "text-sm text-muted-foreground leading-7"
      : variant === "caption"
        ? "text-xs text-muted-foreground leading-6"
        : "text-[15px] text-foreground leading-7";
  return (
    <p className={`${className} whitespace-pre-wrap break-words`}>
      {block.text}
    </p>
  );
}
