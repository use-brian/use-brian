import { describe, it, expect, vi, beforeEach } from "vitest";
const fixture = vi.hoisted(() => ({ state: {} as any, post: vi.fn(), save: vi.fn() }));
vi.mock("../upload-journal", () => ({ captureUploadJournal: async () => ({ state: structuredClone(fixture.state), assertCurrent: () => {},
  session: async () => ({ request: fixture.post }), save: async (next: unknown) => { await fixture.save(next); fixture.state = structuredClone(next); } }) }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn(() => { throw new Error("Unpinned request"); }) }));
import { startRecordingUpload } from "@/lib/api/recordings";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const plan = { uploadId: "upload-one", fileId: "file-one", chunkSizeBytes: 3, expiresAt: "2099-01-01T00:00:00Z", parts: [{ index: 0, offset: 0, sizeBytes: 3, url: "https://storage.example/part" }] };
const input = { workspaceId: "workspace", assistantId: "assistant", recoveryId: "capture", file: new File(["wav"], "capture.wav", { type: "audio/wav" }) };
beforeEach(() => { fixture.state = {}; fixture.save.mockReset().mockResolvedValue(undefined); fixture.post.mockReset(); vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 }))); });
describe("[COMP:recordings/upload-journal] real upload restart protocol", () => {
  it("reuses uncertain completion after restart, without another upload or recording", async () => {
    let complete = 0;
    fixture.post.mockImplementation(async (path: string) => {
      if (path.endsWith("upload-url")) return json(plan);
      if (++complete === 1) throw new TypeError("response lost");
      return json({ recordingId: "recording-one" });
    });
    await expect(startRecordingUpload(input)).rejects.toThrow();
    expect(fixture.state).toMatchObject({ completing: true, plan: { uploadId: "upload-one" } });
    vi.resetModules(); const restarted = await import("@/lib/api/recordings");
    expect(await restarted.startRecordingUpload(input)).toEqual({ recordingId: "recording-one" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fixture.post.mock.calls.filter(([path]) => path.endsWith("upload-url"))).toHaveLength(1);
    expect(await restarted.startRecordingUpload(input)).toEqual({ recordingId: "recording-one" });
    expect(complete).toBe(2);
  });
  it("sends no bytes if the checkpoint cannot commit", async () => {
    fixture.post.mockResolvedValue(json(plan)); fixture.save.mockRejectedValue(new Error("quota"));
    await expect(startRecordingUpload(input)).rejects.toThrow("quota"); expect(fetch).not.toHaveBeenCalled();
  });
  it("renews only a definitively expired incomplete transfer", async () => {
    fixture.state = { plan, completing: true }; fixture.post.mockResolvedValue(json({ error: "expired" }, 410));
    await expect(startRecordingUpload(input)).rejects.toMatchObject({ status: 410 }); expect(fixture.state).toEqual({});
    fixture.state = { plan, completing: true }; fixture.post.mockResolvedValue(json({ error: "unavailable" }, 503));
    await expect(startRecordingUpload(input)).rejects.toThrow(); expect(fixture.state.completing).toBe(true);
  });
});
