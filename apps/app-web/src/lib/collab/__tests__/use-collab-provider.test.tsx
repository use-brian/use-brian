// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { DRAWING_PROTOCOL, FRAGMENT_FIELD, pageToYDocUpdate } from "@use-brian/doc-model";
const state = vi.hoisted(() => ({ local: null as { seed: Uint8Array; registered: boolean } | null, saved: new Map<string, Uint8Array>(), connect: vi.fn(),
  cleared: vi.fn(), attach: vi.fn(), persisted: [] as string[],
  provider: null as null | { token: () => Promise<string>; onAuthenticated: (data: { scope: string }) => void; onAuthenticationFailed: () => void; onStateless: (data: { payload: string }) => void } }));
vi.mock("@/lib/offline/offline-pages", () => ({ LOCAL_PAGES_CHANGED: "local-pages", readLocalPage: async () => state.local }));
vi.mock("@/lib/auth-fetch", () => ({ getValidAccessToken: async () => "token" }));
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
  state.attach.mockReset();
  state.persisted = [];
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; });
describe("[COMP:app-web/collab-provider] offline page lifecycle", () => {
  it('advertises the protocol and keeps reload-required denial sticky across reconnects', async () => {
    await mount();
    expect(state.attach).toHaveBeenCalledTimes(1);
    expect(state.attach.mock.invocationCallOrder[0]).toBeLessThan(state.connect.mock.invocationCallOrder[0]);
    expect(await state.provider!.token()).toBe(`${DRAWING_PROTOCOL}token`);
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
    expect(state.cleared).toHaveBeenCalledWith('doc-page-page-a');
    expect(state.saved.has('doc-page-page-a')).toBe(false);
    expect(state.saved.has('doc-page-other')).toBe(true);
  });
  it("opens a new blank local page, persists edits across navigation, then connects after registration", async () => {
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
  it('keeps Office rooms out of the generic unencrypted page cache and surfaces typed revocation', async () => {
    root = createRoot(document.createElement('div'));
    await act(async () => { root!.render(createElement(OfficeProbe)); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(await state.provider!.token()).toBe('token');
    expect(state.persisted).toEqual([]);
    await act(async () => state.provider!.onStateless({ payload: 'office-write-denied' }));
    expect(latest.writeDenied).toBe(true);
    await act(async () => state.provider!.onStateless({ payload: 'office-access-denied' }));
    expect(latest.accessDenied).toBe(true);
  });
});
