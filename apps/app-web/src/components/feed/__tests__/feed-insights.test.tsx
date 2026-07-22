/**
 * [COMP:app-web/feed-insights] Feed insights — static render contract +
 * the ported pure helpers.
 *
 * vitest in app-web is node-only — `renderToString` + module mocks (the
 * feed-inbox test shape). Effects never run under SSR, so the insights /
 * mentions / quotes fetches stay dormant and the page always paints its
 * loading state: header (heading, range picker), profile-summary skeleton
 * cards, and the post-grid skeleton; the connect-first gate renders when
 * the platform has no profile. The pure helpers (`computePrimaryMetrics`,
 * `computeMedian`, `extractTrendSeries`, `countByKind`, `formatCount`,
 * `formatNumber`) carry the metric-derivation contracts and are asserted
 * directly. Range switching, filters, and the live fetch path are web-QA.
 *
 * SSR quirk: adjacent text/expression JSX renders with comment-node
 * separators, and apostrophes are HTML-escaped — assertions stick to
 * substrings that live inside a single expression and avoid `'`.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

import type { FeedWorkspaceValue } from "@/contexts/feed-profiles-context";

const workspaceRef = vi.hoisted(
  () => ({ current: null }) as { current: unknown },
);
const paramsRef = vi.hoisted(
  () => ({ current: {} }) as { current: Record<string, string> },
);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => paramsRef.current,
}));
vi.mock("@/lib/auth-fetch", () => ({
  authFetch: vi.fn(),
  getAccessToken: () => null,
}));
vi.mock("@/contexts/feed-profiles-context", () => ({
  useFeedWorkspace: () => workspaceRef.current,
}));

import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { FeedInsightsPost, FeedProfile } from "@/lib/api/feed";
import {
  FeedInsights,
  computeMedian,
  computePrimaryMetrics,
  countByKind,
  extractTrendSeries,
  formatCount,
  formatNumber,
} from "../feed-insights";

const dict = en as unknown as Dictionary;
const td = en.feedPage.insights;

function profile(
  platform: FeedProfile["platform"],
  handle: string,
): FeedProfile {
  return {
    assistantId: `a-${handle}`,
    platform,
    platformHandle: handle,
    profilePictureUrl: null,
    enabled: true,
    assistant: { id: `a-${handle}`, name: handle, iconSeed: 0 },
  };
}

function workspace(profiles: FeedProfile[]): FeedWorkspaceValue {
  return {
    workspaceId: "ws-1",
    name: "Acme Team",
    role: "admin",
    canDraft: true,
    me: { id: "u-1" },
    profiles,
    assistants: [],
    refresh: async () => {},
  };
}

function render(profiles: FeedProfile[], platform = "threads"): string {
  workspaceRef.current = workspace(profiles);
  paramsRef.current = { workspaceId: "ws-1", platform };
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <FeedInsights />
    </I18nProvider>,
  );
}

function post(
  id: string,
  kind: FeedInsightsPost["kind"],
  insights: FeedInsightsPost["insights"],
): FeedInsightsPost {
  return {
    id,
    kind,
    permalink: null,
    text: "hello",
    timestamp: null,
    repliedToId: null,
    insights,
  };
}

describe("[COMP:app-web/feed-insights] FeedInsights", () => {
  it("renders the header, range picker, and loading skeletons (effects never run under SSR)", () => {
    const html = render([profile("threads", "acme")]);
    // Heading interpolates the platform label; subtitle interpolates the
    // handle (asserted apostrophe-free).
    expect(html).toContain("Insights · Threads");
    expect(html).toContain("@acme");
    expect(html).toContain(td.range7d);
    expect(html).toContain(td.range90d);
    expect(html).toContain(td.recentPostsHeading);
    // Metric cards + post grid paint their pulse skeletons while loading.
    expect(html).toContain(td.metricFollowers);
    expect(html).toContain(td.metricViews);
    expect(html).toContain("animate-pulse");
    // No data yet: no empty state, no kind filter, no mentions section.
    expect(html).not.toContain(td.emptyTitle);
    expect(html).not.toContain(td.filterPosts);
    expect(html).not.toContain("Mentions ·");
  });

  it("not-connected platform renders the connect-first gate linking to the feed home", () => {
    const html = render([], "twitter");
    expect(html).toContain("Connect X first");
    expect(html).toContain(
      "Connect a X account to see post and account insights.",
    );
    expect(html).toContain('href="/w/ws-1/feed"');
    expect(html).not.toContain(td.recentPostsHeading);
  });

  it("computeMedian: even/odd/empty lists", () => {
    expect(computeMedian([])).toBe(0);
    expect(computeMedian([3, 1, 2])).toBe(2);
    expect(computeMedian([4, 1, 2, 3])).toBe(2.5);
  });

  it("extractTrendSeries: followers read the snapshot column (null → 0); aggregates read their column", () => {
    const trends = [
      { day: "2026-07-01", followers: 10, views: 5, likes: 1, replies: 2, reposts: 3, quotes: 4 },
      { day: "2026-07-02", followers: null, views: 7, likes: 0, replies: 0, reposts: 0, quotes: 0 },
    ];
    expect(extractTrendSeries(trends, "followers_count")).toEqual([10, 0]);
    expect(extractTrendSeries(trends, "views")).toEqual([5, 7]);
    expect(extractTrendSeries(trends, "quotes")).toEqual([4, 0]);
  });

  it("computePrimaryMetrics: a ≥1.5×-median lead marks the top post; median==max marks nothing", () => {
    const posts = [
      post("p1", "post", { views: 100, likes: 1 }),
      post("p2", "post", { views: 10, likes: 1 }),
      post("p3", "post", { views: 10, likes: 1 }),
    ];
    const map = computePrimaryMetrics(posts);
    expect(map.get("p1")).toBe("views");
    expect(map.has("p2")).toBe(false);

    // A single post is its own median — never a standout.
    expect(computePrimaryMetrics([post("x", "post", { views: 50 })]).size).toBe(
      0,
    );
    expect(computePrimaryMetrics([]).size).toBe(0);
  });

  it("computePrimaryMetrics: a post leading two metrics keeps only its strongest lead", () => {
    const posts = [
      post("a", "post", { views: 100, likes: 30 }),
      post("b", "post", { views: 10, likes: 10 }),
      post("c", "post", { views: 10, likes: 10 }),
    ];
    // views ratio 10× beats likes ratio 3× — a single tint, views.
    expect(computePrimaryMetrics(posts).get("a")).toBe("views");
  });

  it("countByKind tallies the filter chip counts", () => {
    const posts = [
      post("1", "post", {}),
      post("2", "reply", {}),
      post("3", "reply", {}),
      post("4", "quote", {}),
    ];
    expect(countByKind(posts)).toEqual({ post: 1, reply: 2, quote: 1 });
  });

  it("formatCount matches the embed-style compaction steps", () => {
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1234)).toBe("1.2K");
    expect(formatCount(31527)).toBe("32K");
    expect(formatCount(1234567)).toBe("1.2M");
    expect(formatCount(12345678)).toBe("12M");
  });

  it("formatNumber: null placeholder, grouped small values, k/M compaction", () => {
    expect(formatNumber(undefined)).toBe("—");
    expect(formatNumber(1500)).toBe("1,500");
    expect(formatNumber(12345)).toBe("12.3k");
    expect(formatNumber(2_500_000)).toBe("2.5M");
  });
});
