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
  RecordingResolveError,
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

  /** authFetch routed by URL: start → complete → file recording. */
  function routeAuthFetch(overrides: { start?: Response[]; complete?: Response | Response[]; recording?: Response } = {}) {
    const starts = overrides.start ?? [json({
      uploadId: "up-1",
      fileId: "file-1",
      parts: [{ index: 0, offset: 0, sizeBytes: 3, url: "https://gcs.example/part-0" }],
    }, 201)];
    mockAuthFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/files/uploads/start")) return starts.shift() ?? json({ error: "unexpected" }, 500);
      if (url.endsWith("/complete")) {
        const c = overrides.complete;
        return (Array.isArray(c) ? c.shift() : c) ?? json({ ok: true, fileId: "file-1" });
      }
      if (url.endsWith("/api/files/file-1/recording")) {
        return overrides.recording ?? json({ recordingId: "rec-1", adopted: true, alreadyProcessed: false });
      }
      if (url.includes("/api/files/uploads/")) return new Response(null, { status: 204 });
      return json({ error: "unexpected" }, 500);
    });
  }
  const bodyOf = (url: string) => {
    const call = mockAuthFetch.mock.calls.find(([input]) => String(input).endsWith(url));
    return call ? JSON.parse((call[1] as RequestInit).body as string) : undefined;
  };

  it("startRecordingUpload publishes the capture as a file, then resolves its recording", async () => {
    routeAuthFetch();
    const putFetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", putFetch);

    const file = new File([new Uint8Array([1, 2, 3])], "call.m4a", { type: "audio/mp4" });
    const out = await startRecordingUpload({ workspaceId: "ws-1", assistantId: "a-1", file, kind: "meeting" });

    expect(out.recordingId).toBe("rec-1");
    expect(bodyOf("/api/files/uploads/start")).toEqual({
      workspaceId: "ws-1", fileName: "call.m4a", mime: "audio/mp4", sizeBytes: 3,
    });
    // The bytes go to the signed part URL via plain fetch (PUT), not authFetch.
    expect(putFetch).toHaveBeenCalledWith("https://gcs.example/part-0", expect.objectContaining({ method: "PUT" }));
    // The recording is resolved from the published file, carrying the kind.
    expect(bodyOf("/api/files/file-1/recording")).toEqual({ workspaceId: "ws-1", kind: "meeting" });
    const urls = mockAuthFetch.mock.calls.map(([input]) => String(input));
    expect(urls.findIndex((u) => u.endsWith("/complete")))
      .toBeLessThan(urls.findIndex((u) => u.endsWith("/file-1/recording")));
    // The retired mint is never called.
    expect(urls.some((u) => u.includes("/api/recordings/upload-url"))).toBe(false);
  });

  it("takes the next numbered name when the file name is already stored", async () => {
    routeAuthFetch({
      start: [
        json({ error: "conflict", detail: "A file with that name already exists" }, 409),
        json({ uploadId: "up-1", fileId: "file-1", parts: [{ index: 0, offset: 0, sizeBytes: 1, url: "https://gcs.example/p" }] }, 201),
      ],
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    const file = new File([new Uint8Array([1])], "Recording 2026-10-03 10.51.webm", { type: "audio/webm" });
    await startRecordingUpload({ workspaceId: "ws-1", assistantId: "a-1", file });
    const names = mockAuthFetch.mock.calls
      .filter(([input]) => String(input).endsWith("/api/files/uploads/start"))
      .map(([, init]) => JSON.parse((init as RequestInit).body as string).fileName);
    expect(names).toEqual(["Recording 2026-10-03 10.51.webm", "Recording 2026-10-03 10.51 (2).webm"]);
  });

  it("throws a RecordingApiError and aborts the upload when a part PUT is refused", async () => {
    routeAuthFetch();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 403 })));
    const file = new File([new Uint8Array([1, 2, 3])], "call.m4a", { type: "audio/mp4" });
    await expect(startRecordingUpload({ workspaceId: "ws-1", assistantId: "a-1", file }))
      .rejects.toBeInstanceOf(RecordingApiError);
    const methods = mockAuthFetch.mock.calls.map(([input, init]) => `${(init as RequestInit).method} ${String(input)}`);
    expect(methods.some((m) => m.startsWith("DELETE ") && m.endsWith("/api/files/uploads/up-1"))).toBe(true);
    expect(methods.some((m) => m.includes("/recording"))).toBe(false);
  });

  it("surfaces the server's refusal when the recording cannot be resolved, naming the stored file", async () => {
    routeAuthFetch({ recording: json({ error: "compartmented_media", detail: "restricted" }, 409) });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    const file = new File([new Uint8Array([1, 2, 3])], "call.m4a", { type: "audio/mp4" });
    const err = await startRecordingUpload({ workspaceId: "ws-1", assistantId: "a-1", file }).catch((e) => e);
    // The bytes are stored, so this is not an upload failure.
    expect(err).toBeInstanceOf(RecordingResolveError);
    expect(err).toMatchObject({ status: 409, code: "compartmented_media", fileId: "file-1" });
  });

  it("asks /complete again after a gateway timeout instead of deleting parts mid-assembly", async () => {
    vi.useFakeTimers();
    try {
      routeAuthFetch({ complete: [new Response("", { status: 524 }), json({ ok: true, fileId: "file-1" })] });
      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
      const file = new File([new Uint8Array([1, 2, 3])], "call.m4a", { type: "audio/mp4" });
      const pending = startRecordingUpload({ workspaceId: "ws-1", assistantId: "a-1", file });
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toEqual({ recordingId: "rec-1" });
      const calls = mockAuthFetch.mock.calls.map(([input, init]) => `${(init as RequestInit).method} ${String(input)}`);
      expect(calls.filter((c) => c.endsWith("/complete"))).toHaveLength(2);
      expect(calls.some((c) => c.startsWith("DELETE "))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the staged parts when /complete keeps timing out (the assembly may still land)", async () => {
    vi.useFakeTimers();
    try {
      routeAuthFetch({ complete: [new Response("", { status: 504 }), new Response("", { status: 504 }), new Response("", { status: 504 })] });
      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
      const file = new File([new Uint8Array([1, 2, 3])], "call.m4a", { type: "audio/mp4" });
      const pending = startRecordingUpload({ workspaceId: "ws-1", assistantId: "a-1", file }).catch((e) => e);
      await vi.runAllTimersAsync();
      expect(await pending).toBeInstanceOf(RecordingApiError);
      const calls = mockAuthFetch.mock.calls.map(([, init]) => (init as RequestInit).method);
      expect(calls).not.toContain("DELETE");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports part PUT progress through browser upload events across bounded parts", async () => {
    const partBytes = 8 * 1024 * 1024;
    routeAuthFetch({
      start: [json({
        uploadId: "up-1",
        fileId: "file-1",
        parts: [
          { index: 0, offset: 0, sizeBytes: partBytes, url: "https://gcs.example/part-0" },
          { index: 1, offset: partBytes, sizeBytes: 3, url: "https://gcs.example/part-1" },
        ],
      }, 201)],
    });
    const requests: Array<{ url: string; type: string | undefined; size: number }> = [];
    let failOnce = true;

    class FakeXMLHttpRequest {
      upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      status = 200;
      url = "";
      headers = new Map<string, string>();
      open(_method: string, url: string) { this.url = url; }
      setRequestHeader(name: string, value: string) { this.headers.set(name, value); }
      send(body: Document | XMLHttpRequestBodyInit | null) {
        const blob = body as Blob;
        // One transient network failure on the second part is retried.
        if (this.url.endsWith("part-1") && failOnce) { failOnce = false; this.onerror?.(); return; }
        requests.push({ url: this.url, type: this.headers.get("Content-Type"), size: blob.size });
        this.upload.onprogress?.({ lengthComputable: true, loaded: blob.size, total: blob.size } as ProgressEvent);
        this.onload?.();
      }
    }

    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
    const file = new File([new Uint8Array(partBytes), new Uint8Array([1, 2, 3])], "meeting.m4a", { type: "audio/x-m4a" });
    const progress = vi.fn();
    await expect(startRecordingUpload({ workspaceId: "ws-1", assistantId: "a-1", file, onProgress: progress }))
      .resolves.toEqual({ recordingId: "rec-1" });

    expect(requests).toEqual([
      { url: "https://gcs.example/part-0", type: "application/octet-stream", size: partBytes },
      { url: "https://gcs.example/part-1", type: "application/octet-stream", size: 3 },
    ]);
    expect(progress).toHaveBeenCalledWith(partBytes / file.size);
    expect(progress).toHaveBeenLastCalledWith(1);
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
