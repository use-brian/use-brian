/**
 * Feed section navigation — the single source of truth for the Feed surface's
 * grouped sub-menu (`FeedSidebarPanel`) and its route helpers, mirroring
 * `studio-nav.ts` (the root CLAUDE.md "derive, don't duplicate" rule).
 *
 * The Feed surface is the ported feed-web operator app
 * (docs/plans/feed-web-consolidation.md): team-level rows (home / inbox /
 * voice) plus per-platform rows (insights / inspiration / drafts / connection /
 * policy / settings) scoped by the active connected platform.
 *
 * The keys index into the i18n `feedPage.sections` / `feedPage.groups`
 * dictionaries; the `segment` is the child route under
 * `/w/[id]/feed/` (team rows) or `/w/[id]/feed/[platform]/` (platform rows).
 *
 * [COMP:app-web/feed-nav]
 */

import type { useT } from "@/lib/i18n/client";

export type FeedSectionKey =
  keyof ReturnType<typeof useT>["feedPage"]["sections"];
type FeedGroupKey = keyof ReturnType<typeof useT>["feedPage"]["groups"];

/** The distribution platforms the feed engine supports. Mirrors the backend's
 *  `distribution_profiles.platform` enum — the URL segment is the platform id. */
export const FEED_PLATFORMS = ["threads", "twitter"] as const;
export type FeedPlatform = (typeof FEED_PLATFORMS)[number];

const FEED_PLATFORM_SET: ReadonlySet<string> = new Set(FEED_PLATFORMS);

/** Narrow an arbitrary route segment to a known feed platform. */
export function isFeedPlatform(
  value: string | null | undefined,
): value is FeedPlatform {
  return !!value && FEED_PLATFORM_SET.has(value);
}

type FeedSection = {
  key: FeedSectionKey;
  /** Route segment. Team rows: under `/feed/`; the home row is the bare
   *  `/feed` index (empty segment). Platform rows: under `/feed/[platform]/`. */
  segment: string;
};
export type FeedGroup = {
  key: FeedGroupKey;
  /** Platform-group sections live under the active `/feed/[platform]/`. */
  perPlatform: boolean;
  sections: readonly FeedSection[];
};

/**
 * Grouped by scope (docs/architecture/feed/operator-app.md):
 *   workspace — team-level surfaces (dashboard, approval inbox, voice)
 *   platform  — surfaces scoped to one connected platform account
 */
export const FEED_GROUPS: readonly FeedGroup[] = [
  {
    key: "workspace",
    perPlatform: false,
    sections: [
      { key: "home", segment: "" },
      { key: "inbox", segment: "inbox" },
      { key: "voice", segment: "voice" },
    ],
  },
  {
    key: "platform",
    perPlatform: true,
    sections: [
      { key: "insights", segment: "insights" },
      { key: "inspiration", segment: "inspiration" },
      { key: "draftSessions", segment: "draft-sessions" },
      { key: "connection", segment: "connection" },
      { key: "policy", segment: "policy" },
      { key: "settings", segment: "settings" },
    ],
  },
] as const;

/**
 * Build a feed route. No args past the workspace → the `/feed` index (home).
 * A `segment` without a `platform` targets a team row (`/feed/inbox`); with a
 * `platform` it targets that platform's row (`/feed/threads/insights`).
 */
export function feedPath(
  workspaceId: string,
  opts: { platform?: FeedPlatform; segment?: string } = {},
): string {
  const base = `/w/${workspaceId}/feed`;
  if (opts.platform) {
    return opts.segment
      ? `${base}/${opts.platform}/${opts.segment}`
      : `${base}/${opts.platform}`;
  }
  return opts.segment ? `${base}/${opts.segment}` : base;
}

/** Matches `/w/<id>/feed[/rest]`, capturing everything after `/feed`. */
const FEED_PATH_RE = /^\/w\/[^/]+\/feed(?:\/([^?#]*))?/;

/**
 * The active feed platform from a pathname (`/w/<id>/feed/<platform>/...`),
 * or `null` on team rows / non-feed paths. Drives the sidebar platform pill.
 */
export function feedPlatformFromPathname(
  pathname: string | null | undefined,
): FeedPlatform | null {
  if (!pathname) return null;
  const m = FEED_PATH_RE.exec(pathname);
  if (!m || !m[1]) return null;
  const first = m[1].split("/")[0];
  return isFeedPlatform(first) ? first : null;
}

/**
 * Resolve the active feed section from a pathname. `/feed` → `home`;
 * `/feed/inbox` → `inbox`; `/feed/<platform>/<segment>[/...]` → the matching
 * platform section. Null when the path isn't inside the feed surface or the
 * segment is unknown.
 */
export function feedSectionFromPathname(
  pathname: string | null | undefined,
): FeedSectionKey | null {
  if (!pathname) return null;
  const m = FEED_PATH_RE.exec(pathname);
  if (!m) return null;
  const rest = (m[1] ?? "").split("/").filter(Boolean);
  if (rest.length === 0) return "home";
  const [first, second] = rest;
  if (isFeedPlatform(first)) {
    if (!second) return null;
    for (const group of FEED_GROUPS) {
      if (!group.perPlatform) continue;
      for (const section of group.sections) {
        if (section.segment === second) return section.key;
      }
    }
    return null;
  }
  for (const group of FEED_GROUPS) {
    if (group.perPlatform) continue;
    for (const section of group.sections) {
      if (section.segment === first) return section.key;
    }
  }
  return null;
}
