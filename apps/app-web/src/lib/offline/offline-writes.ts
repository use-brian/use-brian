/**
 * Offline write manager for ALL clients (originally Phase 5 of
 * docs/plans/doc-desktop-bundled-offline.md, un-gated when the web app went
 * offline-first). Wraps the *non-Yjs* REST writes (page rename / icon /
 * clearance / full-width today) so they queue when offline and replay on
 * reconnect, instead of failing. In-doc edits already survive offline via
 * Yjs + `y-indexeddb`; this covers the metadata writes around them.
 *
 * While the `online` flag (kept fresh by `use-offline-sync`) is up,
 * `offlineWrite` runs the SDK call directly — identical to calling it inline.
 * Offline, it queues.
 *
 * Metadata includes locally-created pages. Their durable creation outbox
 * registers pages before this queue replays. Failed writes remain pending.
 *
 * [COMP:app-web/offline-writes]
 */

import { idbGet, idbUpdate } from "./idb";
import { getUserInfo } from "@/lib/user";
import { enqueueWrite, serializeQueue, parseQueue, type QueuedWrite } from "./write-queue";
import {
  currentOfflineWriteAuthority, sameOfflineWriteAuthority, offlineWriteQueueKey,
  offlineWriteUnavailable, prepareQueuedMetadataWrite, type OfflineWriteAuthority,
} from "./application-write-authority";

// ── Connectivity flag (kept fresh by use-offline-sync) ─────────
// Defaults online so writes go straight through before the hook mounts.
let online = true;
const onlineListeners = new Set<(online: boolean) => void>();
export function setOnline(value: boolean): void {
  if (online === value) return;
  online = value;
  for (const l of onlineListeners) l(online);
}
export function getOnline(): boolean {
  return online;
}
/** Subscribe to connectivity changes (drives `useIsOffline()`). */
export function subscribeOnline(listener: (online: boolean) => void): () => void {
  onlineListeners.add(listener);
  return () => {
    onlineListeners.delete(listener);
  };
}

// ── The persisted queue ────────────────────────────────────────
let queue: QueuedWrite[] = [];
let loadedKey: string | null = null;
const countListeners = new Set<(count: number) => void>();

function emitCount(): void {
  const authority = currentOfflineWriteAuthority();
  const count = authority && loadedKey === offlineWriteQueueKey(authority) ? queue.length : 0;
  for (const l of countListeners) l(count);
}

/** Subscribe to the current principal/workspace outbox count. */
export function subscribePendingCount(listener: (count: number) => void): () => void {
  countListeners.add(listener);
  const authority = currentOfflineWriteAuthority();
  listener(authority && loadedKey === offlineWriteQueueKey(authority) ? queue.length : 0);
  return () => { countListeners.delete(listener); };
}

async function ensureLoaded(authority: OfflineWriteAuthority | null): Promise<string | null> {
  const key = authority ? offlineWriteQueueKey(authority) : null;
  const raw = key ? await idbGet<string>(key) : null;
  // Do not publish another account's pending state after an asynchronous read.
  if (!authority || sameOfflineWriteAuthority(authority, currentOfflineWriteAuthority(authority.workspaceId))) {
    queue = raw ? parseQueue(raw) : [];
    loadedKey = key;
    emitCount();
  }
  return key;
}

async function updateQueue(key: string, update: (current: QueuedWrite[]) => QueuedWrite[]): Promise<void> {
  const raw = await idbUpdate<string>(key, (value) => serializeQueue(update(value ? parseQueue(value) : [])));
  if (key === loadedKey) { queue = parseQueue(raw); emitCount(); }
}

/** Scoped recovery port. Unbound legacy entries are never adopted by the active account. */
export async function readPendingWrites(): Promise<QueuedWrite[]> {
  const authority = currentOfflineWriteAuthority();
  const key = await ensureLoaded(authority);
  if (!key || !sameOfflineWriteAuthority(authority, currentOfflineWriteAuthority())) return [];
  return structuredClone(queue);
}

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `op-${Date.now().toString(36)}-${Math.round(Math.random() * 1e9).toString(36)}`;
  }
}

export interface OfflineWriteSpec<R> {
  /** Op kind (must have a canonical metadata replay route). */
  kind: string;
  /** Coalesce key, or null to keep individually. */
  coalesceKey: string | null;
  /** Serializable args the replay executor needs. */
  payload: unknown;
  /** The live SDK call (used online). */
  exec: () => Promise<R>;
  /** Apply the server result (online). */
  onResult?: (result: R) => void;
  /** Apply an optimistic local update (offline — there's no server result). */
  optimistic?: () => void;
}

/**
 * Run a write now (online) — calling `exec` then `onResult`, propagating
 * errors so the caller's existing try/catch surfaces them — OR, when offline,
 * enqueue it for replay and apply the optimistic update without throwing.
 */
export async function offlineWrite<R>(spec: OfflineWriteSpec<R>): Promise<void> {
  const authorUserId = getUserInfo()?.id;
  const initialAuthority = currentOfflineWriteAuthority();
  const queuedPayload = structuredClone(spec.payload);
  const payload = queuedPayload as { id?: string; name?: string; icon?: string | null; fullWidth?: boolean; clearance?: "public" | "internal" | "confidential" };
  const { readLocalPage, readCachedPage, patchLocalPage } = await import("./offline-pages");
  const local = payload?.id ? await readLocalPage(payload.id) : null;
  const cached = !local && payload?.id ? await readCachedPage(payload.id) : null;
  const authority = initialAuthority ?? currentOfflineWriteAuthority(local?.view.workspaceId ?? cached?.workspaceId);
  if (authorUserId !== getUserInfo()?.id) throw offlineWriteUnavailable();
  const key = await ensureLoaded(authority);
  if (authorUserId !== getUserInfo()?.id || authority
    && !sameOfflineWriteAuthority(authority, currentOfflineWriteAuthority(authority.workspaceId))) {
    throw offlineWriteUnavailable();
  }
  const pendingForPage = payload?.id && queue.some((op) => (op.payload as { id?: string })?.id === payload.id);
  if (online && !local && !pendingForPage) {
    const result = await spec.exec();
    if (authorUserId === getUserInfo()?.id && (sameOfflineWriteAuthority(authority, currentOfflineWriteAuthority(authority?.workspaceId))
      || !authority && !currentOfflineWriteAuthority())) spec.onResult?.(result);
    return;
  }
  if (!authority || !key || authority.viewerId !== authorUserId
    || !sameOfflineWriteAuthority(authority, currentOfflineWriteAuthority(authority.workspaceId))) {
    throw offlineWriteUnavailable();
  }
  await updateQueue(key, (current) => enqueueWrite(current, {
    id: randomId(),
    kind: spec.kind,
    payload: queuedPayload,
    coalesceKey: spec.coalesceKey,
    enqueuedAt: Date.now(),
    attempts: 0,
    authority,
    effect: "pending",
  }));
  if (!sameOfflineWriteAuthority(authority, currentOfflineWriteAuthority(authority.workspaceId))) return;
  if (payload?.id) {
    const patch = spec.kind === "view.rename" ? { name: payload.name, nameOrigin: "user" as const }
      : spec.kind === "view.icon" ? { icon: payload.icon }
      : spec.kind === "view.fullWidth" ? { fullWidth: payload.fullWidth }
      : spec.kind === "view.clearance" ? { clearance: payload.clearance } : {};
    await patchLocalPage(payload.id, patch);
  }
  spec.optimistic?.();
}

// ── Replay ──────────────────────────────────────────────────────
let flushing: Promise<void> | null = null;
/** Replay one scoped snapshot. Each mutation receives a fresh server admission. */
export function flushWriteQueue(): Promise<void> {
  if (flushing) return flushing;
  flushing = flush().finally(() => { flushing = null; });
  return flushing;
}
async function flush(): Promise<void> {
  const authority = currentOfflineWriteAuthority();
  const key = await ensureLoaded(authority);
  if (!authority || !key) return;
  const snapshot = parseQueue((await idbGet<string>(key)) ?? "[]");
  for (const op of snapshot) {
    if (!sameOfflineWriteAuthority(authority, currentOfflineWriteAuthority())
      || !sameOfflineWriteAuthority(op.authority, authority) || op.effect !== "pending") return;
    try {
      const { readLocalPage } = await import("./offline-pages");
      const id = (op.payload as { id?: string })?.id;
      if (id && await readLocalPage(id)) return;
      const dispatch = await prepareQueuedMetadataWrite(op);
      const claimed = { ...op, effect: "uncertain" as const };
      let acquired = false;
      // The IDB transaction is the cross-tab claim. No effect is sent unless its
      // exact payload/version was durably marked uncertain first.
      await updateQueue(key, (current) => current.map((q) => {
        if (JSON.stringify(q) !== JSON.stringify(op)) return q;
        acquired = true;
        return claimed;
      }));
      if (!acquired) return;
      await dispatch();
      await updateQueue(key, (current) => current.filter((q) =>
        JSON.stringify(q) !== JSON.stringify(claimed)));
    } catch {
      // Preserve authored intent and uncertainty. A reconnect never retries a
      // possibly committed effect, including after reload or account change.
      return;
    }
  }
}
