/**
 * [COMP:web/recording-upload] Recordings SDK (app-web) — the 3-step upload flow.
 * Spec: docs/architecture/media/transcription.md.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import { authFetch } from "@/lib/auth-fetch";
import {
  startRecordingUpload,
  estimateRecording,
  processRecording,
  RecordingApiError,
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
  it("startRecordingUpload mints a URL then PUTs the bytes direct to storage", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({ recordingId: "rec-1", uploadUrl: "https://gcs.example/put" }));
    const putFetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", putFetch);

    const file = new File([new Uint8Array([1, 2, 3])], "call.m4a", { type: "audio/mp4" });
    const out = await startRecordingUpload({ workspaceId: "ws-1", assistantId: "a-1", file });

    expect(out.recordingId).toBe("rec-1");
    // The mint call carries the file metadata.
    const mintBody = JSON.parse((mockAuthFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(mintBody).toMatchObject({ workspaceId: "ws-1", assistantId: "a-1", fileName: "call.m4a", mime: "audio/mp4" });
    // The bytes go to the signed URL via plain fetch (PUT), not authFetch.
    expect(putFetch).toHaveBeenCalledWith("https://gcs.example/put", expect.objectContaining({ method: "PUT" }));
  });

  it("startRecordingUpload throws a RecordingApiError when the storage PUT fails", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({ recordingId: "rec-1", uploadUrl: "https://gcs.example/put" }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 403 })));
    const file = new File([new Uint8Array([1])], "call.m4a", { type: "audio/mp4" });
    await expect(startRecordingUpload({ workspaceId: "ws-1", assistantId: "a-1", file })).rejects.toBeInstanceOf(RecordingApiError);
  });

  it("reports signed PUT progress through browser upload events", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({ recordingId: "rec-1", uploadUrl: "https://gcs.example/put" }));
    const progress = vi.fn();

    class FakeXMLHttpRequest {
      static instance: FakeXMLHttpRequest | null = null;
      upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      status = 200;
      method = "";
      url = "";
      headers = new Map<string, string>();
      body: Document | XMLHttpRequestBodyInit | null = null;

      constructor() {
        FakeXMLHttpRequest.instance = this;
      }

      open(method: string, url: string) {
        this.method = method;
        this.url = url;
      }

      setRequestHeader(name: string, value: string) {
        this.headers.set(name, value);
      }

      send(body: Document | XMLHttpRequestBodyInit | null) {
        this.body = body;
        this.upload.onprogress?.({
          lengthComputable: true,
          loaded: 4,
          total: 10,
        } as ProgressEvent);
        this.onload?.();
      }
    }

    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
    const file = new File([new Uint8Array(10)], "call.m4a", { type: "audio/mp4" });
    await expect(startRecordingUpload({
      workspaceId: "ws-1",
      assistantId: "a-1",
      file,
      onProgress: progress,
    })).resolves.toEqual({ recordingId: "rec-1" });

    expect(progress).toHaveBeenNthCalledWith(1, 0.4);
    expect(progress).toHaveBeenLastCalledWith(1);
    expect(FakeXMLHttpRequest.instance?.method).toBe("PUT");
    expect(FakeXMLHttpRequest.instance?.url).toBe("https://gcs.example/put");
    expect(FakeXMLHttpRequest.instance?.headers.get("Content-Type")).toBe("audio/mp4");
    expect(FakeXMLHttpRequest.instance?.body).toBe(file);
  });

  it("splits local self-host recording uploads into bounded sequential ranges", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({
      recordingId: "rec-local",
      uploadUrl: "https://api.selfhost.example/api/local-files?action=write&signature=signed",
    }));
    const requests: Array<{
      headers: Map<string, string>;
      body: Blob;
    }> = [];

    class FakeXMLHttpRequest {
      upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      status = 204;
      headers = new Map<string, string>();

      open() {}
      setRequestHeader(name: string, value: string) {
        this.headers.set(name, value);
      }
      send(body: Document | XMLHttpRequestBodyInit | null) {
        const blob = body as Blob;
        requests.push({ headers: new Map(this.headers), body: blob });
        this.upload.onprogress?.({
          lengthComputable: true,
          loaded: blob.size,
          total: blob.size,
        } as ProgressEvent);
        this.onload?.();
      }
    }

    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
    const firstPartBytes = 8 * 1024 * 1024;
    const file = new File(
      [new Uint8Array(firstPartBytes), new Uint8Array([1, 2, 3])],
      "meeting.m4a",
      { type: "audio/x-m4a" },
    );
    const progress = vi.fn();
    await expect(startRecordingUpload({
      workspaceId: "ws-1",
      assistantId: "a-1",
      file,
      onProgress: progress,
    })).resolves.toEqual({ recordingId: "rec-local" });

    expect(requests).toHaveLength(2);
    expect(requests[0].headers.get("Content-Range")).toBe(
      `bytes 0-${firstPartBytes - 1}/${file.size}`,
    );
    expect(requests[0].body.size).toBe(firstPartBytes);
    expect(requests[1].headers.get("Content-Range")).toBe(
      `bytes ${firstPartBytes}-${file.size - 1}/${file.size}`,
    );
    expect(requests[1].body.size).toBe(3);
    expect(progress).toHaveBeenLastCalledWith(1);
  });

  it("uses a retryable range for a small local self-host recording", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({
      recordingId: "rec-local-small",
      uploadUrl: "https://api.selfhost.example/api/local-files?action=write&signature=signed",
    }));
    const contentRanges: string[] = [];

    class FakeXMLHttpRequest {
      upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      status = 204;
      headers = new Map<string, string>();

      open() {}
      setRequestHeader(name: string, value: string) {
        this.headers.set(name, value);
      }
      send() {
        contentRanges.push(this.headers.get("Content-Range") ?? "");
        this.onload?.();
      }
    }

    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
    const file = new File([new Uint8Array([1, 2, 3])], "memo.m4a", { type: "audio/x-m4a" });
    await expect(startRecordingUpload({
      workspaceId: "ws-1",
      assistantId: "a-1",
      file,
      onProgress: vi.fn(),
    })).resolves.toEqual({ recordingId: "rec-local-small" });

    expect(contentRanges).toEqual(["bytes 0-2/3"]);
  });

  it("retries a local range after a transient network failure", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({
      recordingId: "rec-local-retry",
      uploadUrl: "https://api.selfhost.example/api/local-files?action=write&signature=signed",
    }));
    let requestCount = 0;

    class FakeXMLHttpRequest {
      upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      status = 204;

      open() {}
      setRequestHeader() {}
      send() {
        requestCount += 1;
        if (requestCount === 1) this.onerror?.();
        else this.onload?.();
      }
    }

    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
    const file = new File(
      [new Uint8Array(8 * 1024 * 1024), new Uint8Array([1])],
      "meeting.m4a",
      { type: "audio/x-m4a" },
    );

    await expect(startRecordingUpload({
      workspaceId: "ws-1",
      assistantId: "a-1",
      file,
      onProgress: vi.fn(),
    })).resolves.toEqual({ recordingId: "rec-local-retry" });
    expect(requestCount).toBe(3);
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
