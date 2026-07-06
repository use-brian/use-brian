"use client";

/**
 * Home Dock — the single "Suggested for you" entry in the sidebar, pinned above
 * Favorites on the Home surface. Deliberately quiet: one row, a sparkle, and a
 * "needs you" count. The actual suggestions live in the content pane
 * (`SuggestedView`, the Home landing), not here - the sidebar stays Notion-calm.
 *
 * The badge is the live total of items waiting on the user — the sum of the
 * resolved dock's "Needs you" card counts (approvals + brain reviews +
 * autopilot), read off the workspace dock that `DocSidebarDataProvider` owns.
 * The server merge drops dead cards (the freshness contract), so a handled
 * item never keeps the badge inflated past the next revalidate; at zero (or
 * while the dock is unresolved) the badge hides entirely.
 *
 * Spec: docs/architecture/features/home-dock.md → Frontend.
 *
 * [COMP:app-web/home-dock]
 */

import Link from "next/link";
import { Sparkles } from "lucide-react";
import { useT, format } from "@/lib/i18n/client";
import { needsYouTotal } from "@/lib/api/home-dock";
import { useSidebarData } from "./doc-sidebar-data";

export function HomeDock({ workspaceId }: { workspaceId: string }) {
  const t = useT().docPage.suggested;
  const { dock } = useSidebarData();
  const needsYou = needsYouTotal(dock);
  return (
    <Link
      href={`/w/${workspaceId}/p`}
      className="group mb-1.5 flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-sidebar-accent"
    >
      <Sparkles className="size-4 shrink-0 text-primary" aria-hidden />
      <span className="flex-1 truncate text-[14px] font-medium text-sidebar-foreground">
        {t.sidebarEntry}
      </span>
      {needsYou > 0 && (
        <span
          aria-label={format(t.needsYouBadgeAria, { count: needsYou })}
          className="grid h-[18px] min-w-[18px] place-items-center rounded-[9px] bg-rose-500/15 px-1.5 text-[11px] font-bold text-rose-600 dark:text-rose-400"
        >
          {needsYou > 99 ? "99+" : needsYou}
        </span>
      )}
    </Link>
  );
}
