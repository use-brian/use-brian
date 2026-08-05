import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import { authFetch } from "@/lib/auth-fetch";
import { ingestFiles, ingestLinkedInArchive } from "../ingest";

const mockAuthFetch = vi.mocked(authFetch);

beforeEach(() => vi.resetAllMocks());

describe("[COMP:app-web/chat-context-pins] ordinary file ingest transport", () => {
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
