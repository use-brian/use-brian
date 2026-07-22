"use client";

/**
 * Cross-platform reminding-UX inbox — ported faithfully from
 * `apps/feed-web/src/app/w/[workspaceId]/inbox/page.tsx`
 * (docs/plans/feed-web-consolidation.md §7.2).
 *
 * Aggregates everything that wants the operator's attention across all
 * connected platforms — pending drafts today, future-extensible to any
 * notification surface. Each card links into the unified draft-sessions
 * surface so the operator finishes the workflow there.
 *
 * Sits at /w/[wid]/feed/inbox (team-level, alongside Voice), deliberately
 * separate from per-platform Drafts which scopes to one platform at a time.
 *
 * The card shell, masonry layout, and parent-post + reply-draft preview
 * tiles are deliberately the same primitives used on the draft-sessions
 * list so the two surfaces feel like the same product. The visual signal
 * that distinguishes them is uniformly action-required chrome (primary
 * tint, "Action needed" badge) — the inbox only ever shows pending items.
 *
 * Port deltas (disposition rules §6):
 *   - `useWorkspaceContext()` → `useFeedWorkspace()`; card hrefs are built
 *     via `feedPath()` so they land inside the Feed surface.
 *   - The approvals fetch + dismiss ride the feed SDK
 *     (`fetchFeedAssistantApprovals` keeps feed-web's `[]`-on-error panel
 *     degrade; `rejectFeedDraft` surfaces the server's error message).
 *   - feed-web's `useConfirm().confirmAsync` (in-dialog busy spinner) →
 *     the app-root `confirmDialog()` promise: the dialog closes on
 *     confirm and the in-flight state shows as the card's existing
 *     `dismissingId` fade instead.
 *   - Rows whose platform isn't a known `FeedPlatform` are dropped at
 *     load (type narrowing; the server enum makes this a no-op).
 *   - All copy via `useT().feedPage` (`inbox` + shared `home.time*` keys).
 *
 * [COMP:app-web/feed-inbox]
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Inbox as InboxIcon, Trash2 } from "lucide-react";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  fetchFeedAssistantApprovals,
  rejectFeedDraft,
  type FeedActivityEvent,
  type FeedProfile,
} from "@/lib/api/feed";
import { feedPath, isFeedPlatform, type FeedPlatform } from "@/lib/feed-nav";
import {
  PostDraftPreview,
  QuotedPostPreview,
  ReplyConnector,
} from "@/components/feed/native-post-embed";
import { ExternalPostCard } from "@/components/feed/external-post-card";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

type FeedPageDict = ReturnType<typeof useT>["feedPage"];

/** A pending approval row, narrowed to a known platform at load time. */
export type ApprovalEvent = FeedActivityEvent & { platform: FeedPlatform };

function isApprovalEvent(e: FeedActivityEvent): e is ApprovalEvent {
  return isFeedPlatform(e.platform);
}

type CardKind = "reply" | "original";

export function deriveKind(
  event: Pick<ApprovalEvent, "metadata">,
): CardKind {
  return event.metadata?.replyAuthor || event.metadata?.replyText
    ? "reply"
    : "original";
}

/**
 * Click destination. L0-human drafts carry the originating session id so
 * we deep-link to the unified session view; L5 pipeline drafts (no session)
 * fall back to the platform's drafts list where the operator can act.
 */
export function reminderHref(
  workspaceId: string,
  event: Pick<ApprovalEvent, "platform" | "metadata">,
): string {
  const base = feedPath(workspaceId, {
    platform: event.platform,
    segment: "draft-sessions",
  });
  const sessionId = event.metadata?.sessionId;
  return sessionId ? `${base}/${sessionId}` : base;
}

export function FeedInbox() {
  const team = useFeedWorkspace();
  const canDraft = team.canDraft;
  const t = useT().feedPage;

  const profilesByAssistant = useMemo(() => {
    const map = new Map<string, FeedProfile>();
    for (const p of team.profiles) map.set(p.assistantId, p);
    return map;
  }, [team.profiles]);

  const assistantIds = useMemo(
    () => Array.from(new Set(team.profiles.map((p) => p.assistantId))),
    [team.profiles],
  );

  const [items, setItems] = useState<ApprovalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | FeedPlatform>("all");
  // Optimistically hide a card while its DELETE-equivalent (POST .../reject)
  // is in flight so the row doesn't ghost between the click and refetch.
  const [dismissingId, setDismissingId] = useState<string | null>(null);

  const loadFailedCopy = t.inbox.loadFailed;
  const load = useCallback(async () => {
    if (assistantIds.length === 0) {
      setLoading(false);
      return;
    }
    setError(null);
    try {
      const all = await Promise.all(
        assistantIds.map((id) => fetchFeedAssistantApprovals(id, { limit: 50 })),
      );
      const merged = all
        .flat()
        .filter(isApprovalEvent)
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
      setItems(merged);
    } catch (err) {
      setError(err instanceof Error ? err.message : loadFailedCopy);
    } finally {
      setLoading(false);
    }
  }, [assistantIds, loadFailedCopy]);

  useEffect(() => {
    void load();
  }, [load]);

  // Dismiss = reject the underlying draft event. Permission mirrors the
  // backend (`verifyDraftPermission`): admin/owner OR member with
  // `can_draft=true`. The button is hidden when canDraft is false; the
  // backend re-checks regardless.
  const inboxCopy = t.inbox;
  const dismissItem = useCallback(
    async (event: ApprovalEvent) => {
      const ok = await confirmDialog({
        title: inboxCopy.confirmRemoveTitle,
        description: inboxCopy.confirmRemoveDescription,
        confirmLabel: inboxCopy.confirmRemoveLabel,
        variant: "destructive",
      });
      if (!ok) return;
      setDismissingId(event.id);
      setError(null);
      try {
        const result = await rejectFeedDraft(event.assistantId, event.id, {
          reason: "dismissed-from-inbox",
        });
        if (!result.ok) {
          setError(result.error ?? inboxCopy.removeFailed);
          return;
        }
        setItems((prev) => prev.filter((row) => row.id !== event.id));
      } catch {
        // Network failure — the row stays; the banner explains.
        setError(inboxCopy.removeFailed);
      } finally {
        setDismissingId(null);
      }
    },
    [inboxCopy],
  );

  const counts = useMemo(() => {
    const c: Record<FeedPlatform, number> = {
      instagram: 0,
      threads: 0,
      twitter: 0,
      xhs: 0,
    };
    for (const e of items) c[e.platform] += 1;
    return c;
  }, [items]);

  const visibleItems = useMemo(
    () => (filter === "all" ? items : items.filter((e) => e.platform === filter)),
    [items, filter],
  );

  // Responsive masonry column count. Mirrors the breakpoints used on the
  // draft-sessions list so the two surfaces share a visual cadence.
  const colCount = useColumnCount();

  // Round-robin distribute so reading order stays row-major (top-left
  // first) and each column flush-stacks — variable-height parent-post
  // embeds would otherwise create empty gutters on a CSS Grid.
  const columns = useMemo(() => {
    const cols: ApprovalEvent[][] = Array.from(
      { length: colCount },
      () => [],
    );
    visibleItems.forEach((s, i) => cols[i % colCount].push(s));
    return cols;
  }, [visibleItems, colCount]);

  // Filter chips: only show platform chips that have at least one item
  // somewhere — drives the "All / Threads / X" tab strip without leaking
  // platforms the team doesn't have connected.
  const platformChips = useMemo(() => {
    const list: Array<{ id: FeedPlatform; label: string; count: number }> = [];
    for (const platform of ["threads", "twitter"] as const) {
      if (counts[platform] > 0) {
        list.push({
          id: platform,
          label: t.platformLabels[platform],
          count: counts[platform],
        });
      }
    }
    return list;
  }, [counts, t.platformLabels]);

  return (
    <div className="px-4 md:px-6 py-5 max-w-7xl mx-auto space-y-5">
      <header className="space-y-2">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-primary/12 text-primary ring-1 ring-primary/20">
            <InboxIcon className="h-[18px] w-[18px]" strokeWidth={1.7} />
          </span>
          <h1
            className="text-[15px] font-semibold"          >
            {t.sections.inbox}
          </h1>
          {!loading && items.length > 0 ? (
            <span className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-2 rounded-full bg-muted text-foreground/70 text-xs font-semibold tabular-nums ring-1 ring-border">
              {items.length}
            </span>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed max-w-2xl">
          {t.inbox.subtitle}
        </p>
      </header>

      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive animate-pop-in">
          {error}
        </div>
      ) : null}

      {!loading && platformChips.length > 1 ? (
        <div
          role="tablist"
          aria-label={t.inbox.filterAria}
          className="flex flex-wrap items-center gap-1.5"
        >
          <FilterChip
            label={t.inbox.filterAll}
            count={items.length}
            active={filter === "all"}
            onClick={() => setFilter("all")}
          />
          {platformChips.map((c) => (
            <FilterChip
              key={c.id}
              label={c.label}
              count={c.count}
              active={filter === c.id}
              onClick={() => setFilter(c.id)}
            />
          ))}
        </div>
      ) : null}

      {loading ? (
        <InboxSkeleton />
      ) : items.length === 0 ? (
        <EmptyState />
      ) : visibleItems.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/40 p-8 text-center space-y-1.5 animate-fade-in">
          <p className="text-sm font-medium">{t.inbox.filterEmptyTitle}</p>
          <p className="text-xs text-muted-foreground">
            {t.inbox.filterEmptyBefore}{" "}
            <button
              type="button"
              onClick={() => setFilter("all")}
              className="text-primary hover:underline transition-colors"
            >
              {t.inbox.filterAll}
            </button>
            {t.inbox.filterEmptyAfter}
          </p>
        </div>
      ) : (
        <div
          // `key={filter}` re-mounts so `.animate-stagger` re-fires the
          // per-card rise-in when refiltering — without this the cards
          // snap into their new positions.
          key={filter}
          className="flex gap-3 items-start animate-stagger"
        >
          {columns.map((col, ci) => (
            <ul key={ci} className="flex-1 min-w-0 flex flex-col gap-3">
              {col.map((event) => {
                const profile = profilesByAssistant.get(event.assistantId);
                const isDismissing = dismissingId === event.id;
                return (
                  <li
                    key={event.id}
                    className={
                      "relative group transition-opacity " +
                      (isDismissing ? "opacity-50 pointer-events-none" : "")
                    }
                  >
                    <Link
                      href={reminderHref(team.workspaceId, event)}
                      className="block h-full rounded-xl border p-3 space-y-2.5 shadow-sm hover:shadow-md transition-colors bg-primary/[0.06] border-primary/25 hover:bg-primary/[0.10] hover:border-primary/40"
                    >
                      <CardHeader event={event} />
                      <CardBody event={event} profile={profile ?? null} />
                      <CardFooter event={event} />
                    </Link>
                    {canDraft ? (
                      <button
                        type="button"
                        title={t.inbox.removeFromInbox}
                        aria-label={t.inbox.removeFromInbox}
                        onClick={(e) => {
                          // Sibling-of-Link, not a descendant — preventDefault
                          // is belt-and-braces in case event ordering changes.
                          e.preventDefault();
                          e.stopPropagation();
                          void dismissItem(event);
                        }}
                        disabled={isDismissing}
                        className="absolute top-2 right-2 h-6 w-6 inline-flex items-center justify-center rounded-md bg-card/90 backdrop-blur-sm text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity disabled:opacity-50"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ))}
        </div>
      )}
    </div>
  );
}

function CardHeader({ event }: { event: ApprovalEvent }) {
  const t = useT().feedPage;
  const kind = deriveKind(event);
  const isX = event.platform === "twitter";
  return (
    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <div className="flex items-center gap-1.5 min-w-0">
        <span
          className={
            "inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-[10px] font-semibold ring-1 ring-inset " +
            (isX
              ? "bg-foreground text-background ring-foreground/20"
              : "bg-muted text-foreground/70 ring-border")
          }
        >
          <span aria-hidden>{isX ? "X" : "@"}</span>
          {t.platformLabels[event.platform]}
        </span>
        <KindBadge kind={kind} />
      </div>
      <span className="shrink-0 tabular-nums">
        {timeAgo(t.home, new Date(event.createdAt).getTime())}
      </span>
    </div>
  );
}

function CardBody({
  event,
  profile,
}: {
  event: ApprovalEvent;
  profile: FeedProfile | null;
}) {
  const t = useT().feedPage;
  const draftText = event.metadata?.draftText ?? "";
  const replyAuthor = event.metadata?.replyAuthor ?? null;
  const replyText = event.metadata?.replyText ?? null;
  const replyPermalink = event.metadata?.replyPermalink ?? null;
  const teamHandle = profile?.platformHandle ?? t.inbox.youHandle;
  const teamAvatar = profile?.profilePictureUrl ?? null;

  if (deriveKind(event) === "reply") {
    return (
      <div>
        {replyPermalink && profile ? (
          // Cached structured embed — same path the draft-sessions list
          // uses so the parent post renders the moment the row paints
          // (with seed text/handle hints in flight).
          <ExternalPostCard
            assistantId={event.assistantId}
            platform={event.platform}
            permalink={replyPermalink}
            fallbackAuthorHandle={replyAuthor}
            fallbackText={replyText}
          />
        ) : (
          // No permalink (older inspiration-seeded sessions, or pipeline
          // drafts) — fall back to the static QuotedPostPreview tile so we
          // still show *what we're replying to* before the team's draft.
          <QuotedPostPreview
            platform={event.platform}
            authorHandle={replyAuthor ?? t.postEmbed.unknownHandle}
            text={replyText ?? ""}
            permalink={null}
          />
        )}
        <ReplyConnector />
        {draftText ? (
          <PostDraftPreview
            platform={event.platform}
            authorHandle={teamHandle}
            avatarUrl={teamAvatar}
            text={draftText}
            compact
          />
        ) : (
          <div className="px-1 pt-0.5 text-[12px] text-muted-foreground italic">
            {t.inbox.noReplyDrafted}
          </div>
        )}
      </div>
    );
  }

  // Original post — no reply target. Just the team's draft tile.
  if (draftText) {
    return (
      <PostDraftPreview
        platform={event.platform}
        authorHandle={teamHandle}
        avatarUrl={teamAvatar}
        text={draftText}
      />
    );
  }
  return (
    <p className="text-xs text-muted-foreground italic">
      {t.inbox.noDraftText}
    </p>
  );
}

function CardFooter({ event }: { event: ApprovalEvent }) {
  const t = useT().feedPage;
  const replyAuthor = event.metadata?.replyAuthor;
  const subtitle = replyAuthor
    ? format(t.inbox.replyToAuthor, { author: replyAuthor })
    : t.inbox.newPost;
  return (
    <div className="flex items-center justify-between gap-2 pt-0.5">
      <span className="text-[11px] text-muted-foreground/80 truncate">
        {subtitle}
      </span>
      <span className="inline-flex items-center gap-1 rounded-full px-2 h-5 text-[10px] font-semibold uppercase tracking-wide shrink-0 bg-primary/15 text-primary ring-1 ring-primary/30">
        {t.inbox.actionNeeded}
      </span>
    </div>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={
        "inline-flex items-center gap-1.5 rounded-full px-3 h-7 text-xs font-medium transition-colors " +
        (active
          ? "bg-primary text-primary-foreground"
          : "bg-card border border-border text-muted-foreground hover:text-foreground hover:bg-accent")
      }
    >
      {label}
      <span className={"tabular-nums " + (active ? "opacity-90" : "opacity-60")}>
        {count}
      </span>
    </button>
  );
}

const KIND_BADGE_CLASS: Record<CardKind, string> = {
  reply: "bg-primary/10 text-primary ring-1 ring-primary/25",
  original: "bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/30",
};

function KindBadge({ kind }: { kind: CardKind }) {
  const t = useT().feedPage;
  const label = kind === "reply" ? t.inbox.kindReply : t.inbox.kindOriginal;
  return (
    <span
      className={
        "inline-flex items-center rounded-full px-2 h-5 text-[10px] font-semibold uppercase tracking-wide " +
        KIND_BADGE_CLASS[kind]
      }
    >
      {label}
    </span>
  );
}

function EmptyState() {
  const t = useT().feedPage;
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/40 p-10 text-center space-y-2 animate-pop-in">
      <div className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-muted/60 text-muted-foreground mx-auto">
        <InboxIcon className="h-5 w-5" strokeWidth={1.6} />
      </div>
      <p className="text-sm font-medium">{t.inbox.emptyTitle}</p>
      <p className="text-xs text-muted-foreground max-w-sm mx-auto">
        {t.inbox.emptyBody}
      </p>
    </div>
  );
}

function InboxSkeleton() {
  return (
    <ul className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-3">
      {[1, 2, 3, 4].map((i) => (
        <li
          key={i}
          className="rounded-xl border border-primary/15 bg-primary/[0.04] p-3 animate-pulse space-y-2"
        >
          <div className="flex items-center justify-between">
            <div className="h-4 w-24 bg-muted rounded" />
            <div className="h-3 w-12 bg-muted rounded" />
          </div>
          <div className="h-20 w-full bg-muted/60 rounded-md" />
          <div className="h-3 w-2/3 bg-muted rounded" />
        </li>
      ))}
    </ul>
  );
}

/**
 * Tracks active masonry column count via `matchMedia`, mirroring the
 * Tailwind `lg` (1024px) and `2xl` (1536px) breakpoints used by the
 * draft-sessions list so the two surfaces respond at the same widths.
 * Initial SSR render uses `1`; the page is client-fetched, so the SSR
 * markup is the loading skeleton, not the cards.
 */
function useColumnCount(): number {
  const [count, setCount] = useState(1);
  useEffect(() => {
    const mqLg = window.matchMedia("(min-width: 1024px)");
    const mq2xl = window.matchMedia("(min-width: 1536px)");
    const update = () => {
      if (mq2xl.matches) setCount(3);
      else if (mqLg.matches) setCount(2);
      else setCount(1);
    };
    update();
    mqLg.addEventListener("change", update);
    mq2xl.addEventListener("change", update);
    return () => {
      mqLg.removeEventListener("change", update);
      mq2xl.removeEventListener("change", update);
    };
  }, []);
  return count;
}

function timeAgo(t: FeedPageDict["home"], ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return t.timeJustNow;
  const min = Math.floor(diff / 60_000);
  if (min < 60) return format(t.timeMinutesAgo, { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return format(t.timeHoursAgo, { count: hr });
  return format(t.timeDaysAgo, { count: Math.floor(hr / 24) });
}
