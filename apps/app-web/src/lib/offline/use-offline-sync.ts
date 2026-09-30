"use client";

/**
 * Connectivity + reconnect-flush hook for ALL clients (web, thin shell,
 * bundled desktop — originally Phase 5 of the bundled-desktop offline plan,
 * un-gated when the web app went offline-first).
 *
 * Combines `navigator.onLine` with the collab socket status into one
 * classification, reflects it into the offline-write manager's `online` flag,
 * and retries queued writes on network recovery, online mount, and a timer. Returns the
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

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  classifyConnectivity,
  isEffectivelyOffline,
  type Connectivity,
} from "./connectivity";
import {
  setOnline,
  getOnline,
  subscribeOnline,
  flushWriteQueue,
  subscribePendingCount,
} from "./offline-writes";

import { FEED_LOCAL_CHANGED, flushFeedWorkingCopies, readLocalFeedPosts } from "./feed-offline";

import { LOCAL_PAGES_CHANGED, flushLocalPages, readLocalPages } from "./offline-pages";

export interface OfflineSyncState {
  connectivity: Connectivity;
  /** True when the app should show the Offline affordance + queue writes. */
  offline: boolean;
  /** Online, but the live doc's sync socket is re-dialing / not yet synced
   *  (past a short grace). Display-only: writes are not queued for it. */
  reconnecting: boolean;
  /** Count of writes queued for replay. */
  pending: number;
  /** Feed drafts waiting for explicit recovery rather than automatic replay. */
  paused: number;
}

/** SSR and the first client render must share the same optimistic value. */
export function initialNavigatorOnline(): boolean {
  return true;
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

// ── Collab-live signal (module store) ──────────────────────────
// Stricter than `collabConnected`: true only when the mounted doc's socket is
// connected AND synced. A socket still dialing ("connecting") is not live -
// that is the Reconnecting state the bottom status bar reports. It does NOT
// feed the connectivity classification (writes are not queued while a socket
// re-dials); it is display-only. Reset to true on unmount like its sibling.
let collabLive = true;
const collabLiveListeners = new Set<() => void>();

/** Publish whether the live doc is connected + synced (doc-shell). */
export function publishCollabLive(live: boolean): void {
  if (collabLive === live) return;
  collabLive = live;
  for (const l of collabLiveListeners) l();
}

function getCollabLive(): boolean {
  return collabLive;
}

function subscribeCollabLive(listener: () => void): () => void {
  collabLiveListeners.add(listener);
  return () => {
    collabLiveListeners.delete(listener);
  };
}

/** Grace before a not-live socket reads as Reconnecting, so a page switch
 *  (which re-dials the socket) never flashes the status bar. */
export const RECONNECTING_GRACE_MS = 1000;

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

/**
 * The single connectivity DRIVER — mount once high in the tree (WorkspaceChrome,
 * which is present on every `/w/[id]/*` surface). Watches `navigator.onLine`
 * + the published collab-socket signal, reflects the classification into the
 * module flag, and retries writes while the network is available.
 */
export function useOfflineSync(): OfflineSyncState {
  const [navOnline, setNavOnline] = useState(initialNavigatorOnline);
  const [pending, setPending] = useState(0);
  const [localPending, setLocalPending] = useState(0);
  const [feedPending, setFeedPending] = useState(0);
  const [feedPaused, setFeedPaused] = useState(0);
  const collabUp = useSyncExternalStore(
    subscribeCollabConnected,
    getCollabConnected,
    () => true,
  );
  const collabLiveNow = useSyncExternalStore(
    subscribeCollabLive,
    getCollabLive,
    () => true,
  );
  const [reconnecting, setReconnecting] = useState(false);
  useEffect(() => {
    if (collabLiveNow) {
      setReconnecting(false);
      return;
    }
    const id = setTimeout(() => setReconnecting(true), RECONNECTING_GRACE_MS);
    return () => clearTimeout(id);
  }, [collabLiveNow]);

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
  }, [connectivity]);

  // REST registration must run even when the current (not-yet-registered)
  // page's socket is down. Retry on online cold starts as well as recovery.
  useEffect(() => {
    let cancelled = false;
    const count = async () => {
      const pages = await readLocalPages();
      if (!cancelled) setLocalPending(pages.length);
    };
    const replay = async () => {
      if (navigator.onLine) {
        await flushLocalPages();
        await flushWriteQueue();
      }
      await count();
    };
    void replay().catch(() => {});
    const timer = setInterval(() => { void replay().catch(() => {}); }, 15_000);
    window.addEventListener(LOCAL_PAGES_CHANGED, count);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener(LOCAL_PAGES_CHANGED, count);
    };
  }, [navOnline]);

  useEffect(() => {
    let cancelled = false;
    let idle: ReturnType<typeof setTimeout>;
    const count = async () => {
      const posts = await readLocalFeedPosts();
      if (!cancelled) {
        setFeedPending(posts.filter(p => p.dirty).length);
        setFeedPaused(posts.filter(p => p.dirty && p.error).length);
      }
    };
    const replay = async () => { await flushFeedWorkingCopies(); await count(); };
    const onChange = () => {
      void count();
      clearTimeout(idle);
      idle = setTimeout(() => { void replay().catch(() => {}); }, 1_000);
    };
    void replay().catch(() => {});
    const timer = setInterval(() => { void replay().catch(() => {}); }, 15_000);
    window.addEventListener(FEED_LOCAL_CHANGED, onChange);
    return () => {
      cancelled = true; clearTimeout(idle); clearInterval(timer);
      window.removeEventListener(FEED_LOCAL_CHANGED, onChange);
    };
  }, [navOnline]);

  return {
    connectivity,
    offline: isEffectivelyOffline(connectivity),
    reconnecting: reconnecting && connectivity === "online",
    pending: pending + localPending + feedPending,
    paused: feedPaused,
  };
}
