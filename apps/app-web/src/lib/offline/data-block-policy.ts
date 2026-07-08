/**
 * Data-block offline policy (Phase 5, docs/plans/doc-desktop-bundled-offline.md).
 *
 * Doc's core contract is "live, not snapshot": every page open re-resolves
 * `data` blocks through `GET /api/views/:id/payload` (apps/app-web/CLAUDE.md →
 * Common gotchas; docs/architecture/features/views.md). Offline cannot honor
 * "live" — so the realistic promise is: *online = always re-resolve; offline =
 * render the last cached snapshot with an "Offline" badge; if there's no cache
 * (or it's too old) show a placeholder instead of stale-forever data.*
 *
 * This is the **pure decision**. Online it returns `live` and never serves the
 * cache (the contract is preserved). The caller (a data-block node-view, gated
 * on `isDesktopAuth()`) caches each successful payload and consults this when
 * the network is down. Pure → unit-testable; no IndexedDB or fetch here.
 *
 * [COMP:app-web/offline-data-block-policy]
 */

/** What the data-block node-view should do for this render. */
export type DataBlockRender =
  /** Online: re-resolve fresh from the API (the "live, not snapshot" path). */
  | { mode: "live" }
  /** Offline with a usable cached payload: render it, flagged stale. */
  | { mode: "stale"; ageMs: number }
  /** Offline with nothing renderable: show a placeholder. */
  | { mode: "unavailable"; reason: "no-cache" | "expired" };

/** Metadata about a cached payload (the payload itself lives in IndexedDB). */
interface DataBlockCacheMeta {
  /** Unix ms the payload was last successfully resolved + cached. */
  cachedAt: number;
}

/** Default staleness ceiling: beyond this, an offline cache reads as expired. */
export const DEFAULT_MAX_STALE_MS = 24 * 60 * 60 * 1000; // 24h

export interface DataBlockPolicyInput {
  /** Best available connectivity signal (see `classifyConnectivity`). */
  isOnline: boolean;
  /** Cache metadata for this block, or null when nothing is cached. */
  cache: DataBlockCacheMeta | null;
  /** Injected clock (unix ms). */
  nowMs: number;
  /** Override the staleness ceiling. */
  maxStaleMs?: number;
}

/**
 * Decide how to render a data block. Online → always `live` (cache is never
 * shown, preserving the freshness contract). Offline → `stale` when a
 * within-ceiling cache exists, else `unavailable` (`no-cache` / `expired`).
 */
export function resolveDataBlockRender(input: DataBlockPolicyInput): DataBlockRender {
  if (input.isOnline) return { mode: "live" };

  if (!input.cache) return { mode: "unavailable", reason: "no-cache" };

  const maxStaleMs = input.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
  // Clamp clock skew (cachedAt in the future) to "fresh" rather than negative.
  const ageMs = Math.max(0, input.nowMs - input.cache.cachedAt);
  if (ageMs > maxStaleMs) return { mode: "unavailable", reason: "expired" };

  return { mode: "stale", ageMs };
}

/**
 * Whether a freshly-resolved payload should be written to the offline cache.
 * Only the bundled desktop app caches (the gate is applied by the caller); we
 * never cache a failed/empty resolve.
 */
export function shouldCachePayload(resolvedOk: boolean): boolean {
  return resolvedOk;
}
