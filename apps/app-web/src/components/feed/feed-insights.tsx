"use client";

/**
 * Per-platform insights dashboard — ported faithfully from
 * `apps/feed-web/src/app/w/[workspaceId]/[platform]/insights/page.tsx`
 * (docs/plans/feed-web-consolidation.md §7.5): profile summary cards with
 * period-over-period deltas + bar sparklines, the 7/30/90-day range picker,
 * the per-post masonry with top-performer tinting, and the range-scoped
 * mentions + X-only quotes panels.
 *
 * Port deltas (disposition rules §6):
 *   - `useWorkspaceContext()` → `useFeedWorkspace()`; inline `authFetch`
 *     RPCs → the feed SDK insights wrappers (`fetchFeedInsights` /
 *     `fetchFeedMentions` / `fetchFeedQuotes`).
 *   - feed-web's `NotSupportedState` platform dispatcher is dropped — the
 *     `/feed/[platform]` guard layout already 404s junk platforms
 *     (the Phase 5 draft-sessions precedent).
 *   - The `!profile` connect-first state links to the feed home (connect
 *     onboarding lives there), not feed-web's `/onboarding`.
 *   - All copy via `useT().feedPage` (`insights` + shared `platformLabels` /
 *     `draftSessions.connectFirst*` / `home.timeDaysAgo` /
 *     `postEmbed.unknownHandle` keys); tooltip/legend metric interpolations
 *     use the translated metric labels instead of the raw enum ids.
 *   - Value placeholders for missing data stay the inline glyph feed-web
 *     rendered (not dictionary copy).
 *
 * [COMP:app-web/feed-insights]
 */

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
import {
  fetchFeedInsights,
  fetchFeedMentions,
  fetchFeedQuotes,
  type FeedInsightsMetrics,
  type FeedInsightsPost,
  type FeedInsightsPostKind,
  type FeedInsightsResponse,
  type FeedInsightsTrendDay,
  type FeedMentionItem,
} from "@/lib/api/feed";
import { feedPath, type FeedPlatform } from "@/lib/feed-nav";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

type FeedPageDict = ReturnType<typeof useT>["feedPage"];
type InsightsDict = FeedPageDict["insights"];

type RangeOption = { id: "7d" | "30d" | "90d"; days: number };
const RANGE_OPTIONS: RangeOption[] = [
  { id: "7d", days: 7 },
  { id: "30d", days: 30 },
  { id: "90d", days: 90 },
];

const RANGE_LABEL_KEY: Record<RangeOption["id"], keyof InsightsDict> = {
  "7d": "range7d",
  "30d": "range30d",
  "90d": "range90d",
};

function rangeLabel(td: InsightsDict, range: RangeOption): string {
  return td[RANGE_LABEL_KEY[range.id]];
}

// ── Page ────────────────────────────────────────────────────────

type KindFilter = "all" | "post" | "reply" | "quote";
const KIND_FILTERS: Array<{ id: KindFilter; labelKey: keyof InsightsDict }> = [
  { id: "all", labelKey: "filterAll" },
  { id: "post", labelKey: "filterPosts" },
  { id: "reply", labelKey: "filterReplies" },
  { id: "quote", labelKey: "filterQuotes" },
];

export function FeedInsights() {
  const params = useParams<{ workspaceId: string; platform: string }>();
  const team = useFeedWorkspace();
  const t = useT().feedPage;
  const td = t.insights;
  // The /feed/[platform] guard layout 404s junk platforms before this
  // renders, so the segment is always a known platform here.
  const platform = params.platform as FeedPlatform;
  const profile = team.profiles.find((p) => p.platform === platform);

  const [range, setRange] = useState<RangeOption>(RANGE_OPTIONS[0]);
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [data, setData] = useState<FeedInsightsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mentions, setMentions] = useState<FeedMentionItem[]>([]);
  const [mentionsLoading, setMentionsLoading] = useState(false);
  const [quotes, setQuotes] = useState<FeedMentionItem[]>([]);
  const [quotesLoading, setQuotesLoading] = useState(false);

  useEffect(() => {
    if (!profile) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const until = new Date();
    const since = new Date(until.getTime() - range.days * 24 * 60 * 60 * 1000);
    (async () => {
      try {
        const body = await fetchFeedInsights(profile.assistantId, platform, {
          since: since.toISOString(),
          until: until.toISOString(),
        });
        if (!cancelled) setData(body);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : td.loadFailed);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, range, platform]);

  // Recent @-mentions in the selected range. Independent of the insights
  // fetch above — sourced from the distribution audit log, so it re-runs
  // whenever the range changes but doesn't block the metrics render.
  useEffect(() => {
    if (!profile) return;
    let cancelled = false;
    setMentionsLoading(true);
    fetchFeedMentions(profile.assistantId, platform, {
      days: range.days,
      limit: 20,
    })
      .then((items) => {
        if (!cancelled) setMentions(items);
      })
      .catch(() => {
        if (!cancelled) setMentions([]);
      })
      .finally(() => {
        if (!cancelled) setMentionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [profile, range, platform]);

  // Recent quote tweets in the selected range — X only (Threads has no quote
  // concept, and the backend route is twitter-scoped). Same audit-log source as
  // mentions, independent of the metrics fetch.
  useEffect(() => {
    if (!profile || platform !== "twitter") {
      setQuotes([]);
      return;
    }
    let cancelled = false;
    setQuotesLoading(true);
    fetchFeedQuotes(profile.assistantId, { days: range.days, limit: 20 })
      .then((items) => {
        if (!cancelled) setQuotes(items);
      })
      .catch(() => {
        if (!cancelled) setQuotes([]);
      })
      .finally(() => {
        if (!cancelled) setQuotesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [profile, range, platform]);

  if (!profile) {
    return (
      <NotConnectedState
        t={t}
        workspaceId={params.workspaceId}
        platform={platform}
      />
    );
  }

  return (
    <div className="px-6 md:px-10 py-10 max-w-7xl mx-auto space-y-6 animate-fade-in">
      <header className="flex items-start sm:items-center justify-between gap-4 flex-wrap">
        <div className="space-y-1.5">
          <h1
            className="text-2xl font-semibold tracking-tight"
            style={{ fontFamily: "var(--font-rocknroll)" }}
          >
            {format(td.heading, { platform: t.platformLabels[platform] })}
          </h1>
          <p className="text-xs text-muted-foreground">
            {format(td.subtitle, { handle: profile.platformHandle })}
          </p>
        </div>
        <RangePicker td={td} value={range} onChange={setRange} />
      </header>

      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <ProfileSummary
        td={td}
        metrics={data?.profile ?? null}
        priorMetrics={data?.priorProfile ?? null}
        trends={data?.trends ?? null}
        loading={loading}
      />

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-sm font-medium text-muted-foreground">
            {td.recentPostsHeading}
          </h2>
          {data && data.posts.length > 0 ? (
            <KindFilterPicker
              td={td}
              value={kindFilter}
              onChange={setKindFilter}
              counts={countByKind(data.posts)}
            />
          ) : null}
        </div>
        {loading ? (
          <PostGridSkeleton />
        ) : !data || data.posts.length === 0 ? (
          <EmptyPostsState td={td} hasError={error !== null} />
        ) : (
          (() => {
            const visible =
              kindFilter === "all"
                ? data.posts
                : data.posts.filter((p) => p.kind === kindFilter);
            const primaryMetrics = computePrimaryMetrics(visible);
            return (
              <>
                <TopPerformerLegend td={td} primaryMetrics={primaryMetrics} />
                <PostMasonry
                  t={t}
                  posts={visible}
                  emptyKind={kindFilter}
                  primaryMetrics={primaryMetrics}
                />
              </>
            );
          })()
        )}
      </section>

      {(mentions.length > 0 || mentionsLoading) && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            {format(td.mentionsHeading, { range: rangeLabel(td, range) })}
          </h2>
          {mentionsLoading && mentions.length === 0 ? (
            <MentionsSkeleton />
          ) : (
            <ul className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
              {mentions.map((m) => (
                <li key={m.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">
                      @{m.username ?? t.postEmbed.unknownHandle}
                    </span>
                    {m.timestamp && (
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {formatTimestamp(t, m.timestamp)}
                      </span>
                    )}
                  </div>
                  {m.text && (
                    <p className="mt-1 text-sm text-muted-foreground line-clamp-3 whitespace-pre-wrap">
                      {m.text}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {platform === "twitter" && (quotes.length > 0 || quotesLoading) && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            {format(td.quotesHeading, { range: rangeLabel(td, range) })}
          </h2>
          {quotesLoading && quotes.length === 0 ? (
            <MentionsSkeleton />
          ) : (
            <ul className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
              {quotes.map((q) => (
                <li key={q.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">
                      @{q.username ?? t.postEmbed.unknownHandle}
                    </span>
                    {q.timestamp && (
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {formatTimestamp(t, q.timestamp)}
                      </span>
                    )}
                  </div>
                  {q.text && (
                    <p className="mt-1 text-sm text-muted-foreground line-clamp-3 whitespace-pre-wrap">
                      {q.text}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function MentionsSkeleton() {
  return (
    <ul className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
      {[1, 2, 3].map((i) => (
        <li key={i} className="px-4 py-3 animate-pulse space-y-2">
          <div className="flex justify-between">
            <div className="h-3 w-24 bg-muted rounded" />
            <div className="h-3 w-12 bg-muted rounded" />
          </div>
          <div className="h-3 w-3/4 bg-muted rounded" />
        </li>
      ))}
    </ul>
  );
}

// ── Profile summary ─────────────────────────────────────────────

const PROFILE_METRICS: Array<{
  key: keyof FeedInsightsMetrics;
  labelKey: keyof InsightsDict;
  icon: () => React.ReactElement;
}> = [
  { key: "followers_count", labelKey: "metricFollowers", icon: UsersIcon },
  { key: "views", labelKey: "metricViews", icon: EyeIcon },
  { key: "likes", labelKey: "metricLikes", icon: HeartIcon },
  { key: "replies", labelKey: "metricReplies", icon: CommentIcon },
  { key: "reposts", labelKey: "metricReposts", icon: RepostIcon },
  { key: "quotes", labelKey: "metricQuotes", icon: QuoteIcon },
];

function ProfileSummary({
  td,
  metrics,
  priorMetrics,
  trends,
  loading,
}: {
  td: InsightsDict;
  metrics: FeedInsightsMetrics | null;
  priorMetrics: FeedInsightsMetrics | null;
  trends: FeedInsightsTrendDay[] | null;
  loading: boolean;
}) {
  const days = trends?.map((t) => t.day) ?? [];
  return (
    <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      {PROFILE_METRICS.map((m) => {
        const Icon = m.icon;
        const label = td[m.labelKey];
        const current = metrics?.[m.key];
        const prior = priorMetrics?.[m.key];
        const series = trends ? extractTrendSeries(trends, m.key) : [];
        const labelLower = label.toLowerCase();
        const cardTitle =
          current != null
            ? prior != null
              ? format(td.cardTitleWithDelta, {
                  value: formatNumber(current),
                  metric: labelLower,
                  delta: signedDelta(td, current - prior),
                })
              : format(td.cardTitle, {
                  value: formatNumber(current),
                  metric: labelLower,
                })
            : undefined;
        return (
          <div
            key={m.key}
            className="rounded-xl border border-border bg-card p-5 flex flex-col gap-2 hover-lift"
            title={cardTitle}
          >
            <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">
              <span aria-hidden className="text-muted-foreground/70">
                <Icon />
              </span>
              {label}
            </div>
            <div className="text-3xl font-semibold tabular-nums leading-none">
              {loading ? (
                <span className="inline-block h-8 w-14 bg-muted rounded animate-pulse" />
              ) : (
                formatNumber(current)
              )}
            </div>
            {!loading && current != null && prior != null ? (
              <DeltaLine
                td={td}
                current={current}
                prior={prior}
                metricLabel={labelLower}
              />
            ) : null}
            {!loading && series.length > 1 ? (
              <Sparkline
                td={td}
                values={series}
                days={days}
                metricLabel={labelLower}
                barCls={SPARKLINE_BAR_CLS[m.key] ?? "bg-muted-foreground/40"}
              />
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

/** "+847" / "−12" / "no change" — compact signed string for tooltips. */
function signedDelta(td: InsightsDict, delta: number): string {
  if (delta === 0) return td.noChange;
  const sign = delta > 0 ? "+" : "−";
  return `${sign}${Math.abs(delta).toLocaleString("en-US")}`;
}

/**
 * Pull the per-day numbers for a given profile-metric key out of the
 * trend series. `followers_count` reads from the snapshot column;
 * everything else reads from the matching aggregate column. Days where
 * `followers` is null are mapped to 0 — sparkline-rendering code treats
 * an all-zero series as "no signal" and shows a flat hairline.
 */
// exported for tests
export function extractTrendSeries(
  trends: FeedInsightsTrendDay[],
  key: keyof FeedInsightsMetrics,
): number[] {
  switch (key) {
    case "followers_count":
      return trends.map((t) => t.followers ?? 0);
    case "views":
      return trends.map((t) => t.views);
    case "likes":
      return trends.map((t) => t.likes);
    case "replies":
      return trends.map((t) => t.replies);
    case "reposts":
      return trends.map((t) => t.reposts);
    case "quotes":
      return trends.map((t) => t.quotes);
    default:
      return [];
  }
}

/** Bar fill colour per metric — keyed to match the metric icons so the
 *  sparkline reads as a coloured continuation of the metric icon above. */
const SPARKLINE_BAR_CLS: Partial<Record<keyof FeedInsightsMetrics, string>> = {
  followers_count: "bg-amber-500/55 dark:bg-amber-400/55",
  views: "bg-sky-500/55 dark:bg-sky-400/55",
  likes: "bg-rose-500/55 dark:bg-rose-400/55",
  replies: "bg-blue-500/55 dark:bg-blue-400/55",
  reposts: "bg-emerald-500/55 dark:bg-emerald-400/55",
  quotes: "bg-violet-500/55 dark:bg-violet-400/55",
};

/**
 * Bar sparkline. Discrete bars per day so a single tall day reads as
 * "one big post" rather than a smooth line that suggests continuous
 * activity. Auto-scales to the max value in the series; an all-zero
 * series collapses to a hairline so the row stays anchored visually.
 *
 * Each bar carries a native `title` so the user can hover-inspect the
 * exact value for any specific day — the tradeoff for a chart this
 * small (no axis labels, no gridlines).
 */
function Sparkline({
  td,
  values,
  days,
  metricLabel,
  barCls,
}: {
  td: InsightsDict;
  values: number[];
  days: string[];
  metricLabel: string;
  barCls: string;
}) {
  const max = Math.max(...values, 0);
  const summaryTitle =
    max === 0
      ? format(td.sparklineEmpty, { metric: metricLabel })
      : format(td.sparklinePeak, {
          metric: metricLabel,
          value: formatNumber(max),
          day: formatDayLabel(days[values.indexOf(max)] ?? ""),
        });

  if (max === 0) {
    return (
      <div className="h-7 mt-1 flex items-end" aria-hidden title={summaryTitle}>
        <div className="w-full h-px bg-muted-foreground/15" />
      </div>
    );
  }
  return (
    <div
      className="h-7 mt-1 flex items-end gap-[2px]"
      role="img"
      aria-label={format(td.sparklineAria, {
        count: values.length,
        value: formatNumber(max),
      })}
      title={summaryTitle}
    >
      {values.map((v, i) => {
        const heightPct = Math.max(2, (v / max) * 100);
        return (
          <div
            key={i}
            className={"flex-1 rounded-[2px] " + barCls}
            style={{ height: `${heightPct}%` }}
            title={format(td.sparklineBarTitle, {
              day: formatDayLabel(days[i]),
              value: formatNumber(v),
              metric: metricLabel,
            })}
          />
        );
      })}
    </div>
  );
}

/** "2026-05-07" → "May 7" — compact label for hover tooltips. */
function formatDayLabel(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00Z");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Period-over-period delta — a small signed number with arrow + percent
 * change, color-graded to give an at-a-glance read on whether the metric
 * is up or down vs the prior window of equal length.
 *
 * - 0 → 0: muted "no change"
 * - prior 0 → current N: shows the absolute, no percent (avoids ÷0)
 * - both > 0: signed value + percent
 */
function DeltaLine({
  td,
  current,
  prior,
  metricLabel,
}: {
  td: InsightsDict;
  current: number;
  prior: number;
  metricLabel: string;
}) {
  const delta = current - prior;
  if (delta === 0) {
    return (
      <span
        className="text-[10px] text-muted-foreground/70"
        title={format(td.deltaUnchangedTitle, {
          metric: metricLabel,
          prior: formatNumber(prior),
          current: formatNumber(current),
        })}
      >
        {td.noChange}
      </span>
    );
  }
  const positive = delta > 0;
  const cls = positive
    ? "text-emerald-500 dark:text-emerald-400"
    : "text-rose-500 dark:text-rose-400";
  const pct = prior > 0 ? Math.abs(delta / prior) : null;
  const absDelta = Math.abs(delta).toLocaleString("en-US");
  const fullTooltip = format(td.deltaTooltip, {
    metric: metricLabel,
    direction: positive ? td.deltaDirectionUp : td.deltaDirectionDown,
    delta: absDelta,
    pct: pct !== null ? ` (${(pct * 100).toFixed(pct < 0.1 ? 1 : 0)}%)` : "",
    prior: formatNumber(prior),
    current: formatNumber(current),
  });
  return (
    <span
      className={
        "inline-flex items-center gap-1 text-[10.5px] font-medium tabular-nums " + cls
      }
      aria-label={fullTooltip}
      title={fullTooltip}
    >
      <span aria-hidden>{positive ? "↑" : "↓"}</span>
      {absDelta}
      {pct !== null ? (
        <span className="text-muted-foreground/70 font-normal">
          · {(pct * 100).toFixed(pct < 0.1 ? 1 : 0)}%
        </span>
      ) : null}
    </span>
  );
}

// ── Masonry layout ──────────────────────────────────────────────

/**
 * Row-major masonry — same pattern as `draft-sessions-list.tsx`. Cards
 * are round-robin distributed into N columns based on viewport width;
 * each column is a flex stack so cards sit flush, eliminating the empty
 * gutters a CSS Grid produces when card heights vary (post bodies range
 * from a single line to multi-paragraph). Reading order stays
 * row-major: item 0 → col 0, item 1 → col 1, ….
 *
 * Trade-off: cards in the visual "same row" are no longer
 * bottom-aligned. Accepted because variable-height insight cards make
 * row alignment look broken regardless.
 */
function PostMasonry({
  t,
  posts,
  emptyKind,
  primaryMetrics,
}: {
  t: FeedPageDict;
  posts: FeedInsightsPost[];
  emptyKind: KindFilter;
  primaryMetrics: PrimaryMetricMap;
}) {
  const colCount = useColumnCount();
  const columns = useMemo(() => {
    const cols: FeedInsightsPost[][] = Array.from(
      { length: colCount },
      () => [],
    );
    posts.forEach((p, i) => cols[i % colCount].push(p));
    return cols;
  }, [posts, colCount]);

  if (posts.length === 0) return <EmptyKindState td={t.insights} kind={emptyKind} />;

  return (
    <div className="flex gap-3 items-start">
      {columns.map((col, ci) => (
        <ul key={ci} className="flex-1 min-w-0 flex flex-col gap-3">
          {col.map((post) => (
            <PostInsightsCard
              key={post.id}
              t={t}
              post={post}
              primaryMetric={primaryMetrics.get(post.id) ?? null}
            />
          ))}
        </ul>
      ))}
    </div>
  );
}

// ── Top-performer highlighting ──────────────────────────────────

type AccentMetric = "views" | "likes" | "replies" | "reposts" | "quotes";

/** Per-post → its dominant accent metric (the one where its lead over
 *  the median is largest). Posts not in the map are not standouts. */
export type PrimaryMetricMap = Map<string, AccentMetric>;

const ACCENT_METRICS: AccentMetric[] = [
  "views",
  "likes",
  "replies",
  "reposts",
  "quotes",
];

/**
 * Compute, for each post that's a standout in any metric, the single
 * metric where it leads by the largest ratio above median. A post that
 * tops both views and likes will only be tinted with whichever lead is
 * stronger relative to its peers — the alternative is a card painted
 * two different colours, which was the visual mess we're trying to
 * avoid.
 *
 * Standout threshold: max ≥ 1.5 × median AND max > 0. So a single-post
 * day (where median == max) doesn't paint anything.
 */
// exported for tests
export function computePrimaryMetrics(
  posts: FeedInsightsPost[],
): PrimaryMetricMap {
  const out: PrimaryMetricMap = new Map();
  if (posts.length === 0) return out;

  type Lead = { postId: string; metric: AccentMetric; ratio: number };
  const leads: Lead[] = [];
  for (const metric of ACCENT_METRICS) {
    const values = posts.map((p) => p.insights[metric] ?? 0);
    const max = Math.max(...values);
    if (max <= 0) continue;
    const median = computeMedian(values);
    if (max < median * 1.5) continue;
    const topPost = posts.find((p) => (p.insights[metric] ?? 0) === max);
    if (!topPost) continue;
    leads.push({
      postId: topPost.id,
      metric,
      ratio: max / Math.max(median, 1),
    });
  }
  // Group leads by post; keep the one with the highest ratio.
  for (const lead of leads) {
    const existing = out.get(lead.postId);
    if (!existing) {
      out.set(lead.postId, lead.metric);
      continue;
    }
    const prev = leads.find(
      (l) => l.postId === lead.postId && l.metric === existing,
    );
    if (prev && lead.ratio > prev.ratio) {
      out.set(lead.postId, lead.metric);
    }
  }
  return out;
}

// exported for tests
export function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Card chrome per dominant metric — same shape as the draft-sessions
 * status chrome: faint tint at rest (~6% alpha) that lifts on hover.
 * Plain `bg-card` for non-standout posts. Colour vocabulary matches
 * social-media intuition: views→sky, likes→rose, replies→blue,
 * reposts→emerald, quotes→violet.
 */
const CARD_CHROME: Record<AccentMetric, string> = {
  views:
    "bg-sky-500/[0.06] border-sky-500/25 hover:bg-sky-500/[0.10] hover:border-sky-500/40",
  likes:
    "bg-rose-500/[0.06] border-rose-500/25 hover:bg-rose-500/[0.10] hover:border-rose-500/40",
  replies:
    "bg-blue-500/[0.06] border-blue-500/25 hover:bg-blue-500/[0.10] hover:border-blue-500/40",
  reposts:
    "bg-emerald-500/[0.06] border-emerald-500/25 hover:bg-emerald-500/[0.10] hover:border-emerald-500/40",
  quotes:
    "bg-violet-500/[0.06] border-violet-500/25 hover:bg-violet-500/[0.10] hover:border-violet-500/40",
};

const DEFAULT_CARD_CHROME =
  "bg-card border-border/70 hover:border-border hover:shadow-sm";

/** Small swatch class per metric — same hue family as the card chrome
 *  so the legend reads as a key for the cards. Slightly stronger alpha
 *  (35%) than the card backgrounds so the swatch is recognisable at
 *  this size. */
const LEGEND_SWATCH_CLS: Record<AccentMetric, string> = {
  views: "bg-sky-500/35 dark:bg-sky-400/35 ring-sky-500/30",
  likes: "bg-rose-500/35 dark:bg-rose-400/35 ring-rose-500/30",
  replies: "bg-blue-500/35 dark:bg-blue-400/35 ring-blue-500/30",
  reposts: "bg-emerald-500/35 dark:bg-emerald-400/35 ring-emerald-500/30",
  quotes: "bg-violet-500/35 dark:bg-violet-400/35 ring-violet-500/30",
};

const METRIC_LEGEND_KEY: Record<AccentMetric, keyof InsightsDict> = {
  views: "topViews",
  likes: "topLikes",
  replies: "topReplies",
  reposts: "topReposts",
  quotes: "topQuotes",
};

/** The metric's translated lowercase label — used wherever feed-web
 *  interpolated the raw metric id into user-facing copy. */
const ACCENT_METRIC_LABEL_KEY: Record<AccentMetric, keyof InsightsDict> = {
  views: "metricViews",
  likes: "metricLikes",
  replies: "metricReplies",
  reposts: "metricReposts",
  quotes: "metricQuotes",
};

function accentMetricLabel(td: InsightsDict, metric: AccentMetric): string {
  return td[ACCENT_METRIC_LABEL_KEY[metric]].toLowerCase();
}

/**
 * Inline legend for the top-performer card tints. Renders only the
 * metrics that actually appear in the current grid — so a 7-day view
 * with one standout shows a single chip rather than the full vocabulary.
 * Hides entirely when no card is tinted (saves vertical space on quiet
 * days).
 */
function TopPerformerLegend({
  td,
  primaryMetrics,
}: {
  td: InsightsDict;
  primaryMetrics: PrimaryMetricMap;
}) {
  const used = useMemo(() => {
    const set = new Set<AccentMetric>();
    for (const m of primaryMetrics.values()) set.add(m);
    return ACCENT_METRICS.filter((m) => set.has(m));
  }, [primaryMetrics]);

  if (used.length === 0) return null;

  return (
    <div className="flex items-center flex-wrap gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground">
      <span
        className="text-muted-foreground/70 cursor-help"
        title={td.standoutsTitle}
      >
        {td.standoutsLabel}
      </span>
      {used.map((metric) => (
        <span
          key={metric}
          className="inline-flex items-center gap-1.5"
          title={format(td.legendChipTitle, {
            metric: accentMetricLabel(td, metric),
          })}
        >
          <span
            aria-hidden
            className={
              "inline-block h-2.5 w-2.5 rounded-sm ring-1 ring-inset " +
              LEGEND_SWATCH_CLS[metric]
            }
          />
          {td[METRIC_LEGEND_KEY[metric]]}
        </span>
      ))}
    </div>
  );
}

/**
 * Tracks the active masonry column count via `matchMedia`. Mirrors the
 * `lg` (1024px) and `2xl` (1536px) breakpoints used by the other feed
 * surfaces so the column cadence is consistent across pages.
 * SSR returns 1; the page is client-fetched so the SSR markup is the
 * skeleton, not real cards — no hydration mismatch.
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

// ── Per-post card ───────────────────────────────────────────────

function PostInsightsCard({
  t,
  post,
  primaryMetric,
}: {
  t: FeedPageDict;
  post: FeedInsightsPost;
  primaryMetric: AccentMetric | null;
}) {
  const td = t.insights;
  const preview = useMemo(() => {
    if (!post.text) return t.home.noText;
    return post.text.length > 200 ? `${post.text.slice(0, 200)}…` : post.text;
  }, [post.text, t.home.noText]);

  const chrome = primaryMetric ? CARD_CHROME[primaryMetric] : DEFAULT_CARD_CHROME;
  const cardTitle = primaryMetric
    ? format(td.topPerformerTitle, {
        metric: accentMetricLabel(td, primaryMetric),
      })
    : undefined;

  return (
    <li
      className={
        "group rounded-2xl border p-5 flex flex-col gap-4 transition-[border-color,box-shadow,background-color] duration-200 " +
        chrome
      }
      title={cardTitle}
    >
      {/* Header: kind marker + timestamp on the left, source link on the
          right. Both muted; the body is the hero. */}
      <header className="flex items-center justify-between gap-3 text-[11.5px] text-muted-foreground">
        <div className="flex items-center gap-1.5 min-w-0">
          {post.kind !== "post" ? <KindMarker td={td} kind={post.kind} /> : null}
          <span className="tabular-nums">
            {post.timestamp ? formatTimestamp(t, post.timestamp) : "—"}
          </span>
        </div>
        {post.permalink ? (
          <a
            href={post.permalink}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-muted-foreground/80 hover:text-foreground transition-colors shrink-0"
          >
            {td.sourceLink}
            <ExternalIcon />
          </a>
        ) : null}
      </header>

      {/* Body — the post text. With masonry layout, cards size to their
          content; `line-clamp-6` is a soft cap so an unusually long post
          (Threads max is ~500 chars ≈ 8–9 lines) doesn't dwarf its column
          peers. */}
      <p className="text-[14.5px] leading-[1.55] whitespace-pre-wrap line-clamp-6 text-foreground/95">
        {preview}
      </p>

      {/* Engagement — same shape as the draft post-preview's
          `Counter` row (`external-post-card.tsx`): tight `gap-3.5`
          cluster, left-aligned, `12.5px` muted text. Hairline above
          separates it from the body. */}
      {post.error ? (
        <p className="text-[11px] text-amber-300/80 italic pt-3 border-t border-border/50">
          {td.postInsightsUnavailable}
        </p>
      ) : (
        <div className="flex items-center gap-3.5 pt-3 border-t border-border/50 text-[12.5px] text-muted-foreground">
          <EngagementCounter
            td={td}
            icon={<EyeIcon />}
            value={post.insights.views}
            label={accentMetricLabel(td, "views")}
          />
          <EngagementCounter
            td={td}
            icon={<HeartIcon />}
            value={post.insights.likes}
            label={accentMetricLabel(td, "likes")}
          />
          <EngagementCounter
            td={td}
            icon={<CommentIcon />}
            value={post.insights.replies}
            label={accentMetricLabel(td, "replies")}
          />
          <EngagementCounter
            td={td}
            icon={<RepostIcon />}
            value={post.insights.reposts}
            label={accentMetricLabel(td, "reposts")}
          />
          <EngagementCounter
            td={td}
            icon={<QuoteIcon />}
            value={post.insights.quotes}
            label={accentMetricLabel(td, "quotes")}
          />
        </div>
      )}
    </li>
  );
}

function EngagementCounter({
  td,
  icon,
  value,
  label,
}: {
  td: InsightsDict;
  icon: React.ReactNode;
  value: number | undefined;
  label: string;
}) {
  const safe = value ?? 0;
  return (
    <span
      className="inline-flex items-center gap-1 tabular-nums"
      aria-label={format(td.engagementAria, { count: safe, metric: label })}
    >
      <span aria-hidden className="text-muted-foreground/80">
        {icon}
      </span>
      {formatCount(safe)}
    </span>
  );
}

/** Compact count formatter — matches the Threads embed style used by
 *  `external-post-card.tsx` so the insights cards and draft post-preview
 *  read the same. "1234" → "1.2K", "31527" → "32K", "1234567" → "1.2M". */
// exported for tests
export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

// ── Skeletons & empty states ────────────────────────────────────

function PostGridSkeleton() {
  return (
    <ul className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-3">
      {[1, 2, 3, 4, 5, 6].map((i) => (
        <li
          key={i}
          className="rounded-xl border border-border bg-card p-4 animate-pulse space-y-3"
        >
          <div className="flex justify-between">
            <div className="h-3 w-20 bg-muted rounded" />
            <div className="h-3 w-24 bg-muted rounded" />
          </div>
          <div className="space-y-1.5">
            <div className="h-3 w-full bg-muted rounded" />
            <div className="h-3 w-4/5 bg-muted rounded" />
            <div className="h-3 w-3/5 bg-muted rounded" />
          </div>
          <div className="grid grid-cols-5 gap-2">
            {[0, 1, 2, 3, 4].map((j) => (
              <div key={j} className="h-7 bg-muted rounded" />
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

function EmptyPostsState({
  td,
  hasError,
}: {
  td: InsightsDict;
  hasError: boolean;
}) {
  if (hasError) return null;
  return (
    <div className="rounded-xl border border-border bg-card p-8 text-center space-y-2">
      <p className="text-sm font-medium">{td.emptyTitle}</p>
      <p className="text-xs text-muted-foreground max-w-sm mx-auto">
        {td.emptyBody}
      </p>
    </div>
  );
}

function EmptyKindState({ td, kind }: { td: InsightsDict; kind: KindFilter }) {
  const title =
    kind === "reply"
      ? td.emptyKindReplies
      : kind === "quote"
        ? td.emptyKindQuotes
        : td.emptyKindPosts;
  return (
    <div className="rounded-xl border border-border bg-card p-8 text-center space-y-2">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground max-w-sm mx-auto">
        {td.emptyKindBefore}{" "}
        <span className="font-medium">{td.emptyKindAll}</span>{" "}
        {td.emptyKindAfter}
      </p>
    </div>
  );
}

function KindMarker({
  td,
  kind,
}: {
  td: InsightsDict;
  kind: FeedInsightsPostKind;
}) {
  // Quietly mark non-default kinds inline next to the timestamp, instead
  // of a coloured pill that competes with the post body. Posts (the
  // default) get no marker at all — nothing to disambiguate.
  const label =
    kind === "reply" ? td.kindReply : kind === "quote" ? td.kindQuote : td.kindPost;
  const Icon = kind === "reply" ? CornerArrowIcon : QuoteIcon;
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground/85">
      <Icon />
      <span className="font-medium text-foreground/75">{label}</span>
      <span aria-hidden className="text-muted-foreground/40 mx-0.5">·</span>
    </span>
  );
}

function CornerArrowIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="9 14 4 9 9 4" />
      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
    </svg>
  );
}

function KindFilterPicker({
  td,
  value,
  onChange,
  counts,
}: {
  td: InsightsDict;
  value: KindFilter;
  onChange: (k: KindFilter) => void;
  counts: Record<FeedInsightsPostKind, number>;
}) {
  return (
    <div className="inline-flex items-center rounded-xl border border-border bg-card p-0.5 shrink-0">
      {KIND_FILTERS.map((opt) => {
        const isActive = opt.id === value;
        const count =
          opt.id === "all"
            ? counts.post + counts.reply + counts.quote
            : counts[opt.id];
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            className={
              "px-3 h-8 text-xs font-medium rounded-lg transition-colors inline-flex items-center gap-1.5 " +
              (isActive
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-accent")
            }
            aria-pressed={isActive}
          >
            {td[opt.labelKey]}
            <span
              className={
                "tabular-nums text-[10px] " +
                (isActive ? "text-primary-foreground/85" : "text-muted-foreground/70")
              }
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// exported for tests
export function countByKind(
  posts: FeedInsightsPost[],
): Record<FeedInsightsPostKind, number> {
  const counts: Record<FeedInsightsPostKind, number> = {
    post: 0,
    reply: 0,
    quote: 0,
  };
  for (const p of posts) counts[p.kind]++;
  return counts;
}

function NotConnectedState({
  t,
  workspaceId,
  platform,
}: {
  t: FeedPageDict;
  workspaceId: string;
  platform: FeedPlatform;
}) {
  const label = t.platformLabels[platform];
  return (
    <div className="px-8 py-10 max-w-2xl space-y-4">
      <h1
        className="text-xl font-semibold"
        style={{ fontFamily: "var(--font-rocknroll)" }}
      >
        {format(t.draftSessions.connectFirstTitle, { platform: label })}
      </h1>
      <p className="text-sm text-muted-foreground">
        {format(t.insights.connectBody, { platform: label })}
      </p>
      <Link
        href={feedPath(workspaceId)}
        className="inline-flex items-center justify-center rounded-xl bg-primary px-4 h-11 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        {format(t.draftSessions.connectCta, { platform: label })}
      </Link>
    </div>
  );
}

// ── Range picker ────────────────────────────────────────────────

function RangePicker({
  td,
  value,
  onChange,
}: {
  td: InsightsDict;
  value: RangeOption;
  onChange: (r: RangeOption) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-xl border border-border bg-card p-0.5 shrink-0">
      {RANGE_OPTIONS.map((opt) => {
        const isActive = opt.id === value.id;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt)}
            className={
              "px-3 h-8 text-xs font-medium rounded-lg transition-colors " +
              (isActive
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-accent")
            }
            aria-pressed={isActive}
          >
            {rangeLabel(td, opt)}
          </button>
        );
      })}
    </div>
  );
}

// ── Utilities ───────────────────────────────────────────────────

// exported for tests
export function formatNumber(value: number | undefined): string {
  if (value == null) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)}k`;
  return new Intl.NumberFormat("en-US").format(value);
}

function formatTimestamp(t: FeedPageDict, iso: string): string {
  const ts = new Date(iso);
  if (isNaN(ts.getTime())) return iso;
  const diffMs = Date.now() - ts.getTime();
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (diffDays < 1) return t.insights.timeToday;
  if (diffDays === 1) return t.insights.timeYesterday;
  if (diffDays < 7) return format(t.home.timeDaysAgo, { count: diffDays });
  return ts.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function ExternalIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

// Engagement icons — same stroke weight + viewBox as
// `external-post-card.tsx` so the dashboard and the draft preview read
// identically. Heart/Comment/Repost match exactly; Eye is for "views"
// (insights surfaces it where embeds don't); Quote replaces Share so the
// icon vocabulary tracks Threads' actual feature names.

const COUNTER_ICON_PROPS = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor" as const,
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function EyeIcon() {
  return (
    <svg {...COUNTER_ICON_PROPS} aria-hidden>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg {...COUNTER_ICON_PROPS} aria-hidden>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function HeartIcon() {
  return (
    <svg {...COUNTER_ICON_PROPS} aria-hidden>
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}

function CommentIcon() {
  return (
    <svg {...COUNTER_ICON_PROPS} aria-hidden>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function RepostIcon() {
  return (
    <svg {...COUNTER_ICON_PROPS} aria-hidden>
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

function QuoteIcon() {
  return (
    <svg {...COUNTER_ICON_PROPS} aria-hidden>
      <path d="M3 7a2 2 0 0 1 2-2h6l4 4v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M14 5h5a2 2 0 0 1 2 2v8" />
    </svg>
  );
}
