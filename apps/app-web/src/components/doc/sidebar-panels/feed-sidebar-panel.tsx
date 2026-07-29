"use client";

/**
 * Feed sidebar panel — the platform-led sub-nav (docs/plans/feed-revamp.md
 * §8a, D13/D14). Structure clones `StudioSidebarPanel`.
 *
 * Three groups, top to bottom, narrowing scope as you descend:
 *
 *   - **Company** — platform-agnostic work: the company voice every platform
 *     inherits, and the Plan calendar (which filters by platform *inside* the
 *     surface rather than splitting the nav).
 *   - **Platform** — a switcher, then that platform's voice. Everything below
 *     the switcher inherits it.
 *   - **Platform drafts** — the post list ITSELF, promoted out of the page and
 *     into the sidebar (D14). A compact status filter sits in the header so
 *     the list dominates, per the locked review-queue idiom; selecting a row
 *     opens the post in place in the main pane (D15).
 *
 * The hosted **Platforms** integration group (insights / inspiration /
 * connection / policy / settings) is unchanged and still last.
 *
 * [COMP:app-web/sidebar-panel-feed]
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Check, ChevronDown, Plus } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { isHostedEdition } from "@/lib/edition";
import { cn } from "@/lib/utils";
import {
  FEED_GROUPS,
  FEED_PLATFORMS,
  feedPath,
  feedPlatformFromPathname,
  feedPostIdFromPathname,
  feedPostPath,
  isConnectableFeedPlatform,
  resolveCurrentFeedPlatform,
  setCurrentFeedPlatform,
  type FeedPlatform,
} from "@/lib/feed-nav";
import {
  fetchFeedDistributionAssistants,
  fetchFeedDraftSessions,
  type FeedDraftSessionSummary,
} from "@/lib/api/feed";
import {
  POST_QUEUE_STATUSES,
  buildPostQueue,
  filterQueue,
  parseQueueFilter,
  type PostQueueFilter,
  type PostQueueItem,
} from "@/lib/feed-posts";
import { PlatformIcon } from "@/components/feed/platform-icon";
import { StatusDot } from "@/components/feed/feed-status";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSidebarData } from "@/components/doc/doc-sidebar-data";
import { FEED_POSTS_CHANGED_EVENT } from "@/lib/feed-posts-events";

export function FeedSidebarPanel({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const tf = t.feedPage;
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const { feedProfiles } = useSidebarData();
  const profiles = useMemo(() => feedProfiles ?? [], [feedProfiles]);
  const platformIntegrationsEnabled = isHostedEdition();

  // ── Current platform ────────────────────────────────────────────────────
  // The URL is authoritative AND available during render, so it resolves
  // synchronously: waiting for an effect would paint the wrong platform for a
  // frame on every `/feed/<platform>/…` route, and render it wrong on the
  // server. Only the localStorage fallback (used by Company routes, which
  // carry no platform) has to wait for mount.
  const urlPlatform = feedPlatformFromPathname(pathname);
  const [storedPlatform, setStoredPlatform] = useState<FeedPlatform | null>(
    null,
  );
  useEffect(() => {
    setStoredPlatform(
      resolveCurrentFeedPlatform({
        workspaceId,
        pathname: null,
        connectedPlatforms: profiles.map((p) => p.platform),
      }),
    );
  }, [workspaceId, profiles]);
  const platform = urlPlatform ?? storedPlatform ?? FEED_PLATFORMS[0];

  function switchPlatform(next: FeedPlatform) {
    setCurrentFeedPlatform(workspaceId, next);
    setStoredPlatform(next);
    // On a platform-scoped route the URL is authoritative, so switching has
    // to navigate or the sidebar would disagree with the pane.
    if (pathname.includes(`/feed/${platform}/`)) {
      router.push(pathname.replace(`/feed/${platform}/`, `/feed/${next}/`));
    }
  }

  // ── The post list (D14) ─────────────────────────────────────────────────
  const [assistantIds, setAssistantIds] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void fetchFeedDistributionAssistants(workspaceId).then((assistants) => {
      if (!cancelled) setAssistantIds(assistants.map((a) => a.id));
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const allAssistantIds = useMemo(() => {
    const ids = new Set(assistantIds);
    for (const profile of profiles) ids.add(profile.assistantId);
    return Array.from(ids);
  }, [assistantIds, profiles]);

  const [items, setItems] = useState<PostQueueItem[]>([]);
  const [filter, setFilter] = useState<PostQueueFilter>("all");

  // Seed the filter from `?status=` ONCE. The Approvals panel deep-links
  // `/feed/inbox`, which forwards here carrying the intent; after that the
  // operator owns the filter, so a later navigation must not yank it back.
  const searchParams = useSearchParams();
  const seededFilter = useRef(false);
  useEffect(() => {
    if (seededFilter.current) return;
    const fromUrl = searchParams.get("status");
    if (!fromUrl) return;
    seededFilter.current = true;
    setFilter(parseQueueFilter(fromUrl));
  }, [searchParams]);

  // Generation guard. The platform resolves in two steps (URL synchronously,
  // then the stored fallback), so two loads can be in flight at once — and
  // without this the SLOWER one wins, which showed an empty Instagram list
  // over the Threads posts that had already arrived.
  const loadGeneration = useRef(0);
  const loadPosts = useCallback(async () => {
    const generation = ++loadGeneration.current;
    if (allAssistantIds.length === 0) {
      if (generation === loadGeneration.current) setItems([]);
      return;
    }
    const perAssistant = await Promise.all(
      allAssistantIds.map(async (assistantId) => ({
        assistantId,
        sessions: await fetchFeedDraftSessions(assistantId, platform).catch(
          () => [] as FeedDraftSessionSummary[],
        ),
      })),
    );
    if (generation !== loadGeneration.current) return;
    setItems(buildPostQueue(perAssistant));
  }, [allAssistantIds, platform]);

  useEffect(() => {
    void loadPosts();
  }, [loadPosts]);

  // The pane creates, renames, and resolves posts. Without a signal the list
  // would only refresh on a full page load, because the sidebar never
  // unmounts (the persistent-layout rule in the root CLAUDE.md).
  useEffect(() => {
    const onChanged = () => void loadPosts();
    window.addEventListener(FEED_POSTS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(FEED_POSTS_CHANGED_EVENT, onChanged);
  }, [loadPosts]);

  const visible = useMemo(() => filterQueue(items, filter), [items, filter]);
  const activePostId = feedPostIdFromPathname(pathname);
  const reviewCount = useMemo(
    () => items.filter((i) => i.status === "review").length,
    [items],
  );

  const rowCls = (activeRow: boolean) =>
    cn(
      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
      activeRow
        ? "doc-nav-active font-medium text-sidebar-accent-foreground"
        : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
    );

  const groupLabelCls =
    "px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/45";

  const companyGroup = FEED_GROUPS[0];
  const platformGroup = FEED_GROUPS[1];
  const hostedSections = FEED_GROUPS[2].sections;

  return (
    <nav
      aria-label={tf.sectionsAriaLabel}
      className="flex flex-col gap-4 px-1 pt-1"
    >
      {/* ── Company ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-0.5">
        <div className={groupLabelCls}>{tf.groups.company}</div>
        <ul className="flex flex-col gap-0.5">
          {companyGroup.sections.map((s) => {
            const href = feedPath(workspaceId, {
              segment: s.segment || undefined,
            });
            // Exact-match: Plan owns the bare `/feed` index and would
            // otherwise stay lit on every child route.
            const activeRow = pathname === href;
            return (
              <li key={s.key}>
                <Link
                  href={href}
                  aria-current={activeRow ? "page" : undefined}
                  className={rowCls(activeRow)}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {tf.sections[s.key]}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>

      {/* ── Platform (switcher + that platform's voice) ──────────────────── */}
      <div className="flex flex-col gap-0.5">
        <div className={groupLabelCls}>{tf.groups.platform}</div>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={tf.platformPickerAria}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <PlatformIcon platform={platform} className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left font-medium">
              {tf.platformLabels[platform]}
            </span>
            <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44">
            {FEED_PLATFORMS.map((p) => {
              const connected = profiles.some((x) => x.platform === p);
              return (
                <DropdownMenuItem key={p} onClick={() => switchPlatform(p)}>
                  <PlatformIcon platform={p} className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    {tf.platformLabels[p]}
                  </span>
                  {connected ? (
                    <span className="text-[10px] text-muted-foreground">
                      {tf.platformStatusConnected}
                    </span>
                  ) : null}
                  {p === platform ? (
                    <Check className="size-3.5 shrink-0" aria-hidden />
                  ) : null}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
        <ul className="flex flex-col gap-0.5">
          {platformGroup.sections.map((s) => {
            const href = feedPath(workspaceId, {
              platform,
              segment: s.segment,
            });
            const activeRow = pathname === href;
            return (
              <li key={s.key}>
                <Link
                  href={href}
                  aria-current={activeRow ? "page" : undefined}
                  className={rowCls(activeRow)}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {tf.sections[s.key]}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>

      {/* ── Platform drafts: the post list itself (D14) ──────────────────── */}
      <div className="flex min-h-0 flex-col gap-0.5">
        <div className="flex items-center gap-1 pb-1 pl-1 pr-0.5">
          <span className={cn(groupLabelCls, "flex-1 p-0")}>
            {tf.groups.drafts}
          </span>
          {reviewCount > 0 ? (
            <span
              aria-label={tf.inboxBadgeAria.replace(
                "{count}",
                String(reviewCount),
              )}
              className="inline-flex min-w-[18px] shrink-0 items-center justify-center rounded-full bg-foreground px-1.5 text-[10px] font-semibold leading-[18px] text-background"
            >
              {reviewCount > 99 ? "99+" : reviewCount}
            </span>
          ) : null}
          {/* Compact filter, not a tall option list: the sidebar's job here
              is to LIST posts, so the filter collapses into its header. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={tf.posts.filterAria}
              className="inline-flex h-5 shrink-0 items-center gap-0.5 rounded px-1 text-[10px] font-medium uppercase tracking-wide text-sidebar-foreground/45 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              {filter === "all" ? tf.posts.filterAll : tf.posts.status[filter]}
              <ChevronDown className="size-3" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              <DropdownMenuItem onClick={() => setFilter("all")}>
                <span className="min-w-0 flex-1">{tf.posts.filterAll}</span>
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {items.length}
                </span>
              </DropdownMenuItem>
              {POST_QUEUE_STATUSES.map((status) => (
                <DropdownMenuItem key={status} onClick={() => setFilter(status)}>
                  <StatusDot status={status} />
                  <span className="min-w-0 flex-1">
                    {tf.posts.status[status]}
                  </span>
                  <span className="text-[10px] tabular-nums text-muted-foreground">
                    {items.filter((i) => i.status === status).length}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <ul className="flex flex-col gap-0.5">
          {visible.map((item) => {
            const href = feedPostPath(
              workspaceId,
              item.platform,
              item.sessionId,
            );
            const activeRow = activePostId === item.sessionId;
            return (
              <li key={item.sessionId}>
                <Link
                  href={href}
                  aria-current={activeRow ? "page" : undefined}
                  className={rowCls(activeRow)}
                >
                  <StatusDot status={item.status} />
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    {item.title}
                  </span>
                </Link>
              </li>
            );
          })}
          {visible.length === 0 ? (
            <li className="px-2 py-1.5 text-[12px] text-sidebar-foreground/45">
              {filter === "all" ? tf.posts.empty : tf.posts.emptyFiltered}
            </li>
          ) : null}
          <li>
            <Link
              href={feedPath(workspaceId, { platform, segment: "posts" })}
              className={cn(rowCls(false), "text-[13px]")}
            >
              <Plus className="size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{tf.posts.newPost}</span>
            </Link>
          </li>
        </ul>
      </div>

      {/* ── Platforms (hosted integration layer, unchanged) ──────────────── */}
      {platformIntegrationsEnabled ? (
        <div className="flex flex-col gap-0.5">
          <div className={groupLabelCls}>{tf.groups.platforms}</div>
          <ul className="flex flex-col gap-0.5">
            {FEED_PLATFORMS.map((p) => {
              const profile = profiles.find((x) => x.platform === p);
              const connected = !!profile;
              const connectable = isConnectableFeedPlatform(p);
              const href = feedPath(workspaceId, {
                platform: p,
                segment: connected ? "insights" : "connection",
              });
              const isOpen = pathname.startsWith(
                `${feedPath(workspaceId, { platform: p })}/`,
              );
              const statusLabel = connected
                ? `@${profile.platformHandle}`
                : connectable
                  ? tf.platformStatusNotConnected
                  : tf.platformStatusComingSoon;
              return (
                <li key={p}>
                  <Link
                    href={href}
                    aria-current={isOpen ? "page" : undefined}
                    className={rowCls(false)}
                  >
                    <PlatformAvatar platform={p} dimmed={!connected} />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block truncate text-[13px]",
                          connected
                            ? "font-medium"
                            : "text-sidebar-foreground/70",
                        )}
                      >
                        {tf.platformLabels[p]}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {statusLabel}
                      </span>
                    </span>
                    {connected ? (
                      // Muted rather than a saturated dot: the sidebar is warm
                      // grey chrome and a bright pip reads offbrand in it.
                      <span
                        aria-hidden
                        className="size-1.5 shrink-0 rounded-full bg-foreground/45"
                      />
                    ) : null}
                  </Link>
                  {isOpen && connected ? (
                    <ul className="mt-0.5 flex flex-col gap-0.5 pl-6">
                      {hostedSections.map((s) => {
                        const subHref = feedPath(workspaceId, {
                          platform: p,
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
                                {tf.sections[s.key]}
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
      ) : null}
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
