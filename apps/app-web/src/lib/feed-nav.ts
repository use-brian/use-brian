/**
 * Feed section navigation — the single source of truth for the Feed surface's
 * grouped sub-menu (`FeedSidebarPanel`) and its route helpers, mirroring
 * `studio-nav.ts` (the root CLAUDE.md "derive, don't duplicate" rule).
 *
 * The Feed surface splits into two groups (docs/plans/feed-create-split.md):
 * **Create** — workspace-level content creation (home / voice / drafts /
 * inbox / ready), which works with ZERO platform connections — and
 * **Platforms** — the integration side, one row per target platform with
 * per-platform sub-rows (insights / inspiration / connection / policy /
 * settings) for connected ones.
 *
 * The keys index into the i18n `feedPage.sections` / `feedPage.groups`
 * dictionaries; the `segment` is the child route under
 * `/w/[id]/feed/` (create rows) or `/w/[id]/feed/[platform]/` (platform rows).
 *
 * [COMP:app-web/feed-nav]
 */

import type { useT } from "@/lib/i18n/client";

export type FeedSectionKey =
  keyof ReturnType<typeof useT>["feedPage"]["sections"];
type FeedGroupKey = keyof ReturnType<typeof useT>["feedPage"]["groups"];

/**
 * The platforms a team can DRAFT for — the Create half of the split. The
 * URL segment is the platform id. Mirrors the backend's
 * `FEED_TARGET_PLATFORMS` (`packages/api-platform/src/db/feed-store.ts`).
 */
export const FEED_PLATFORMS = ["instagram", "threads", "twitter", "xhs"] as const;
export type FeedPlatform = (typeof FEED_PLATFORMS)[number];

/**
 * The platforms with a full integration (OAuth + publish). Mirrors the
 * backend's `distribution_profiles.platform` CHECK constraint. The connect
 * dialog and OAuth URL builder derive from THIS list — Instagram/XHS render
 * a coming-soon connection stub instead.
 */
export const FEED_CONNECTABLE_PLATFORMS = ["threads", "twitter"] as const;
export type ConnectableFeedPlatform =
  (typeof FEED_CONNECTABLE_PLATFORMS)[number];

const FEED_PLATFORM_SET: ReadonlySet<string> = new Set(FEED_PLATFORMS);
const FEED_CONNECTABLE_SET: ReadonlySet<string> = new Set(
  FEED_CONNECTABLE_PLATFORMS,
);

/** Narrow an arbitrary route segment to a known feed target platform. */
export function isFeedPlatform(
  value: string | null | undefined,
): value is FeedPlatform {
  return !!value && FEED_PLATFORM_SET.has(value);
}

/** Narrow a target platform to the connectable (OAuth + publish) subset. */
export function isConnectableFeedPlatform(
  value: string | null | undefined,
): value is ConnectableFeedPlatform {
  return !!value && FEED_CONNECTABLE_SET.has(value);
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
 * Grouped by the Create/Platforms split (docs/architecture/feed/operator-app.md):
 *   create    — workspace-level content creation (works with zero
 *               connections): dashboard, voice, drafts, approval inbox,
 *               ready-to-post queue. Drafts hoisted here from the old
 *               per-platform `draft-sessions` row (feed-create-split.md D8).
 *   platforms — the integration side, scoped to one platform account
 */
export const FEED_GROUPS: readonly FeedGroup[] = [
  {
    key: "create",
    perPlatform: false,
    sections: [
      { key: "home", segment: "" },
      { key: "voice", segment: "voice" },
      { key: "drafts", segment: "drafts" },
      { key: "inbox", segment: "inbox" },
      { key: "ready", segment: "ready" },
    ],
  },
  {
    key: "platforms",
    perPlatform: true,
    sections: [
      { key: "insights", segment: "insights" },
      { key: "inspiration", segment: "inspiration" },
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

// ── Platform pick (guided first-run, feed-create-split.md D14) ────────────
//
// The platforms the brand posts on, chosen in the feed home's first-run step
// and used as the default platform on the Drafts and Voice pages. Stored
// per-workspace in localStorage — a per-device UI default, deliberately not
// server state (the `workspaces` table has no generic settings jsonb and the
// sidebar/chips still switch freely). Reads are validated against
// `FEED_PLATFORMS` so a stale pick from a removed platform never leaks out.

const platformPickKey = (workspaceId: string) =>
  `feed:platform-pick:${workspaceId}`;

/** Usable Storage or null — SSR, private mode, and Node 26's undefined
 *  experimental `localStorage` global all resolve to null (no-throw). */
function pickStorage(): Storage | null {
  try {
    const s = (globalThis as { localStorage?: Storage }).localStorage;
    return s && typeof s.getItem === "function" ? s : null;
  } catch {
    return null;
  }
}

/** The stored platform pick for a workspace; `[]` when unset/unavailable. */
export function getFeedPlatformPick(workspaceId: string): FeedPlatform[] {
  const storage = pickStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(platformPickKey(workspaceId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is FeedPlatform => isFeedPlatform(String(p)));
  } catch {
    return [];
  }
}

/** Persist the platform pick. Silently a no-op when storage is unavailable. */
export function setFeedPlatformPick(
  workspaceId: string,
  platforms: readonly FeedPlatform[],
): void {
  const storage = pickStorage();
  if (!storage) return;
  try {
    storage.setItem(platformPickKey(workspaceId), JSON.stringify(platforms));
  } catch {
    /* private mode / quota — the pick just isn't remembered */
  }
}

/**
 * The default platform for Create surfaces: first picked platform, else the
 * first connected profile's platform, else the first target in app order.
 */
export function defaultFeedPlatform(
  workspaceId: string,
  connectedPlatforms: readonly FeedPlatform[],
): FeedPlatform {
  return (
    getFeedPlatformPick(workspaceId)[0] ??
    connectedPlatforms[0] ??
    FEED_PLATFORMS[0]
  );
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
