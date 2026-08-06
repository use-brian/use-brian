import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import { authFetch } from "@/lib/auth-fetch";
import {
  MAX_INGEST_FILE_BYTES,
  getIngestJobStatus,
  ingestFiles,
  ingestLinkedInArchive,
  storeFiles,
} from "../ingest";
import { statusForIngestResult } from "@/components/doc/suggested-file-drop";

const mockAuthFetch = vi.mocked(authFetch);

beforeEach(() => vi.resetAllMocks());

describe("[COMP:app-web/chat-context-pins] ordinary file ingest transport", () => {
  it("stages Pins files through the storage-only endpoint", async () => {
    const file = new File(["brief"], "brief.pdf", { type: "application/pdf" });
    mockAuthFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      files: [{
        fileName: "brief.pdf",
        ok: true,
        fileId: "file-staged",
        distilled: false,
        decomposed: false,
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(storeFiles("ws-1", [file])).resolves.toMatchObject([
      { fileId: "file-staged", distilled: false, decomposed: false },
    ]);
    expect(mockAuthFetch.mock.calls[0][0]).toMatch(/\/api\/files\/store$/);
  });

  it("sends a selected batch as one multipart request per file", async () => {
    const first = new File(["alpha"], "alpha.txt", { type: "text/plain" });
    const second = new File(["beta"], "beta.txt", { type: "text/plain" });
    mockAuthFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        files: [{ fileName: "alpha.txt", ok: true, fileId: "file-a" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        files: [{ fileName: "beta.txt", ok: true, fileId: "file-b" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(ingestFiles("ws-1", [first, second])).resolves.toEqual([
      { fileName: "alpha.txt", ok: true, fileId: "file-a" },
      { fileName: "beta.txt", ok: true, fileId: "file-b" },
    ]);

    expect(mockAuthFetch).toHaveBeenCalledTimes(2);
    const firstForm = mockAuthFetch.mock.calls[0][1]?.body as FormData;
    const secondForm = mockAuthFetch.mock.calls[1][1]?.body as FormData;
    expect(firstForm.getAll("files")).toEqual([first]);
    expect(secondForm.getAll("files")).toEqual([second]);
    expect(firstForm.get("workspaceId")).toBe("ws-1");
    expect(secondForm.get("workspaceId")).toBe("ws-1");
  });

  it("uploads a large stored file as signed parts and completes it", async () => {
    const bytes = new Uint8Array(MAX_INGEST_FILE_BYTES + 1);
    const file = new File([bytes], "catalog.pdf", { type: "application/pdf" });
    const partBytes = 8 * 1024 * 1024;
    const parts = Array.from({ length: Math.ceil(file.size / partBytes) }, (_, index) => ({
      index,
      offset: index * partBytes,
      sizeBytes: Math.min(partBytes, file.size - index * partBytes),
      url: `https://storage.example/part-${index}`,
    }));
    mockAuthFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        uploadId: "upload-1",
        fileId: "file-large",
        chunkSizeBytes: partBytes,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        parts,
      }), { status: 201, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        fileName: "catalog.pdf",
        ok: true,
        fileId: "file-large",
        sizeBytes: file.size,
        decomposed: false,
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const directFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", directFetch);
    const progress = vi.fn();

    await expect(storeFiles("ws-1", [file], { onProgress: progress })).resolves.toMatchObject([
      { ok: true, fileId: "file-large", decomposed: false },
    ]);

    expect(mockAuthFetch).toHaveBeenCalledTimes(2);
    expect(mockAuthFetch.mock.calls[0][0]).toMatch(/\/api\/files\/uploads\/start$/);
    expect(mockAuthFetch.mock.calls[1][0]).toMatch(/\/api\/files\/uploads\/upload-1\/complete$/);
    expect(directFetch).toHaveBeenCalledTimes(parts.length);
    for (const [index, call] of directFetch.mock.calls.entries()) {
      expect(call[0]).toBe(`https://storage.example/part-${index}`);
      expect((call[1]?.body as Blob).size).toBe(parts[index].sizeBytes);
    }
    expect(progress).toHaveBeenLastCalledWith(file, file.size, file.size);
  });

  it("keeps a request-level failure on its file and continues the batch", async () => {
    const tooLarge = new File(["large"], "large.pdf", { type: "application/pdf" });
    const valid = new File(["ok"], "valid.txt", { type: "text/plain" });
    mockAuthFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "file_too_large",
        detail: "Each file must be 30 MB or smaller.",
      }), { status: 413, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        files: [{ fileName: "valid.txt", ok: true, fileId: "file-ok" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(ingestFiles("ws-1", [tooLarge, valid])).resolves.toEqual([
      {
        fileName: "large.pdf",
        ok: false,
        error: "Each file must be 30 MB or smaller.",
      },
      { fileName: "valid.txt", ok: true, fileId: "file-ok" },
    ]);
    expect(mockAuthFetch).toHaveBeenCalledTimes(2);
  });
});

describe("[COMP:api/linkedin-import-http] app-web LinkedIn import SDK", () => {
  it("posts the ZIP and workspace to the dedicated lossless endpoint", async () => {
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "linkedin.zip", {
      type: "application/zip",
    });
    mockAuthFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      run: { id: "run-1", status: "pending", counts: { rows: 0 } },
    }), { status: 202, headers: { "Content-Type": "application/json" } }));
    mockAuthFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      run: { id: "run-1", status: "completed", counts: { rows: 15026 } },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(ingestLinkedInArchive("ws-1", file, { pollIntervalMs: 0 })).resolves.toMatchObject({
      fileName: "linkedin.zip",
      ok: true,
      linkedinImport: { runId: "run-1", status: "completed", rows: 15026 },
    });

    const [url, init] = mockAuthFetch.mock.calls[0];
    expect(url).toMatch(/\/api\/imports\/linkedin$/);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init?.body as FormData;
    expect(form.get("workspaceId")).toBe("ws-1");
    expect(form.get("file")).toBe(file);
    expect(mockAuthFetch.mock.calls[1]?.[0]).toMatch(/\/api\/imports\/linkedin\/run-1$/);
  });

  it("does not report a queued import as successful when the worker later fails", async () => {
    const file = new File(["zip"], "linkedin.zip", { type: "application/zip" });
    mockAuthFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        run: { id: "run-2", status: "processing", counts: { rows: 0 } },
      }), { status: 202, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        run: { id: "run-2", status: "failed", counts: { rows: 42 }, error: "reconciliation failed" },
      }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(ingestLinkedInArchive("ws-1", file, { pollIntervalMs: 0 })).resolves.toMatchObject({
      ok: false,
      error: "reconciliation failed",
      linkedinImport: { runId: "run-2", status: "failed", rows: 42 },
    });
  });

  it("surfaces the server's archive validation error", async () => {
    mockAuthFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Unsafe ZIP member path" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    }));
    const file = new File(["bad"], "linkedin.zip", { type: "application/zip" });
    await expect(ingestLinkedInArchive("ws-1", file)).rejects.toThrow("Unsafe ZIP member path");
  });
});

// ── Queued-ingest completion signal ─────────────────────────────────────────
//
// POST /api/files/ingest answers as soon as the bytes are filed; the brain
// ingest runs on the worker queue. These two contracts are what stop the UI
// from reporting a failure it cannot actually observe — the shape of the
// 2026-08-05 incident, where a CDN timeout on a 185 s request made every fully
// ingested file render as "Failed".
describe("[COMP:app-web/home-file-drop] queued-ingest status poll", () => {
  it("reports the job's status", async () => {
    mockAuthFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      jobId: "job-1", fileId: "wf-1", status: "processing",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(getIngestJobStatus("job-1")).resolves.toEqual({ status: "processing" });
    expect(mockAuthFetch.mock.calls[0][0]).toMatch(/\/api\/files\/ingest-jobs\/job-1$/);
  });

  it("carries the reason through on a failed job", async () => {
    mockAuthFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      status: "failed", error: "readBytes failed",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(getIngestJobStatus("job-1")).resolves.toEqual({
      status: "failed",
      error: "readBytes failed",
    });
  });

  it("returns null — not a failure — when the status cannot be read", async () => {
    // A 5xx or a dropped connection says nothing about the job, which is
    // durable server-side. Inventing a failure here is the whole bug.
    mockAuthFetch.mockResolvedValueOnce(new Response("nope", { status: 503 }));
    await expect(getIngestJobStatus("job-1")).resolves.toBeNull();

    mockAuthFetch.mockRejectedValueOnce(new Error("Load failed"));
    await expect(getIngestJobStatus("job-1")).resolves.toBeNull();
  });
});

describe("[COMP:app-web/home-file-drop] upload result → chip status", () => {
  it("shows a queued ingest as still working, never as done or failed", () => {
    expect(statusForIngestResult({
      fileName: "report.html", ok: true, fileId: "wf-1", status: "queued", jobId: "job-1",
    })).toBe("analyzing");
  });

  it("treats a store-only result as done", () => {
    expect(statusForIngestResult({ fileName: "brief.pdf", ok: true, status: "stored" })).toBe("done");
  });

  it("only turns red when the server actually reported a failure", () => {
    expect(statusForIngestResult({ fileName: "x", ok: false, error: "Unsupported file type" })).toBe("error");
    expect(statusForIngestResult(undefined)).toBe("error");
  });
});
