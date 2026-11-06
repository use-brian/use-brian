import { describe, it, expect, vi } from "vitest";
const fixture = vi.hoisted(() => ({ data: new Map(), viewer: "a", readFailed: false }));
vi.mock("@/lib/offline/idb", () => ({ idbReadRequired: async (key: string) => { if (fixture.readFailed) throw new Error("Storage unavailable"); return fixture.data.get(key); }, idbUpdate: async (key: string, update: Function) => { const next = update(fixture.data.get(key)); fixture.data.set(key, next); return next; } }));
vi.mock("@/lib/offline/application-write-authority", () => ({ currentOfflineWriteAuthority: (workspaceId: string) => ({ apiOrigin: "https://api.example", viewerId: fixture.viewer, workspaceId }), sameOfflineWriteAuthority: (a: any,b: any) => JSON.stringify(a) === JSON.stringify(b), pinOfflineWriteSession: vi.fn() }));
import { captureUploadJournal } from "../upload-journal";
describe("[COMP:recordings/upload-journal] interrupted transfer", () => {
  it("restores uncertain completion after restart and prevents a late account write", async () => {
    const journal = await captureUploadJournal("w", "capture");
    await journal.save({ plan: { uploadId: "upload", fileId: "file", chunkSizeBytes: 1, parts: [], expiresAt: "future" }, completing: true });
    vi.resetModules(); const { captureUploadJournal: reopen } = await import("../upload-journal");
    expect((await reopen("w", "capture")).state).toMatchObject({ completing: true, plan: { uploadId: "upload" } });
    fixture.viewer = "b"; await expect(journal.save({ recordingId: "wrong" })).rejects.toThrow();
    expect((await reopen("w", "capture")).state).toEqual({});
  });
  it("refuses to start a replacement transfer when its durable checkpoint cannot be read", async () => {
    fixture.readFailed = true;
    await expect(captureUploadJournal("w", "capture")).rejects.toThrow("Storage unavailable");
    fixture.readFailed = false;
  });

});
