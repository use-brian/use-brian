"use client";

/**
 * Renders a `HeadingBlock` at level 1 / 2 / 3. Read-only in Phase 1
 * (matches the plan doc — inline editing lands with Phase 2's
 * write-back). Size scale mirrors the existing chat-side Heading
 * widget so a heading reads identically inline and in a page.
 *
 * [COMP:app-web/page-renderer]
 */

import type { HeadingBlock } from "@/lib/api/views";

export function BlockHeading({ block }: { block: HeadingBlock }) {
  if (block.level === 1) {
    return (
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        {block.text}
      </h1>
    );
  }
  if (block.level === 2) {
    return (
      <h2 className="text-xl font-semibold tracking-tight text-foreground">
        {block.text}
      </h2>
    );
  }
  return (
    <h3 className="text-lg font-medium tracking-tight text-foreground">
      {block.text}
    </h3>
  );
}
