// @vitest-environment jsdom
/**
 * [COMP:app-web/doc-file-url] Durable doc-file reads — the authenticated
 * `?redirect=0` mint every consumer goes through.
 *
 * Pins the mint contract: `?redirect=0` on the read route (a CORS fetch
 * can't follow the route's cross-origin 302 — tainted `Origin: null` vs
 * bucket CORS, the 2026-07-22 page-icon incident), JSON `{ url }` response →
 * `fetchDocFileBlob` fetches storage directly / `resolveDocFileSrc` returns
 * the signed URL for plain `<img src>`/href use (the Bearer-only route URL
 * itself 401s as a subresource — the sibling block-image/block-file/deck
 * bug), non-JSON response (local-disk dev stream) handled by both, and the
 * failure legs throwing (or nulling, for `resolveFileRefUrl`).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { mockAuthFetch } = vi.hoisted(() => ({ mockAuthFetch: vi.fn() }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: mockAuthFetch }));

import {
  fetchDocFileBlob,
  resolveDocFileSrc,
  resolveFileRefUrl,
  type FileRef,
} from "../doc-file-url";

const SIGNED_URL = "https://signed.example/ws/file?sig=abc";
const PNG = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });

const durableRef = (path = "wf_1"): FileRef => ({
  bucket: "workspace_files",
  path,
  mimeType: "image/png",
  sizeBytes: 3,
  name: "a.png",
});

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

  it("resolveDocFileSrc returns the minted signed URL for <img src>/href use", async () => {
    mockAuthFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ url: SIGNED_URL }),
    });

    const src = await resolveDocFileSrc("ws_1", "wf_1");

    expect(src).toBe(SIGNED_URL);
    expect(String(mockAuthFetch.mock.calls[0][0])).toContain("?redirect=0");
    // The signed URL is handed to the element, never fetched here.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("resolveDocFileSrc wraps directly-streamed dev bytes in an object URL", async () => {
    mockAuthFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "image/png" }),
      blob: async () => PNG,
    });
    if (!URL.createObjectURL) {
      // jsdom lacks createObjectURL; a deterministic stub is fine.
      URL.createObjectURL = (() => "blob:stub") as typeof URL.createObjectURL;
    }

    const src = await resolveDocFileSrc("ws_1", "wf_1");

    expect(src).toMatch(/^blob:/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("resolveFileRefUrl routes durable refs through the mint and nulls on failure", async () => {
    mockAuthFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ url: SIGNED_URL }),
    });
    await expect(resolveFileRefUrl(durableRef(), "ws_1")).resolves.toBe(SIGNED_URL);

    mockAuthFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    await expect(resolveFileRefUrl(durableRef("wf_2"), "ws_1")).resolves.toBeNull();
  });
});
