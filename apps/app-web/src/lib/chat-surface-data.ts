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
 * All three reads start independently. Personal history uses the workspace-wide
 * sessions endpoint, whose server-side admission does not need roster IDs.
 * Shared cache keys deduplicate the panel and surface's simultaneous reads.
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
  listPersonalSessions,
  setSessionArchived,
  listWorkspaceSessions,
  type DocSession,
  type WorkspaceSession,
} from "@/lib/api/sessions";
import {
  chatRosterCacheKey,
  chatArchivedSessionsCacheKey,
  chatSessionsCacheKey,
  chatSharedSessionsCacheKey,
  chatTranscriptCacheKey,
} from "@/lib/surface-prefetch";
import {
  invalidateSurfaceCache,
  loadSurfaceCache,
  markSurfaceCacheStale,
  mutateSurfaceCache,
  readSurfaceCache,
  seedSurfaceCache,
  useCachedResource,
  SurfaceCacheEvictionError,
  evictSurfaceCacheKey,
} from "@/lib/surface-cache";
import { idbDelete, idbGet, idbSet } from "@/lib/offline/idb";
import { getUserInfo } from "@/lib/user";
import { CHAT_SESSIONS_REFRESH_EVENT, dispatchChatSessionsRefresh } from "@/lib/chat-session-events";
import { OFFLINE_AUTHORITY_MS, SURFACE_CONTENT_LEASE_MS, useLeasedResource } from "@/lib/offline/surface-content-cache";

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
): Promise<{ snapshot: ChatSessionsSnapshot; expiresAt: number } | null> {
  const stored = await idbGet<unknown>(
    chatSessionsSnapshotKey(viewerId, workspaceId),
  );
  if (!isEnvelope(stored) || !isChatSessionsSnapshot(stored.value)) return null;
  const age = Date.now() - stored.updatedAt;
  if (!Number.isFinite(age) || age >= OFFLINE_AUTHORITY_MS || age < -60_000) return null;
  return { snapshot: stored.value, expiresAt: stored.updatedAt + OFFLINE_AUTHORITY_MS };
}

/** Best-effort last-known-good replacement. */
export async function writeChatSessionsSnapshot(
  viewerId: string,
  workspaceId: string,
  value: ChatSessionsSnapshot,
  updatedAt = Date.now(),
): Promise<void> {
  const envelope: StoredSnapshot = {
    version: SNAPSHOT_VERSION,
    updatedAt,
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
 * Roster and strict session readers include the HTTP status in their errors.
 * An authoritative denial must evict history rather than use a disk copy.
 */
export function isAuthoritativeRosterDenial(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = /:\s*(\d{3})\s*$/.exec(error.message)?.[1];
  return status === "401" || status === "403" || status === "404";
}

/** Commit access eviction with the request that still owns this cache key. */
async function readChatResource<T>(fetch: () => Promise<T>): Promise<T> {
  try { return await fetch(); }
  catch (error) {
    if (isAuthoritativeRosterDenial(error)) throw new SurfaceCacheEvictionError(error);
    throw error;
  }
}

// ── Fetchers ─────────────────────────────────────────────────────────────

/** Workspace-wide history is independently authorized; no roster waterfall. */
export async function fetchPersonalChatSessions(
  workspaceId: string,
): Promise<DocSession[]> {
  return readChatList(chatSessionsCacheKey(workspaceId), () =>
    readChatResource(() => listPersonalSessions({ workspaceId, strict: true })));
}

/** The fetcher behind `chat-shared:<wid>:<viewer>`. */
function fetchSharedChatSessions(
  workspaceId: string,
): Promise<WorkspaceSession[]> {
  return readChatList(chatSharedSessionsCacheKey(workspaceId), () =>
    readChatResource(() => listWorkspaceSessions({ workspaceId, strict: true })));
}

/** Project-filtered pages share the session invalidation prefix and viewer key. */
export function useProjectChatSessionsData(workspaceId: string, projectId: string | null) {
  const key = chatSharedSessionsCacheKey(workspaceId, projectId);
  const rows = useCachedResource(key, () => readChatList(key, () =>
    readChatResource(() => listWorkspaceSessions({ workspaceId, contextProjectId: projectId, strict: true }))));
  const [paging, setPaging] = useState(false);
  const [exhaustedCursor, setExhaustedCursor] = useState<string | null>(null);
  const [pageError, setPageError] = useState<unknown>(null);
  useEffect(() => { setExhaustedCursor(null); setPageError(null); }, [key]);
  const more = async () => {
    const last = rows.data?.at(-1);
    if (!last || paging) return;
    setPaging(true); setPageError(null);
    try {
      const next = await listWorkspaceSessions({ workspaceId, contextProjectId: projectId,
        before: { id: last.id, lastActive: last.lastActive }, strict: true });
      mutateSurfaceCache<WorkspaceSession[]>(key, current => [...current, ...next.filter(row => !current.some(old => old.id === row.id))]);
      setExhaustedCursor(next.length < 50 ? next.at(-1)?.id ?? last.id : null);
    } catch (error) { setPageError(error); } finally { setPaging(false); }
  };
  return { ...rows, error: rows.error ?? pageError, paging, hasMore: rows.data?.at(-1)?.id !== exhaustedCursor, more };
}

/** Keep creations made during an older read; the next read is authoritative. */
async function readChatList<T extends DocSession>(key: string, fetch: () => Promise<T[]>): Promise<T[]> {
  const before = new Set(readSurfaceCache<T[]>(key).data?.map(row => row.id));
  const rows = await fetch();
  const added = (readSurfaceCache<T[]>(key).data ?? []).filter(row =>
    !before.has(row.id) && !rows.some(fetched => fetched.id === row.id));
  return [...added, ...rows];
}

/** Publish a server-confirmed creation in every list that renders its audience. */
export function cacheCreatedChatSession(workspaceId: string, row: DocSession | WorkspaceSession, audience: "personal" | "workspace"): void {
  const keys = audience === "personal" ? [chatSessionsCacheKey(workspaceId)] : [
    chatSharedSessionsCacheKey(workspaceId),
    chatSharedSessionsCacheKey(workspaceId, row.contextProjectId ?? null),
  ];
  for (const key of keys) {
    if (readSurfaceCache<DocSession[]>(key).data !== undefined) {
      mutateSurfaceCache<DocSession[]>(key, rows => [row, ...rows.filter(old => old.id !== row.id)]);
    } else {
      // Seed immediately, even while the original list read is pending. A
      // confirmed create grants only this row a bounded presentation lifetime.
      seedSurfaceCache(key, [row], { expiresInMs: () => SURFACE_CONTENT_LEASE_MS, keepInflightOnExpiry: true }, true);
    }
  }
}

// ── Optimistic patches ───────────────────────────────────────────────────

/** Archived history is separately cached and paged; failures remain visible. */
export function useArchivedChatSessionsData(workspaceId: string, audience: "personal" | "workspace", enabled: boolean) {
  const key = chatArchivedSessionsCacheKey(workspaceId, audience);
  const fetchPage = (before?: { id: string; lastActive: string }): Promise<DocSession[]> => audience === "workspace"
    ? listWorkspaceSessions({ workspaceId, archived: true, strict: true, before })
    : listPersonalSessions({ workspaceId, archived: true, strict: true, before });
  const rows = useCachedResource<DocSession[]>(enabled ? key : null, () => fetchPage());
  const [paging, setPaging] = useState(false);
  const [exhaustedCursor, setExhaustedCursor] = useState<string | null>(null);
  const [pageError, setPageError] = useState<unknown>(null);
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId?: string | null }>).detail;
      if (!detail?.workspaceId || detail.workspaceId === workspaceId) markSurfaceCacheStale(key);
    };
    window.addEventListener(CHAT_SESSIONS_REFRESH_EVENT, handler);
    return () => window.removeEventListener(CHAT_SESSIONS_REFRESH_EVENT, handler);
  }, [enabled, key, workspaceId]);
  useEffect(() => { setExhaustedCursor(null); setPageError(null); }, [key]);
  const more = async () => {
    const last = rows.data?.at(-1);
    if (!last || paging) return;
    setPaging(true); setPageError(null);
    try {
      const next = await fetchPage({ id: last.id, lastActive: last.lastActive });
      mutateSurfaceCache<DocSession[]>(key, current => [...current, ...next.filter(row => !current.some(old => old.id === row.id))]);
      setExhaustedCursor(next.length < 50 ? next.at(-1)?.id ?? last.id : null);
    } catch (error) { setPageError(error); } finally { setPaging(false); }
  };
  const refresh = () => { setPageError(null); setExhaustedCursor(null); return rows.refresh(); };
  return { ...rows, refresh, error: rows.error ?? pageError, paging, hasMore: (rows.data?.length ?? 0) >= 50 && rows.data?.at(-1)?.id !== exhaustedCursor, more };
}

/** The row action and Settings manager share one cache/refresh contract. */
export async function setChatSessionArchived(workspaceId: string, audience: "personal" | "workspace", row: DocSession, archived: boolean): Promise<void> {
  await setSessionArchived(row.id, archived);
  const without = <R extends DocSession>(list: R[]): R[] => list.filter(r => r.id !== row.id);
  patchPersonalChatSessions(workspaceId, without);
  patchSharedChatSessions(workspaceId, without);
  mutateSurfaceCache<DocSession[]>(chatSharedSessionsCacheKey(workspaceId, row.contextProjectId ?? null), without);
  mutateSurfaceCache<DocSession[]>(chatArchivedSessionsCacheKey(workspaceId, audience), without);
  markChatSessionsStale(workspaceId);
  dispatchChatSessionsRefresh(workspaceId);
}

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
  personalError: unknown;
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
    readChatResource(() => listWorkspaceAssistants(wid as string)),
  );
  const personal = useLeasedResource<DocSession[]>(sessionsKey, () =>
    fetchPersonalChatSessions(wid as string),
  );
  const shared = useLeasedResource<WorkspaceSession[]>(sharedKey, () =>
    fetchSharedChatSessions(wid as string),
  );
  const rosterDenied = isAuthoritativeRosterDenial(roster.error);
  const personalDenied = rosterDenied || isAuthoritativeRosterDenial(personal.error);
  const sharedDenied = rosterDenied || isAuthoritativeRosterDenial(shared.error);
  const denied = personalDenied || sharedDenied;

  // Disk tier: read once per (viewer, workspace); the memory tier out-ranks
  // it as soon as either list lands.
  const viewerId = getUserInfo()?.id ?? null;
  const scope = viewerId && wid ? chatSessionsSnapshotKey(viewerId, wid) : null;
  const [persisted, setPersisted] = useState<{
    scope: string;
    snapshot: ChatSessionsSnapshot;
    expiresAt: number;
  } | null>(null);
  useEffect(() => {
    if (!viewerId || !wid || !scope || denied) return;
    let cancelled = false;
    void readChatSessionsSnapshot(viewerId, wid).then((stored) => {
      if (cancelled || !stored) return;
      setPersisted(current => current?.scope === scope && current.expiresAt >= stored.expiresAt ? current : { scope, ...stored });
    });
    return () => {
      cancelled = true;
    };
  }, [denied, scope, viewerId, wid]);
  useEffect(() => {
    if (!persisted) return;
    const expiry = setTimeout(() => setPersisted(current => current === persisted ? null : current), Math.max(0, persisted.expiresAt - Date.now()));
    return () => clearTimeout(expiry);
  }, [persisted]);
  // Persist only a healthy pair; a failed refresh must not overwrite the
  // previous snapshot or race the authoritative-denial eviction below.
  useEffect(() => {
    if (!viewerId || !wid || !scope || !personal.data || !shared.data) return;
    if (roster.error !== undefined || personal.error !== undefined || shared.error !== undefined) return;
    const snapshot = { personal: personal.data, shared: shared.data };
    const updatedAt = Math.min(personal.updatedAt, shared.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) return;
    setPersisted({ scope, snapshot, expiresAt: updatedAt + OFFLINE_AUTHORITY_MS });
    void writeChatSessionsSnapshot(viewerId, wid, snapshot, updatedAt);
  }, [personal.data, personal.error, personal.updatedAt, roster.error, shared.data, shared.error, shared.updatedAt, scope, viewerId, wid]);
  useEffect(() => {
    if (!viewerId || !wid || !denied) return;
    setPersisted(null);
    void deleteChatSessionsSnapshot(viewerId, wid);
  }, [denied, viewerId, wid]);
  useEffect(() => {
    if (!rosterDenied || !sessionsKey || !sharedKey) return;
    invalidateSurfaceCache(sessionsKey);
    invalidateSurfaceCache(sharedKey);
  }, [rosterDenied, sessionsKey, sharedKey]);

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

  const disk = !denied && persisted && persisted.scope === scope && persisted.expiresAt > Date.now() ? persisted.snapshot : null;

  const refreshShared = shared.refresh;
  const refreshPersonal = personal.refresh;
  const refreshRoster = roster.refresh;
  const refresh = useCallback(async () => {
    await Promise.all([refreshRoster(), refreshShared(), refreshPersonal()]);
  }, [refreshPersonal, refreshRoster, refreshShared]);

  return {
    assistants: roster.data ?? EMPTY_ASSISTANTS,
    assistantsLoaded: roster.data !== undefined || roster.error !== undefined,
    personal: personalDenied ? null : personal.data ?? disk?.personal ?? null,
    shared: sharedDenied ? null : shared.data ?? disk?.shared ?? null,
    personalError: personal.error ?? roster.error,
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

/** An authoritative history denial invalidates previously painted content. */
export function evictTranscriptCache(sessionId: string): void {
  evictSurfaceCacheKey(chatTranscriptCacheKey(sessionId));
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
