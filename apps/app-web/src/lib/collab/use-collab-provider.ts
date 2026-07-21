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
import { HocuspocusProvider } from "@hocuspocus/provider";
import type { IndexeddbPersistence } from "y-indexeddb";
import { getValidAccessToken } from "@/lib/auth-fetch";
import { hasLoadedState } from "@/lib/collab/doc-empty";

/**
 * Resolve the sync server URL for this page session. Order:
 *   1. `NEXT_PUBLIC_DOC_SYNC_URL` if set — explicit override (staging,
 *      local-against-prod, a future host move).
 *   2. Otherwise derive it from where the app is served: only the prod doc
 *      host dials the prod sync host. Previews (`*.vercel.app`) and local dev
 *      fall back to localhost so they never co-edit prod documents. Reading the
 *      hostname at runtime (rather than a build-time `VERCEL_ENV`) means prod
 *      "just works" with zero Vercel env config and can't silently regress to
 *      localhost if that build var isn't exposed.
 */
function resolveSyncUrl(): string {
  if (process.env.NEXT_PUBLIC_DOC_SYNC_URL)
    return process.env.NEXT_PUBLIC_DOC_SYNC_URL;
  if (
    typeof window !== "undefined" &&
    window.location.hostname === "app.usebrian.ai"
  )
    return "wss://doc-sync.usebrian.ai";
  return "ws://localhost:8080";
}

export type CollabStatus = "connecting" | "connected" | "disconnected";

export type CollabHandle = {
  doc: Y.Doc | null;
  provider: HocuspocusProvider | null;
  status: CollabStatus;
  synced: boolean;
};

export function useCollabProvider(pageId: string | null): CollabHandle {
  const [bundle, setBundle] = useState<{
    doc: Y.Doc;
    provider: HocuspocusProvider;
  } | null>(null);
  const [status, setStatus] = useState<CollabStatus>("connecting");
  const [synced, setSynced] = useState(false);

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
    const provider = new HocuspocusProvider({
      url: resolveSyncUrl(),
      name: pageId,
      document: doc,
      // HocuspocusProvider calls this per (re)connect. Unlike REST (authFetch
      // refreshes on 401), the socket has no retry path, so we refresh here
      // when the 1h access token is missing/expired — otherwise an expired
      // token loops "Reconnecting…" forever.
      token: async () => (await getValidAccessToken()) ?? "",
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
    });
    setBundle({ doc, provider });

    // Offline-first (ALL clients — web, thin shell, bundled desktop; originally
    // Phase 4 of docs/plans/doc-desktop-bundled-offline.md, extended to the web
    // after typed-but-unsynced notes were lost in a doc-sync outage): persist
    // the doc to IndexedDB so an opened page survives offline — edits made
    // while disconnected live in the local store across reloads/navigation and
    // replay on reconnect, where the Yjs CRDT merge keeps BOTH sides (there is
    // no destructive "pick one version" path). Loaded dynamically to keep the
    // heavy module out of the initial bundle.
    let cancelled = false;
    let persistence: IndexeddbPersistence | null = null;
    void import("y-indexeddb")
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
          .then(() => {
            if (!cancelled && hasLoadedState(doc)) setSynced(true);
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
      provider.destroy();
      doc.destroy();
      setBundle(null);
      setStatus("connecting");
      setSynced(false);
    };
  }, [pageId]);

  return {
    doc: bundle?.doc ?? null,
    provider: bundle?.provider ?? null,
    status,
    synced,
  };
}
