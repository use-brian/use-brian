import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import { authFetch } from "@/lib/auth-fetch";
import { ingestLinkedInArchive } from "../ingest";

const mockAuthFetch = vi.mocked(authFetch);

beforeEach(() => vi.resetAllMocks());

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
