"use client";

/**
 * Owns the Yjs document + HocuspocusProvider lifecycle for one page. The doc
 * is created on mount (keyed by pageId), the provider dials the sync service
 * presenting the user's JWT, and both are torn down on unmount / pageId change
 * (StrictMode double-mount safe via the effect cleanup).
 *
 * Every client also attaches `y-indexeddb` persistence, so an opened page and
 * any offline edits survive reloads and replay on reconnect (CRDT merge — both
 * sides kept, never a destructive overwrite). The teardown's
 * `persistence.destroy()` only detaches listeners; the local store survives.
 * The stores are scrubbed on sign-out (`clearLocalDocCaches`).
 *
 * [COMP:app-web/collab-provider]
 */

import { useEffect, useState } from "react";
import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import type { IndexeddbPersistence } from "y-indexeddb";
import { getValidAccessToken } from "@/lib/auth-fetch";
import { hasLoadedState } from "@/lib/collab/doc-empty";
import { DRAWING_PROTOCOL } from '@use-brian/doc-model';

import { resolveSyncUrl } from "@/lib/offline/sync-local-page";
import { LOCAL_PAGES_CHANGED, readLocalPage } from "@/lib/offline/offline-pages";

export type CollabStatus = "connecting" | "connected" | "disconnected";

export type CollabHandle = {
  doc: Y.Doc | null;
  provider: HocuspocusProvider | null;
  status: CollabStatus;
  synced: boolean;
  writeDenied?: boolean;
  reloadRequired?: boolean;
  recoveryRequired?: boolean;
  accessDenied?: boolean;
  discardLocalChanges?: () => Promise<void>;
};

export function useCollabProvider(pageId: string | null): CollabHandle {
  const [bundle, setBundle] = useState<{
    doc: Y.Doc;
    provider: HocuspocusProvider;
    discardLocalChanges: () => Promise<void>;
  } | null>(null);
  const [status, setStatus] = useState<CollabStatus>("connecting");
  const [synced, setSynced] = useState(false);
  const [writeDenied, setWriteDenied] = useState(false);
  const [reloadRequired, setReloadRequired] = useState(false);
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);

  useEffect(() => {
    // No active page (the `/p` index empty-selection state, or the gap
    // between a page switch and its metadata resolving): hold no socket.
    // Lets the shell call this hook unconditionally (Rules of Hooks) while
    // still tearing the previous page's connection down.
    if (!pageId) {
      setBundle(null);
      setStatus("connecting");
      setSynced(false);
      return;
    }
    const doc = new Y.Doc();
    const officeDocument = pageId.startsWith("office:");
    const socket = new HocuspocusProviderWebsocket({ url: resolveSyncUrl(), autoConnect: false });
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: pageId,
      document: doc,
      // HocuspocusProvider calls this per (re)connect. Unlike REST (authFetch
      // refreshes on 401), the socket has no retry path, so we refresh here
      // when the 1h access token is missing/expired — otherwise an expired
      // token loops "Reconnecting…" forever.
      token: async () => (officeDocument ? "" : DRAWING_PROTOCOL) + ((await getValidAccessToken()) ?? ""),
      onStatus: ({ status: s }) => {
        const v = String(s);
        setStatus(
          v === "connected"
            ? "connected"
            : v === "connecting"
              ? "connecting"
              : "disconnected",
        );
      },
      onSynced: () => setSynced(true),
      onAuthenticated: ({ scope }) => setWriteDenied(scope !== 'read-write'),
      onAuthenticationFailed: () => setWriteDenied(true),
      onStateless: ({ payload }) => {
        if (payload === 'drawing-protocol-reload-required') { setWriteDenied(true); setReloadRequired(true); }
        if (payload === 'drawing-legacy-state-recovery-required') { setWriteDenied(true); setRecoveryRequired(true); }
        if (payload === 'page-write-denied') setWriteDenied(true);
        if (payload === 'page-write-allowed') setWriteDenied(false);
        if (payload === 'office-write-denied') setWriteDenied(true);
        if (payload === 'office-write-allowed') setWriteDenied(false);
        if (payload === 'office-access-denied') { setWriteDenied(true); setAccessDenied(true); }
      },
    });
    // An externally owned socket does not auto-attach its document provider.
    provider.attach();
    setBundle({ doc, provider, discardLocalChanges: async () => {
      // Only exposed behind the page's explicit local-reset confirmation.
      if (doc.isDestroyed) return;
      cancelled = true;
      provider.destroy(); socket.destroy();
      await persistence?.destroy();
      const { clearDocument } = await import('y-indexeddb');
      await clearDocument(`doc-page-${pageId}`);
      window.location.reload();
    } });

    // Offline-first (ALL clients — web, thin shell, bundled desktop; originally
    // Phase 4 of docs/plans/doc-desktop-bundled-offline.md, extended to the web
    // after typed-but-unsynced notes were lost in a doc-sync outage): persist
    // the doc to IndexedDB so an opened page survives offline — edits made
    // while disconnected live in the local store across reloads/navigation and
    // replay on reconnect, where the Yjs CRDT merge keeps BOTH sides (there is
    // no destructive "pick one version" path). Loaded dynamically to keep the
    // heavy module out of the initial bundle.
    let cancelled = false;
    let started = false;
    const connectRegisteredPage = async () => {
      const local = officeDocument ? null : await readLocalPage(pageId);
      if (cancelled) return;
      if (local && !local.registered) {
        setStatus("disconnected");
        return;
      }
      if (!started) {
        started = true;
        void socket.connect().catch(() => { if (!cancelled) setStatus("disconnected"); });
      }
    };
    window.addEventListener(LOCAL_PAGES_CHANGED, connectRegisteredPage);
    void connectRegisteredPage();
    let persistence: IndexeddbPersistence | null = null;
    if (!officeDocument) void import("y-indexeddb")
      .then(({ IndexeddbPersistence: Idb }) => {
        if (cancelled) return; // effect torn down before the import resolved
        persistence = new Idb(`doc-page-${pageId}`, doc);
        // Offline-usable: once local state loads, treat the editor as ready
        // even if the socket never connects — but ONLY when the store actually
        // held state (the page has been opened on this device before). A page
        // never seen on this device has an empty local store; unblocking the
        // editor on that would render a server-backed page as a blank
        // editable doc. Those stay skeleton-gated on the live socket, and the
        // editor shows the offline-unavailable notice instead.
        void persistence.whenSynced
          .then(async () => {
            const local = await readLocalPage(pageId);
            if (cancelled) return;
            if (local) Y.applyUpdate(doc, local.seed);
            if (hasLoadedState(doc)) setSynced(true);
          })
          .catch(() => {
            /* local load failed; stay dependent on the live socket */
          });
      })
      .catch(() => {
        /* offline persistence unavailable; behave as online-only */
      });

    return () => {
      cancelled = true;
      void persistence?.destroy();
      window.removeEventListener(LOCAL_PAGES_CHANGED, connectRegisteredPage);
      provider.destroy();
      socket.destroy();
      doc.destroy();
      setBundle(null);
      setStatus("connecting");
      setSynced(false);
      setWriteDenied(false);
      setReloadRequired(false);
      setRecoveryRequired(false);
      setAccessDenied(false);
    };
  }, [pageId]);

  return {
    doc: bundle?.doc ?? null,
    provider: bundle?.provider ?? null,
    status,
    synced,
    writeDenied: writeDenied || reloadRequired || recoveryRequired,
    reloadRequired,
    recoveryRequired,
    accessDenied,
    discardLocalChanges: bundle?.discardLocalChanges,
  };
}
