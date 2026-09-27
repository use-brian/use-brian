// @vitest-environment jsdom
/** Page icons consume authenticated file bytes, retaining their current shared
 * cache behavior. Cache invalidation is a separate departmental boundary.
 * [COMP:app-web/page-icon]
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FileText } from "lucide-react";

const { mockAuthFetch } = vi.hoisted(() => ({ mockAuthFetch: vi.fn() }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: mockAuthFetch }));

import { PageIcon } from "../page-icon";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WS = "11111111-2222-3333-4444-555555555555";
// Distinct file ids per test — the object-URL cache is module-level.
const token = (tail: string) =>
  `img:${WS}/aaaaaaaa-bbbb-cccc-dddd-eeeeeeee${tail}`;

const bytesResponse = () => ({
  ok: true,
  headers: new Headers({ "content-type": "image/png" }),
  blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
});

describe("[COMP:app-web/page-icon] PageIcon", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockAuthFetch.mockReset();
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
    if (!URL.createObjectURL) {
      // jsdom lacks createObjectURL; a deterministic stub is fine — we only
      // assert the <img> wiring, not blob semantics.
      URL.createObjectURL = (() => "blob:stub") as typeof URL.createObjectURL;
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (root) act(() => root!.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  async function mount(node: React.ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(node));
    await act(async () => {});
  }

  it("renders an emoji value as the historical span", async () => {
    await mount(
      <PageIcon icon="🌱" fallback={FileText} emojiClassName="text-[15px]" />,
    );
    expect(container!.querySelector("span")?.textContent).toBe("🌱");
    expect(container!.querySelector("img")).toBeNull();
    expect(mockAuthFetch).not.toHaveBeenCalled();
  });

  it("renders the derived glyph when there is no icon", async () => {
    await mount(
      <PageIcon icon={null} fallback={FileText} glyphClassName="size-4" />,
    );
    expect(container!.querySelector("svg")).not.toBeNull();
    expect(container!.querySelector("img")).toBeNull();
  });

  it("loads authenticated bytes and renders an img token, cached across mounts", async () => {
    mockAuthFetch.mockResolvedValue(bytesResponse());
    const t = token("0001");

    await mount(
      <PageIcon icon={t} fallback={FileText} imgClassName="size-4" />,
    );
    const img = container!.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toMatch(/^blob:/);
    expect(mockAuthFetch).toHaveBeenCalledTimes(1);
    expect(String(mockAuthFetch.mock.calls[0][0])).toContain(
      `/api/doc-files/${WS}/`,
    );
    expect(String(mockAuthFetch.mock.calls[0][0])).toContain("redirect=0");
    expect(mockAuthFetch.mock.calls[0][1]).toEqual({cache:'no-store'});
    expect(mockFetch).not.toHaveBeenCalled();

    // Second mount of the same token: served from the module cache, no fetch.
    act(() => root!.unmount());
    container!.remove();
    await mount(
      <PageIcon icon={t} fallback={FileText} imgClassName="size-4" />,
    );
    expect(container!.querySelector("img")).not.toBeNull();
    expect(mockAuthFetch).toHaveBeenCalledTimes(1);
  });

  it("renders directly returned image bytes", async () => {
    mockAuthFetch.mockResolvedValue(bytesResponse());

    await mount(
      <PageIcon icon={token("0003")} fallback={FileText} imgClassName="size-4" />,
    );
    expect(container!.querySelector("img")).not.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("falls back to the glyph when the icon fetch fails", async () => {
    mockAuthFetch.mockResolvedValue({ ok: false, status: 404 });
    await mount(
      <PageIcon
        icon={token("0002")}
        fallback={FileText}
        glyphClassName="size-4"
      />,
    );
    expect(container!.querySelector("img")).toBeNull();
    expect(container!.querySelector("svg")).not.toBeNull();
  });

  it("falls back to the glyph when the authorized response body fails", async () => {
    mockAuthFetch.mockResolvedValue({ok:true,blob:async()=>{throw new Error('incomplete body')}});
    await mount(
      <PageIcon
        icon={token("0004")}
        fallback={FileText}
        glyphClassName="size-4"
      />,
    );
    expect(container!.querySelector("img")).toBeNull();
    expect(container!.querySelector("svg")).not.toBeNull();
  });
});
