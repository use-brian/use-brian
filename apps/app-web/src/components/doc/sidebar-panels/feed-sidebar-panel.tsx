"use client";

/**
 * Feed sidebar panel — the grouped section sub-menu rendered in the left
 * sidebar when the active surface is Feed. Structure clones
 * `StudioSidebarPanel`.
 *
 * Two groups (docs/plans/feed-create-split.md D1):
 *   - **Create** — workspace-level rows (home / voice / drafts / inbox /
 *     ready). Fully usable with ZERO platform connections; the inbox row
 *     carries the cross-platform pending-approvals badge.
 *   - **Platforms** — one row per TARGET platform (Instagram / Threads / X /
 *     XHS) with a connection-state hint. A connected platform's row links to
 *     its insights and expands its sub-rows (insights / inspiration /
 *     connection / policy / settings) while the pathname is inside it; an
 *     unconnected row links to its connection page (connect entry for
 *     Threads/X, coming-soon stub for Instagram/XHS).
 *
 * The old single-platform picker pill died with the split — switching
 * platforms is just clicking another row. Profiles come from
 * `useSidebarData().feedProfiles` (the panel adds no second fetch).
 *
 * [COMP:app-web/sidebar-panel-feed]
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import {
  FEED_GROUPS,
  FEED_PLATFORMS,
  feedPath,
  feedPlatformFromPathname,
  isConnectableFeedPlatform,
  type FeedPlatform,
} from "@/lib/feed-nav";
import { fetchFeedApprovalsCount } from "@/lib/api/feed";
import { PlatformIcon } from "@/components/feed/platform-icon";
import { useSidebarData } from "@/components/doc/doc-sidebar-data";

export function FeedSidebarPanel({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const pathname = usePathname() ?? "";
  const { feedProfiles } = useSidebarData();
  const profiles = useMemo(() => feedProfiles ?? [], [feedProfiles]);
  const activePlatform = feedPlatformFromPathname(pathname);

  // ── Inbox badge (cross-platform pending approvals) ──────────────────────
  const assistantIds = useMemo(
    () => Array.from(new Set(profiles.map((p) => p.assistantId))),
    [profiles],
  );
  const [inboxCount, setInboxCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void fetchFeedApprovalsCount(assistantIds).then((n) => {
      if (!cancelled) setInboxCount(n);
    });
    return () => {
      cancelled = true;
    };
  }, [assistantIds, pathname]);

  const rowCls = (activeRow: boolean) =>
    cn(
      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
      activeRow
        ? "doc-nav-active font-medium text-sidebar-accent-foreground"
        : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
    );

  const createGroup = FEED_GROUPS[0];
  const platformSections = FEED_GROUPS[1].sections;

  return (
    <nav
      aria-label={t.feedPage.sectionsAriaLabel}
      className="flex flex-col gap-4 px-1 pt-1"
    >
      {/* ── Create ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-0.5">
        <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/45">
          {t.feedPage.groups[createGroup.key]}
        </div>
        <ul className="flex flex-col gap-0.5">
          {createGroup.sections.map((s) => {
            const href = feedPath(workspaceId, {
              segment: s.segment || undefined,
            });
            // The home row (bare `/feed`) is exact-match so it doesn't stay
            // lit on every child route.
            const activeRow =
              s.key === "home" ? pathname === href : pathname.startsWith(href);
            return (
              <li key={s.key}>
                <Link
                  href={href}
                  aria-current={activeRow ? "page" : undefined}
                  className={rowCls(activeRow)}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {t.feedPage.sections[s.key]}
                  </span>
                  {s.key === "inbox" && inboxCount > 0 ? (
                    <span
                      aria-label={t.feedPage.inboxBadgeAria.replace(
                        "{count}",
                        String(inboxCount),
                      )}
                      className="inline-flex min-w-[18px] shrink-0 items-center justify-center rounded-full bg-foreground px-1.5 text-[10px] font-semibold leading-[18px] text-background"
                    >
                      {inboxCount > 99 ? "99+" : inboxCount}
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>

      {/* ── Platforms ───────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-0.5">
        <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/45">
          {t.feedPage.groups.platforms}
        </div>
        <ul className="flex flex-col gap-0.5">
          {FEED_PLATFORMS.map((platform) => {
            const profile = profiles.find((p) => p.platform === platform);
            const connected = !!profile;
            const connectable = isConnectableFeedPlatform(platform);
            const href = feedPath(workspaceId, {
              platform,
              segment: connected ? "insights" : "connection",
            });
            const isOpen = activePlatform === platform;
            const statusLabel = connected
              ? `@${profile.platformHandle}`
              : connectable
                ? t.feedPage.platformStatusNotConnected
                : t.feedPage.platformStatusComingSoon;
            return (
              <li key={platform}>
                <Link
                  href={href}
                  aria-current={isOpen ? "page" : undefined}
                  className={rowCls(isOpen && !connected)}
                >
                  <PlatformAvatar platform={platform} dimmed={!connected} />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block truncate text-[13px]",
                        connected ? "font-medium" : "text-sidebar-foreground/70",
                      )}
                    >
                      {t.feedPage.platformLabels[platform]}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {statusLabel}
                    </span>
                  </span>
                  {connected ? (
                    <span
                      aria-hidden
                      className="size-1.5 shrink-0 rounded-full bg-emerald-500"
                    />
                  ) : null}
                </Link>
                {/* Sub-rows for the platform the user is inside, connected only. */}
                {isOpen && connected ? (
                  <ul className="mt-0.5 flex flex-col gap-0.5 pl-6">
                    {platformSections.map((s) => {
                      const subHref = feedPath(workspaceId, {
                        platform,
                        segment: s.segment,
                      });
                      const activeRow = pathname.startsWith(subHref);
                      return (
                        <li key={s.key}>
                          <Link
                            href={subHref}
                            aria-current={activeRow ? "page" : undefined}
                            className={rowCls(activeRow)}
                          >
                            <span className="min-w-0 flex-1 truncate">
                              {t.feedPage.sections[s.key]}
                            </span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}

function PlatformAvatar({
  platform,
  dimmed,
}: {
  platform: FeedPlatform;
  dimmed?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md",
        platform === "twitter"
          ? "bg-foreground text-background"
          : "bg-muted text-foreground/70",
        dimmed && "opacity-55",
      )}
    >
      <PlatformIcon platform={platform} className="size-3.5" />
    </span>
  );
}
