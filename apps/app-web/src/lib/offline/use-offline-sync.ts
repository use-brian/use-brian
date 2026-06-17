"use client";

/**
 * Connectivity + reconnect-flush hook for the bundled desktop app (Phase 5).
 *
 * Combines `navigator.onLine` with the collab socket status into one
 * classification, reflects it into the offline-write manager's `online` flag,
 * and flushes the queued writes on the offline→online rising edge. Returns the
 * state for an Offline pill + pending-write count.
 *
 * Gated: on web + the thin shell (`isDesktopAuth()` false) it stays "online" and
 * touches nothing — no listeners, no flush.
 *
 * [COMP:app-web/use-offline-sync]
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isDesktopAuth } from "@/lib/desktop-auth-source";
import {
  classifyConnectivity,
  isEffectivelyOffline,
  shouldFlushQueue,
  type Connectivity,
} from "./connectivity";
import {
  setOnline,
  getOnline,
  subscribeOnline,
  flushWriteQueue,
  subscribePendingCount,
} from "./offline-writes";

export interface OfflineSyncState {
  connectivity: Connectivity;
  /** True when the bundled app should show the Offline affordance + queue writes. */
  offline: boolean;
  /** Count of writes queued for replay. */
  pending: number;
}

/**
 * Reader hook: true when the bundled app is offline. Backed by the module-level
 * connectivity flag (driven by the single `useOfflineSync` driver in
 * WorkspaceChrome), so any component anywhere can gate its controls on it.
 * Always false on web + the thin shell (the `isDesktopAuth()` gate).
 */
export function useIsOffline(): boolean {
  const bundled = isDesktopAuth();
  const online = useSyncExternalStore(
    subscribeOnline,
    getOnline,
    () => true,
  );
  return bundled && !online;
}

/** Reader hook: number of writes queued for replay (for the "N pending" badge). */
export function usePendingWrites(): number {
  const [pending, setPending] = useState(0);
  useEffect(() => subscribePendingCount(setPending), []);
  return pending;
}

/**
 * The single connectivity DRIVER — mount once high in the tree (WorkspaceChrome,
 * which is present on every `/w/[id]/*` surface). Watches `navigator.onLine`
 * (+ an optional collab-socket signal), reflects it into the module flag, and
 * flushes the queued writes on the offline→online rising edge.
 */
export function useOfflineSync(collabConnected = true): OfflineSyncState {
  const bundled = isDesktopAuth();
  const [navOnline, setNavOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [pending, setPending] = useState(0);
  const prevRef = useRef<Connectivity>("online");

  // navigator online/offline events (bundled only).
  useEffect(() => {
    if (!bundled || typeof window === "undefined") return;
    const on = () => setNavOnline(true);
    const off = () => setNavOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    setNavOnline(navigator.onLine);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [bundled]);

  // Pending-write count (always subscribe; it's a no-op count on web).
  useEffect(() => subscribePendingCount(setPending), []);

  const connectivity: Connectivity = bundled
    ? classifyConnectivity({ navigatorOnline: navOnline, collabConnected })
    : "online";

  // Reflect into the module flag + flush queued writes on recovery.
  useEffect(() => {
    if (!bundled) return;
    setOnline(connectivity === "online");
    if (shouldFlushQueue(prevRef.current, connectivity)) void flushWriteQueue();
    prevRef.current = connectivity;
  }, [bundled, connectivity]);

  return {
    connectivity,
    offline: bundled && isEffectivelyOffline(connectivity),
    pending,
  };
}
