/**
 * Chat sessions data - the ONE hook the Chat sidebar panel and the Chat
 * surface both read (instant-navigation contract N1, N2, N7).
 *
 * Before this module each side fetched its own copy: the panel ran
 * `setRows(null)` then roster -> sessions on every Chat entry and painted
 * "Loading", and the surface ran the same waterfall a second time for its
 * thread -> assistant resolution. Neither read a cache, so every entry
 * cold-loaded a list the user had been looking at a moment earlier. Both now
 * read three surface-cache keys built in `lib/surface-prefetch.ts`:
 *
 *  - `chat-roster:<wid>:<viewer>`   the workspace's assistants
 *  - `chat-sessions:<wid>:<viewer>` the viewer's personal threads (merged
 *                                   across every assistant, newest first)
 *  - `chat-shared:<wid>:<viewer>`   the workspace's shared rooms
 *
 * The roster and the shared list fetch in PARALLEL. The personal list needs
 * the roster's ids (`listSessionsForAssistants` fans out per assistant), so
 * its fetcher reads the roster from the cache entry synchronously when a
 * fresh copy is there and otherwise JOINS the roster load already in flight
 * (`loadSurfaceCache` dedupes by key) - never a second roster request, never
 * a serial roster -> sessions effect chain.
 *
 * Disk tier (plan section 6.4): the two session lists are mirrored into the
 * offline IndexedDB store under a viewer + workspace key, the way the Brain
 * graph is (`lib/offline/brain-content-cache.ts`), so a full reload paints the
 * last-known rail while the network answers. The memory tier wins whenever it
 * holds a value; the disk copy fills only the cold gap. An authoritative
 * denial on the roster fetch (401 / 403 / 404 - the viewer lost the
 * workspace) evicts the disk copy rather than falling back to it. Sign-out
 * sweeps the whole KV store (`clearLocalDocCaches`), this key included.
 *
 * Stale triggers: the spine (`lib/surface-cache-invalidation.ts`: the
 * `session` primitive marks the two list keys, the `assistant` primitive marks
 * the roster) plus the same-tab `CHAT_SESSIONS_REFRESH_EVENT`, which this hook
 * turns into `markSurfaceCacheStale` on the two list keys. Neither the panel
 * nor the surface carries a refetch listener of its own any more; a user's
 * own mutation patches the cached rows through `mutateSurfaceCache` and lets
 * the stale mark revalidate behind the paint.
 *
 * Transcripts: `chat-transcript:<sessionId>`, keyed per SESSION so a thread
 * switch paints the last transcript of the SAME session when one is cached
 * and never the previous thread's rows. The chat reducer stays the render
 * source (a live turn streams into it), so the surface drives this key
 * explicitly through the helpers at the bottom rather than through
 * `useCachedResource`'s auto-revalidation, which could race a running turn.
 *
 * Spec: docs/architecture/features/perceived-performance.md ->
 * "Instant-navigation contract"; docs/architecture/features/chat-app.md.
 * [COMP:app-web/chat-sessions-cache]
 */

import { useCallback, useEffect, useState } from "react";
import {
  listWorkspaceAssistants,
  type WorkspaceAssistantSummary,
} from "@/lib/api/views";
import {
  listSessionsForAssistants,
  listWorkspaceSessions,
  type DocSession,
  type WorkspaceSession,
} from "@/lib/api/sessions";
import {
  chatRosterCacheKey,
  chatSessionsCacheKey,
  chatSharedSessionsCacheKey,
  chatTranscriptCacheKey,
} from "@/lib/surface-prefetch";
import {
  isSurfaceCacheStale,
  loadSurfaceCache,
  markSurfaceCacheStale,
  mutateSurfaceCache,
  readSurfaceCache,
  useCachedResource,
} from "@/lib/surface-cache";
import { idbDelete, idbGet, idbSet } from "@/lib/offline/idb";
import { getUserInfo } from "@/lib/user";
import { CHAT_SESSIONS_REFRESH_EVENT } from "@/lib/chat-session-events";
import { leaseSurfaceContent, surfaceContentRemaining, useLeasedResource } from "@/lib/offline/surface-content-cache";

// ── Disk tier ────────────────────────────────────────────────────────────

const SNAPSHOT_VERSION = 1;
const SNAPSHOT_PREFIX = "chat-sessions";

/** The two lists the rail paints, persisted together as one envelope. */
export type ChatSessionsSnapshot = {
  personal: DocSession[];
  shared: WorkspaceSession[];
};

type StoredSnapshot = {
  version: typeof SNAPSHOT_VERSION;
  updatedAt: number;
  value: unknown;
};

/**
 * The IndexedDB key: viewer FIRST because the store is browser-wide and the
 * multi-account switcher changes the viewer without a reload - two accounts
 * on one device must never read each other's threads.
 */
export function chatSessionsSnapshotKey(
  viewerId: string,
  workspaceId: string,
): string {
  return `${SNAPSHOT_PREFIX}:${viewerId}:${workspaceId}`;
}

function isSessionRow(value: unknown): value is DocSession {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<DocSession>;
  return (
    typeof row.id === "string" &&
    typeof row.title === "string" &&
    typeof row.lastActive === "string"
  );
}

function isChatSessionsSnapshot(
  value: unknown,
): value is ChatSessionsSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<ChatSessionsSnapshot>;
  return (
    Array.isArray(snapshot.personal) &&
    snapshot.personal.every(isSessionRow) &&
    Array.isArray(snapshot.shared) &&
    snapshot.shared.every(isSessionRow)
  );
}

function isEnvelope(value: unknown): value is StoredSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredSnapshot>;
  return (
    candidate.version === SNAPSHOT_VERSION &&
    typeof candidate.updatedAt === "number" &&
    "value" in candidate
  );
}

/** Read + validate the persisted lists; anything corrupt or missing is `null`. */
async function readChatSessionsSnapshot(
  viewerId: string,
  workspaceId: string,
): Promise<ChatSessionsSnapshot | null> {
  const stored = await idbGet<unknown>(
    chatSessionsSnapshotKey(viewerId, workspaceId),
  );
  if (!isEnvelope(stored) || !isChatSessionsSnapshot(stored.value)) return null;
  return stored.value;
}

/** Best-effort last-known-good replacement. */
export async function writeChatSessionsSnapshot(
  viewerId: string,
  workspaceId: string,
  value: ChatSessionsSnapshot,
): Promise<void> {
  const envelope: StoredSnapshot = {
    version: SNAPSHOT_VERSION,
    updatedAt: Date.now(),
    value,
  };
  await idbSet(chatSessionsSnapshotKey(viewerId, workspaceId), envelope);
}

/** Evict after an authoritative denial (the viewer lost the workspace). */
async function deleteChatSessionsSnapshot(
  viewerId: string,
  workspaceId: string,
): Promise<void> {
  await idbDelete(chatSessionsSnapshotKey(viewerId, workspaceId));
}

/**
 * `listWorkspaceAssistants` throws `Failed to list workspace assistants:
 * <status>` on a non-OK response; the two session fetchers swallow their
 * status and return `[]`. The roster is therefore the one fetch on this
 * workspace that can tell an access loss from a transient failure, and it
 * decides the disk eviction for all three keys.
 */
export function isAuthoritativeRosterDenial(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = /:\s*(\d{3})\s*$/.exec(error.message)?.[1];
  return status === "401" || status === "403" || status === "404";
}

// ── Fetchers ─────────────────────────────────────────────────────────────

/**
 * The roster the personal-sessions fetch fans out over. A fresh cached copy
 * is read synchronously; a cold or stale one joins (or starts) the roster
 * load under the same key the roster hook uses, so the two never race two
 * requests. A failed roster load falls back to the last cached roster, then
 * to an empty one (an empty fan-out returns no rows rather than throwing).
 */
async function resolveRoster(
  workspaceId: string,
): Promise<WorkspaceAssistantSummary[]> {
  const key = chatRosterCacheKey(workspaceId);
  const entry = readSurfaceCache<WorkspaceAssistantSummary[]>(key);
  if (entry.data !== undefined && !isSurfaceCacheStale(key)) return entry.data;
  const loaded = await loadSurfaceCache(key, () =>
    leaseSurfaceContent(() => listWorkspaceAssistants(workspaceId)),
    { expiresInMs: surfaceContentRemaining },
  );
  return loaded ?? entry.data ?? [];
}

/** The fetcher behind `chat-sessions:<wid>:<viewer>`. */
export async function fetchPersonalChatSessions(
  workspaceId: string,
): Promise<DocSession[]> {
  const roster = await resolveRoster(workspaceId);
  if (roster.length === 0) return [];
  return listSessionsForAssistants({
    workspaceId,
    assistantIds: roster.map((assistant) => assistant.id),
  });
}

/** The fetcher behind `chat-shared:<wid>:<viewer>`. */
function fetchSharedChatSessions(
  workspaceId: string,
): Promise<WorkspaceSession[]> {
  return listWorkspaceSessions({ workspaceId });
}

// ── Optimistic patches ───────────────────────────────────────────────────

/**
 * Apply a local edit to a cached list. `mutateSurfaceCache` alone no-ops on
 * an empty slot, which is right for a rename or a delete (there is no list
 * to patch, and inventing one would paint "no chats yet" over rows the
 * server holds). `seed` opts into filling an empty slot with `updater([])` -
 * a room created on a cold pane must resolve as a room the moment it exists.
 * A seed goes through `loadSurfaceCache`, so it joins any load already in
 * flight, in which case the network copy (which includes the row) lands a
 * beat later instead.
 */
function patchOrSeed<T>(
  key: string,
  updater: (rows: T[]) => T[],
  seed: boolean,
): void {
  const entry = readSurfaceCache<T[]>(key);
  if (entry.data !== undefined) {
    mutateSurfaceCache<T[]>(key, updater);
    return;
  }
  if (!seed) return;
  void loadSurfaceCache<T[]>(key, async () => updater([]));
}

export function patchSharedChatSessions(
  workspaceId: string,
  updater: (rows: WorkspaceSession[]) => WorkspaceSession[],
  options?: { seed?: boolean },
): void {
  patchOrSeed(chatSharedSessionsCacheKey(workspaceId), updater, !!options?.seed);
}

export function patchPersonalChatSessions(
  workspaceId: string,
  updater: (rows: DocSession[]) => DocSession[],
  options?: { seed?: boolean },
): void {
  patchOrSeed(chatSessionsCacheKey(workspaceId), updater, !!options?.seed);
}

/** Mark both session lists stale - the same-tab refresh signal's effect. */
function markChatSessionsStale(workspaceId: string): void {
  markSurfaceCacheStale(chatSessionsCacheKey(workspaceId));
  markSurfaceCacheStale(chatSharedSessionsCacheKey(workspaceId));
}

// ── The hook ─────────────────────────────────────────────────────────────

export type ChatSessionsData = {
  assistants: WorkspaceAssistantSummary[];
  /** The roster fetch has settled (with rows or with an error). */
  assistantsLoaded: boolean;
  /** `null` only when NOTHING is cached in memory or on disk - the one state
   *  that paints the rail skeleton. */
  personal: DocSession[] | null;
  shared: WorkspaceSession[] | null;
  /** Any of the three loads is in flight behind painted rows. */
  revalidating: boolean;
  /** Force every list to revalidate (rows stay painted). */
  refresh: () => Promise<void>;
  refreshShared: () => Promise<WorkspaceSession[] | undefined>;
  refreshPersonal: () => Promise<DocSession[] | undefined>;
};

const EMPTY_ASSISTANTS: WorkspaceAssistantSummary[] = [];

export function useChatSessionsData(
  workspaceId: string | null | undefined,
): ChatSessionsData {
  const wid = workspaceId || null;
  const rosterKey = wid ? chatRosterCacheKey(wid) : null;
  const sessionsKey = wid ? chatSessionsCacheKey(wid) : null;
  const sharedKey = wid ? chatSharedSessionsCacheKey(wid) : null;

  const roster = useLeasedResource<WorkspaceAssistantSummary[]>(rosterKey, () =>
    listWorkspaceAssistants(wid as string),
  );
  const personal = useLeasedResource<DocSession[]>(sessionsKey, () =>
    fetchPersonalChatSessions(wid as string),
  );
  const shared = useLeasedResource<WorkspaceSession[]>(sharedKey, () =>
    fetchSharedChatSessions(wid as string),
  );

  // Disk tier: read once per (viewer, workspace); the memory tier out-ranks
  // it as soon as either list lands.
  const viewerId = getUserInfo()?.id ?? null;
  const scope = viewerId && wid ? chatSessionsSnapshotKey(viewerId, wid) : null;
  const [persisted, setPersisted] = useState<{
    scope: string;
    snapshot: ChatSessionsSnapshot;
  } | null>(null);
  useEffect(() => {
    if (!viewerId || !wid || !scope) return;
    let cancelled = false;
    void readChatSessionsSnapshot(viewerId, wid).then((snapshot) => {
      if (cancelled || !snapshot) return;
      setPersisted({ scope, snapshot });
    });
    return () => {
      cancelled = true;
    };
  }, [scope, viewerId, wid]);
  // Persist only a healthy pair: with the roster in error the personal list
  // is a degraded `[]` (the fan-out had nothing to fan over), and after an
  // authoritative denial the eviction below must be the last write.
  useEffect(() => {
    if (!viewerId || !wid || !personal.data || !shared.data) return;
    if (roster.error !== undefined) return;
    void writeChatSessionsSnapshot(viewerId, wid, {
      personal: personal.data,
      shared: shared.data,
    });
  }, [personal.data, roster.error, shared.data, viewerId, wid]);
  useEffect(() => {
    if (!viewerId || !wid || !isAuthoritativeRosterDenial(roster.error)) return;
    setPersisted(null);
    void deleteChatSessionsSnapshot(viewerId, wid);
  }, [roster.error, viewerId, wid]);

  // The same-tab refresh signal (a rename, a delete, a turn settling with an
  // auto-title, a room created) marks both lists stale; the hook's own load
  // effect then revalidates behind the painted rows.
  useEffect(() => {
    if (!wid || typeof window === "undefined") return;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId?: string | null }>)
        .detail;
      if (detail?.workspaceId && detail.workspaceId !== wid) return;
      markChatSessionsStale(wid);
    };
    window.addEventListener(CHAT_SESSIONS_REFRESH_EVENT, handler);
    return () => window.removeEventListener(CHAT_SESSIONS_REFRESH_EVENT, handler);
  }, [wid]);

  const denied = isAuthoritativeRosterDenial(roster.error);
  const disk = !denied && persisted && persisted.scope === scope ? persisted.snapshot : null;

  const refreshShared = shared.refresh;
  const refreshPersonal = personal.refresh;
  const refreshRoster = roster.refresh;
  const refresh = useCallback(async () => {
    await Promise.all([refreshRoster(), refreshShared(), refreshPersonal()]);
  }, [refreshPersonal, refreshRoster, refreshShared]);

  return {
    assistants: roster.data ?? EMPTY_ASSISTANTS,
    assistantsLoaded: roster.data !== undefined || roster.error !== undefined,
    personal: personal.data ?? disk?.personal ?? null,
    shared: shared.data ?? disk?.shared ?? null,
    revalidating: roster.revalidating || personal.revalidating || shared.revalidating,
    refresh,
    refreshShared,
    refreshPersonal,
  };
}

// ── Transcripts ──────────────────────────────────────────────────────────

/** The cached transcript for a session, or `undefined` when cold. */
export function readCachedTranscript<T>(sessionId: string): T[] | undefined {
  return readSurfaceCache<T[]>(chatTranscriptCacheKey(sessionId)).data;
}

/**
 * Write-through for the reducer's rows (an optimistic user message, a turn
 * that just streamed in), so a revisit paints them before the refetch.
 * Patches the cached slot when there is one; seeds it otherwise, which joins
 * any fetch in flight for the same session (the fetch then wins, and it
 * carries the same rows).
 */
export function writeTranscriptCache<T>(sessionId: string, messages: T[]): void {
  patchOrSeed<T>(chatTranscriptCacheKey(sessionId), () => messages, true);
}

/**
 * Load a session's transcript into the cache. `force` bypasses the in-flight
 * dedupe: a room's settle refetch must not join a hydrate request that
 * started before the turn ended, or it would miss the turn it exists to
 * pick up. Resolves `undefined` when the fetch failed and nothing is cached.
 */
export async function loadTranscriptCache<T>(
  sessionId: string,
  fetcher: () => Promise<T[]>,
  options?: { force?: boolean },
): Promise<T[] | undefined> {
  if (options?.force) {
    const rows = await fetcher();
    writeTranscriptCache(sessionId, rows);
    return rows;
  }
  return loadSurfaceCache<T[]>(chatTranscriptCacheKey(sessionId), fetcher);
}
