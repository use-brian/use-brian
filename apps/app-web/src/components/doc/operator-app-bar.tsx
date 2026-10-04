"use client";

/** Home mini apps below primary navigation. Selecting a project
 * does not scope these routes. [COMP:app-web/operator-app-bar] */

import Link from "next/link";
import { surfaceFromPathname } from "@/lib/doc-page-url";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
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
  type LucideIcon, ShoppingBag, Ticket,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { Tooltip } from "@/components/ui/tooltip";
import {
  operatorAppFromSurface,
  customHomeAppId,
  homeAppBasePath,
  homeAppPath,
  isHomeAppPath,
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
  association: Ticket,
};

export function OperatorAppBar({
  workspaceId,
  active,
  homeApps,
  customApps,
}: {
  workspaceId: string;
  /** Null outside mini apps: show workspace destinations without a selection. */
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
  const pathname = usePathname();
  // `homeAppPath` reads localStorage. Keep the hydration frame on deterministic
  // base paths, then resolve cached locations after mount.
  const [locationsReady, setLocationsReady] = useState(false);
  useEffect(() => setLocationsReady(true), []);
  // Home contains the built-in operator surfaces and custom apps.
  const surface = surfaceFromPathname(pathname);
  if (!operatorAppFromSurface(surface) && surface !== "apps") return null;
  const labels: Record<OperatorAppKey, string> = {
    page: t.page,
    office: t.office,
    tasks: t.tasks,
    feed: t.feed,
    crm: t.crm,
    browsers: t.browsers,
    chat: t.chat,
    shopify: t.shopify,
    association: t.association,
  };
  // A `custom:<id>` entry
  // survives only if its row exists AND is renderable — which is how the T3
  // drift rule reaches the strip: an app whose re-synced manifest widened its
  // scopes drops to `needs_consent` and disappears here until re-granted. A
  // dangling entry from a deleted app is dropped by the same filter, so
  // neither leaves a dead square behind.
  const byId = new Map(customApps.map((a) => [a.id, a]));
  const apps: HomeAppEntry[] =
    homeApps.filter((entry) => {
          if (isBuiltinHomeAppKey(entry)) return isOperatorAppKey(entry);
          const id = customHomeAppId(entry);
          return Boolean(id && byId.get(id)?.renderable);
        });
  if (apps.length === 0) return null;
  return (
    <div className="shrink-0 border-t border-sidebar-border/60 px-2 pt-2 pb-1.5">
      <p className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-sidebar-foreground/55">{t.workspaceApps}</p>
    <nav
      aria-label={t.aria}
      className="flex flex-row flex-wrap items-center gap-0.5"
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
        const href = locationsReady
          ? key === active && pathname && isHomeAppPath(workspaceId, key, pathname)
            ? pathname
            : homeAppPath(workspaceId, key)
          : homeAppBasePath(workspaceId, key);
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
                // 44px on a phone (responsive contract M3); the strip wraps there.
                "group flex size-11 shrink-0 items-center justify-center rounded-md transition-colors md:size-7",
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
    </div>
  );
}
