// @vitest-environment jsdom
/**
 * [COMP:app-web/doc-file-url] fetchDocFileBlob — the fetch()-based read path
 * for durable doc files.
 *
 * Pins the mint contract: `?redirect=0` on the read route, JSON `{ url }`
 * response → direct storage fetch (a CORS fetch can't follow the route's
 * cross-origin 302 — tainted `Origin: null` vs bucket CORS, the 2026-07-22
 * page-icon incident), non-JSON response (local-disk dev stream) returned
 * as bytes, and both failure legs throwing.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { mockAuthFetch } = vi.hoisted(() => ({ mockAuthFetch: vi.fn() }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: mockAuthFetch }));

import { fetchDocFileBlob } from "../doc-file-url";

const SIGNED_URL = "https://signed.example/ws/file?sig=abc";
const PNG = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });

describe("[COMP:app-web/doc-file-url] fetchDocFileBlob", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockAuthFetch.mockReset();
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mints the signed URL via ?redirect=0 and fetches it directly", async () => {
    mockAuthFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ url: SIGNED_URL }),
    });
    mockFetch.mockResolvedValue({ ok: true, blob: async () => PNG });

    const blob = await fetchDocFileBlob("ws_1", "wf_1");

    expect(blob).toBe(PNG);
    expect(String(mockAuthFetch.mock.calls[0][0])).toContain(
      "/api/doc-files/ws_1/wf_1?redirect=0",
    );
    expect(mockFetch).toHaveBeenCalledWith(SIGNED_URL);
  });

  it("returns directly-streamed bytes as-is (local-disk dev)", async () => {
    mockAuthFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "image/png" }),
      blob: async () => PNG,
    });

    const blob = await fetchDocFileBlob("ws_1", "wf_1");

    expect(blob).toBe(PNG);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws when the mint request fails", async () => {
    mockAuthFetch.mockResolvedValue({ ok: false, status: 404 });
    await expect(fetchDocFileBlob("ws_1", "wf_1")).rejects.toThrow("HTTP 404");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws when the direct storage fetch fails", async () => {
    mockAuthFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ url: SIGNED_URL }),
    });
    mockFetch.mockResolvedValue({ ok: false, status: 403 });
    await expect(fetchDocFileBlob("ws_1", "wf_1")).rejects.toThrow("HTTP 403");
  });
});
