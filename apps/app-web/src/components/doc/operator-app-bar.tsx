"use client";

/**
 * Operator app-bar — the Home hub's second tier (tasks-operator-surface §2).
 *
 * Rendered by `DocSidebar` between the top icon row and the surface body
 * whenever the active surface belongs to an operator app (Page / Tasks /
 * CRM / Feed / Browsers / Chat) — the sidebar owns navigation in this design
 * language, so the app switcher lives here rather than as an extra chrome
 * band over the content pane.
 *
 * WHICH apps render is WORKSPACE CONFIG (`workspaces.home_apps`, migration
 * 385), passed down from `WorkspaceChrome` — which reads it from the
 * sidebar-data provider, the one place that owns both the fetch and the
 * `workspace_config` live repair. This component is deliberately dumb about
 * where the list came from. See docs/architecture/features/home-apps.md.
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
 * resume it later.
 *
 * The top icon row stays frozen at Home / Brain / Studio / Workflow; this
 * block is where the operator-app family grows.
 *
 * [COMP:app-web/operator-app-bar]
 */

import Link from "next/link";
import { useIntentPrefetch } from "@/lib/surface-prefetch";
import {
  CheckSquare,
  FileText,
  Files,
  Users,
  Megaphone,
  MessageSquare,
  MonitorPlay,
  Puzzle,
  type LucideIcon, ShoppingBag,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { Tooltip } from "@/components/ui/tooltip";
import {
  customHomeAppId,
  homeAppPath,
  isBuiltinHomeAppKey,
  isOperatorAppKey,
  writeOperatorApp,
  type HomeAppEntry,
  type OperatorAppKey,
} from "@/lib/operator-apps";
import type { CustomHomeApp } from "@/lib/api/home-apps";

/** App key → glyph — shared with the operator top bar's tab chip
 *  (`components/operator/operator-topbar.tsx`) so the app-bar entry and the
 *  chip can never drift. */
export const APP_ICON: Record<OperatorAppKey, LucideIcon> = {
  page: FileText,
  office: Files,
  tasks: CheckSquare,
  feed: Megaphone,
  crm: Users,
  browsers: MonitorPlay,
  chat: MessageSquare,
  shopify: ShoppingBag,
};

export function OperatorAppBar({
  workspaceId,
  active,
  homeApps,
  customApps,
}: {
  workspaceId: string;
  /**
   * The strip entry the current route belongs to — a built-in key or
   * `custom:<id>` — or `null` off the family (Brain / Studio / Workflow),
   * where the bar renders nothing at all. The switcher stays scoped to the
   * family: offering Page/Tasks/CRM/Feed from Studio would claim a
   * relationship the routes do not have.
   */
  active: HomeAppEntry | null;
  /**
   * The workspace's configured strip, in order (`workspaces.home_apps`).
   * Rendered as-is: the stored array order IS the strip order, dragged by an
   * owner/admin in Studio → Mini apps. Nothing here sorts it, so this array is
   * the only thing that decides what sits where.
   */
  homeApps: readonly HomeAppEntry[];
  /** The workspace's custom apps, for resolving `custom:<id>` entries. */
  customApps: readonly CustomHomeApp[];
}) {
  const t = useT().operatorBar;
  const intentPrefetch = useIntentPrefetch();
  const labels: Record<OperatorAppKey, string> = {
    page: t.page,
    office: t.office,
    tasks: t.tasks,
    feed: t.feed,
    crm: t.crm,
    browsers: t.browsers,
    chat: t.chat,
    shopify: t.shopify,
  };
  // Off the family the bar renders nothing (below). A `custom:<id>` entry
  // survives only if its row exists AND is renderable — which is how the T3
  // drift rule reaches the strip: an app whose re-synced manifest widened its
  // scopes drops to `needs_consent` and disappears here until re-granted. A
  // dangling entry from a deleted app is dropped by the same filter, so
  // neither leaves a dead square behind.
  const byId = new Map(customApps.map((a) => [a.id, a]));
  const apps: HomeAppEntry[] =
    active === null
      ? []
      : homeApps.filter((entry) => {
          if (isBuiltinHomeAppKey(entry)) return isOperatorAppKey(entry);
          const id = customHomeAppId(entry);
          return Boolean(id && byId.get(id)?.renderable);
        });
  // Off the operator family (Brain / Studio / Workflow) there is nothing to
  // switch between, so the bar renders nothing. The browser connect/reconnect
  // affordance that once kept an empty strip alive now lives in the Browsers
  // surface's own top bar (computer-use.md §5).
  if (apps.length === 0) return null;
  return (
    <nav
      aria-label={t.aria}
      // `pl-4`: indented under the Home pill — the strip reads as Home's
      // children, not a second toolbar.
      className="flex flex-row items-center gap-0.5 pl-4 pr-2 pb-1.5"
    >
      {apps.map((key) => {
        // A custom app's icon and label are WORKSPACE DATA (its manifest), not
        // i18n — the strip takes them verbatim, with `Puzzle` standing in for a
        // manifest icon this build's lucide set does not carry.
        const custom = isBuiltinHomeAppKey(key)
          ? null
          : byId.get(customHomeAppId(key) ?? '');
        const Icon = custom ? Puzzle : APP_ICON[key as OperatorAppKey];
        const label = custom ? custom.name : labels[key as OperatorAppKey];
        const isActive = key === active;
        const href = homeAppPath(workspaceId, key);
        return (
          <Tooltip key={key} label={label}>
            <Link
              href={href}
              // Hover/focus warms the route AND the app's landing list, so the
              // Tasks / CRM tables are usually already in cache on click.
              {...intentPrefetch(href)}
              aria-label={label}
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
