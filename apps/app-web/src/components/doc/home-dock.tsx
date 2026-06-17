"use client";

/**
 * Home Dock — the single "Suggested for you" entry in the sidebar, pinned above
 * Favorites on the Home surface. Deliberately quiet: one row, a sparkle, and a
 * "needs you" count. The actual suggestions live in the content pane
 * (`SuggestedView`, the Home landing), not here - the sidebar stays Notion-calm.
 *
 * Design: docs/plans/home-dock.md + docs/plans/mockups/home-suggested.html.
 *
 * ⚠️ PREVIEW / MOCK ONLY. The count is hard-coded; real value comes from live
 * signals (plan §3-§5). Copy moves to en/ja/zh via useT() before ship.
 *
 * [COMP:app-web/home-dock] (mock)
 */

import Link from "next/link";
import { Sparkles } from "lucide-react";

export function HomeDock({ workspaceId }: { workspaceId: string }) {
  // mock: number of "needs you" items the assistant flagged.
  const needsYou = 3;
  return (
    <Link
      href={`/w/${workspaceId}/p`}
      className="group mb-1.5 flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-sidebar-accent"
    >
      <Sparkles className="size-4 shrink-0 text-primary" aria-hidden />
      <span className="flex-1 truncate text-[14px] font-medium text-sidebar-foreground">
        Suggested for you
      </span>
      {needsYou > 0 && (
        <span className="grid h-[18px] min-w-[18px] place-items-center rounded-[9px] bg-rose-500/15 px-1.5 text-[11px] font-bold text-rose-600 dark:text-rose-400">
          {needsYou}
        </span>
      )}
    </Link>
  );
}
