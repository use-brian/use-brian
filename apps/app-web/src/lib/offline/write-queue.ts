/**
 * Offline write-queue (queue-and-replay) for the **bundled desktop** build
 * (Phase 5, docs/plans/doc-desktop-bundled-offline.md). Yjs already buffers
 * in-doc edits offline; this covers the *non-Yjs* REST mutations that otherwise
 * fail when the network is down — page/draft create, rename/icon/clearance,
 * reparent, entity cell edits, publish/share, etc. (the full catalog lives in
 * the connector below).
 *
 * This module is **pure data-structure logic** — no IndexedDB, no `fetch`, no
 * Electron — so it unit-tests cleanly. The persistence (IndexedDB) and the
 * actual replay executor (mapping `kind` → the SDK call) are injected by the
 * integration layer, which is gated on `isDesktopAuth()` so the web app and the
 * thin shell are never affected.
 *
 * Three coalescing behaviors, matching how each write actually composes:
 *   - **append**  — ordered, kept individually (creates, reparent, comments).
 *   - **replace** — last-write-wins by `coalesceKey` (rename, icon, clearance).
 *   - **merge**   — last-write-wins *per field* by `coalesceKey` (entity patches:
 *                   two edits to different cells of one row must both survive).
 *
 * [COMP:app-web/offline-write-queue]
 */

/** A single queued non-Yjs mutation. `payload` is the serializable args the
 *  replay executor needs to re-issue the call. */
export interface QueuedWrite {
  /** Stable per-op id (idempotency token for the queue + dedupe on replay). */
  id: string;
  /** Op kind, e.g. `view.rename`, `entity.patch`, `view.reparent`. */
  kind: string;
  /** Serializable arguments for the executor. */
  payload: unknown;
  /**
   * Non-null → this op collapses against earlier ops with the same key
   * (last-write-wins / merge). Null → kept individually, in order.
   */
  coalesceKey: string | null;
  /** Unix ms the op was (re)queued. */
  enqueuedAt: number;
  /** Replay attempts so far (for dead-lettering poison ops). */
  attempts: number;
}

/** Optional per-field merge for `merge`-coalesced ops (e.g. entity patches). */
export type PayloadMerger = (existing: unknown, incoming: unknown) => unknown;

/**
 * Enqueue a write. When `op.coalesceKey` matches an existing op, the existing
 * one is replaced **in place** (relative order with other ops is preserved):
 * the payload becomes `incoming` (replace) or `merge(existing, incoming)` when a
 * merger is supplied, `attempts` resets to 0, and `enqueuedAt` advances. With a
 * null key (or no match) the op is appended.
 *
 * Returns a new array (never mutates the input).
 */
export function enqueueWrite(
  queue: readonly QueuedWrite[],
  op: QueuedWrite,
  merge?: PayloadMerger,
): QueuedWrite[] {
  if (op.coalesceKey !== null) {
    const idx = queue.findIndex(
      (q) => q.coalesceKey === op.coalesceKey && q.kind === op.kind,
    );
    if (idx !== -1) {
      const existing = queue[idx];
      const next = queue.slice();
      next[idx] = {
        ...op,
        payload: merge ? merge(existing.payload, op.payload) : op.payload,
        // Keep the original op id so optimistic UI / dedupe references stay valid.
        id: existing.id,
        attempts: 0,
      };
      return next;
    }
  }
  return [...queue, op];
}

export interface ReplayResult {
  /** Ops that replayed successfully (removed from the queue). */
  flushed: QueuedWrite[];
  /** Ops still pending (the failed op at the head, then the untried tail). */
  remaining: QueuedWrite[];
  /** Ops dropped after exceeding `maxAttempts` (poison / permanently-failing). */
  dead: { op: QueuedWrite; error: string }[];
}

export interface ReplayOptions {
  /** Drop an op after this many failed attempts (dead-letter). Default 5. */
  maxAttempts?: number;
}

/**
 * Replay the queue **in order** through an injected executor. Stops at the first
 * op that fails (so ordered ops — create, reparent — never replay out of order),
 * returning the unflushed tail for the next attempt. An op that has failed
 * `maxAttempts` times is dead-lettered (dropped + reported) rather than blocking
 * the queue forever.
 *
 * `execute` should throw/reject on failure. It is the integration layer's job to
 * map `op.kind` → the real SDK call; idempotent ops (save/delete/publish) are
 * safe to re-run, which is why a partial flush + retry is correct.
 */
export async function replayQueue(
  queue: readonly QueuedWrite[],
  execute: (op: QueuedWrite) => Promise<void>,
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const maxAttempts = options.maxAttempts ?? 5;
  const flushed: QueuedWrite[] = [];
  const dead: { op: QueuedWrite; error: string }[] = [];
  const items = queue.slice();

  for (let i = 0; i < items.length; i++) {
    const op = items[i];
    try {
      await execute(op);
      flushed.push(op);
    } catch (err) {
      const attempts = op.attempts + 1;
      const error = err instanceof Error ? err.message : String(err);
      if (attempts >= maxAttempts) {
        // Poison op: drop it and keep draining the rest of the queue.
        dead.push({ op: { ...op, attempts }, error });
        continue;
      }
      // Preserve ordering: stop here, return the failed op (attempts bumped) at
      // the head followed by everything untried after it.
      const remaining = [{ ...op, attempts }, ...items.slice(i + 1)];
      return { flushed, remaining, dead };
    }
  }

  return { flushed, remaining: [], dead };
}

// ── Persistence (pure serialize/validate; IndexedDB I/O lives in the caller) ──

/** Serialize the queue for at-rest storage (IndexedDB / a key-value blob). */
export function serializeQueue(queue: readonly QueuedWrite[]): string {
  return JSON.stringify(queue);
}

/**
 * Parse a persisted queue, dropping any entry that isn't a well-formed
 * `QueuedWrite` (a partially-written or corrupt store reads as "fewer pending
 * ops" rather than throwing and stranding the user).
 */
export function parseQueue(raw: string): QueuedWrite[] {
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter(isQueuedWrite);
}

function isQueuedWrite(v: unknown): v is QueuedWrite {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.kind === "string" &&
    (o.coalesceKey === null || typeof o.coalesceKey === "string") &&
    typeof o.enqueuedAt === "number" &&
    typeof o.attempts === "number" &&
    "payload" in o
  );
}
