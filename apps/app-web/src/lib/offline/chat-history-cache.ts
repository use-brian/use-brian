/** Retained display bytes and cache versions, never permission grants.
 * [COMP:app-web/chat-sessions-cache] */
import type { DocSessionMessage } from "@/lib/api/sessions";
import { currentOfflineWriteAuthority, offlineWriteIdentityIsCurrent, sameOfflineWriteAuthority, type OfflineWriteAuthority } from "./application-write-authority";
import { useCallback, useSyncExternalStore } from "react";
import { getUserInfo } from "@/lib/user";
import { publicRuntimeConfig } from "@/lib/runtime-public-config";
import { evictSurfaceCacheKey, mutateSurfaceCache, readSurfaceCache, seedSurfaceCache, subscribeSurfaceCache } from "@/lib/surface-cache";
import { chatCachePersistence, type ChatCacheTicket, type ChatCacheRowFence, type FencedList } from "./chat-cache-fence";
import { CHAT_SESSIONS_REFRESH_EVENT, dispatchChatSessionsRefresh, type ChatCacheFenceSignal } from "@/lib/chat-session-events";

export const CHAT_OFFLINE_AUTHORITY_MS = 24 * 60 * 60_000;
type Snapshot = { version: 1; syncedAt: number; rows: DocSessionMessage[]; cacheFence?: ChatCacheRowFence };
type Status = { syncedAt: number; retained: boolean; cacheFence?: ChatCacheRowFence } | null;
type ReadOwner = { scope: OfflineWriteAuthority; epoch: number; request: number; generation: number; ticket?: ChatCacheTicket | null };
export type ChatListRead = { scope: OfflineWriteAuthority; generation: number; ticket: ChatCacheTicket | null };
let generation = 0;
const revisions = new Map<string, { epoch: number; request: number }>();
const listReads = new WeakMap<object, ChatListRead>();
const rowFences = new WeakMap<object, ChatCacheRowFence>();
const scopes = new Map<string, OfflineWriteAuthority>();
const scopeParts = (scope: OfflineWriteAuthority) => [scope.apiOrigin, scope.viewerId, scope.workspaceId].map(encodeURIComponent).join(":");
export const chatFenceKey = (scope: OfflineWriteAuthority) => `chat-cache-fence:v1:${scopeParts(scope)}`;
export const chatSessionsDiskKey = (scope: OfflineWriteAuthority) => `chat-sessions:v3:${scopeParts(scope)}`;
const remember = (scope: OfflineWriteAuthority) => { scopes.set(chatFenceKey(scope), scope); while (scopes.size > 128) scopes.delete(scopes.keys().next().value!); };
const scopeCurrent = (scope: OfflineWriteAuthority) => sameOfflineWriteAuthority(scope, currentOfflineWriteAuthority(scope.workspaceId));

export async function refreshChatCacheFence(scope: OfflineWriteAuthority): Promise<void> {
  remember(scope); await chatCachePersistence.refresh(chatFenceKey(scope));
}
export async function captureChatListRead(workspaceId: string): Promise<ChatListRead | null> {
  const scope = currentOfflineWriteAuthority(workspaceId), start = generation;
  if (!scope) return null;
  remember(scope); const ticket = await chatCachePersistence.capture(chatFenceKey(scope));
  return generation === start && scopeCurrent(scope) ? { scope, generation, ticket } : null;
}
export function tagChatListResponse<T extends { id: string }>(rows: T[], read?: ChatListRead | null): T[] {
  if (read) {
    listReads.set(rows, read);
    if (read.ticket) for (const row of rows) rowFences.set(row, chatCachePersistence.source(read.ticket, row.id));
  }
  return rows;
}
export const chatListResponseRead = (rows: unknown[]) => listReads.get(rows);
export function filterRetainedChatSessions<T extends { id: string }>(scope: OfflineWriteAuthority, rows: T[], read?: ChatListRead | null): T[] {
  if (!scopeCurrent(scope) || read && (read.generation !== generation || !sameOfflineWriteAuthority(read.scope, scope))) return [];
  if (!chatCachePersistence.current(chatFenceKey(scope))) return read && !read.ticket ? rows : [];
  return chatCachePersistence.filter(chatFenceKey(scope), rows, row => read?.ticket
    ? chatCachePersistence.source(read.ticket, row.id) : rowFences.get(row));
}
export async function readChatListDisk<T extends FencedList>(scope: OfflineWriteAuthority): Promise<T | null> {
  const start = generation; remember(scope);
  const stored = await chatCachePersistence.readList<T>(chatFenceKey(scope), chatSessionsDiskKey(scope));
  if (!stored || start !== generation || !scopeCurrent(scope)) return null;
  for (const row of [...stored.value.personal, ...stored.value.shared]) rowFences.set(row,
    { generation: stored.cacheGeneration!, marker: stored.rowMarkers?.[row.id] ?? null });
  return stored;
}
export async function writeChatListDisk(scope: OfflineWriteAuthority, value: FencedList): Promise<void> {
  const read = await captureChatListRead(scope.workspaceId);
  if (!read?.ticket || !sameOfflineWriteAuthority(read.scope, scope)) return;
  await chatCachePersistence.writeList(chatFenceKey(scope), chatSessionsDiskKey(scope), read.ticket, value, row => rowFences.get(row));
}
export function chatHistoryScope(sessionId: string, scope = currentOfflineWriteAuthority()): ReadOwner | null {
  if (!scope || !offlineWriteIdentityIsCurrent(scope)) return null;
  remember(scope); const key = chatHistoryDiskKey(scope, sessionId);
  const previous = revisions.get(key) ?? { epoch: 0, request: 0 };
  const next = { ...previous, request: previous.request + 1 }; revisions.set(key, next);
  return { scope, epoch: next.epoch, request: next.request, generation };
}
export async function prepareChatHistoryRead(owner: ReadOwner | null): Promise<void> {
  if (owner && isChatHistoryReadCurrent(owner, "", false) && owner.ticket === undefined)
    owner.ticket = await chatCachePersistence.capture(chatFenceKey(owner.scope));
}
export function isChatHistoryReadCurrent(owner: ReadOwner, sessionId: string, checkEpoch = true): boolean {
  const revision = revisions.get(chatHistoryDiskKey(owner.scope, sessionId));
  return owner.generation === generation && scopeCurrent(owner.scope) && (!checkEpoch || revision?.epoch === owner.epoch)
    && (!sessionId || (owner.ticket ? chatCachePersistence.matches(chatFenceKey(owner.scope), sessionId, chatCachePersistence.source(owner.ticket, sessionId)) : chatCachePersistence.allowsUnfenced(chatFenceKey(owner.scope), sessionId)));
}
const ownsWrite = (owner: ReadOwner, sessionId: string) => isChatHistoryReadCurrent(owner, sessionId)
  && revisions.get(chatHistoryDiskKey(owner.scope, sessionId))?.request === owner.request;
export function chatHistoryDiskKey(scope: OfflineWriteAuthority, sessionId: string): string { return `chat-history:v1:${scopeParts(scope)}:${encodeURIComponent(sessionId)}`; }
export function chatHistoryMemoryKey(sessionId: string): string {
  const scope = currentOfflineWriteAuthority();
  return transcriptMemoryKey(sessionId, scope);
}
const transcriptMemoryKey = (sessionId: string, scope: OfflineWriteAuthority | null) =>
  `chat-transcript:${[scope?.apiOrigin ?? publicRuntimeConfig().apiUrl ?? "http://localhost:4000", scope?.viewerId ?? getUserInfo()?.id ?? "signed-out", scope?.workspaceId ?? "no-workspace", sessionId].map(encodeURIComponent).join(":")}`;
const statusKey = (scope: OfflineWriteAuthority, id: string) => `${chatHistoryDiskKey(scope, id)}:status`;
function publish(scope: OfflineWriteAuthority, id: string, value: Status): void {
  if (!scopeCurrent(scope)) return;
  const key = statusKey(scope, id);
  if (readSurfaceCache<Status>(key).data === undefined) seedSurfaceCache(key, value); else mutateSurfaceCache<Status>(key, () => value);
}
export async function readChatHistory(owner: ReadOwner | null, id: string): Promise<Snapshot | null> {
  if (!owner) return null;
  await prepareChatHistoryRead(owner);
  const stored = await chatCachePersistence.readHistory<Snapshot>(chatFenceKey(owner.scope), chatHistoryDiskKey(owner.scope, id), id);
  if (!isChatHistoryReadCurrent(owner, id)) return null;
  const age = stored ? Date.now() - stored.syncedAt : NaN;
  return stored?.version === 1 && Number.isFinite(age) && age >= 0 && age < CHAT_OFFLINE_AUTHORITY_MS
    && Array.isArray(stored.rows) && stored.rows.every(row => row && typeof row.id === "string" && typeof row.role === "string") ? stored : null;
}
export function markRetainedChatHistory(owner: ReadOwner | null, id: string, syncedAt: number, retained = true): void {
  if (owner && isChatHistoryReadCurrent(owner, id)) publish(owner.scope, id,
    { syncedAt, retained, ...(owner.ticket ? { cacheFence: chatCachePersistence.source(owner.ticket, id) } : {}) });
}
export async function writeChatHistory(owner: ReadOwner | null, id: string, rows: DocSessionMessage[], syncedAt: number): Promise<void> {
  if (!owner) return; await prepareChatHistoryRead(owner);
  if (!ownsWrite(owner, id)) return;
  if (owner.ticket) await chatCachePersistence.writeHistory(chatFenceKey(owner.scope), chatHistoryDiskKey(owner.scope, id), id, owner.ticket,
    { version: 1, syncedAt, rows } satisfies Snapshot);
  if (ownsWrite(owner, id)) markRetainedChatHistory(owner, id, syncedAt, false);
}
export async function evictChatHistory(owner: ReadOwner | null, id: string, committedDenial = false): Promise<void> {
  if (!owner) return;
  const current = () => committedDenial
    ? owner.generation === generation && offlineWriteIdentityIsCurrent(owner.scope)
    : isChatHistoryReadCurrent(owner, id);
  if (!current()) return;
  await prepareChatHistoryRead(owner); if (!current()) return;
  const key = chatHistoryDiskKey(owner.scope, id), previous = revisions.get(key) ?? { epoch: 0, request: 0 };
  revisions.set(key, { ...previous, epoch: previous.epoch + 1 });
  const changed = await chatCachePersistence.deny(chatFenceKey(owner.scope), key, chatSessionsDiskKey(owner.scope), id, owner.ticket);
  if (!changed || owner.generation !== generation || !offlineWriteIdentityIsCurrent(owner.scope)) return;
  evictSurfaceCacheKey(statusKey(owner.scope, id)); evictSurfaceCacheKey(transcriptMemoryKey(id, owner.scope));
  // Durable filtering above is complete even if optional UI code is unavailable.
  dispatchChatSessionsRefresh(owner.scope.workspaceId, { ...owner.scope, sessionId: id });
  await import("@/lib/chat-surface-data").then(module => owner.generation === generation && scopeCurrent(owner.scope) ? module.reconcileChatSessionLists(owner.scope) : undefined).catch(() => {});
}
export async function retainedChatHistoryIsCurrent(scope: OfflineWriteAuthority, id: string): Promise<boolean> {
  await refreshChatCacheFence(scope);
  const status = readSurfaceCache<Status>(statusKey(scope, id)).data;
  return !!status?.cacheFence && chatCachePersistence.matches(chatFenceKey(scope), id, status.cacheFence);
}
export function useRetainedChatHistoryStatus(id: string | null): Status {
  const scope = currentOfflineWriteAuthority(), key = scope && id ? statusKey(scope, id) : null;
  return useSyncExternalStore(useCallback(listener => key ? subscribeSurfaceCache(key, listener) : () => {}, [key]),
    useCallback(() => key ? readSurfaceCache<Status>(key).data ?? null : null, [key]), () => null);
}
export function chatHistorySyncedAt(id: string): number | undefined {
  const scope = currentOfflineWriteAuthority(); return scope ? readSurfaceCache<Status>(statusKey(scope, id)).data?.syncedAt : undefined;
}
if (typeof window !== "undefined") {
  window.addEventListener("brian:local-data-cleared", event => {
    generation++; revisions.clear(); chatCachePersistence.clearMemory();
    if ((event as CustomEvent<{ committed?: boolean }>).detail?.committed) {
      for (const scope of scopes.values()) dispatchChatSessionsRefresh(scope.workspaceId, { ...scope });
      scopes.clear();
    }
  });
  window.addEventListener(CHAT_SESSIONS_REFRESH_EVENT, event => {
    const signal = (event as CustomEvent<{ cacheFence?: ChatCacheFenceSignal }>).detail?.cacheFence;
    if (!signal || signal.viewerId !== getUserInfo()?.id) return;
    const start = generation;
    const scope = { ...signal, applicationId: "native" as const };
    void refreshChatCacheFence(scope).then(async () => {
      const { reconcileChatSessionLists } = await import("@/lib/chat-surface-data");
      if (start === generation && scopeCurrent(scope)) await reconcileChatSessionLists(scope);
    }).catch(() => {});
  });
}
