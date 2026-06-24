/**
 * [COMP:web/recording-upload] Recordings SDK (app-web) — the 3-step upload flow.
 * Spec: docs/plans/recording-to-brain.md.
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
  it("startRecordingUpload mints a URL then PUTs the bytes direct to GCS", async () => {
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

  it("startRecordingUpload throws a RecordingApiError when the GCS PUT fails", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({ recordingId: "rec-1", uploadUrl: "https://gcs.example/put" }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 403 })));
    const file = new File([new Uint8Array([1])], "call.m4a", { type: "audio/mp4" });
    await expect(startRecordingUpload({ workspaceId: "ws-1", assistantId: "a-1", file })).rejects.toBeInstanceOf(RecordingApiError);
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

  it("processRecording returns the pipeline result", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({
      utteranceCount: 40, segmentsInserted: 12, truncated: false,
      salesCall: { isSalesCall: true, score: 0.8 }, surchargeCredits: 11, surcharged: true,
    }));
    const res = await processRecording("rec-1");
    expect(res.surcharged).toBe(true);
    expect(res.salesCall.isSalesCall).toBe(true);
  });
});
