/** Transient local sends, never roster content or authority. [COMP:app-web/chat-send-feedback] */
import { useMemo, useSyncExternalStore } from "react";
import type { LiveWorkItem } from "@/lib/api/live";
import { getUserInfo } from "@/lib/user";

type PendingSend = { token: symbol; sessionId: string | null };
const pending = new Map<string, readonly PendingSend[]>();
const empty: readonly PendingSend[] = [];
const listeners = new Set<() => void>();
const recency = new Map<string, Map<string, { at: string; token: symbol }>>();
const completed = new Map<string, Map<string, { at: number; turnId: string | null }>>();
const completionKey = (sessionId: string, turnId?: string | null) => JSON.stringify([sessionId, turnId ?? null]);
const completedAfterRead = (value: { at: number; turnId: string | null } | undefined, row: { turnId?: string | null; statusReadStartedAt?: number }) =>
  value !== undefined && value.turnId === (row.turnId ?? null) && value.at >= (row.statusReadStartedAt ?? 0);
let revision = 0;
function emit() { revision++; for (const listener of listeners) listener(); }
function useRevision() { return useSyncExternalStore(subscribe, () => revision, () => 0); }
function remember<T>(store: Map<string, Map<string, T>>, key: string, id: string, value: T) {
  const entries = store.get(key) ?? new Map<string, T>();
  entries.delete(id);
  entries.set(id, value);
  if (entries.size > 1000) entries.delete(entries.keys().next().value!);
  store.set(key, entries);
}
const scope = (workspaceId: string) => JSON.stringify([getUserInfo()?.id ?? null, workspaceId]);
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
function publish(key: string, rows: readonly PendingSend[]) {
  if (rows.length) pending.set(key, rows);
  else pending.delete(key);
  emit();
}

/** Capture the viewer once, so late cleanup cannot affect another account. */
export function beginChatSendFeedback(workspaceId: string, sessionId: string | null) {
  const key = scope(workspaceId);
  const token = Symbol();
  let released = false;
  if (sessionId) completed.get(key)?.delete(completionKey(sessionId));
  publish(key, [...(pending.get(key) ?? empty), { token, sessionId }]);
  return {
    adopt(id: string) {
      if (released) return;
      completed.get(key)?.delete(completionKey(id));
      publish(key, (pending.get(key) ?? empty).map(row => row.token === token ? { ...row, sessionId: id } : row));
    },
    complete(turnId: string | null = null) {
      if (released) return;
      const id = pending.get(key)?.find(row => row.token === token)?.sessionId;
      if (id) remember(completed, key, completionKey(id, turnId), { at: Date.now(), turnId });
      this.release();
    },
    release() {
      if (released) return;
      released = true;
      publish(key, (pending.get(key) ?? empty).filter(row => row.token !== token));
    },
  };
}

/** Active server rows and local sends form a union, not two independent counts. */
export function useChatLiveCount(workspaceId: string, items: LiveWorkItem[]): number {
  const key = scope(workspaceId);
  useRevision();
  const sends = pending.get(key) ?? empty;
  const active = items.filter(item => item.state !== "settled" &&
    (item.kind !== "session" || !completedAfterRead(completed.get(key)?.get(completionKey(item.id, item.turnId)), item)));
  const sessions = new Set(active.filter(item => item.kind === "session").map(item => item.id));
  let count = active.length;
  for (const send of sends) {
    if (!send.sessionId) count++;
    else if (!sessions.has(send.sessionId)) {
      sessions.add(send.sessionId);
      count++;
    }
  }
  return count;
}


/** Observe a terminal session signal without granting a list or title lease. */
export function settleChatSessionFeedback(workspaceId: string, sessionId: string, turnId: string | null = null): void {
  if (!turnId) return;
  remember(completed, scope(workspaceId), completionKey(sessionId, turnId), { at: Date.now(), turnId });
  emit();
}

/** Recency survives a cold memory cache while its authorized disk rows paint. */
export function recordChatSessionRecency(workspaceId: string, sessionId: string, at: string): () => void {
  const key = scope(workspaceId), token = Symbol();
  const previous = recency.get(key)?.get(sessionId);
  remember(recency, key, sessionId, { at, token });
  emit();
  return () => {
    if (recency.get(key)?.get(sessionId)?.token !== token) return;
    if (previous) recency.get(key)!.set(sessionId, previous);
    else recency.get(key)?.delete(sessionId);
    emit();
  };
}

type SessionRow = { id: string; lastActive: string; status?: string; statusReadStartedAt?: number; turnId?: string | null };
/** Only reorder/update rows the caller already has authority to display. */
export function useChatSessionFeedback<T extends SessionRow>(workspaceId: string | null, rows: T[] | null | undefined): T[] | null | undefined {
  const version = useRevision();
  const key = scope(workspaceId ?? "");
  return useMemo(() => {
    if (!rows || !workspaceId) return rows;
    const working = new Set((pending.get(key) ?? empty).map(send => send.sessionId));
    let reordered = false;
    const presented = rows.map(row => {
      const at = recency.get(key)?.get(row.id)?.at;
      const settled = completed.get(key)?.get(completionKey(row.id, row.turnId));
      const status = working.has(row.id) ? "running"
        : completedAfterRead(settled, row) ? "idle" : row.status;
      const promoted = at !== undefined && at > row.lastActive;
      reordered ||= promoted;
      return promoted || status !== row.status ? { ...row, ...(promoted ? { lastActive: at } : {}), status } : row;
    });
    return reordered ? presented.sort((a, b) => b.lastActive.localeCompare(a.lastActive)) : presented;
  }, [key, rows, version, workspaceId]);
}
