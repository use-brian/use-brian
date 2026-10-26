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
import { subscribeUserInfo } from "@/lib/user";
import { hasLoadedState } from "@/lib/collab/doc-empty";
import { DRAWING_PROTOCOL } from '@use-brian/doc-model';

import { resolveSyncUrl } from "@/lib/offline/sync-local-page";
import { evictCachedPage, LOCAL_PAGES_CHANGED, readLocalPage } from "@/lib/offline/offline-pages";
import { currentOfflineWriteAuthority, sameOfflineWriteAuthority, pinOfflineWriteSession,
  offlinePageDocumentKey, offlineWriteUnavailable, type OfflineWriteAuthority } from "@/lib/offline/application-write-authority";

export type CollabStatus = "connecting" | "connected" | "disconnected";

export type CollabHandle = {
  doc: Y.Doc | null;
  provider: HocuspocusProvider | null;
  status: CollabStatus;
  synced: boolean;
  writeDenied?: boolean;
  reloadRequired?: boolean;
  /** A Brief Direction edit was refused (project-briefs.md); reload to continue. */
  briefProtected?: boolean;
  recoveryRequired?: boolean;
  accessDenied?: boolean;
  discardLocalChanges?: () => Promise<void>;
};

export function useCollabProvider(pageId: string | null): CollabHandle {
  const [bundle, setBundle] = useState<{
    doc: Y.Doc;
    provider: HocuspocusProvider;
    discardLocalChanges: () => Promise<void>;
    authority: OfflineWriteAuthority;
  } | null>(null);
  const [, identityChanged] = useState(0);
  useEffect(() => subscribeUserInfo(() => identityChanged(value => value + 1)), []);
  const activeAuthority = currentOfflineWriteAuthority();
  const authorityKey = activeAuthority ? JSON.stringify(activeAuthority) : null;
  const [status, setStatus] = useState<CollabStatus>("connecting");
  const [synced, setSynced] = useState(false);
  const [writeDenied, setWriteDenied] = useState(false);
  const [reloadRequired, setReloadRequired] = useState(false);
  const [briefProtected, setBriefProtected] = useState(false);
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);

  useEffect(() => {
    // No active page (the `/p` index empty-selection state, or the gap
    // between a page switch and its metadata resolving): hold no socket.
    // Lets the shell call this hook unconditionally (Rules of Hooks) while
    // still tearing the previous page's connection down.
    const authority = currentOfflineWriteAuthority();
    if (!pageId || !authority || JSON.stringify(authority) !== authorityKey) {
      setBundle(null);
      setStatus("connecting");
      setSynced(false);
      return;
    }
    const doc = new Y.Doc();
    const officeDocument = pageId.startsWith("office:");
    const documentKey = officeDocument ? null : offlinePageDocumentKey(pageId, authority);
    const socket = new HocuspocusProviderWebsocket({ url: resolveSyncUrl(), autoConnect: false });
    let persistence: IndexeddbPersistence | null = null;
    let cancelled = false;
    let disposed = false;
    let provider: HocuspocusProvider;
    const purgeDeniedPage = async () => {
      if (cancelled) return;
      cancelled = true;
      setWriteDenied(true);
      setAccessDenied(true);
      setSynced(false);
      setStatus("disconnected");
      provider.destroy();
      socket.destroy();
      await persistence?.destroy();
      if (!officeDocument) {
        const { clearDocument } = await import("y-indexeddb");
        await Promise.all([
          ...(documentKey ? [clearDocument(documentKey)] : []),
          evictCachedPage(pageId, authority),
        ]);
      }
      if (!doc.isDestroyed) doc.destroy();
      if (!disposed) setBundle(null);
    };
    provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: pageId,
      document: doc,
      // HocuspocusProvider calls this per (re)connect. Unlike REST (authFetch
      // refreshes on 401), the socket has no retry path, so we refresh here
      // when the 1h access token is missing/expired — otherwise an expired
      // token loops "Reconnecting…" forever.
      token: async () => {
        if (cancelled) throw offlineWriteUnavailable();
        const session = await pinOfflineWriteSession(authority);
        if (cancelled) throw offlineWriteUnavailable();
        return (officeDocument ? "" : DRAWING_PROTOCOL) + session.bearer();
      },
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
        // A Brief's Direction changes only through the Brief pane (project-briefs.md):
        // the refused local edit is discarded by reloading.
        if (payload === 'brief-direction-protected') { setWriteDenied(true); setReloadRequired(true); setBriefProtected(true); }
        if (payload === 'drawing-legacy-state-recovery-required') { setWriteDenied(true); setRecoveryRequired(true); }
        if (payload === 'page-write-denied') setWriteDenied(true);
        if (payload === 'page-write-allowed') setWriteDenied(false);
        if (payload === 'page-access-denied') void purgeDeniedPage();
        if (payload === 'office-write-denied') setWriteDenied(true);
        if (payload === 'office-write-allowed') setWriteDenied(false);
        if (payload === 'office-access-denied') void purgeDeniedPage();
      },
    });
    // An externally owned socket does not auto-attach its document provider.
    provider.attach();
    setBundle({ doc, provider, authority, discardLocalChanges: async () => {
      // Only exposed behind the page's explicit local-reset confirmation.
      if (doc.isDestroyed) return;
      cancelled = true;
      provider.destroy(); socket.destroy();
      await persistence?.destroy();
      const { clearDocument } = await import('y-indexeddb');
      if (documentKey) await clearDocument(documentKey);
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
    let started = false;
    const connectRegisteredPage = async () => {
      const local = officeDocument ? null : await readLocalPage(pageId);
      if (cancelled || !sameOfflineWriteAuthority(authority, currentOfflineWriteAuthority())) return;
      if (local) {
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
    const unsubscribe = subscribeUserInfo(() => {
      if (sameOfflineWriteAuthority(authority, currentOfflineWriteAuthority())) return;
      cancelled = true;
      provider.destroy(); socket.destroy();
      void persistence?.destroy();
      if (!doc.isDestroyed) doc.destroy();
      setBundle(null); setSynced(false); setStatus("disconnected");
    });
    if (documentKey) void import("y-indexeddb")
      .then(({ IndexeddbPersistence: Idb }) => {
        if (cancelled || !sameOfflineWriteAuthority(authority, currentOfflineWriteAuthority())) return;
        persistence = new Idb(documentKey, doc);
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
            if (cancelled || !sameOfflineWriteAuthority(authority, currentOfflineWriteAuthority())) return;
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
      disposed = true;
      unsubscribe();
      void persistence?.destroy();
      window.removeEventListener(LOCAL_PAGES_CHANGED, connectRegisteredPage);
      provider.destroy();
      socket.destroy();
      if (!doc.isDestroyed) doc.destroy();
      setBundle(null);
      setStatus("connecting");
      setSynced(false);
      setWriteDenied(false);
      setReloadRequired(false);
      setBriefProtected(false);
      setRecoveryRequired(false);
      setAccessDenied(false);
    };
  }, [pageId, authorityKey]);

  const admittedBundle = bundle && sameOfflineWriteAuthority(bundle.authority, activeAuthority) ? bundle : null;

  return {
    doc: admittedBundle?.doc ?? null,
    provider: admittedBundle?.provider ?? null,
    status,
    synced: !!admittedBundle && synced,
    writeDenied: writeDenied || reloadRequired || recoveryRequired,
    reloadRequired,
    briefProtected,
    recoveryRequired,
    accessDenied,
    discardLocalChanges: admittedBundle?.discardLocalChanges,
  };
}
