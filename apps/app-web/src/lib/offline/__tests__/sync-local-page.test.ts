import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { FRAGMENT_FIELD, pageToYDocUpdate } from "@use-brian/doc-model";
const state = vi.hoisted(() => ({ saved: null as Uint8Array | null, provider: null as any, persisted: false, closed: false,
  userId: "viewer-a", apiOrigin: "http://api.example", database: "", afterStorage: null as null | (() => void), socket: null as any }));
vi.mock("@/lib/user", () => ({ getUserInfo: () => ({ id: state.userId }) }));
vi.mock("@/lib/runtime-public-config", () => ({ publicRuntimeConfig: () => ({ apiUrl: state.apiOrigin }) }));
vi.mock("@/lib/auth-fetch", () => ({ getValidAccessToken: vi.fn(async () => `fixture.${btoa(JSON.stringify({ sub: state.userId }))}.fixture`) }));
vi.mock("y-indexeddb", () => ({
  IndexeddbPersistence: class {
    whenSynced: Promise<void>;
    constructor(name: string, doc: Y.Doc) {
      state.database = name;
      this.whenSynced = import("yjs").then((Yjs) => {
        if (state.saved) Yjs.applyUpdate(doc, state.saved);
        state.persisted = true;
        state.afterStorage?.();
      });
    }
    async destroy() { state.closed = true; }
  },
}));
vi.mock("@hocuspocus/provider", () => ({
  HocuspocusProviderWebsocket: class {
    shouldConnect = false;
    constructor(public config: any) { state.socket = this; }
    async connect() {
      expect(state.persisted).toBe(true);
      expect(state.provider.attached).toBe(true);
      state.provider.isSynced = true;
      state.provider.config.onSynced({ state: true });
    }
    destroy() {}
  },
  HocuspocusProvider: class {
    isSynced = false;
    hasUnsyncedChanges = true;
    attached = false;
    attach() { this.attached = true; }
    constructor(public config: any) { state.provider = this; }
    destroy() {}
  },
}));
import { syncLocalPage } from "../sync-local-page";
import { currentOfflineWriteAuthority } from "../application-write-authority";
const workspaceId = "00000000-0000-4000-8000-000000000001";
const request = vi.fn<typeof fetch>();
const authority = () => currentOfflineWriteAuthority(workspaceId)!;

beforeEach(() => {
  state.saved = null; state.provider = null; state.persisted = false; state.closed = false;
  state.userId = "viewer-a"; state.apiOrigin = "http://api.example"; state.database = ""; state.afterStorage = null; state.socket = null;
  request.mockReset().mockImplementation(async () => new Response(JSON.stringify({ id: "page-a", workspaceId })));
  vi.stubGlobal("fetch", request);
  vi.stubGlobal("window", { location: { pathname: `/w/${workspaceId}/p/page-a`, hostname: "localhost" } });
});
describe("[COMP:app-web/offline-pages] closed-page content replay", () => {
  it("loads offline edits before connecting and waits for their acknowledgement", async () => {
    const seed = pageToYDocUpdate({ blocks: [] }, "New draft");
    const edited = new Y.Doc();
    Y.applyUpdate(edited, seed);
    const paragraph = edited.getXmlFragment(FRAGMENT_FIELD).get(0) as Y.XmlElement;
    const text = new Y.XmlText(); text.insert(0, "Written offline"); paragraph.insert(0, [text]);
    state.saved = Y.encodeStateAsUpdate(edited);
    edited.destroy();
    let done = false;
    const syncing = syncLocalPage("page-a", seed, authority()).then(() => { done = true; });
    await vi.waitFor(() => expect(state.provider?.isSynced).toBe(true));
    expect(done).toBe(false); // handshake alone does not acknowledge our edits
    expect(state.provider.config.document.getXmlFragment(FRAGMENT_FIELD).toString()).toContain("Written offline");
    state.provider.hasUnsyncedChanges = false;
    state.provider.config.onUnsyncedChanges({ number: 0 });
    await syncing;
    expect(state.closed).toBe(true);
    expect(state.database).toContain("viewer-a");
    expect(state.database).toContain(encodeURIComponent("http://api.example"));
    expect(state.database).not.toBe("doc-page-page-a");
  });
  it("rejects authentication failure so the outbox retains the page", async () => {
    const syncing = syncLocalPage("page-a", pageToYDocUpdate({ blocks: [] }, "New draft"), authority());
    const rejected = expect(syncing).rejects.toThrow("denied");
    await vi.waitFor(() => expect(state.provider).not.toBeNull());
    state.provider.config.onAuthenticationFailed();
    await rejected;
    expect(state.closed).toBe(true);
  });
  it("does not read cached bytes or connect when current page admission fails", async () => {
    request.mockResolvedValue(new Response("", { status: 403 }));
    await expect(syncLocalPage("page-a", new Uint8Array(), authority())).rejects.toThrow();
    expect(state.persisted).toBe(false); expect(state.provider).toBeNull();
  });
  it("refuses an account change while local persistence is loading", async () => {
    state.afterStorage = () => { state.userId = "viewer-b"; };
    await expect(syncLocalPage("page-a", new Uint8Array(), authority())).rejects.toThrow();
    expect(state.provider).toBeNull(); expect(state.closed).toBe(true);
  });
  it("does not refresh an upload transport into a different account", async () => {
    const syncing = syncLocalPage("page-a", pageToYDocUpdate({ blocks: [] }, "New draft"), authority());
    const rejected = expect(syncing).rejects.toThrow();
    await vi.waitFor(() => expect(state.provider).not.toBeNull());
    state.userId = "viewer-b";
    expect(() => state.provider.config.token()).toThrow();
    state.provider.config.onUnsyncedChanges({ number: 0 });
    await rejected;
    expect(state.closed).toBe(true);
  });
  it("stops rather than reconnecting a transport with an uncertain upload", async () => {
    const syncing = syncLocalPage("page-a", pageToYDocUpdate({ blocks: [] }, "New draft"), authority());
    const rejected = expect(syncing).rejects.toThrow("interrupted");
    await vi.waitFor(() => expect(state.socket).not.toBeNull());
    state.socket.shouldConnect = true;
    state.socket.config.onDisconnect();
    await rejected;
    expect(state.socket.shouldConnect).toBe(false);
    expect(state.closed).toBe(true);
  });
});
