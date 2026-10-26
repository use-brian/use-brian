/** Upload a closed local page through the same authenticated Yjs protocol.
 * [COMP:app-web/offline-pages]
 */
import { publicRuntimeConfig } from "@/lib/runtime-public-config";
import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { offlinePageDocumentKey, pinOfflineWriteSession, offlineWriteUnavailable, type OfflineWriteAuthority } from "./application-write-authority";
import { DRAWING_PROTOCOL } from '@use-brian/doc-model';

export function resolveSyncUrl(): string {
  const configuredSyncUrl = publicRuntimeConfig().docSyncUrl;
  if (configuredSyncUrl) return configuredSyncUrl;
  if (typeof window !== "undefined" && window.location.hostname === "app.usebrian.ai") {
    return "wss://doc-sync.usebrian.ai";
  }
  return "ws://localhost:8080";
}

export async function syncLocalPage(pageId: string, seed: Uint8Array, authority: OfflineWriteAuthority): Promise<void> {
  const session = await pinOfflineWriteSession(authority);
  const admission = await session.request(`/api/views/${encodeURIComponent(pageId)}`);
  if (!admission.ok) throw offlineWriteUnavailable();
  const page: unknown = await admission.json();
  if (!page || typeof page !== "object" || !("id" in page) || page.id !== pageId
    || !("workspaceId" in page) || page.workspaceId !== authority.workspaceId) throw offlineWriteUnavailable();
  session.assertCurrent();
  const key = offlinePageDocumentKey(pageId, authority);
  if (!key) throw offlineWriteUnavailable();
  const { IndexeddbPersistence } = await import("y-indexeddb");
  session.assertCurrent();
  const doc = new Y.Doc();
  const persistence = new IndexeddbPersistence(key, doc);
  let socket: HocuspocusProviderWebsocket | undefined;
  let provider: HocuspocusProvider | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await persistence.whenSynced;
    session.assertCurrent();
    Y.applyUpdate(doc, seed);
    const syncUrl = resolveSyncUrl();
    await new Promise<void>((resolve, reject) => {
      const stop = (error: Error) => {
        if (socket) socket.shouldConnect = false;
        reject(error);
      };
      const assertCurrent = () => {
        session.assertCurrent();
        if (resolveSyncUrl() !== syncUrl) throw offlineWriteUnavailable();
      };
      const complete = () => {
        try {
          assertCurrent();
          if (provider?.isSynced && !provider.hasUnsyncedChanges) resolve();
        } catch (error) { stop(error instanceof Error ? error : offlineWriteUnavailable()); }
      };
      socket = new HocuspocusProviderWebsocket({ url: syncUrl, autoConnect: false, maxAttempts: 1,
        onDisconnect: () => stop(new Error("offline_page_sync_interrupted")) });
      provider = new HocuspocusProvider({
        websocketProvider: socket, name: pageId, document: doc,
        token: () => { assertCurrent(); return DRAWING_PROTOCOL + session.bearer(); },
        onAuthenticated: ({ scope }) => { if (scope !== "read-write") stop(new Error("offline_page_sync_denied")); },
        onSynced: complete,
        onUnsyncedChanges: complete,
        onAuthenticationFailed: () => stop(new Error("offline_page_sync_denied")),
      });
      provider.attach();
      timer = setTimeout(() => stop(new Error("offline_page_sync_timeout")), 15_000);
      assertCurrent();
      void socket.connect().catch(error => stop(error instanceof Error ? error : offlineWriteUnavailable()));
    });
    session.assertCurrent();
  } finally {
    clearTimeout(timer);
    provider?.destroy();
    socket?.destroy();
    await persistence.destroy();
    doc.destroy();
  }
}
