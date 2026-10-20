import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { FRAGMENT_FIELD, pageToYDocUpdate } from "@use-brian/doc-model";

const state = vi.hoisted(() => ({ data: new Map<string, unknown>(), userId: "viewer-a", failStorage: false,
  apiOrigin: "http://api.example", token: null as string | null }));
vi.mock("@/lib/user", () => ({ getUserInfo: () => ({ id: state.userId }) }));
vi.mock("@/lib/offline/idb", () => ({
  idbGet: vi.fn(async (key: string) => structuredClone(state.data.get(key) ?? null)),
  idbSet: vi.fn(async (key: string, value: unknown) => { state.data.set(key, structuredClone(value)); }),
  idbDelete: vi.fn(async (key: string) => { state.data.delete(key); }),
  idbUpdate: vi.fn(async (key: string, update: (v: unknown) => unknown) => {
    if (state.failStorage) throw new Error("quota");
    const next = update(structuredClone(state.data.get(key) ?? null));
    state.data.set(key, structuredClone(next));
    return next;
  }),
}));
vi.mock("@/lib/runtime-public-config", () => ({ publicRuntimeConfig: () => ({ apiUrl: state.apiOrigin }) }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn(), getValidAccessToken: vi.fn(async () => state.token ?? token(state.userId)) }));
vi.mock("../sync-local-page", () => ({ syncLocalPage: vi.fn(async () => {}) }));
import { authFetch } from "@/lib/auth-fetch";
import { createDraft, getView, listViews } from "@/lib/api/views";
import { setOnline, offlineWrite, flushWriteQueue } from "../offline-writes";
import { syncLocalPage } from "../sync-local-page";
import { createLocalPage, flushLocalPages, readLocalPage, readLocalPages, readCachedPage, cachePage } from "../offline-pages";
import { idbGet } from "../idb";
const wid = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000002";
const childId = "00000000-0000-4000-8000-000000000003";
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const token = (sub: string) => `fixture.${btoa(JSON.stringify({ sub }))}.fixture`;
const request = vi.fn<typeof fetch>();

/** Transport fixture only; real native/source ACL proof belongs to the API/browser suites. */
function server() {
  const pages = new Map<string, unknown>();
  request.mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("offline-capabilities")) return reply({ clientAssignedPageIds: true });
    if (path.endsWith("/views/draft")) {
      const input = JSON.parse(init!.body as string);
      const page = (await readLocalPage(input.id))?.view ?? { ...input, workspaceId: wid, createdBy: state.userId };
      pages.set(input.id, page);
      return reply(page, 201);
    }
    if (path.endsWith("/commit-created")) return reply({ committed: true });
    const page = pages.get(path.split("/").at(-1)!);
    return page ? reply(page) : reply({}, 404);
  });
  return pages;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.data.clear(); state.userId = "viewer-a"; state.failStorage = false; state.token = null; state.apiOrigin = "http://api.example";
  setOnline(false);
  vi.stubGlobal("navigator", { onLine: false });
  vi.stubGlobal("window", { location: { pathname: `/w/${wid}/p/${id}`, hostname: "localhost" }, dispatchEvent: vi.fn() });
  request.mockReset(); vi.stubGlobal("fetch", request);
  vi.mocked(authFetch).mockReset();
  vi.mocked(syncLocalPage).mockReset().mockResolvedValue();
});

describe("[COMP:app-web/offline-pages] durable offline creation", () => {
  it("creates, navigates, and reloads a blank page without a network request", async () => {
    const page = await createDraft({ workspaceId: wid, teamspaceId: null });
    expect(page.id).toMatch(/^[\da-f-]{36}$/);
    expect(page.teamspaceId).toBeNull();
    // Each read comes from the serialized durable store, not a memory object.
    expect(await getView(page.id)).toEqual(page);
    expect(await listViews({ workspaceId: wid, state: "draft" })).toEqual([page]);
    const local = await readLocalPage(page.id);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, local!.seed);
    expect(doc.store.clients.size).toBeGreaterThan(0); // blank is editable
    doc.destroy();
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("keeps private inheritance and orders offline parent then child", async () => {
    await createLocalPage({ id, workspaceId: wid, teamspaceId: null });
    const child = await createLocalPage({ id: childId, workspaceId: wid, nestParentId: id });
    expect(child.teamspaceId).toBeNull();
    expect(child.nestParentId).toBe(id);
    expect((await readLocalPages()).map((p) => p.view.id)).toEqual([id, childId]);
  });

  it("inherits a cached teamspace and project from a parent", async () => {
    const parent = await createLocalPage({ id, workspaceId: wid, teamspaceId: "teamspace-a" });
    await cachePage({ ...parent, id: "cached-parent", projectId: "project-a" });
    const child = await createLocalPage({ id: childId, workspaceId: wid, nestParentId: "cached-parent" });
    expect(child).toMatchObject({ teamspaceId: "teamspace-a", projectId: "project-a" });
  });

  it("rejects an unknown parent and does not claim success when storage fails", async () => {
    await expect(createLocalPage({ id, workspaceId: wid, nestParentId: "missing" })).rejects.toThrow("parent");
    state.failStorage = true;
    await expect(createDraft({ workspaceId: wid })).rejects.toThrow("storage");
    expect(await readLocalPages()).toEqual([]);
  });

  it("scopes local pages and metadata to the signed-in viewer", async () => {
    const page = await createLocalPage({ id, workspaceId: wid });
    await cachePage(page);
    state.userId = "viewer-b";
    expect(await readLocalPages()).toEqual([]);
    expect(await readCachedPage(id)).toBeNull();
  });

  it("coalesces a rename while a local page is waiting even if the network is up", async () => {
    await createLocalPage({ id, workspaceId: wid });
    setOnline(true);
    for (const name of ["First title", "Final title"]) {
      await offlineWrite({ kind: "view.rename", coalesceKey: `rename:${id}`, payload: { id, name } });
    }
    expect((await getView(id)).name).toBe("Final title");
    expect((await listViews({ workspaceId: wid, state: "draft" }))[0].name).toBe("Final title");
    expect(request).not.toHaveBeenCalled();
    await flushWriteQueue();
    expect(authFetch).not.toHaveBeenCalled(); // create must finish first
    expect(request).not.toHaveBeenCalled();
  });

  it("uses identical seed structs on both sides so templates do not duplicate", async () => {
    const page = await createLocalPage({ id, workspaceId: wid, name: "Notes", blocks: [{ kind: "text", id: "block-a", text: "Seed" }] });
    const local = (await readLocalPage(id))!;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, local.seed);
    const before = doc.getXmlFragment(FRAGMENT_FIELD).toString();
    Y.applyUpdate(doc, pageToYDocUpdate({ blocks: [{ kind: "text", id: "block-a", text: "Seed" }] }, "Notes"));
    expect(doc.getXmlFragment(FRAGMENT_FIELD).toString()).toBe(before);
    doc.destroy();
  });

  it("registers and syncs closed pages in order, retaining their stable URLs", async () => {
    await createLocalPage({ id, workspaceId: wid, name: "Parent" });
    await createLocalPage({ id: childId, workspaceId: wid, nestParentId: id });
    vi.stubGlobal("navigator", { onLine: true });
    server();
    await Promise.all([flushLocalPages(), flushLocalPages()]);
    expect(vi.mocked(syncLocalPage).mock.calls.map((call) => call[0])).toEqual([id, childId]);
    expect(await readLocalPages()).toEqual([]);
    expect((await readCachedPage(id))?.name).toBe("Parent");
    const creates = request.mock.calls.filter(([url]) => String(url).endsWith("/views/draft"));
    expect(creates.map(([, init]) => JSON.parse(init!.body as string).id)).toEqual([id, childId]);
  });

  it("does not issue creates against an older API that might ignore stable IDs", async () => {
    await createLocalPage({ id, workspaceId: wid });
    vi.stubGlobal("navigator", { onLine: true });
    request.mockImplementation(async () => reply({}, 404));
    await flushLocalPages();
    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0][0])).toContain("offline-capabilities");
    expect(await readLocalPage(id)).not.toBeNull();
  });

  it("retains a failed create after repeated failures and blocks its children", async () => {
    await createLocalPage({ id, workspaceId: wid });
    await createLocalPage({ id: childId, workspaceId: wid, nestParentId: id });
    vi.stubGlobal("navigator", { onLine: true });
    request.mockImplementation(async () => reply({}, 503));
    for (let n = 0; n < 7; n++) await flushLocalPages();
    expect((await readLocalPages()).length).toBe(2);
    expect(syncLocalPage).not.toHaveBeenCalled();
  });

  it("retains an uncertain content upload without retrying it or recreating the page", async () => {
    await createLocalPage({ id, workspaceId: wid });
    vi.stubGlobal("navigator", { onLine: true });
    server();
    vi.mocked(syncLocalPage).mockRejectedValueOnce(new Error("connection lost"));
    await flushLocalPages();
    expect((await readLocalPage(id))?.registered).toBe(true);
    await flushLocalPages();
    expect((await readLocalPage(id))?.effects.upload).toBe("uncertain");
    expect(syncLocalPage).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.filter(([url]) => String(url).endsWith("/views/draft"))).toHaveLength(1);
  });

  it("does not lose a page created while another page is uploading", async () => {
    await createLocalPage({ id, workspaceId: wid });
    vi.stubGlobal("navigator", { onLine: true });
    server();
    vi.mocked(syncLocalPage).mockImplementationOnce(async () => {
      await createLocalPage({ id: childId, workspaceId: wid });
    });
    await flushLocalPages();
    expect((await readLocalPages()).map((p) => p.view.id)).toEqual([childId]);
  });

  it("retains the UUID if an online create loses its response", async () => {
    setOnline(true); vi.stubGlobal("navigator", { onLine: true });
    request.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const page = await createDraft({ workspaceId: wid });
    expect(JSON.parse(request.mock.calls[0][1]!.body as string).id).toBe(page.id);
    expect((await readLocalPage(page.id))?.view.id).toBe(page.id);
    expect((await readLocalPage(page.id))?.effects.registration).toBe("uncertain");
    await flushLocalPages();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("never treats an authoritative create denial as offline success", async () => {
    setOnline(true); vi.stubGlobal("navigator", { onLine: true });
    request.mockResolvedValue(reply({}, 403));
    await expect(createDraft({ workspaceId: wid })).rejects.toThrow("HTTP 403");
    expect(await readLocalPages()).toEqual([]);
  });

  it("keeps ordinary authorized online creation on the canonical route with the original bearer", async () => {
    setOnline(true); vi.stubGlobal("navigator", { onLine: true });
    server();
    const page = await createDraft({ workspaceId: wid, name: "Fictional online page" });
    expect(page).toMatchObject({ name: "Fictional online page", workspaceId: wid, createdBy: "viewer-a" });
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0];
    expect(String(url)).toBe(`http://api.example/api/workspaces/${wid}/views/draft`);
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${token("viewer-a")}`);
    expect(await readLocalPages()).toEqual([]);
  });

  it("does not adopt unbound historical page queues", async () => {
    state.data.set("offline:pages:viewer-a", [{ input: { id, workspaceId: wid }, view: { id, workspaceId: wid }, registered: false }]);
    expect(await readLocalPages()).toEqual([]);
    vi.stubGlobal("navigator", { onLine: true });
    await flushLocalPages();
    expect(request).not.toHaveBeenCalled();
    expect(state.data.has("offline:pages:viewer-a")).toBe(true);
  });

  it.each(["viewer", "workspace", "deployment"])("isolates queued bytes and effects after a %s change", async kind => {
    await createLocalPage({ id, workspaceId: wid });
    if (kind === "viewer") state.userId = "viewer-b";
    if (kind === "workspace") window.location.pathname = "/w/another-workspace/p/page";
    if (kind === "deployment") state.apiOrigin = "http://other.example";
    vi.stubGlobal("navigator", { onLine: true });
    expect(await readLocalPages()).toEqual([]);
    expect(await readCachedPage(id)).toBeNull();
    await flushLocalPages();
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses a refreshed token for another subject before sending any request", async () => {
    await createLocalPage({ id, workspaceId: wid });
    vi.stubGlobal("navigator", { onLine: true }); state.token = token("viewer-b");
    await flushLocalPages();
    expect(request).not.toHaveBeenCalled();
    expect((await readLocalPage(id))?.effects.registration).toBe("pending");
  });

  it("withholds an asynchronous storage read when the account changes before it resolves", async () => {
    await createLocalPage({ id, workspaceId: wid });
    vi.mocked(idbGet).mockImplementationOnce(async key => {
      const value = structuredClone(state.data.get(key) ?? null);
      state.userId = "viewer-b";
      return value;
    });
    expect(await readLocalPages()).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it("does not send a stage effect when its durable claim fails", async () => {
    await createLocalPage({ id, workspaceId: wid });
    vi.stubGlobal("navigator", { onLine: true }); server(); state.failStorage = true;
    await flushLocalPages();
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toEqual([]);
    expect(syncLocalPage).not.toHaveBeenCalled();
  });

  it("preserves the original uncertain intent when the account changes after registration dispatch", async () => {
    await createLocalPage({ id, workspaceId: wid });
    vi.stubGlobal("navigator", { onLine: true }); server();
    const ordinary = request.getMockImplementation()!;
    request.mockImplementation(async (url, init) => {
      const response = await ordinary(url, init);
      if (String(url).endsWith("views/draft")) state.userId = "viewer-b";
      return response;
    });
    await flushLocalPages();
    expect(await readLocalPages()).toEqual([]);
    expect(syncLocalPage).not.toHaveBeenCalled();
    state.userId = "viewer-a";
    expect((await readLocalPage(id))?.effects.registration).toBe("uncertain");
    await flushLocalPages();
    expect(request.mock.calls.filter(([url]) => String(url).endsWith("views/draft"))).toHaveLength(1);
  });

  it("reauthorizes a registered page before reading/uploading local content", async () => {
    await createLocalPage({ id, workspaceId: wid });
    vi.stubGlobal("navigator", { onLine: true }); server();
    const ordinary = request.getMockImplementation()!;
    request.mockImplementation(async (url, init) => {
      if (/\/api\/views\//.test(String(url)) && !init?.method) return reply({}, 403);
      return ordinary(url, init);
    });
    await flushLocalPages();
    expect((await readLocalPage(id))?.registered).toBe(true);
    expect((await readLocalPage(id))?.effects.upload).toBe("pending");
    expect(syncLocalPage).not.toHaveBeenCalled();
    expect(request.mock.calls.filter(([url]) => String(url).endsWith("commit-created"))).toHaveLength(0);
  });

  it("keeps a lost created-event response uncertain across reconnects", async () => {
    await createLocalPage({ id, workspaceId: wid });
    vi.stubGlobal("navigator", { onLine: true }); server();
    const ordinary = request.getMockImplementation()!;
    request.mockImplementation(async (url, init) => {
      if (String(url).endsWith("commit-created")) throw new TypeError("Fictional lost acknowledgement");
      return ordinary(url, init);
    });
    await flushLocalPages(); await flushLocalPages();
    expect((await readLocalPage(id))?.effects.createdEvent).toBe("uncertain");
    expect(request.mock.calls.filter(([url]) => String(url).endsWith("commit-created"))).toHaveLength(1);
    expect(syncLocalPage).toHaveBeenCalledTimes(1);
  });

  it("does not retry a lost registration acknowledgement after module reload", async () => {
    await createLocalPage({ id, workspaceId: wid });
    vi.stubGlobal("navigator", { onLine: true }); server();
    const ordinary = request.getMockImplementation()!;
    request.mockImplementation(async (url, init) => {
      if (String(url).endsWith("views/draft")) throw new TypeError("Fictional lost registration");
      return ordinary(url, init);
    });
    await flushLocalPages();
    vi.resetModules();
    const reloaded = await import("../offline-pages");
    await reloaded.flushLocalPages();
    expect((await reloaded.readLocalPage(id))?.effects.registration).toBe("uncertain");
    expect(request.mock.calls.filter(([url]) => String(url).endsWith("views/draft"))).toHaveLength(1);
  });

  it("lets only one tab claim registration and preserves concurrently authored work", async () => {
    await createLocalPage({ id, workspaceId: wid });
    vi.stubGlobal("navigator", { onLine: true }); server();
    const ordinary = request.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    request.mockImplementation(async (url, init) => {
      if (String(url).endsWith("views/draft")) await gate;
      return ordinary(url, init);
    });
    const first = flushLocalPages();
    await vi.waitFor(() => expect(request.mock.calls.some(([url]) => String(url).endsWith("views/draft"))).toBe(true));
    await createLocalPage({ id: childId, workspaceId: wid });
    vi.resetModules();
    const other = await import("../offline-pages");
    await other.flushLocalPages();
    release(); await first;
    expect(request.mock.calls.filter(([url]) => String(url).endsWith("views/draft"))).toHaveLength(1);
    expect((await readLocalPages()).map(page => page.view.id)).toEqual([childId]);
  });

  it("caches fetched metadata for offline reopening but evicts it on denial", async () => {
    const page = await createLocalPage({ id, workspaceId: wid });
    state.data.clear(); vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(authFetch).mockResolvedValueOnce(reply(page));
    expect(await getView(id)).toEqual(page);
    vi.stubGlobal("navigator", { onLine: false });
    expect(await getView(id)).toEqual(page);
    vi.stubGlobal("navigator", { onLine: true });
    vi.mocked(authFetch).mockResolvedValueOnce(reply({}, 403));
    await expect(getView(id)).rejects.toThrow("HTTP 403");
    expect(await readCachedPage(id)).toBeNull();
  });
});
