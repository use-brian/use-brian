/**
 * The Feed surfaces' cache loaders - the fetchers behind the three keys
 * `lib/surface-prefetch.ts` builds for Feed (`feedWorkspaceCacheKey`,
 * `feedSessionsCacheKey`, `feedPlanCacheKey`), each composed over the
 * paint-first disk tier in `lib/offline/feed-cache.ts`.
 *
 * Why this exists (report E "Worst offenders" #1): every Feed entry rendered
 * "Loading your feed workspace..." until five requests resolved, while
 * `feedCachedJson` had every one of those responses on disk and refused to
 * return them while online. Now each loader answers from IndexedDB on a cold
 * memory key and lets the network land behind the paint; a warm key is
 * network-only. Surface keys come from `surface-prefetch.ts`, whose rail
 * hover warm reaches these loaders through a dynamic import.
 *
 * Contract held in every loader:
 *  - the record written to disk is the record the network returned, under
 *    the viewer-scoped `feed:cache:<viewer>:...` namespace, so a shared
 *    device never paints another account's rows;
 *  - an authoritative denial (401 / 403 / 404 on the workspace read) evicts
 *    both tiers and rethrows, never falls back;
 *  - a partial failure (profiles, brand, ideas) degrades the way the
 *    provider always did - the surface renders its pre-feature shape.
 *
 * Spec: docs/architecture/features/perceived-performance.md ->
 * "Instant-navigation contract".
 * [COMP:app-web/feed-surface-cache]
 */

import type { BrandRecord } from "@use-brian/shared/brand";
import { fetchWorkspaceBrand } from "@/lib/api/brand";
import {
  fetchFeedCloudLink,
  fetchFeedDistributionAssistants,
  fetchFeedDraftSessions,
  fetchFeedIdeas,
  fetchFeedTeamProfiles,
  fetchPlanBrief,
  fetchPlanSlots,
  type FeedCloudLink,
  type FeedDraftSessionSummary,
  type FeedProfile,
} from "@/lib/api/feed";
import { deploymentCapabilities } from "@/lib/edition";
import type { FeedPlatform } from "@/lib/feed-nav";
import { feedCollaborationCacheKey } from "@/lib/surface-prefetch";
import type { FeedIdea, PlanBrief, PlanSlot } from "@/lib/feed-plan";
import {
  deleteFeedCachedJson,
  feedCachedJson,
  feedOwner,
  feedPaintFirst,
  isAuthoritativeFeedDenial,
  readFeedCachedJson,
  writeFeedCachedJson,
} from "@/lib/offline/feed-cache";
import { mergeLocalFeedSessions } from "@/lib/offline/feed-offline";
import {
  SurfaceCacheEvictionError,
  loadSurfaceCache,
  mutateSurfaceCache,
  readSurfaceCache,
} from "@/lib/surface-cache";

// ── The workspace record (the shell gate) ────────────────────────────────

/**
 * What the Feed shell resolves before any feed page renders. Mirrors
 * feed-web's `WorkspaceContextValue` minus `refresh`, which the provider
 * composes on top (a function does not belong in a cache row).
 */
export type FeedWorkspaceRecord = {
  workspaceId: string;
  name: string;
  role: "owner" | "admin" | "member";
  canDraft: boolean;
  me: { id: string };
  profiles: FeedProfile[];
  assistants: Array<{ id: string; name: string }>;
  brand: BrandRecord | null;
  cloudLink?: FeedCloudLink;
};

type WorkspaceApiResponse = {
  id?: string;
  name?: string;
  role?: "owner" | "admin" | "member";
  me?: { id: string };
  members?: Array<{
    userId: string;
    role: "owner" | "admin" | "member";
    canDraft: boolean;
  }>;
};

/**
 * Effective draft permission: owner/admin always; for 'member' roles look up
 * the requester's row in the members list and read `canDraft` (the list is
 * gated to team members, so it's safe for the requester's own permission).
 * Falls back to false if the row is missing. Pure - unit-tested directly.
 */
export function deriveCanDraft(team: {
  role: "owner" | "admin" | "member";
  myUserId: string;
  members?: Array<{ userId: string; canDraft: boolean }>;
}): boolean {
  if (team.role === "owner" || team.role === "admin") return true;
  const myMember = team.members?.find((m) => m.userId === team.myUserId);
  return myMember?.canDraft === true;
}

async function loadWorkspaceIdentity(workspaceId: string): Promise<{
  name: string;
  role: "owner" | "admin" | "member";
  myUserId: string;
  canDraft: boolean;
}> {
  const team = await feedCachedJson<WorkspaceApiResponse>(`/api/workspaces/${workspaceId}`);
  if (!team.id || !team.name || !team.role) {
    throw new Error("workspace API returned an incomplete payload");
  }
  const myUserId = team.me?.id ?? "";
  const canDraft = deriveCanDraft({
    role: team.role,
    myUserId,
    members: team.members,
  });
  return { name: team.name, role: team.role, myUserId, canDraft };
}

/** The composed record's disk name (viewer-scoped by `feed-cache.ts`). */
export function feedWorkspaceRecordPath(workspaceId: string): string {
  return `record:feed-workspace:${workspaceId}`;
}

async function fetchFeedWorkspaceRecord(
  workspaceId: string,
  key: string,
): Promise<FeedWorkspaceRecord> {
  const owner = feedOwner();
  const capabilities = deploymentCapabilities();
  let team: Awaited<ReturnType<typeof loadWorkspaceIdentity>>;
  let profiles: FeedProfile[] | null;
  let assistants: Array<{ id: string; name: string }>;
  let brand: BrandRecord | null;
  let cloudLink: FeedCloudLink;
  try {
    [team, profiles, assistants, brand, cloudLink] = await Promise.all([
      loadWorkspaceIdentity(workspaceId),
      // Profiles failure != surface failure: connections are optional to
      // planning. But a failed or timed-out read is not "nothing connected":
      // null here keeps the last-known profiles below, so a slow API never
      // erases a real connection (docs/architecture/feed/twitter.md ->
      // "Return landing").
      fetchFeedTeamProfiles(workspaceId).catch(() => null),
      // Same degrade: the Create surfaces just see no brand voice yet.
      fetchFeedDistributionAssistants(workspaceId).catch(
        () => [] as Array<{ id: string; name: string }>,
      ),
      // A brand read failing must never take down a composer, so this is the
      // same degrade as profiles: null, and every consumer renders its
      // pre-brand shape.
      fetchWorkspaceBrand(workspaceId).catch(() => null),
      capabilities.managedInfrastructure
        ? Promise.resolve({ state: "native" as const })
        : capabilities.hostedUpgradePrompts
          ? fetchFeedCloudLink(workspaceId).catch(
              () => ({ state: "unlinked" as const }),
            )
          : Promise.resolve({ state: "disabled" as const }),
    ]);
  } catch (error) {
    if (isAuthoritativeFeedDenial(error)) {
      // "Not yours" evicts both tiers: the disk copy would otherwise paint a
      // workspace this viewer no longer has on the next cold load.
      await deleteFeedCachedJson(feedWorkspaceRecordPath(workspaceId));
      throw new SurfaceCacheEvictionError(error);
    }
    throw error;
  }
  const record: FeedWorkspaceRecord = {
    workspaceId,
    name: team.name,
    role: team.role,
    canDraft: team.canDraft,
    me: { id: team.myUserId },
    profiles: profiles ?? (await lastKnownFeedProfiles(workspaceId, key)),
    assistants,
    brand,
    cloudLink,
  };
  // The signed-in viewer changed while this was in flight (the multi-account
  // switcher): the record belongs to the previous account.
  if (feedOwner() !== owner) throw new Error("Local identity changed");
  await writeFeedCachedJson(feedWorkspaceRecordPath(workspaceId), record);
  return record;
}

/**
 * The profiles this viewer last saw for the workspace: the in-memory record,
 * else the disk record, else none. Used only when a profiles read fails.
 */
async function lastKnownFeedProfiles(
  workspaceId: string,
  key: string,
): Promise<FeedProfile[]> {
  const memory = readSurfaceCache<FeedWorkspaceRecord>(key).data;
  if (memory) return memory.profiles;
  const disk = await readFeedCachedJson<FeedWorkspaceRecord>(
    feedWorkspaceRecordPath(workspaceId),
  ).catch(() => null);
  return disk?.profiles ?? [];
}

/**
 * Drop a just-disconnected profile from both cache tiers. A failed read keeps
 * the last-known profiles (`lastKnownFeedProfiles`), so without this a
 * disconnect followed by a slow refresh would paint the account again.
 */
export async function forgetFeedProfile(params: {
  workspaceId: string;
  key: string;
  assistantId: string;
  platform: string;
}): Promise<void> {
  const drop = (record: FeedWorkspaceRecord): FeedWorkspaceRecord => ({
    ...record,
    profiles: record.profiles.filter(
      (p) => !(p.assistantId === params.assistantId && p.platform === params.platform),
    ),
  });
  mutateSurfaceCache<FeedWorkspaceRecord>(params.key, drop);
  const path = feedWorkspaceRecordPath(params.workspaceId);
  const disk = await readFeedCachedJson<FeedWorkspaceRecord>(path).catch(() => null);
  if (disk) await writeFeedCachedJson(path, drop(disk), true);
}

/**
 * The shell gate's loader. Paint-first on a cold key, network-only on a warm
 * one (`feedPaintFirst`). `key` is `feedWorkspaceCacheKey(workspaceId)`,
 * built by the caller.
 */
export function loadFeedWorkspaceRecord(
  workspaceId: string,
  key: string,
): Promise<FeedWorkspaceRecord> {
  return feedPaintFirst(
    key,
    () => readFeedCachedJson<FeedWorkspaceRecord>(feedWorkspaceRecordPath(workspaceId)),
    () => fetchFeedWorkspaceRecord(workspaceId, key),
  );
}

// ── One platform's sessions, every assistant ──────────────────────────────

export type FeedPlatformSessions = Array<{
  assistantId: string;
  sessions: FeedDraftSessionSummary[];
}>;

/**
 * The assistants whose sessions a platform list shows: every distribution
 * assistant (connected or not) plus every connected profile's assistant. The
 * sidebar rail and the per-platform posts list derive the SAME set from the
 * workspace record, which is what lets them share one cache key.
 */
export function feedSessionAssistantIds(
  workspace: Pick<FeedWorkspaceRecord, "assistants" | "profiles">,
): string[] {
  const ids = new Set(workspace.assistants.map((a) => a.id));
  for (const profile of workspace.profiles) ids.add(profile.assistantId);
  return Array.from(ids);
}

export function feedSessionsRecordPath(workspaceId: string, platform: FeedPlatform): string {
  return `record:feed-sessions:${workspaceId}:${platform}`;
}

/** Apply known detail denials after local overlays, including late list reads. */
function withoutDeniedFeedSessions(workspaceId: string, lists: FeedPlatformSessions): FeedPlatformSessions {
  return lists.map(({ assistantId, sessions }) => ({
    assistantId,
    sessions: sessions.filter(session => !isAuthoritativeFeedDenial(
      readSurfaceCache(feedCollaborationCacheKey(workspaceId, assistantId, session.id)).error,
    )),
  }));
}

async function fetchFeedPlatformSessions(args: {
  workspaceId: string;
  platform: FeedPlatform;
  workspaceKey: string;
}): Promise<FeedPlatformSessions> {
  const { workspaceId, platform, workspaceKey } = args;
  // The assistant set comes from the workspace record. A warm record answers
  // synchronously; a cold one JOINS the in-flight load (dedupe by key), so the
  // two fetches start together instead of one effect waiting on the other.
  const record =
    readSurfaceCache<FeedWorkspaceRecord>(workspaceKey).data ??
    (await loadSurfaceCache(workspaceKey, () =>
      loadFeedWorkspaceRecord(workspaceId, workspaceKey),
    ));
  if (!record) throw new Error("feed workspace unavailable");
  const perAssistant = await Promise.all(
    feedSessionAssistantIds(record).map(async (assistantId) => ({
      assistantId,
      sessions: await fetchFeedDraftSessions(assistantId, platform).catch(
        () => [] as FeedDraftSessionSummary[],
      ),
    })),
  );
  const permitted = withoutDeniedFeedSessions(workspaceId, perAssistant);
  await writeFeedCachedJson(feedSessionsRecordPath(workspaceId, platform), permitted);
  return withoutDeniedFeedSessions(workspaceId, permitted);
}

/**
 * The per-platform sessions loader. `sessionsKey` is
 * `feedSessionsCacheKey(workspaceId, platform)`, `workspaceKey` is
 * `feedWorkspaceCacheKey(workspaceId)`. The disk copy is re-overlaid with the
 * viewer's dirty local posts (`mergeLocalFeedSessions`) on read: those live in
 * their own IndexedDB record and can move while the list is not mounted.
 */
export function loadFeedPlatformSessions(args: {
  workspaceId: string;
  platform: FeedPlatform;
  sessionsKey: string;
  workspaceKey: string;
}): Promise<FeedPlatformSessions> {
  const { workspaceId, platform, sessionsKey } = args;
  return feedPaintFirst(
    sessionsKey,
    async () => {
      const disk = await readFeedCachedJson<FeedPlatformSessions>(
        feedSessionsRecordPath(workspaceId, platform),
      );
      if (!disk) return null;
      return withoutDeniedFeedSessions(workspaceId, await Promise.all(
        disk.map(async ({ assistantId, sessions }) => ({
          assistantId,
          sessions: await mergeLocalFeedSessions(assistantId, sessions, platform),
        })),
      ));
    },
    () => fetchFeedPlatformSessions(args),
  );
}

// ── One month of the Plan surface ─────────────────────────────────────────

export type FeedPlanMonth = {
  slots: PlanSlot[];
  brief: PlanBrief | null;
  ideas: FeedIdea[];
  /**
   * The slots read failed. The surface still renders (an empty calendar
   * under its load-failed banner, exactly as before), and the record is NOT
   * written to disk, so the next cold load asks the network again.
   */
  loadFailed?: boolean;
};

export function feedPlanRecordPath(assistantId: string, month: string): string {
  return `record:feed-plan:${assistantId}:${month}`;
}

async function fetchFeedPlanMonth(assistantId: string, month: string): Promise<FeedPlanMonth> {
  const [slots, brief, ideas] = await Promise.all([
    fetchPlanSlots(assistantId, month),
    fetchPlanBrief(assistantId, month),
    fetchFeedIdeas(assistantId, "open"),
  ]);
  const record: FeedPlanMonth = {
    slots: slots ?? [],
    brief,
    ideas: ideas ?? [],
    ...(slots === null ? { loadFailed: true } : {}),
  };
  if (slots !== null) {
    await writeFeedCachedJson(feedPlanRecordPath(assistantId, month), record);
  }
  return record;
}

/**
 * The Plan surface's loader: slots, brief and open ideas in parallel, one
 * record. `key` is `feedPlanCacheKey(workspaceId, assistantId, month)`.
 */
export function loadFeedPlanMonth(args: {
  assistantId: string;
  month: string;
  key: string;
}): Promise<FeedPlanMonth> {
  const { assistantId, month, key } = args;
  return feedPaintFirst(
    key,
    () => readFeedCachedJson<FeedPlanMonth>(feedPlanRecordPath(assistantId, month)),
    () => fetchFeedPlanMonth(assistantId, month),
  );
}
