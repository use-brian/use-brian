/**
 * Offline write manager for the bundled desktop app (Phase 5,
 * docs/plans/doc-desktop-bundled-offline.md). Wraps the *non-Yjs* REST writes
 * (page rename / icon / clearance / full-width today) so they queue when offline
 * and replay on reconnect, instead of failing. In-doc edits already survive
 * offline via Yjs + `y-indexeddb`; this covers the metadata writes around them.
 *
 * Gated: on web + the thin shell (`isDesktopAuth()` false) `offlineWrite` runs
 * the SDK call directly — identical to calling it inline. Only the bundled app,
 * while offline, queues.
 *
 * Scope (v1): last-write-wins metadata writes on an EXISTING page (safe to
 * coalesce + replay idempotently). Creates / reparent / entity writes (temp-id
 * assignment + ordering) are a tracked follow-up — see the plan.
 *
 * [COMP:app-web/offline-writes]
 */

import {
  renameView,
  setViewIcon,
  setViewFullWidth,
  setViewClearance,
} from "@/lib/api/views";
import { isDesktopAuth } from "@/lib/desktop-auth-source";
import { idbGet, idbSet } from "./idb";
import {
  enqueueWrite,
  replayQueue,
  serializeQueue,
  parseQueue,
  type QueuedWrite,
} from "./write-queue";

const QUEUE_KEY = "offline:write-queue";

// ── Connectivity flag (kept fresh by use-offline-sync) ─────────
// Defaults online so writes go straight through before the hook mounts / on web.
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
let loaded = false;
const countListeners = new Set<(count: number) => void>();

function emitCount(): void {
  for (const l of countListeners) l(queue.length);
}

/** Subscribe to the pending-write count (for the "N pending" badge). */
export function subscribePendingCount(listener: (count: number) => void): () => void {
  countListeners.add(listener);
  listener(queue.length);
  return () => {
    countListeners.delete(listener);
  };
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  const raw = await idbGet<string>(QUEUE_KEY);
  queue = raw ? parseQueue(raw) : [];
  loaded = true;
  emitCount();
}

async function persist(): Promise<void> {
  await idbSet(QUEUE_KEY, serializeQueue(queue));
  emitCount();
}

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `op-${Date.now().toString(36)}-${Math.round(Math.random() * 1e9).toString(36)}`;
  }
}

export interface OfflineWriteSpec<R> {
  /** Op kind (must have an entry in EXECUTORS for replay). */
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
 * Run a write now (online / web) — calling `exec` then `onResult`, propagating
 * errors so the caller's existing try/catch surfaces them — OR, when offline in
 * the bundled app, enqueue it for replay and apply the optimistic update without
 * throwing.
 */
export async function offlineWrite<R>(spec: OfflineWriteSpec<R>): Promise<void> {
  if (!isDesktopAuth() || online) {
    const result = await spec.exec();
    spec.onResult?.(result);
    return;
  }
  await ensureLoaded();
  queue = enqueueWrite(queue, {
    id: randomId(),
    kind: spec.kind,
    payload: spec.payload,
    coalesceKey: spec.coalesceKey,
    enqueuedAt: Date.now(),
    attempts: 0,
  });
  await persist();
  spec.optimistic?.();
}

// ── Replay ──────────────────────────────────────────────────────
// Maps a queued op's kind + payload back to the real SDK call. Keep in sync with
// the `offline*` wrappers below.
type RenamePayload = { id: string; name: string };
type IconPayload = { id: string; icon: string | null };
type FullWidthPayload = { id: string; fullWidth: boolean };
type ClearancePayload = { id: string; clearance: "public" | "internal" | "confidential" };

const EXECUTORS: Record<string, (payload: unknown) => Promise<unknown>> = {
  "view.rename": (p) => renameView((p as RenamePayload).id, (p as RenamePayload).name),
  "view.icon": (p) => setViewIcon((p as IconPayload).id, (p as IconPayload).icon),
  "view.fullWidth": (p) => setViewFullWidth((p as FullWidthPayload).id, (p as FullWidthPayload).fullWidth),
  "view.clearance": (p) => setViewClearance((p as ClearancePayload).id, (p as ClearancePayload).clearance),
};

/** Replay queued writes in order (call on the offline→online rising edge). */
export async function flushWriteQueue(): Promise<void> {
  if (!isDesktopAuth()) return;
  await ensureLoaded();
  if (queue.length === 0) return;
  const result = await replayQueue(queue, async (op) => {
    const fn = EXECUTORS[op.kind];
    if (fn) await fn(op.payload);
  });
  queue = result.remaining;
  await persist();
}
