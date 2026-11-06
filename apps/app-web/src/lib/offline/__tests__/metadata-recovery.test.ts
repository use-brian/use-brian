import { beforeEach, describe, it, expect, vi } from "vitest";
const fixture = vi.hoisted(() => ({ data: new Map<string, unknown>(), user: "actor" }));
vi.mock("../idb", () => ({ idbGet: async (key: string) => structuredClone(fixture.data.get(key) ?? null), idbUpdate: async (key: string, fn: Function) => { const value = fn(structuredClone(fixture.data.get(key) ?? null)); fixture.data.set(key, structuredClone(value)); return value; } }));
vi.mock("@/lib/user", () => ({ getUserInfo: () => ({ id: fixture.user }) }));
vi.mock("@/lib/runtime-public-config", () => ({ publicRuntimeConfig: () => ({ apiUrl: "https://api.example" }) }));
vi.mock("@/lib/auth-fetch", () => ({ getValidAccessToken: async () => `h.${btoa(JSON.stringify({ sub: fixture.user }))}.s` }));
vi.mock("../offline-pages", () => ({ readLocalPage: async () => null, readCachedPage: async () => ({ name: "Original" }), patchLocalPage: async () => {} }));
import { offlineWrite, flushWriteQueue, readPendingWrites, setOnline } from "../offline-writes";
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => { fixture.data.clear(); fixture.user = "actor"; setOnline(false); vi.stubGlobal("window", { location: { pathname: "/w/00000000-0000-4000-8000-000000000001/p/page" } }); });
describe("[COMP:app-web/metadata-conflicts] conditional recovery", () => {
  it.each([true, false])("reconciles a lost response after commit=%s without duplicate effects", async committed => {
    let name = "Original", patches = 0, drop = true;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      if (init?.method === "PATCH") {
        patches++;
        const condition = JSON.parse(decodeURIComponent(new Headers(init.headers).get("X-Brian-Metadata-Base")!));
        expect(condition).toEqual({ field: "name", value: "Original" });
        if (!drop || committed) name = JSON.parse(init.body).name;
        if (drop) { drop = false; throw new Error("lost response"); }
      }
      return response({ id: "page", workspaceId: "00000000-0000-4000-8000-000000000001", name, offlineMetadataCas: true });
    }));
    await offlineWrite({ kind: "view.rename", payload: { id: "page", name: "Local" }, coalesceKey: "rename:page" });
    await flushWriteQueue(); expect((await readPendingWrites())[0].effect).toBe("uncertain");
    vi.resetModules(); const restarted = await import("../offline-writes");
    await restarted.flushWriteQueue(); expect(await restarted.readPendingWrites()).toEqual([]);
    expect(name).toBe("Local"); expect(patches).toBe(committed ? 1 : 2);
  });
  it("retains a conflicting local title and continues an unrelated page", async () => {
    const writes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      const id = String(url).split("/").at(-1)!;
      if (init?.method === "PATCH") writes.push(id);
      return response({ id, workspaceId: "00000000-0000-4000-8000-000000000001", name: id === "page" ? "Remote edit" : "Original", offlineMetadataCas: true });
    }));
    for (const id of ["page", "another"]) await offlineWrite({ kind: "view.rename", payload: { id, name: "Local" }, coalesceKey: id });
    await flushWriteQueue(); expect(writes).toEqual(["another"]);
    expect(await readPendingWrites()).toMatchObject([{ conflict: true, payload: { name: "Local" } }]);
  });
});
