/**
 * Connectivity signal for the bundled desktop offline layer (Phase 5,
 * docs/plans/doc-desktop-bundled-offline.md).
 *
 * Combines two signals app-web already has — `navigator.onLine` and the
 * collab socket status (`CollabStatus` from `use-collab-provider.ts`) — into one
 * classification that drives (a) the Offline badge, (b) whether non-Yjs writes
 * are queued vs. issued, and (c) when to flush the write-queue on recovery.
 *
 * Pure → unit-testable. The React glue (event listeners + wiring to the collab
 * provider) lives in a thin hook, gated on `isDesktopAuth()`.
 *
 * [COMP:app-web/offline-connectivity]
 */

export type Connectivity =
  /** Network up AND the collab socket is connected — full health. */
  | "online"
  /** Network reports up but the collab socket is down — sync unreachable;
   *  treat writes cautiously (queue them) and show the Offline affordance. */
  | "degraded"
  /** `navigator.onLine` is false — definitively offline. */
  | "offline";

/** Classify connectivity from the two raw signals. */
export function classifyConnectivity(input: {
  navigatorOnline: boolean;
  collabConnected: boolean;
}): Connectivity {
  if (!input.navigatorOnline) return "offline";
  return input.collabConnected ? "online" : "degraded";
}

/**
 * Whether to behave as offline: show the badge and **queue** non-Yjs writes
 * rather than issue them. True for both `offline` and `degraded` — if the sync
 * socket can't reach the backend, REST writes likely can't either.
 */
export function isEffectivelyOffline(c: Connectivity): boolean {
  return c !== "online";
}

/**
 * Whether a transition should trigger a write-queue flush: only on the rising
 * edge into full `online` health (so we don't replay against a still-degraded
 * backend, and don't flush repeatedly while already online).
 */
export function shouldFlushQueue(prev: Connectivity, next: Connectivity): boolean {
  return next === "online" && prev !== "online";
}
