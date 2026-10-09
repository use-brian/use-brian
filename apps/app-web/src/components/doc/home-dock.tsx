"use client";

/**
 * Home Dock — the single "Suggested for you" entry in the sidebar, rendered
 * above Organization / Projects across workspace surfaces. Deliberately quiet: one row, a sparkle, and a "needs you"
 * count. The actual suggestions live at the explicit `/p?suggested=1` Page
 * content-pane route (`SuggestedView`), not here - the sidebar stays
 * Notion-calm.
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
import { suggestedPath } from "@/lib/suggested-landing";
import { useSidebarData } from "./doc-sidebar-data";

export function HomeDock({ workspaceId }: { workspaceId: string }) {
  const t = useT().docPage.suggested;
  const { dock } = useSidebarData();
  const needsYou = needsYouTotal(dock);
  if (!dock || (!dock.note?.trim() && needsYou === 0 && !dock.pickUp.length
    && !dock.comingUp.length && dock.brain.growth7d <= 0)) return null;
  return (
    <Link
      href={suggestedPath(workspaceId)}
      className="group min-h-7 max-md:min-h-11 flex items-center gap-2.5 rounded-md px-2 py-0.5 hover:bg-sidebar-accent"
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
