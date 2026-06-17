"use client";

/**
 * Right-hand chat column for the Doc v1 three-column shell.
 *
 *   ┌─ DocSidebar ─┬─ Active page ─┬─ DocSidePanel ──┐
 *   │  Drafts + Saved │  PageRenderer │  <FloatingChat      │
 *   │                 │               │   mode="side-panel" │
 *   └─────────────────┴───────────────┴────────────────────┘
 *
 * The side panel hosts the same `<FloatingChat>` component that, in the
 * legacy two-column layout, anchored to the bottom of the viewport as a
 * collapsible pill. Passing `mode="side-panel"` swaps the outer chrome
 * for a flush-fill column without touching the streaming engine, SSE
 * loop, or tool-confirmation flow — all of that is preserved verbatim.
 *
 * Visibility:
 *   - Hidden below the `lg` breakpoint (1024px). On narrow viewports the
 *     active page reclaims the column width, and the chat surfaces via
 *     the mobile drawer (Phase 4 polish). For now, narrow-viewport users
 *     have no chat access on the doc surface — that's an accepted
 *     Phase 0 gap.
 *   - The column is 380px wide and shrink-0, so the centre page reflows
 *     naturally as the viewport changes.
 *
 * Spec:
 *  - `.claude/plans/snuggly-noodling-tiger.md` § Resolution C — wrap,
 *    don't reparent
 *  - `docs/architecture/features/doc.md` (Phase 0 plumbing section)
 *
 * [COMP:app-web/side-panel]
 */

import { FloatingChat } from "../chrome/floating-chat";
import type { ChatTargetPage } from "@/lib/chat-target";
import { useT } from "@/lib/i18n/client";

type Props = {
  workspaceId: string;
  assistantId: string;
  /** The page open on the doc — forwarded to the chat's context chip. */
  activePage?: ChatTargetPage | null;
};

export function DocSidePanel({ workspaceId, assistantId, activePage = null }: Props) {
  const t = useT().docPage;
  return (
    <aside
      aria-label={t.sidePanelAria}
      className="hidden lg:flex h-full w-[380px] shrink-0 flex-col border-l border-border bg-background"
    >
      <FloatingChat
        workspaceId={workspaceId}
        assistantId={assistantId}
        mode="side-panel"
        activePage={activePage}
      />
    </aside>
  );
}
