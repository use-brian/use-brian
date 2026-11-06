import { beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ data: new Map(), viewer: "a" }));
vi.mock("@/lib/offline/idb", () => ({ idbGet: async (key: string) => fixture.data.get(key), idbUpdate: async (key: string, update: Function) => { const next = update(fixture.data.get(key)); fixture.data.set(key, next); return next; } }));
vi.mock("@/lib/offline/application-write-authority", () => ({ currentOfflineWriteAuthority: () => ({ viewerId: fixture.viewer }), sameOfflineWriteAuthority: (a: any,b: any) => !!a && a.viewerId === b?.viewerId }));
import { mediaOwner, saveOfflineMedia, readOfflineMedia, removeOfflineMedia, downloadOfflineMedia, MEDIA_RETENTION_MS } from "../offline-media";
beforeEach(() => { fixture.data.clear(); fixture.viewer = "a"; });
describe("[COMP:recordings/offline-media] complete local playback copies", () => {
  it("restores bytes after module restart and refuses another account", async () => {
    const owner = mediaOwner()!; await saveOfflineMedia(owner, "r", new Blob(["audio"]));
    vi.resetModules(); const reloaded = await import("../offline-media");
    expect(await (await reloaded.readOfflineMedia(owner, "r"))?.text()).toBe("audio");
    fixture.viewer = "b"; expect(await reloaded.readOfflineMedia(owner, "r")).toBeNull();
  });
  it("evicts denials and enforces retention", async () => {
    const owner = mediaOwner()!; await saveOfflineMedia(owner, "r", new Blob(["audio"]));
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + MEDIA_RETENTION_MS + 1);
    expect(await readOfflineMedia(owner, "r")).toBeNull(); now.mockRestore();
    await removeOfflineMedia(owner, "r"); expect(await readOfflineMedia(owner, "r")).toBeNull();
  });
  it("never caches a partial, aborted or oversized download", async () => {
    const owner = mediaOwner()!;
    const request = vi.spyOn(globalThis, "fetch");
    request.mockResolvedValue(new Response("audio", { headers: { "content-length": String(129 * 1024 * 1024) } }));
    await downloadOfflineMedia(owner, "oversized", "https://storage.example/media", new AbortController().signal);
    expect(await readOfflineMedia(owner, "oversized")).toBeNull();
    request.mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.error(new Error("disconnected")); } })));
    await expect(downloadOfflineMedia(owner, "partial", "https://storage.example/media", new AbortController().signal)).rejects.toThrow("disconnected");
    expect(await readOfflineMedia(owner, "partial")).toBeNull();
    const abort = new AbortController(); abort.abort();
    request.mockResolvedValue(new Response("audio"));
    await downloadOfflineMedia(owner, "aborted", "https://storage.example/media", abort.signal);
    expect(await readOfflineMedia(owner, "aborted")).toBeNull(); request.mockRestore();
  });

});
