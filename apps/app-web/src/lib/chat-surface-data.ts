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

import { recordChatSessionRecency, useChatSessionFeedback } from "@/lib/chat-send-feedback";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  listWorkspaceAssistants,
  type WorkspaceAssistantSummary,
} from "@/lib/api/views";
import {
  listPersonalSessions,
  fetchSessionMessages,
  type DocSessionMessage,
  setSessionArchived,
  listWorkspaceSessions,
  type ChatSessionSummary,
  type DocSession,
  type WorkspaceSession,
} from "@/lib/api/sessions";
import {
  chatRosterCacheKey,
  chatArchivedSessionsCacheKey,
  chatSessionsCacheKey,
  chatSharedSessionsCacheKey,
  chatTranscriptCacheKey,
  chatTranscriptIntentCacheKey,
} from "@/lib/surface-prefetch";
import {
  invalidateSurfaceCache,
  loadSurfaceCache,
  markSurfaceCacheStale,
  mutateSurfaceCache,
  mutateSurfaceCachePrefix,
  readSurfaceCache,
  seedSurfaceCache,
  useCachedResource,
  SurfaceCacheEvictionError,
  evictSurfaceCacheKey,
} from "@/lib/surface-cache";
import { idbDelete } from "@/lib/offline/idb";
import { getUserInfo } from "@/lib/user";
import { CHAT_SESSIONS_REFRESH_EVENT, dispatchChatSessionsRefresh, type ChatCacheFenceSignal } from "@/lib/chat-session-events";
import { SURFACE_CONTENT_LEASE_MS, useLeasedResource } from "@/lib/offline/surface-content-cache";
import { CHAT_OFFLINE_AUTHORITY_MS, chatHistorySyncedAt, captureChatListRead, filterRetainedChatSessions, chatListResponseRead, chatSessionsDiskKey, readChatListDisk, writeChatListDisk, refreshChatCacheFence, tagChatListResponse } from "@/lib/offline/chat-history-cache";
import { currentOfflineWriteAuthority, type OfflineWriteAuthority } from "@/lib/offline/application-write-authority";
import { publicRuntimeConfig } from "@/lib/runtime-public-config";

// ── Disk tier ────────────────────────────────────────────────────────────

const SNAPSHOT_VERSION = 1;

/** Direct-link summaries share the rail row's durable cache fence. */
export function useCurrentChatSummary(workspaceId: string, summary: ChatSessionSummary | null): ChatSessionSummary | null {
  const sessionId = summary?.id;
  const subscribe = useCallback((notify: () => void) => {
    if (!sessionId) return () => {};
    let listening = true;
    const fence = (event: Event) => {
      const signal = (event as CustomEvent<{ cacheFence?: ChatCacheFenceSignal }>).detail?.cacheFence;
      const scope = currentOfflineWriteAuthority(workspaceId);
      if (!scope || !signal || signal.viewerId !== scope.viewerId || signal.apiOrigin !== scope.apiOrigin
        || signal.workspaceId !== workspaceId || signal.sessionId && signal.sessionId !== sessionId) return;
      void refreshChatCacheFence(scope).then(() => { if (listening) notify(); });
    };
    window.addEventListener(CHAT_SESSIONS_REFRESH_EVENT, fence);
    return () => { listening = false; window.removeEventListener(CHAT_SESSIONS_REFRESH_EVENT, fence); };
  }, [sessionId, workspaceId]);
  const read = useCallback(() => {
    const scope = currentOfflineWriteAuthority(workspaceId);
    return scope && summary ? filterRetainedChatSessions(scope, [summary])[0] ?? null : null;
  }, [summary, workspaceId]);
  return useSyncExternalStore(subscribe, read, () => null);
}


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
  return chatSessionsDiskKey({ viewerId, workspaceId, applicationId: "native", apiOrigin: (publicRuntimeConfig().apiUrl ?? "http://localhost:4000").replace(/\/$/, "") });
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
  const scope = currentOfflineWriteAuthority(workspaceId);
  if (!scope || scope.viewerId !== viewerId) return null;
  const stored = await readChatListDisk(scope);
  if (!isEnvelope(stored) || !isChatSessionsSnapshot(stored.value)) return null;
  const age = Date.now() - stored.updatedAt;
  if (!Number.isFinite(age) || age >= CHAT_OFFLINE_AUTHORITY_MS || age < 0) return null;
  return { snapshot: stored.value, expiresAt: stored.updatedAt + CHAT_OFFLINE_AUTHORITY_MS };
}

/** Best-effort last-known-good replacement; painting never renews its timestamp. */
export async function writeChatSessionsSnapshot(viewerId: string, workspaceId: string,
  value: ChatSessionsSnapshot, updatedAt = Date.now()): Promise<void> {
  const scope = currentOfflineWriteAuthority(workspaceId);
  if (!scope || scope.viewerId !== viewerId) return;
  await writeChatListDisk(scope, { version: SNAPSHOT_VERSION, updatedAt, value });
}

/** Signals carry no verdict: consult the committed fence before altering rows. */
export async function reconcileChatSessionLists(scope: OfflineWriteAuthority): Promise<void> {
  await refreshChatCacheFence(scope);
  const filter = (rows: DocSession[]) => filterRetainedChatSessions(scope, rows);
  mutateSurfaceCachePrefix<DocSession[]>(chatSessionsCacheKey(scope.workspaceId), filter);
  mutateSurfaceCachePrefix<DocSession[]>(chatSharedSessionsCacheKey(scope.workspaceId), filter);
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

// ── List reads held by mounted hosts ─────────────────────────────────────
//
// Each list response waits on server-side title admission (M5Q-10), so a read
// nobody is waiting for any more is stopped: every host that renders a cached
// list holds its key while mounted, and when the last holder of a key unmounts
// or moves to another key while that key's read is in flight, the read is
// detached from the cache (no failure is recorded, so the next mount paints
// the disk snapshot and revalidates) and aborted. Identical queries from
// different keys or hosts already share one request (session-list-requests).
// chat-app.md → "Listing".

const listHolders = new Map<string, number>();
const listReads = new Map<string, AbortController>();

/** Run one list read of `key` with a signal its last holder can abort. */
async function heldListRead<T>(key: string, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  listReads.set(key, controller);
  try { return await read(controller.signal); }
  finally { if (listReads.get(key) === controller) listReads.delete(key); }
}

/** Hold a list key while this host is mounted. */
function useChatListHold(key: string | null): void {
  useEffect(() => {
    if (!key) return;
    listHolders.set(key, (listHolders.get(key) ?? 0) + 1);
    return () => {
      listHolders.set(key, (listHolders.get(key) ?? 1) - 1);
      // One tick of grace: a StrictMode replay or a remount re-holds first.
      setTimeout(() => {
        if ((listHolders.get(key) ?? 0) > 0) return;
        listHolders.delete(key);
        const read = listReads.get(key);
        if (!read) return;
        listReads.delete(key);
        // Detach before aborting, so the abort is not recorded as a failure.
        evictSurfaceCacheKey(key);
        read.abort();
      }, 0);
    };
  }, [key]);
}

// ── Fetchers ─────────────────────────────────────────────────────────────

/** Workspace-wide history is independently authorized; no roster waterfall. */
export async function fetchPersonalChatSessions(
  workspaceId: string,
): Promise<DocSession[]> {
  const key = chatSessionsCacheKey(workspaceId);
  return readChatList(workspaceId, key, () =>
    readChatResource(() => heldListRead(key, (signal) => listPersonalSessions({ workspaceId, strict: true, signal }))));
}

/** The fetcher behind `chat-shared:<wid>:<viewer>`. */
function fetchSharedChatSessions(
  workspaceId: string,
): Promise<WorkspaceSession[]> {
  const key = chatSharedSessionsCacheKey(workspaceId);
  return readChatList(workspaceId, key, () =>
    readChatResource(() => heldListRead(key, (signal) => listWorkspaceSessions({ workspaceId, strict: true, signal }))));
}

/** Project-filtered pages share the session invalidation prefix and viewer key. */
export function useProjectChatSessionsData(workspaceId: string, projectId: string | null) {
  const key = chatSharedSessionsCacheKey(workspaceId, projectId);
  useChatListHold(key);
  const rows = useCachedResource(key, () => readChatList(workspaceId, key, () =>
    readChatResource(() => heldListRead(key, (signal) => listWorkspaceSessions({ workspaceId, contextProjectId: projectId, strict: true, signal })))));
  const [paging, setPaging] = useState(false);
  const [exhaustedCursor, setExhaustedCursor] = useState<string | null>(null);
  const [pageError, setPageError] = useState<unknown>(null);
  useEffect(() => { setExhaustedCursor(null); setPageError(null); }, [key]);
  const more = async () => {
    const last = rows.data?.at(-1);
    if (!last || paging) return;
    setPaging(true); setPageError(null);
    try {
      const next = await readChatList(workspaceId, key, () => listWorkspaceSessions({ workspaceId, contextProjectId: projectId,
        before: { id: last.id, lastActive: last.lastActive }, strict: true }));
      mutateSurfaceCache<WorkspaceSession[]>(key, current => [...current, ...next.filter(row => !current.some(old => old.id === row.id))]);
      setExhaustedCursor(next.length < 50 ? next.at(-1)?.id ?? last.id : null);
    } catch (error) { setPageError(error); } finally { setPaging(false); }
  };
  const authority = currentOfflineWriteAuthority(workspaceId);
  const presented = useChatSessionFeedback(workspaceId, authority && rows.data ? filterRetainedChatSessions(authority, rows.data) : rows.data);
  return { ...rows, data: presented ?? undefined, error: rows.error ?? pageError, paging, hasMore: rows.data?.at(-1)?.id !== exhaustedCursor, more };
}

/** Keep creations made during an older read; the next read is authoritative. */
async function readChatList<T extends DocSession>(workspaceId: string, key: string, fetch: () => Promise<T[]>): Promise<T[]> {
  const read = await captureChatListRead(workspaceId);
  const before = new Set(readSurfaceCache<T[]>(key).data?.map(row => row.id));
  const statusReadStartedAt = Date.now();
  const fetched = await fetch();
  const sourceRead = chatListResponseRead(fetched) ?? read;
  if (sourceRead) await refreshChatCacheFence(sourceRead.scope);
  const rows = fetched.map(row => ({ ...row, statusReadStartedAt }));
  const added = (readSurfaceCache<T[]>(key).data ?? []).filter(row =>
    !before.has(row.id) && !rows.some(fetched => fetched.id === row.id));
  // A server snapshot can predate the local send even when it lands later.
  // Preserve only recency on authorized rows, never an absent row or its title.
  const current = new Map((readSurfaceCache<T[]>(key).data ?? []).map(row => [row.id, row]));
  const merged = [...added, ...rows.map(row => {
    const local = current.get(row.id);
    return local && local.lastActive > row.lastActive ? { ...row, lastActive: local.lastActive } : row;
  })].sort((a, b) => b.lastActive.localeCompare(a.lastActive));
  return sourceRead ? tagChatListResponse(filterRetainedChatSessions(sourceRead.scope, merged, sourceRead), sourceRead) : [];
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

/** Promote only already-authorized rows; rollback cannot undo a newer send. */
export function promoteChatSession(workspaceId: string, sessionId: string, contextProjectId?: string | null): () => void {
  const personalKey = chatSessionsCacheKey(workspaceId);
  const sharedKey = chatSharedSessionsCacheKey(workspaceId);
  const known = [...(readSurfaceCache<DocSession[]>(personalKey).data ?? []),
    ...(readSurfaceCache<DocSession[]>(sharedKey).data ?? [])].find(row => row.id === sessionId);
  const keys = [personalKey, sharedKey, chatSharedSessionsCacheKey(workspaceId, contextProjectId ?? known?.contextProjectId ?? null)];
  const previousActivity = keys.flatMap(key => readSurfaceCache<DocSession[]>(key).data ?? [])
    .filter(row => row.id === sessionId).map(row => Date.parse(row.lastActive)).filter(Number.isFinite);
  const changedAt = new Date(Math.max(Date.now(), ...previousActivity.map(time => time + 1))).toISOString();
  const rollbackPresentation = recordChatSessionRecency(workspaceId, sessionId, changedAt);
  const previous = new Map<string, string>();
  for (const key of keys) {
    mutateSurfaceCache<DocSession[]>(key, rows => rows.map(row => {
      if (row.id !== sessionId) return row;
      previous.set(key, row.lastActive);
      return { ...row, lastActive: changedAt };
    }).sort((a, b) => b.lastActive.localeCompare(a.lastActive)));
  }
  return () => {
    rollbackPresentation();
    for (const [key, lastActive] of previous) {
      mutateSurfaceCache<DocSession[]>(key, rows => rows.map(row =>
        row.id === sessionId && row.lastActive === changedAt ? { ...row, lastActive } : row,
      ).sort((a, b) => b.lastActive.localeCompare(a.lastActive)));
    }
  };
}

// ── Optimistic patches ───────────────────────────────────────────────────

/** Archived history is separately cached and paged; failures remain visible. */
export function useArchivedChatSessionsData(workspaceId: string, audience: "personal" | "workspace", enabled: boolean) {
  const key = chatArchivedSessionsCacheKey(workspaceId, audience);
  const fetchPage = (before?: { id: string; lastActive: string }, signal?: AbortSignal): Promise<DocSession[]> => audience === "workspace"
    ? listWorkspaceSessions({ workspaceId, archived: true, strict: true, before, signal })
    : listPersonalSessions({ workspaceId, archived: true, strict: true, before, signal });
  useChatListHold(enabled ? key : null);
  const rows = useCachedResource<DocSession[]>(enabled ? key : null, () => readChatList(workspaceId, key, () => heldListRead(key, (signal) => fetchPage(undefined, signal))));
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
      const next = await readChatList(workspaceId, key, () => fetchPage({ id: last.id, lastActive: last.lastActive }));
      mutateSurfaceCache<DocSession[]>(key, current => [...current, ...next.filter(row => !current.some(old => old.id === row.id))]);
      setExhaustedCursor(next.length < 50 ? next.at(-1)?.id ?? last.id : null);
    } catch (error) { setPageError(error); } finally { setPaging(false); }
  };
  const refresh = () => { setPageError(null); setExhaustedCursor(null); return rows.refresh(); };
  const authority = currentOfflineWriteAuthority(workspaceId);
  return { ...rows, data: authority && rows.data ? filterRetainedChatSessions(authority, rows.data) : rows.data,
    refresh, error: rows.error ?? pageError, paging, hasMore: (rows.data?.length ?? 0) >= 50 && rows.data?.at(-1)?.id !== exhaustedCursor, more };
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
  /** Original authoritative read time when a retained disk list is painted. */
  retainedSyncedAt?: number;
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

  useChatListHold(sessionsKey);
  useChatListHold(sharedKey);
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
    setPersisted({ scope, snapshot, expiresAt: updatedAt + CHAT_OFFLINE_AUTHORITY_MS });
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

  const authority = wid ? currentOfflineWriteAuthority(wid) : null;
  const personalRows = personalDenied ? null : personal.data ?? disk?.personal ?? null;
  const sharedRows = sharedDenied ? null : shared.data ?? disk?.shared ?? null;
  const presentedPersonal = useChatSessionFeedback(wid, authority && personalRows ? filterRetainedChatSessions(authority, personalRows) : personalRows);
  const presentedShared = useChatSessionFeedback(wid, authority && sharedRows ? filterRetainedChatSessions(authority, sharedRows) : sharedRows);

  return {
    retainedSyncedAt: disk && (personal.data === undefined || shared.data === undefined)
      ? persisted!.expiresAt - CHAT_OFFLINE_AUTHORITY_MS : undefined,
    assistants: roster.data ?? EMPTY_ASSISTANTS,
    assistantsLoaded: roster.data !== undefined || roster.error !== undefined,
    personal: presentedPersonal ?? null,
    shared: presentedShared ?? null,
    personalError: personal.error ?? roster.error,
    revalidating: roster.revalidating || personal.revalidating || shared.revalidating,
    refresh,
    refreshShared,
    refreshPersonal,
  };
}

// ── Transcripts ──────────────────────────────────────────────────────────

type TranscriptIntent = {
  sessionId: string;
  expiresAt: number;
  controller: AbortController;
  promise: Promise<DocSessionMessage[]>;
  consumed: boolean;
};

/** Warm only deliberate pointer/keyboard intent, never every visible row. */
export function warmChatTranscript(sessionId: string): void {
  if (typeof window === "undefined" || !getUserInfo()?.id || readCachedTranscript(sessionId) !== undefined) return;
  const key = chatTranscriptIntentCacheKey();
  const existing = readSurfaceCache<TranscriptIntent>(key).data;
  if (existing?.sessionId === sessionId && existing.expiresAt > Date.now()) return;
  evictSurfaceCacheKey(key);
  const controller = new AbortController();
  const intent: TranscriptIntent = {
    sessionId, expiresAt: Date.now() + 10_000, controller, consumed: false,
    promise: fetchSessionMessages(sessionId, { strict: true, signal: controller.signal }),
  };
  seedSurfaceCache(key, intent, {
    expiresInMs: value => value.expiresAt - Date.now(),
    dispose: value => { if (!value.consumed) value.controller.abort(); },
  });
  void intent.promise.catch(() => {
    if (readSurfaceCache<TranscriptIntent>(key).data === intent) evictSurfaceCacheKey(key);
  });
}

/** Consume one intent read. Live refreshes always bypass pre-turn bytes. */
export async function fetchChatTranscript(
  sessionId: string,
  options: { force?: boolean; signal: AbortSignal; onCached?: (rows: DocSessionMessage[]) => void },
): Promise<DocSessionMessage[]> {
  const key = chatTranscriptIntentCacheKey();
  const intent = readSurfaceCache<TranscriptIntent>(key).data;
  if (intent?.sessionId === sessionId && !options.force && intent.expiresAt > Date.now()) {
    intent.consumed = true;
    evictSurfaceCacheKey(key);
    const abort = () => intent.controller.abort();
    if (options.signal.aborted) abort();
    options.signal.addEventListener("abort", abort, { once: true });
    try { return await intent.promise; }
    finally { options.signal.removeEventListener("abort", abort); }
  }
  // A selection or fresh read supersedes speculative work for any other chat.
  evictSurfaceCacheKey(key);
  return fetchSessionMessages(sessionId, { strict: true, signal: options.signal, onCached: options.onCached });
}

/** The cached transcript for a session, or `undefined` when cold. */
export function readCachedTranscript<T>(sessionId: string): T[] | undefined {
  const syncedAt = chatHistorySyncedAt(sessionId);
  if (syncedAt !== undefined && Date.now() - syncedAt >= CHAT_OFFLINE_AUTHORITY_MS) {
    evictTranscriptCache(sessionId);
    return undefined;
  }
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
