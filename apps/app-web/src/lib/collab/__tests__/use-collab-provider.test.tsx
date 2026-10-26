// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { DRAWING_PROTOCOL, FRAGMENT_FIELD, pageToYDocUpdate } from "@use-brian/doc-model";
const state = vi.hoisted(() => ({ local: null as { seed: Uint8Array; registered: boolean } | null, saved: new Map<string, Uint8Array>(), connect: vi.fn(),
  cleared: vi.fn(), evicted: vi.fn(), attach: vi.fn(), persisted: [] as string[],
  userId: "viewer-a", apiOrigin: "http://api.example", userListeners: new Set<() => void>(),
  provider: null as null | { token: () => Promise<string>; onAuthenticated: (data: { scope: string }) => void; onAuthenticationFailed: () => void; onStateless: (data: { payload: string }) => void } }));
vi.mock("@/lib/offline/offline-pages", () => ({ LOCAL_PAGES_CHANGED: "local-pages", readLocalPage: async () => state.userId === "viewer-a" ? state.local : null, evictCachedPage: state.evicted }));
vi.mock("@/lib/user", () => ({ getUserInfo: () => ({ id: state.userId }), subscribeUserInfo: (listener: () => void) => {
  state.userListeners.add(listener); return () => state.userListeners.delete(listener);
} }));
vi.mock("@/lib/runtime-public-config", () => ({ publicRuntimeConfig: () => ({ apiUrl: state.apiOrigin }) }));
vi.mock("@/lib/auth-fetch", () => ({ getValidAccessToken: async () => token(state.userId) }));
vi.mock("@hocuspocus/provider", () => ({
  HocuspocusProviderWebsocket: class { connect = state.connect; destroy() {} },
  HocuspocusProvider: class { constructor(config: NonNullable<typeof state.provider>) { state.provider = config; } attach = state.attach; destroy() {} },
}));
vi.mock("y-indexeddb", () => ({
  clearDocument: async (name: string) => { state.cleared(name); state.saved.delete(name); },
  IndexeddbPersistence: class {
    whenSynced: Promise<void>;
    save: () => void;
    constructor(private name: string, private doc: Y.Doc) {
      state.persisted.push(name);
      this.save = () => { state.saved.set(name, Y.encodeStateAsUpdate(doc)); };
      this.whenSynced = Promise.resolve().then(() => {
        const saved = state.saved.get(name);
        if (saved) Y.applyUpdate(doc, saved);
        doc.on("update", this.save);
      });
    }
    async destroy() { this.doc.off("update", this.save); }
  },
}));
import { useCollabProvider, type CollabHandle } from "../use-collab-provider";
import { offlinePageDocumentKey } from "@/lib/offline/application-write-authority";
const token = (sub: string) => `fixture.${btoa(JSON.stringify({ sub }))}.fixture`;
const documentKey = () => offlinePageDocumentKey("page-a")!;
let latest: CollabHandle;
let root: Root | null;
function Probe() { latest = useCollabProvider("page-a"); return null; }
function OfficeProbe() { latest = useCollabProvider("office:artifact-a"); return null; }
async function mount() {
  root = createRoot(document.createElement("div"));
  await act(async () => { root!.render(createElement(Probe)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.local = null; state.saved.clear(); state.connect.mockReset().mockResolvedValue(undefined);
  state.cleared.mockReset();
  state.evicted.mockReset();
  state.attach.mockReset();
  state.persisted = [];
  state.userId = "viewer-a"; state.apiOrigin = "http://api.example"; state.userListeners.clear();
  window.history.replaceState({}, "", "/w/00000000-0000-4000-8000-000000000001/p/page-a");
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount()); root = null;
  Reflect.deleteProperty(window, "usebrianDesktop");
});
describe("[COMP:app-web/collab-provider] offline page lifecycle", () => {
  it("starts the editor on the bundled desktop hash route with scoped persistence", async () => {
    window.history.replaceState({}, "", "/renderer/index.html#/w/00000000-0000-4000-8000-000000000001/p/page-a");
    Object.defineProperty(window, "usebrianDesktop", { configurable: true, value: { getAccessToken: () => token(state.userId) } });
    await mount();
    expect(latest.doc).not.toBeNull();
    expect(latest.provider).not.toBeNull();
    expect(state.attach).toHaveBeenCalledTimes(1);
    expect(state.connect).toHaveBeenCalledTimes(1);
    expect(state.persisted).toEqual([documentKey()]);
    expect(documentKey()).toContain("00000000-0000-4000-8000-000000000001");
    expect(await state.provider!.token()).toBe(`${DRAWING_PROTOCOL}${token("viewer-a")}`);
  });

  it('advertises the protocol and keeps reload-required denial sticky across reconnects', async () => {
    await mount();
    expect(state.attach).toHaveBeenCalledTimes(1);
    expect(state.attach.mock.invocationCallOrder[0]).toBeLessThan(state.connect.mock.invocationCallOrder[0]);
    expect(await state.provider!.token()).toBe(`${DRAWING_PROTOCOL}${token("viewer-a")}`);
    await act(async () => state.provider!.onStateless({ payload: 'drawing-protocol-reload-required' }));
    expect(latest.reloadRequired).toBe(true);
    await act(async () => state.provider!.onAuthenticated({ scope: 'read-write' }));
    expect(latest.writeDenied).toBe(true);
  });
  it('retains rejected legacy cache until an explicit page-local reset', async () => {
    state.local = { registered: false, seed: pageToYDocUpdate({ blocks: [] }, 'Local') };
    await mount();
    state.saved.set('doc-page-other', new Uint8Array([1]));
    await act(async () => state.provider!.onStateless({ payload: 'drawing-legacy-state-recovery-required' }));
    expect(latest.recoveryRequired).toBe(true);
    expect(state.cleared).not.toHaveBeenCalled();
    await act(async () => state.provider!.onAuthenticated({ scope: 'read-write' }));
    expect(latest.writeDenied).toBe(true);
    // jsdom cannot navigate; cache isolation is asserted independently of reload.
    await act(async () => latest.discardLocalChanges!());
    expect(state.cleared).toHaveBeenCalledWith(documentKey());
    expect(state.saved.has(documentKey())).toBe(false);
    expect(state.saved.has('doc-page-other')).toBe(true);
  });
  it("opens a new blank local page, retains edits, and connects after all outbox stages acknowledge", async () => {
    state.local = { registered: false, seed: pageToYDocUpdate({ blocks: [] }, "New draft") };
    await mount();
    expect(latest.synced).toBe(true);
    expect(state.connect).not.toHaveBeenCalled();
    const paragraph = latest.doc!.getXmlFragment(FRAGMENT_FIELD).get(0) as Y.XmlElement;
    paragraph.insert(0, [new Y.XmlText("Local edits survive")]);
    await act(async () => root!.unmount()); root = null;
    await mount();
    expect(latest.doc!.getXmlFragment(FRAGMENT_FIELD).toString()).toContain("Local edits survive");
    state.local.registered = true;
    await act(async () => { window.dispatchEvent(new Event("local-pages")); });
    expect(state.connect).not.toHaveBeenCalled();
    state.local = null;
    await act(async () => { window.dispatchEvent(new Event("local-pages")); });
    expect(state.connect).toHaveBeenCalledTimes(1);
  });
  it("keeps an uncached server page gated until it actually loads content", async () => {
    await mount();
    expect(latest.synced).toBe(false);
    expect(state.connect).toHaveBeenCalledTimes(1);
  });
  it('reflects authenticated scope and live server denial without deleting offline content', async () => {
    state.local = { registered: false, seed: pageToYDocUpdate({ blocks: [] }, 'Local page') };
    await mount();
    const before = Y.encodeStateAsUpdate(latest.doc!);
    await act(async () => state.provider!.onAuthenticated({ scope: 'readonly' }));
    expect(latest.writeDenied).toBe(true);
    await act(async () => state.provider!.onStateless({ payload: 'page-write-allowed' }));
    expect(latest.writeDenied).toBe(false);
    await act(async () => state.provider!.onStateless({ payload: 'page-write-denied' }));
    expect(latest.writeDenied).toBe(true);
    expect(Y.encodeStateAsUpdate(latest.doc!)).toEqual(before);
    await act(async () => state.provider!.onAuthenticated({ scope: 'read-write' }));
    expect(latest.writeDenied).toBe(false);
    await act(async () => state.provider!.onAuthenticationFailed());
    expect(latest.writeDenied).toBe(true);
  });
  it('purges page-local content and metadata on typed read-access denial', async () => {
    await mount();
    latest.doc!.getMap('fixture').set('secret', 'restricted');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(state.saved.has(documentKey())).toBe(true);
    await act(async () => {
      state.provider!.onStateless({ payload: 'page-access-denied' });
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(latest.accessDenied).toBe(true);
    expect(latest.doc).toBeNull();
    expect(state.cleared).toHaveBeenCalledWith(documentKey());
    expect(state.evicted).toHaveBeenCalledWith('page-a', expect.objectContaining({ viewerId: 'viewer-a' }));
    expect(state.saved.has(documentKey())).toBe(false);
  });
  it('keeps Office rooms out of the generic unencrypted page cache and surfaces typed revocation', async () => {
    root = createRoot(document.createElement('div'));
    await act(async () => { root!.render(createElement(OfficeProbe)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(await state.provider!.token()).toBe(token("viewer-a"));
    expect(state.persisted).toEqual([]);
    await act(async () => state.provider!.onStateless({ payload: 'office-write-denied' }));
    expect(latest.writeDenied).toBe(true);
    await act(async () => state.provider!.onStateless({ payload: 'office-access-denied' }));
    expect(latest.accessDenied).toBe(true);
    expect(latest.doc).toBeNull();
    expect(latest.synced).toBe(false);
    expect(state.cleared).not.toHaveBeenCalled();
  });
  it("never adopts the historical unscoped page database into a signed-in account", async () => {
    const old = new Y.Doc(); old.getMap("fixture").set("secret", "Historical private bytes");
    state.saved.set("doc-page-page-a", Y.encodeStateAsUpdate(old)); old.destroy();
    await mount();
    expect(latest.doc!.getMap("fixture").get("secret")).toBeUndefined();
    expect(latest.synced).toBe(false);
    expect(state.saved.has("doc-page-page-a")).toBe(true);
  });
  it("drops the old live document and bearer callback before switching an account", async () => {
    await mount();
    latest.doc!.getMap("fixture").set("secret", "Fictional private bytes");
    const oldDoc = latest.doc!, oldProvider = state.provider!, oldKey = documentKey();
    await act(async () => {
      state.userId = "viewer-b";
      for (const listener of state.userListeners) listener();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(oldDoc.isDestroyed).toBe(true);
    expect(latest.doc).not.toBe(oldDoc);
    expect(latest.doc?.getMap("fixture").get("secret")).toBeUndefined();
    expect(latest.synced).toBe(false);
    await expect(oldProvider.token()).rejects.toThrow();
    expect(state.persisted).toContain(oldKey);
    expect(state.persisted.at(-1)).not.toBe(oldKey);
  });
  it("holds persistence and transport when the native principal is unavailable", async () => {
    state.userId = "";
    await mount();
    expect(latest.doc).toBeNull(); expect(latest.synced).toBe(false);
    expect(state.connect).not.toHaveBeenCalled(); expect(state.persisted).toEqual([]);
  });
});
