"use client";

/**
 * Operator app-bar — the Home hub's second tier (tasks-operator-surface §2).
 *
 * Rendered by `DocSidebar` between the top icon row and the surface body
 * whenever the active surface belongs to an operator app (Page / Tasks /
 * Feed) — the sidebar owns navigation in this design language, so the app
 * switcher lives here rather than as an extra chrome band over the content
 * pane.
 *
 * UI/UX (founder redesign 2026-07-22, settled after four iterations): a
 * **dock-style icon strip** — ONE fixed-height row of 28px icon squares
 * speaking the same grammar as the top icon row (same square size, same
 * hover wash, same `.doc-nav-active` active square), indented under Home
 * so it reads as Home's children. The active app's icon takes
 * `text-primary` — the strip's one color accent; labels live in hover
 * tooltips (the content pane's own header already names the active
 * surface). Rejected on the way here: grey label pills (double-pill
 * stutter under Home), an equal-segment control (labels truncate at 4+
 * apps), an expanding-chip track (washy three-grey mush), and vertical
 * nav rows (grow ~28px per app — sidebar height belongs to the surface
 * body). The strip is the only shape that stays fixed-height at ANY app
 * count (~8 fit before an overflow menu is worth building).
 *
 * Clicking a row navigates to that app's route AND persists the selection
 * per workspace (`writeOperatorApp`), so the top-row Home icon and ⌘/Ctrl+1
 * resume it later. Feed appears only while the workspace has connected
 * distribution profiles (`feedEnabled` — the same probe that used to gate
 * its top-row icon before it re-parented here).
 *
 * The top icon row stays frozen at Home / Brain / Studio / Workflow; this
 * block is where the operator-app family grows (CRM's slot is reserved).
 *
 * [COMP:app-web/operator-app-bar]
 */

import Link from "next/link";
import {
  CheckSquare,
  FileText,
  Handshake,
  Megaphone,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { Tooltip } from "@/components/ui/tooltip";
import {
  OPERATOR_APP_KEYS,
  operatorAppPath,
  writeOperatorApp,
  type OperatorAppKey,
} from "@/lib/operator-apps";

const APP_ICON: Record<OperatorAppKey, LucideIcon> = {
  page: FileText,
  tasks: CheckSquare,
  feed: Megaphone,
  crm: Handshake,
};

export function OperatorAppBar({
  workspaceId,
  active,
  feedEnabled,
}: {
  workspaceId: string;
  /** The operator app the current route belongs to. */
  active: OperatorAppKey;
  /** Whether the Feed app is available for this workspace. */
  feedEnabled: boolean;
}) {
  const t = useT().operatorBar;
  const labels: Record<OperatorAppKey, string> = {
    page: t.page,
    tasks: t.tasks,
    feed: t.feed,
    crm: t.crm,
  };
  const apps = OPERATOR_APP_KEYS.filter(
    (key) => key !== "feed" || feedEnabled,
  );
  return (
    <nav
      aria-label={t.aria}
      // `pl-4`: indented under the Home pill — the strip reads as Home's
      // children, not a second toolbar.
      className="flex flex-row items-center gap-0.5 pl-4 pr-2 pb-1.5"
    >
      {apps.map((key) => {
        const Icon = APP_ICON[key];
        const isActive = key === active;
        return (
          <Tooltip key={key} label={labels[key]}>
            <Link
              href={operatorAppPath(workspaceId, key)}
              aria-label={labels[key]}
              aria-current={isActive ? "page" : undefined}
              onClick={() => writeOperatorApp(workspaceId, key)}
              className={cn(
                "group flex size-7 shrink-0 items-center justify-center rounded-md transition-colors",
                isActive ? "doc-nav-active" : "hover:bg-sidebar-accent",
              )}
            >
              <Icon
                className={cn(
                  "size-4 shrink-0",
                  isActive
                    ? "text-primary"
                    : "text-sidebar-foreground/55 group-hover:text-sidebar-accent-foreground",
                )}
                strokeWidth={1.8}
                aria-hidden
              />
            </Link>
          </Tooltip>
        );
      })}
    </nav>
  );
}
