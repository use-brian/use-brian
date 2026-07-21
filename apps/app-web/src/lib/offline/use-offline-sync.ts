"use client";

/**
 * Connectivity + reconnect-flush hook for ALL clients (web, thin shell,
 * bundled desktop — originally Phase 5 of the bundled-desktop offline plan,
 * un-gated when the web app went offline-first).
 *
 * Combines `navigator.onLine` with the collab socket status into one
 * classification, reflects it into the offline-write manager's `online` flag,
 * and flushes the queued writes on the offline→online rising edge. Returns the
 * state for an Offline pill + pending-write count.
 *
 * The collab socket signal arrives through a module-level store
 * (`publishCollabConnected`), published by `doc-shell` (which owns the
 * provider) and consumed here — the driver mounts in WorkspaceChrome, above
 * where the socket lives, so a prop can't reach it. "connecting" counts as up
 * (the initial dial must not flash the Offline pill); only a provider sitting
 * in "disconnected" degrades the classification.
 *
 * [COMP:app-web/use-offline-sync]
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
  /** True when the app should show the Offline affordance + queue writes. */
  offline: boolean;
  /** Count of writes queued for replay. */
  pending: number;
}

// ── Collab-socket signal (module store) ────────────────────────
// True unless a mounted doc page reports its sync socket as down. Pages
// publish on status change and reset to true on unmount, so no open doc
// means "up" (navigator.onLine alone decides).
let collabConnected = true;
const collabListeners = new Set<() => void>();

/** Publish the collab socket state (doc-shell; reset to true on unmount). */
export function publishCollabConnected(connected: boolean): void {
  if (collabConnected === connected) return;
  collabConnected = connected;
  for (const l of collabListeners) l();
}

export function getCollabConnected(): boolean {
  return collabConnected;
}

function subscribeCollabConnected(listener: () => void): () => void {
  collabListeners.add(listener);
  return () => {
    collabListeners.delete(listener);
  };
}

/**
 * Reader hook: true when the app is offline (navigator down, or the live doc's
 * sync socket down). Backed by the module-level connectivity flag (driven by
 * the single `useOfflineSync` driver in WorkspaceChrome), so any component
 * anywhere can gate its controls on it.
 */
export function useIsOffline(): boolean {
  const online = useSyncExternalStore(
    subscribeOnline,
    getOnline,
    () => true,
  );
  return !online;
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
 * + the published collab-socket signal, reflects the classification into the
 * module flag, and flushes the queued writes on the offline→online rising edge.
 */
export function useOfflineSync(): OfflineSyncState {
  const [navOnline, setNavOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [pending, setPending] = useState(0);
  const prevRef = useRef<Connectivity>("online");
  const collabUp = useSyncExternalStore(
    subscribeCollabConnected,
    getCollabConnected,
    () => true,
  );

  // navigator online/offline events.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const on = () => setNavOnline(true);
    const off = () => setNavOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    setNavOnline(navigator.onLine);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // Pending-write count.
  useEffect(() => subscribePendingCount(setPending), []);

  const connectivity: Connectivity = classifyConnectivity({
    navigatorOnline: navOnline,
    collabConnected: collabUp,
  });

  // Reflect into the module flag + flush queued writes on recovery.
  useEffect(() => {
    setOnline(connectivity === "online");
    if (shouldFlushQueue(prevRef.current, connectivity)) void flushWriteQueue();
    prevRef.current = connectivity;
  }, [connectivity]);

  return {
    connectivity,
    offline: isEffectivelyOffline(connectivity),
    pending,
  };
}
