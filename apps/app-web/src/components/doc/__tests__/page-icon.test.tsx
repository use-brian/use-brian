// @vitest-environment jsdom
/**
 * [COMP:app-web/page-icon] PageIcon — emoji / image-token / fallback render.
 *
 * Pins the three branches of the shared icon renderer:
 *   - emoji value → the historical `<span>`
 *   - `img:<ws>/<file>` token → an authenticated fetch (authFetch → blob →
 *     object-URL) rendered as `<img>`; the module-level cache dedupes the
 *     fetch across mounts (a sidebar of rows must not fetch N times)
 *   - fetch failure → the derived lucide glyph (same as no icon)
 *
 * Driven for real in jsdom (`createRoot` + `act`), matching the other doc
 * component tests.
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

const okBlobResponse = () => ({
  ok: true,
  blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
});

describe("[COMP:app-web/page-icon] PageIcon", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    mockAuthFetch.mockReset();
    if (!URL.createObjectURL) {
      // jsdom lacks createObjectURL; a deterministic stub is fine — we only
      // assert the <img> wiring, not blob semantics.
      URL.createObjectURL = (() => "blob:stub") as typeof URL.createObjectURL;
    }
  });

  afterEach(() => {
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

  it("loads an img: token through authFetch and renders an <img>, cached across mounts", async () => {
    mockAuthFetch.mockResolvedValue(okBlobResponse());
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

    // Second mount of the same token: served from the module cache, no fetch.
    act(() => root!.unmount());
    container!.remove();
    await mount(
      <PageIcon icon={t} fallback={FileText} imgClassName="size-4" />,
    );
    expect(container!.querySelector("img")).not.toBeNull();
    expect(mockAuthFetch).toHaveBeenCalledTimes(1);
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
});
