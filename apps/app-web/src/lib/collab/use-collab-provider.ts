"use client";

/**
 * Owns the Yjs document + HocuspocusProvider lifecycle for one page. The doc
 * is created on mount (keyed by pageId), the provider dials the sync service
 * presenting the user's JWT, and both are torn down on unmount / pageId change
 * (StrictMode double-mount safe via the effect cleanup).
 *
 * [COMP:app-web/collab-provider]
 */

import { useEffect, useState } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import type { IndexeddbPersistence } from "y-indexeddb";
import { getValidAccessToken } from "@/lib/auth-fetch";
import { isDesktopAuth } from "@/lib/desktop-auth-source";

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
    window.location.hostname === "app.sidan.ai"
  )
    return "wss://doc-sync.sidan.ai";
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

    // Bundled desktop only (Phase 4, docs/plans/doc-desktop-bundled-offline.md):
    // persist the doc to IndexedDB so an opened page survives offline and edits
    // replay on reconnect. Gated on `isDesktopAuth()` (the bundled token bridge)
    // so the web app and thin shell are unaffected — they keep the "live, not
    // snapshot" contract with no local persistence. Loaded dynamically so the
    // web bundle never executes `y-indexeddb`.
    let cancelled = false;
    let persistence: IndexeddbPersistence | null = null;
    if (isDesktopAuth()) {
      void import("y-indexeddb")
        .then(({ IndexeddbPersistence: Idb }) => {
          if (cancelled) return; // effect torn down before the import resolved
          persistence = new Idb(`doc-page-${pageId}`, doc);
          // Offline-usable: once local state loads, treat the editor as ready
          // even if the socket never connects.
          void persistence.whenSynced
            .then(() => {
              if (!cancelled) setSynced(true);
            })
            .catch(() => {
              /* local load failed; stay dependent on the live socket */
            });
        })
        .catch(() => {
          /* offline persistence unavailable; behave as online-only */
        });
    }

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
