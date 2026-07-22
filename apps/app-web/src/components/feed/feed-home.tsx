"use client";

/**
 * Feed home — the team dashboard, ported faithfully from
 * `apps/feed-web/src/app/w/[workspaceId]/page.tsx`
 * (docs/plans/feed-web-consolidation.md §7.1): connected-accounts stat cards,
 * per-platform quick links, and a live "Recent activity" list; a zero-profile
 * connect-account onboarding state.
 *
 * Port deltas (disposition rules §6):
 *   - `useWorkspaceContext()` → `useFeedWorkspace()`; every link is built via
 *     `feedPath()` so it lands inside the Feed surface.
 *   - Distribution fetches ride the feed SDK (`@/lib/api/feed`), which keeps
 *     feed-web's degrade-to-empty contract for a failed panel.
 *   - The live activity feed rides the shared `openFeedStream` (EventSource,
 *     `[COMP:app-web/feed-sse]`) instead of feed-web's inline fetch-stream
 *     SSE parser; rows older than mount are dropped client-side to preserve
 *     feed-web's `since=now` "fresh rows only" semantics (the initial fetch
 *     owns the backlog), deduped by id.
 *   - `?connected=<platform>` OAuth landing: success banner (inline, app-web
 *     has no global toast), a one-shot `refresh()` so the new profile appears
 *     without a reload, and the feed-web 4s `router.replace` back to the
 *     clean feed home.
 *   - All copy via `useT().feedPage.home`.
 *
 * [COMP:app-web/feed-home]
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { Inbox, MessageSquare, Settings as SettingsIcon, ArrowUpRight, Plus } from "lucide-react";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
import { authFetch } from "@/lib/auth-fetch";
import {
  fetchFeedAssistantApprovals,
  fetchFeedAssistantEvents,
  type FeedActivityEvent,
  type FeedProfile,
} from "@/lib/api/feed";
import { openFeedStream } from "@/lib/feed-sse";
import {
  FEED_PLATFORMS,
  feedPath,
  getFeedPlatformPick,
  isFeedPlatform,
  setFeedPlatformPick,
  type FeedPlatform,
} from "@/lib/feed-nav";
import { CardSkeletonList, Skeleton } from "@/components/skeleton";
import { PlatformIcon } from "@/components/feed/platform-icon";
import { useConnectAccount } from "@/components/feed/connect-account-dialog";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

const RECENT_LIMIT = 12;

type FeedPageDict = ReturnType<typeof useT>["feedPage"];

type PlatformStats = {
  pending: number;
  postedRecent: number;
};

const ACTIVITY_TYPES = [
  "drafted",
  "posted-reply",
  "post-created",
  "reply-received",
  "mention-received",
  "quote-received",
] as const;
const ACTIVITY_TYPE_SET: ReadonlySet<string> = new Set(ACTIVITY_TYPES);

function eventTypeLabel(t: FeedPageDict["home"], eventType: string): string {
  const labels: Record<string, string> = {
    drafted: t.eventTypes.drafted,
    "posted-reply": t.eventTypes.postedReply,
    "post-created": t.eventTypes.postCreated,
    "reply-received": t.eventTypes.replyReceived,
    "mention-received": t.eventTypes.mentionReceived,
    "quote-received": t.eventTypes.quoteReceived,
  };
  return labels[eventType] ?? eventType;
}

export function FeedHome() {
  const team = useFeedWorkspace();
  const { openConnect, dialog, isAdmin } = useConnectAccount();

  // `?connected=<platform>` — the OAuth callback landing. Refresh profiles
  // once so the fresh connection shows without a reload, then replace the
  // param away after the banner's 4s (feed-web's timing).
  const searchParams = useSearchParams();
  const router = useRouter();
  const connectedParam = searchParams.get("connected");
  const connected: FeedPlatform | null = isFeedPlatform(connectedParam)
    ? connectedParam
    : null;
  const refreshedRef = useRef(false);
  const refresh = team.refresh;
  useEffect(() => {
    if (!connected || refreshedRef.current) return;
    refreshedRef.current = true;
    void refresh();
  }, [connected, refresh]);
  useEffect(() => {
    if (!connected) return;
    const t = setTimeout(() => router.replace(feedPath(team.workspaceId)), 4000);
    return () => clearTimeout(t);
  }, [connected, router, team.workspaceId]);

  return (
    <>
      {dialog}
      {team.profiles.length === 0 ? (
        <EmptyHome onConnect={openConnect} canConnect={isAdmin} />
      ) : (
        <DashboardHome onConnect={openConnect} canConnect={isAdmin} connected={connected} />
      )}
    </>
  );
}

function DashboardHome(props: {
  onConnect: () => void;
  canConnect: boolean;
  connected: FeedPlatform | null;
}) {
  const { onConnect, canConnect, connected } = props;
  const team = useFeedWorkspace();
  const t = useT().feedPage;
  const [statsByAssistant, setStatsByAssistant] = useState<Record<string, PlatformStats>>({});
  const [recent, setRecent] = useState<FeedActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const uniqueAssistantIds = Array.from(
          new Set(team.profiles.map((p) => p.assistantId)),
        );
        const stats: Record<string, PlatformStats> = {};
        const allRecent: FeedActivityEvent[] = [];

        await Promise.all(
          uniqueAssistantIds.map(async (assistantId) => {
            const [pending, recentEvents, posted] = await Promise.all([
              fetchFeedAssistantApprovals(assistantId, { limit: 200 }),
              fetchFeedAssistantEvents(assistantId, {
                limit: 20,
                eventTypes: ACTIVITY_TYPES,
              }),
              fetchFeedAssistantEvents(assistantId, {
                limit: 200,
                eventTypes: ["post-created", "posted-reply"],
              }),
            ]);

            stats[assistantId] = {
              pending: pending.length,
              postedRecent: posted.filter(
                (e) => Date.now() - new Date(e.createdAt).getTime() < 7 * 24 * 60 * 60 * 1000,
              ).length,
            };
            allRecent.push(...recentEvents);
          }),
        );

        if (cancelled) return;
        setStatsByAssistant(stats);
        setRecent(
          allRecent
            .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
            .slice(0, RECENT_LIMIT),
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [team.profiles]);

  // Live "Recent activity" — subscribe to the workspace feed-events SSE and
  // prepend each new actionable event as it lands. The initial fetch above
  // owns the backlog, so rows older than mount are dropped (feed-web passed
  // `since=now`; EventSource replays the server's default window) and rows
  // are deduped by id. Reconnects ride EventSource's built-in backoff.
  useEffect(() => {
    const mountedAt = Date.now();
    const handle = openFeedStream({
      workspaceId: team.workspaceId,
      onEvent: (row) => {
        if (!row.id || !ACTIVITY_TYPE_SET.has(row.eventType)) return;
        if (new Date(row.createdAt).getTime() < mountedAt) return;
        const event: FeedActivityEvent = {
          id: row.id,
          assistantId: row.assistantId,
          platform: row.platform,
          eventType: row.eventType,
          metadata: (row.metadata ?? null) as FeedActivityEvent["metadata"],
          createdAt: row.createdAt,
        };
        setRecent((prev) => {
          if (prev.some((e) => e.id === event.id)) return prev;
          return [event, ...prev].slice(0, RECENT_LIMIT);
        });
      },
    });
    return () => {
      handle.close();
    };
  }, [team.workspaceId]);

  const totalPending = Object.values(statsByAssistant).reduce(
    (acc, s) => acc + s.pending,
    0,
  );
  const totalPostedWeek = Object.values(statsByAssistant).reduce(
    (acc, s) => acc + s.postedRecent,
    0,
  );

  return (
    <div className="px-4 md:px-6 py-5 max-w-7xl mx-auto space-y-6">
      <header className="space-y-1.5">
        <h1
          className="text-3xl font-bold tracking-tight"        >
          {team.name}
        </h1>
        <p className="text-sm text-muted-foreground" style={{ animationDelay: "60ms" }}>
          {format(
            team.profiles.length === 1 ? t.home.subtitleOne : t.home.subtitle,
            { count: team.profiles.length, role: t.home.roles[team.role] },
          )}
        </p>
      </header>

      {connected ? (
        <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-3 text-sm text-emerald-300">
          {format(t.home.connectedBanner, { platform: t.platformLabels[connected] })}
        </div>
      ) : null}

      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3 animate-stagger">
        <StatCard
          label={t.home.statPendingLabel}
          value={loading ? "" : totalPending}
          loading={loading}
          hint={t.home.statPendingHint}
          accent={totalPending > 0 ? "warn" : "muted"}
        />
        <StatCard
          label={t.home.statPostedLabel}
          value={loading ? "" : totalPostedWeek}
          loading={loading}
          hint={t.home.statPostedHint}
          accent="muted"
        />
        <StatCard
          label={t.home.statAccountsLabel}
          value={team.profiles.length}
          hint={team.profiles.map((p) => t.platformLabels[p.platform]).join(" · ")}
          accent="muted"
        />
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {t.home.platformsHeading}
          </h2>
          {canConnect ? (
            <button
              type="button"
              onClick={onConnect}
              className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary hover:underline transition-colors"
            >
              <Plus className="h-3 w-3" /> {t.home.addAnother}
            </button>
          ) : null}
        </div>
        <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 animate-stagger">
          {team.profiles.map((profile) => {
            const stats = statsByAssistant[profile.assistantId];
            return (
              <PlatformCard
                key={`${profile.assistantId}-${profile.platform}`}
                workspaceId={team.workspaceId}
                profile={profile}
                pending={stats?.pending}
              />
            );
          })}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {t.home.recentHeading}
        </h2>
        {loading ? (
          <CardSkeletonList count={4} lines={1} />
        ) : recent.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-card/40 p-8 text-center text-sm text-muted-foreground">
            {t.home.recentEmpty}
          </div>
        ) : (
          <ul className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden animate-stagger">
            {recent.map((event) => (
              <ActivityRow key={event.id} event={event} workspaceId={team.workspaceId} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function StatCard(props: {
  label: string;
  value: number | string;
  hint: string;
  accent: "warn" | "muted";
  loading?: boolean;
}) {
  const valueColor = props.accent === "warn" ? "text-amber-500 dark:text-amber-300" : "text-foreground";
  return (
    <div className="relative rounded-xl border border-border/60 bg-card p-4 shadow-xs">
      <div className="relative">
        <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          {props.label}
        </div>
        {props.loading ? (
          <Skeleton className="mt-2.5 h-8 w-16" />
        ) : (
          <div
            className={`mt-2 text-3xl font-bold tabular-nums ${valueColor}`}
           
          >
            {props.value}
          </div>
        )}
        <div className="mt-1 text-xs text-muted-foreground">{props.hint}</div>
      </div>
    </div>
  );
}

function PlatformCard(props: {
  workspaceId: string;
  profile: FeedProfile;
  pending: number | undefined;
}) {
  const { workspaceId, profile, pending } = props;
  const t = useT().feedPage;
  const label = t.platformLabels[profile.platform];
  const isX = profile.platform === "twitter";
  return (
    <li className="rounded-xl border border-border/60 bg-card p-4 space-y-3 shadow-xs transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span
            className={
              "inline-flex h-9 w-9 items-center justify-center rounded-xl text-xs font-semibold shrink-0 ring-1 ring-inset " +
              (isX
                ? "bg-foreground text-background ring-foreground/20"
                : "bg-muted text-foreground/70 ring-border")
            }
          >
            {isX ? "X" : "@"}
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold leading-tight">{label}</div>
            <div className="text-xs text-muted-foreground mt-0.5 truncate">
              @{profile.platformHandle}
            </div>
          </div>
        </div>
        <span
          className={
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium " +
            (profile.enabled
              ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/25"
              : "bg-amber-500/15 text-amber-300 ring-1 ring-amber-400/25")
          }
        >
          <span
            className={
              "h-1.5 w-1.5 rounded-full " +
              (profile.enabled ? "bg-emerald-400 animate-pulse-soft" : "bg-amber-400")
            }
          />
          {profile.enabled ? t.home.live : t.home.paused}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-1.5 text-xs">
        <QuickLink
          href={feedPath(workspaceId, { segment: "inbox" })}
          icon={<Inbox className="h-3.5 w-3.5" />}
          label={t.home.quickInbox}
          badge={pending && pending > 0 ? pending : undefined}
        />
        <QuickLink
          href={feedPath(workspaceId, { platform: profile.platform, segment: "policy" })}
          icon={<MessageSquare className="h-3.5 w-3.5" />}
          label={t.home.quickPolicy}
        />
        <QuickLink
          href={feedPath(workspaceId, { platform: profile.platform, segment: "connection" })}
          icon={<SettingsIcon className="h-3.5 w-3.5" />}
          label={t.home.quickConnect}
        />
      </div>
    </li>
  );
}

function QuickLink(props: {
  href: string;
  icon: React.ReactNode;
  label: string;
  badge?: number;
}) {
  return (
    <Link
      href={props.href}
      className="group relative flex flex-col items-center gap-1 rounded-lg border border-border/60 bg-background/40 px-2 py-2 hover:bg-accent hover:border-primary/40 hover:text-foreground active:bg-accent/80 transition-all duration-200 press"
    >
      <span className="text-muted-foreground group-hover:text-primary transition-colors">
        {props.icon}
      </span>
      <span>{props.label}</span>
      {props.badge ? (
        <span className="absolute -top-1.5 -right-1.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-background ring-2 ring-card">
          {props.badge > 99 ? "99+" : props.badge}
        </span>
      ) : null}
    </Link>
  );
}

function ActivityRow({ event, workspaceId }: { event: FeedActivityEvent; workspaceId: string }) {
  const t = useT().feedPage;
  const text =
    event.metadata?.text ??
    event.metadata?.draftText ??
    event.metadata?.replyText ??
    t.home.noText;
  const platform = isFeedPlatform(event.platform) ? event.platform : null;
  const platformLabel = platform ? t.platformLabels[platform] : event.platform;
  const inboxHref = feedPath(workspaceId, { segment: "inbox" });
  const sessionsBase = platform
    ? feedPath(workspaceId, { platform, segment: "draft-sessions" })
    : null;
  const draftedHref = sessionsBase
    ? event.metadata?.sessionId
      ? `${sessionsBase}/${event.metadata.sessionId}`
      : sessionsBase
    : inboxHref;
  const href =
    event.eventType === "drafted"
      ? draftedHref
      : event.eventType.includes("posted") || event.eventType === "post-created"
        ? sessionsBase
          ? event.metadata?.sessionId
            ? `${sessionsBase}/${event.metadata.sessionId}`
            : `${sessionsBase}?filter=posted`
          : inboxHref
        : inboxHref;

  return (
    <li>
      <Link
        href={href}
        className="group flex items-start justify-between gap-3 px-4 py-3 hover:bg-accent/50 active:bg-accent/70 transition-colors"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground tracking-wide">
            <span>{eventTypeLabel(t.home, event.eventType)}</span>
            <span aria-hidden>·</span>
            <span>{platformLabel}</span>
          </div>
          <div className="text-sm mt-0.5 line-clamp-2">{text}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {timeAgo(t.home, event.createdAt)}
          </span>
          <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-200" />
        </div>
      </Link>
    </li>
  );
}

function timeAgo(t: FeedPageDict["home"], iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return t.timeJustNow;
  if (min < 60) return format(t.timeMinutesAgo, { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return format(t.timeHoursAgo, { count: hr });
  const day = Math.floor(hr / 24);
  if (day < 7) return format(t.timeDaysAgo, { count: day });
  return new Date(iso).toLocaleDateString();
}

/**
 * Zero-profile home. Create-first (feed-create-split.md D7): with no brand
 * voice yet, an admin names one and it's created via the plain assistants
 * endpoint — the exact call the connect dialog makes before OAuth, minus the
 * OAuth. With a brand voice but no connection, point at Drafts (drafting
 * needs no connection); connecting stays available as the secondary path.
 */
function EmptyHome({ onConnect, canConnect }: { onConnect: () => void; canConnect: boolean }) {
  const t = useT().feedPage;
  const team = useFeedWorkspace();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const brand = team.assistants[0] ?? null;

  // Guided first-run step 2 (feed-create-split.md D14): once the brand
  // assistant exists, pick the platform(s) the brand posts on. The pick is a
  // per-device localStorage default read by the Drafts/Voice pages; reading
  // it in an effect keeps the SSR and first client paint identical.
  const [picked, setPicked] = useState<FeedPlatform[]>([]);
  const [pickState, setPickState] = useState<"loading" | "needed" | "done">(
    "loading",
  );
  useEffect(() => {
    setPickState(
      getFeedPlatformPick(team.workspaceId).length > 0 ? "done" : "needed",
    );
  }, [team.workspaceId]);

  function togglePicked(p: FeedPlatform) {
    setPicked((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p],
    );
  }

  function confirmPick(platforms: readonly FeedPlatform[]) {
    setFeedPlatformPick(team.workspaceId, platforms);
    setPickState("done");
  }

  async function createBrand() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t.home.emptyNameRequired);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch(`${API_URL}/api/assistants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmed,
          kind: "app",
          appType: "distribution",
          workspaceId: team.workspaceId,
        }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b?.error ?? t.home.emptyCreateFailed);
      }
      await team.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.home.emptyCreateFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-[70vh] items-center justify-center px-6 animate-fade-in">
      <div className="max-w-md space-y-5 text-center">
        <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-muted text-muted-foreground mx-auto ring-1 ring-border">
          <Inbox className="h-7 w-7" />
        </div>
        {brand && pickState === "loading" ? null : brand &&
          pickState === "needed" ? (
          <>
            <h1 className="text-[15px] font-semibold">{t.home.pickTitle}</h1>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t.home.pickBody}
            </p>
            <div className="flex flex-wrap justify-center gap-1.5">
              {FEED_PLATFORMS.map((p) => {
                const active = picked.includes(p);
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => togglePicked(p)}
                    aria-pressed={active}
                    className={
                      "press inline-flex items-center gap-1.5 h-8 rounded-full border px-3.5 text-[13px] font-medium transition-colors " +
                      (active
                        ? "border-transparent bg-foreground text-background"
                        : "border-border bg-background/60 text-muted-foreground hover:bg-accent")
                    }
                  >
                    <PlatformIcon platform={p} className="size-3.5" />
                    {t.platformLabels[p]}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => confirmPick(picked)}
              disabled={picked.length === 0}
              className="inline-flex w-full items-center justify-center rounded-lg bg-primary px-3 h-8 text-[12.5px] font-medium text-primary-foreground hover:bg-primary/90 active:bg-primary/85 disabled:opacity-50 transition-colors press"
            >
              {t.home.pickCta}
            </button>
            <button
              type="button"
              onClick={() => confirmPick(FEED_PLATFORMS)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {t.home.pickSkip}
            </button>
          </>
        ) : brand ? (
          <>
            <h1
              className="text-[15px] font-semibold"            >
              {brand.name}
            </h1>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t.home.createdBanner}
            </p>
            <Link
              href={feedPath(team.workspaceId, { segment: "drafts" })}
              className="inline-flex items-center justify-center rounded-lg bg-primary px-3 h-8 text-[12.5px] font-medium text-primary-foreground hover:bg-primary/90 active:bg-primary/85 transition-colors press"
            >
              {t.comingSoon.draftsCta}
            </Link>
            {canConnect ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">{t.home.emptyOrConnect}</p>
                <button
                  type="button"
                  onClick={onConnect}
                  className="inline-flex items-center justify-center rounded-xl border border-border px-4 h-9 text-sm font-medium hover:bg-accent transition-colors"
                >
                  {t.home.emptyConnectCta}
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <h1
              className="text-[15px] font-semibold"            >
              {t.home.emptyTitle}
            </h1>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t.home.emptyBody}
            </p>
            {canConnect ? (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void createBrand();
                }}
              >
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t.home.emptyNamePlaceholder}
                  disabled={busy}
                  className="w-full h-9 rounded-lg border border-border bg-background px-3 text-sm focus:outline-none focus:border-primary/50 disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex w-full items-center justify-center rounded-lg bg-primary px-3 h-8 text-[12.5px] font-medium text-primary-foreground hover:bg-primary/90 active:bg-primary/85 disabled:opacity-50 transition-colors press"
                >
                  {busy ? t.home.emptyCreating : t.home.emptyCta}
                </button>
                {error ? (
                  <p className="text-sm text-destructive">{error}</p>
                ) : null}
                <p className="text-xs text-muted-foreground">{t.home.emptyOrConnect}</p>
                <button
                  type="button"
                  onClick={onConnect}
                  disabled={busy}
                  className="inline-flex items-center justify-center rounded-xl border border-border px-4 h-9 text-sm font-medium hover:bg-accent disabled:opacity-50 transition-colors"
                >
                  {t.home.emptyConnectCta}
                </button>
              </form>
            ) : (
              <p className="text-sm text-muted-foreground">{t.home.emptyAskAdmin}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
