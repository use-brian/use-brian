/**
 * [COMP:web/recording-upload] Recordings SDK (app-web) — the 3-step upload flow.
 * Spec: docs/architecture/media/transcription.md.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import { authFetch } from "@/lib/auth-fetch";
import {
  startRecordingUpload,
  streamLiveRecordingWindow,
  type LiveRecordingPage,
  estimateRecording,
  processRecording,
  RecordingApiError,
  recordingMimeForFile,
} from "../recordings";

const mockAuthFetch = vi.mocked(authFetch);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("[COMP:web/recording-upload] recordings SDK", () => {
  it("infers recording MIME from common extensions when a file drag omits the type", () => {
    expect(recordingMimeForFile({ name: "voice-note.m4a", type: "" })).toBe("audio/mp4");
    expect(recordingMimeForFile({ name: "screen-share.MOV", type: "" })).toBe("video/quicktime");
    expect(recordingMimeForFile({ name: "brief.pdf", type: "" })).toBeNull();
  });

  const file = new File([new Uint8Array([1, 2, 3, 4, 5])], "call.m4a", { type: "audio/mp4" });
  const params = { workspaceId: "ws-1", assistantId: "a-1", file, kind: "meeting" as const };
  function plan(base = "https://storage.example/part", uploadHeaders?: Record<string, string>) {
    return { uploadId: "up-1", fileId: "file-1", chunkSizeBytes: 3, expiresAt: "later",
      parts: [{ index: 0, offset: 0, sizeBytes: 3, url: `${base}0` },
        { index: 1, offset: 3, sizeBytes: 2, url: `${base}1` }], uploadHeaders };
  }
  function mint(base?: string, headers?: Record<string, string>) {
    mockAuthFetch.mockResolvedValueOnce(json(plan(base, headers)))
      .mockResolvedValueOnce(json({ recordingId: "canonical-rec" }));
  }

  it("PUTs each exact slice and only returns the canonical completed recording", async () => {
    mint();
    const put = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", put);
    expect(await startRecordingUpload(params)).toEqual({ recordingId: "canonical-rec" });
    expect(JSON.parse(mockAuthFetch.mock.calls[0][1]!.body as string)).toEqual({
      workspaceId: "ws-1", assistantId: "a-1", fileName: "call.m4a", mime: "audio/mp4", sizeBytes: 5, kind: "meeting",
    });
    expect(put).toHaveBeenCalledTimes(2);
    for (const [i, expected] of [[1, 2, 3], [4, 5]].entries()) {
      const [url, init] = (put.mock.calls as unknown as [string, RequestInit][])[i];
      expect(url).toBe(`https://storage.example/part${i}`);
      expect(Array.from(new Uint8Array(await (init.body as Blob).arrayBuffer()))).toEqual(expected);
      expect(init.headers).toEqual({ "Content-Type": "application/octet-stream" });
    }
    expect(mockAuthFetch.mock.calls[1][0]).toMatch(/recordings\/complete-upload$/);
    expect(JSON.parse(mockAuthFetch.mock.calls[1][1]!.body as string)).toEqual({
      workspaceId: "ws-1", assistantId: "a-1", uploadId: "up-1", kind: "meeting",
    });
    expect(put.mock.invocationCallOrder[1]).toBeLessThan(mockAuthFetch.mock.invocationCallOrder[1]);
  });

  it.each(["recording_intake_provenance_required", "recording_upload_prepare_failed"])("does not PUT or complete after failed admission: %s", async (code) => {
    mockAuthFetch.mockResolvedValueOnce(json({ error: code }, 409));
    const put = vi.fn(); vi.stubGlobal("fetch", put);
    await expect(startRecordingUpload(params)).rejects.toMatchObject({ code, status: 409 });
    expect(put).not.toHaveBeenCalled();
    expect(mockAuthFetch).toHaveBeenCalledTimes(1);
  });

  it("labels API network errors as preparation failures, not storage errors", async () => {
    mockAuthFetch.mockRejectedValueOnce(new TypeError("offline"));
    await expect(startRecordingUpload(params)).rejects.toMatchObject({ code: "recording_upload_prepare_failed" });
  });

  it("never completes after failed bytes and does not retry a rejected signature", async () => {
    mint(); const put = vi.fn(async () => new Response(null, { status: 403 }));
    vi.stubGlobal("fetch", put);
    await expect(startRecordingUpload(params)).rejects.toMatchObject({ code: "recording_upload_storage_failed", status: 403 });
    expect(put).toHaveBeenCalledTimes(1);
    expect(mockAuthFetch).toHaveBeenCalledTimes(1);
  });

  it("does not resolve while canonical completion is pending", async () => {
    let complete!: (response: Response) => void;
    mockAuthFetch.mockResolvedValueOnce(json(plan())).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    const resolved = vi.fn();
    const upload = startRecordingUpload(params).then(resolved);
    await vi.waitFor(() => expect(mockAuthFetch).toHaveBeenCalledTimes(2));
    expect(resolved).not.toHaveBeenCalled();
    complete(json({ recordingId: "canonical-rec" }));
    await upload;
    expect(resolved).toHaveBeenCalledWith({ recordingId: "canonical-rec" });
  });

  it("classifies unknown server completion errors by API stage", async () => {
    mockAuthFetch.mockResolvedValueOnce(json(plan())).mockResolvedValueOnce(json({ error: "adoption_conflict" }, 409));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    await expect(startRecordingUpload(params)).rejects.toMatchObject({ code: "recording_upload_complete_failed", status: 409 });
  });

  it.each([false, true])("reports failed completion rather than success (network=%s)", async (network) => {
    mockAuthFetch.mockResolvedValueOnce(json(plan()));
    if (network) mockAuthFetch.mockRejectedValueOnce(new TypeError("offline"));
    else mockAuthFetch.mockResolvedValueOnce(json({}, 500));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    await expect(startRecordingUpload(params)).rejects.toMatchObject({ code: "recording_upload_complete_failed" });
  });

  it("rejects malformed plans before PUT", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({ ...plan(), parts: [] }));
    const put = vi.fn(); vi.stubGlobal("fetch", put);
    await expect(startRecordingUpload(params)).rejects.toMatchObject({ code: "recording_upload_prepare_failed" });
    expect(put).not.toHaveBeenCalled();
  });

  it("forwards Azure signed headers for every fetch part", async () => {
    mint(undefined, { "x-ms-blob-type": "BlockBlob" });
    const put = vi.fn(async () => new Response(null, { status: 201 })); vi.stubGlobal("fetch", put);
    await startRecordingUpload(params);
    for (const [, init] of put.mock.calls as unknown as [string, RequestInit][]) {
      expect(init.headers).toMatchObject({ "x-ms-blob-type": "BlockBlob" });
    }
  });

  it("retries transient fetch failures on the same part", async () => {
    mint();
    const put = vi.fn().mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockImplementation(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", put);
    await startRecordingUpload(params);
    expect(put.mock.calls.map(([url]) => url)).toEqual([0, 0, 0, 1].map(i => `https://storage.example/part${i}`));
  });

  it("bounds network retries and never completes exhausted bytes", async () => {
    mint(); const put = vi.fn().mockRejectedValue(new TypeError("network")); vi.stubGlobal("fetch", put);
    await expect(startRecordingUpload(params)).rejects.toMatchObject({ code: "recording_upload_storage_failed" });
    expect(put).toHaveBeenCalledTimes(3);
    expect(mockAuthFetch).toHaveBeenCalledTimes(1);
  });

  it.each(["https://api.selfhost.example/api/local-files?part=", "https://azure.example/part"])("preserves monotonic XHR progress, exact parts, signed headers and retries: %s", async (base) => {
    mint(base, { "x-ms-blob-type": "BlockBlob" });
    const requests: Array<{ url: string; headers: Record<string, string>; body: Blob }> = [];
    class FakeXHR {
      upload: { onprogress?: (event: unknown) => void } = {};
      onload?: () => void; onerror?: () => void; status = 200;
      url = ""; headers: Record<string, string> = {};
      open(_method: string, url: string) { this.url = url; }
      setRequestHeader(name: string, value: string) { this.headers[name] = value; }
      send(body: Blob) {
        requests.push({ url: this.url, headers: this.headers, body });
        this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: body.size });
        if (requests.length === 1) this.onerror?.(); else this.onload?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    const progress = vi.fn();
    await expect(startRecordingUpload({ ...params, onProgress: progress })).resolves.toEqual({ recordingId: "canonical-rec" });
    expect(requests.map(r => r.url)).toEqual([`${base}0`, `${base}0`, `${base}1`]);
    expect(requests.map(r => r.body.size)).toEqual([3, 3, 2]);
    for (const r of requests) {
      expect(r.headers).toEqual({ "Content-Type": "application/octet-stream", "x-ms-blob-type": "BlockBlob" });
    }
    const values = progress.mock.calls.map(([value]) => value);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(values.at(-1)).toBe(1);
  });

  it("estimateRecording returns the duration + surcharge", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({ recordingId: "rec-1", durationMs: 6300000, durationSeconds: 6300, surchargeCredits: 11 }));
    const est = await estimateRecording("rec-1");
    expect(est.surchargeCredits).toBe(11);
    expect(est.durationSeconds).toBe(6300);
  });

  it("estimateRecording surfaces the backend machine code (too_long) on error", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({ error: "too_long", detail: "Recordings over 3 hours aren't supported yet." }, 413));
    const err = await estimateRecording("rec-1").catch((e) => e);
    expect(err).toBeInstanceOf(RecordingApiError);
    expect(err.code).toBe("too_long");
    expect(err.status).toBe(413);
  });

  it("processRecording returns the 202 queued acknowledgement (worker transcribes async)", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({ recordingId: "rec-1", status: "queued", jobId: "job-1" }, 202));
    const res = await processRecording("rec-1");
    expect(res.status).toBe("queued");
    expect(res.jobId).toBe("job-1");
  });
});

it("keeps uploading audio windows before and after the validated interaction marker arrives", async () => {
  mockAuthFetch.mockImplementation(async () => json({ ok: true }));
  const page: LiveRecordingPage = { pageId: "page", sessionId: "session", title: "Meeting", notesHeadingId: "notes", markerBlockId: "marker" };
  const params = { workspaceId: "w", assistantId: "a", page, chunkId: "one", blob: new Blob(["audio"]), mime: "audio/webm", startMs: 0, endMs: 30000 };
  await streamLiveRecordingWindow(params);
  page.interactionCaptureId = "validated-capture";
  await streamLiveRecordingWindow({ ...params, chunkId: "two" });
  delete page.interactionCaptureId;
  await streamLiveRecordingWindow({ ...params, chunkId: "three" });
  const bodies = mockAuthFetch.mock.calls.map(([, init]) => init?.body as FormData);
  expect(bodies.map((body) => body.get("interactionCaptureId"))).toEqual([null, "validated-capture", null]);
  expect(bodies.every((body) => (body.get("audio") as Blob).size === 5)).toBe(true);
});

it("uploads explicit mixed source plus isolated microphone and pause discontinuity alongside original audio", async () => {
  mockAuthFetch.mockClear();
  mockAuthFetch.mockImplementation(async () => json({ ok: true, interactionError: true }));
  const page: LiveRecordingPage = { pageId: "page", sessionId: "session", title: "Meeting", notesHeadingId: "notes", markerBlockId: "marker", interactionCaptureId: "capture" };
  const params = { workspaceId: "w", assistantId: "a", page, chunkId: "dual", blob: new Blob(["mixed context"]), mime: "audio/webm", startMs: 1000, endMs: 31000 };
  const response = await streamLiveRecordingWindow({ ...params, interactionSource: "mixed", microphone: { blob: new Blob(["isolated mic"], { type: "audio/webm" }), mime: "audio/webm" }, discontinuity: true });
  expect(response.interactionError).toBe(true);
  const body = mockAuthFetch.mock.calls[0][1]?.body as FormData;
  expect(body.get("interactionCaptureId")).toBe("capture");
  expect(body.get("interactionSource")).toBe("mixed");
  expect(body.get("discontinuity")).toBe("true");
  expect(body.get("offsetMs")).toBe("1000"); expect(body.get("durationMs")).toBe("30000");
  expect(await (body.get("audio") as Blob).text()).toBe("mixed context");
  expect(await (body.get("microphone") as Blob).text()).toBe("isolated mic");

  await streamLiveRecordingWindow({ ...params, interactionSource: "microphone" });
  const micOnly = mockAuthFetch.mock.calls[1][1]?.body as FormData;
  expect(micOnly.get("interactionSource")).toBe("microphone");
  expect(micOnly.has("microphone")).toBe(false); expect(micOnly.has("discontinuity")).toBe(false);

  // Encoder failure remains explicitly mixed with NO mic file, so the server
  // fails closed for triggers while retaining the normal context transcription.
  await streamLiveRecordingWindow({ ...params, interactionSource: "mixed" });
  const failed = mockAuthFetch.mock.calls[2][1]?.body as FormData;
  expect(failed.get("interactionSource")).toBe("mixed");
  expect(failed.has("microphone")).toBe(false); expect(failed.has("audio")).toBe(true);
});
