// @vitest-environment jsdom
/**
 * [COMP:app-web/shopify-surface-cache] The Shopify surface paints from the
 * surface cache (instant-navigation contract N1-N4).
 *
 * The four things a phone tap on the Shopify icon depends on:
 *  - a warmed `shopify:<wid>` key renders the section strip and the open tab
 *    on the FIRST frame, with the reachability fetch still pending (N1);
 *  - an empty cache paints the rail skeleton and never a "Loading..."
 *    sentence (N4);
 *  - a `markSurfaceCacheStale` (the shape a spine signal would take) keeps
 *    the strip painted while the revalidation is in flight and swaps in the
 *    new answer when it lands - no blank frame (N3);
 *  - the key the surface reads is the key the icon's hover warms (N2).
 *
 * Plus the section strip's two placements (responsive contract M3 / M8): a
 * 26px inline strip in the topbar from `md`, a full-width two-column row of
 * 36px cells below it.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import {
  loadSurfaceCache,
  markSurfaceCacheStale,
  resetSurfaceCache,
} from "@/lib/surface-cache";
import { shopifyToolsCacheKey, warmTargetFor } from "@/lib/surface-prefetch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: vi.fn(),
    push: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  usePathname: () => "/w/ws-1/shopify",
  useSearchParams: () => new URLSearchParams("section=draft"),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
// The topbar reads the sidebar-data provider; render its centre slot bare.
vi.mock("@/components/operator/operator-topbar", () => ({
  OperatorTopbar: ({ center }: { center?: React.ReactNode }) => (
    <div data-testid="topbar">{center}</div>
  ),
}));
// The tabs carry their own fetches; only their presence matters here.
vi.mock("../draft-tab", () => ({ DraftTab: () => <div data-testid="draft-tab" /> }));
vi.mock("../inventory-tab", () => ({ InventoryTab: () => <div data-testid="inventory-tab" /> }));
vi.mock("../analyse-tab", () => ({ AnalyseTab: () => <div data-testid="analyse-tab" /> }));
vi.mock("../campaign-tab", () => ({ CampaignTab: () => <div data-testid="campaign-tab" /> }));

const api = vi.hoisted(() => ({ listTools: vi.fn(), callTool: vi.fn(), askAssistant: vi.fn() }));
vi.mock("@/lib/api/shopify", () => api);

import { ShopifySurface } from "../shopify-surface";

const WORKSPACE = "ws-1";
const CONNECTED = { tools: ["shopifyGetShop", "shopifyListProducts"], connected: true };
/** A fetch that never answers - the "still pending" half of every first-paint check. */
const pending = () => new Promise<never>(() => {});

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(ticks = 3) {
  for (let i = 0; i < ticks; i += 1) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

async function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <I18nProvider locale="en" dict={en}>
        <ShopifySurface workspaceId={WORKSPACE} />
      </I18nProvider>,
    );
  });
  await settle();
}

const text = () => host?.textContent ?? "";

function unmount() {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
}

describe("[COMP:app-web/shopify-surface-cache] Shopify surface first paint", () => {
  beforeEach(() => {
    resetSurfaceCache();
    api.listTools.mockReset();
  });
  afterEach(unmount);

  it("paints the section strip from a warmed key while the fetch is still pending (N1)", async () => {
    await loadSurfaceCache(shopifyToolsCacheKey(WORKSPACE), async () => CONNECTED);
    api.listTools.mockImplementation(pending);
    await mount();
    expect(text()).toContain(en.shopifyApp.tabDraft);
    expect(text()).toContain(en.shopifyApp.tabCampaign);
    expect(text()).not.toContain(en.shopifyApp.loading);
    expect(host!.querySelector('[data-testid="draft-tab"]')).not.toBeNull();
    // A fresh key is painted, not refetched.
    expect(api.listTools).not.toHaveBeenCalled();
  });

  it("paints the rail skeleton, never a Loading sentence, when nothing is cached (N4)", async () => {
    api.listTools.mockImplementation(pending);
    await mount();
    expect(text()).not.toContain(en.shopifyApp.loading);
    expect(host!.querySelector(".skeleton")).not.toBeNull();
    expect(host!.querySelector("[data-shopify-sections]")).toBeNull();
  });

  it("keeps the strip up through a stale mark and swaps in the new answer when it lands (N3)", async () => {
    await loadSurfaceCache(shopifyToolsCacheKey(WORKSPACE), async () => CONNECTED);
    let release: (value: typeof CONNECTED) => void = () => {};
    api.listTools.mockImplementation(
      () =>
        new Promise<typeof CONNECTED>((resolve) => {
          release = resolve;
        }),
    );
    await mount();

    await act(async () => {
      markSurfaceCacheStale(shopifyToolsCacheKey(WORKSPACE));
    });
    await settle();
    expect(api.listTools).toHaveBeenCalledTimes(1);
    // No blank frame: the strip and the open tab stay painted while the
    // revalidation is in flight.
    expect(text()).toContain(en.shopifyApp.tabDraft);
    expect(host!.querySelector('[data-testid="draft-tab"]')).not.toBeNull();
    expect(host!.querySelector(".skeleton")).toBeNull();

    await act(async () => {
      release({ tools: [], connected: false });
    });
    await settle();
    expect(text()).toContain(en.shopifyApp.notConnected);
    expect(host!.querySelector("[data-shopify-sections]")).toBeNull();
  });

  it("unmounts open tabs and their store data when the 15-second renewal finds the store unreachable", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      api.listTools.mockResolvedValue(CONNECTED);
      await mount();
      expect(host!.querySelector('[data-testid="inventory-tab"],[data-testid="draft-tab"]')).not.toBeNull();
      api.listTools.mockResolvedValue({ tools: [], connected: false });
      // No focus, no stale mark: only the lease's own 15-second renewal runs.
      await act(async () => { vi.advanceTimersByTime(15_000); });
      await settle();
    } finally { vi.useRealTimers(); }
    expect(text()).toContain(en.shopifyApp.notConnected);
    expect(host!.querySelector("[data-shopify-sections]")).toBeNull();
    expect(host!.querySelector('[data-testid="draft-tab"],[data-testid="inventory-tab"]')).toBeNull();
  });

  it("offers Retry after a cold-load failure instead of retrying on its own", async () => {
    api.listTools.mockRejectedValue(new Error("store down"));
    await mount();
    expect(text()).toContain("store down");
    expect(text()).toContain(en.shopifyApp.retry);
    expect(text()).not.toContain(en.shopifyApp.loading);
    expect(api.listTools).toHaveBeenCalledTimes(1);
  });

  it("reads the key the Shopify icon's hover warms (N2)", () => {
    expect(warmTargetFor("shopify", WORKSPACE).key).toBe(shopifyToolsCacheKey(WORKSPACE));
  });
});

describe("[COMP:app-web/shopify-surface-cache] section strip placement (M3, M8)", () => {
  beforeEach(async () => {
    resetSurfaceCache();
    api.listTools.mockReset();
    await loadSurfaceCache(shopifyToolsCacheKey(WORKSPACE), async () => CONNECTED);
    api.listTools.mockImplementation(pending);
  });
  afterEach(unmount);

  it("renders the strip inline in the topbar from md and as a full-width two-column row below it", async () => {
    await mount();
    const topbar = host!.querySelector('[data-shopify-sections="topbar"]');
    const phone = host!.querySelector('[data-shopify-sections="phone"]');
    expect(topbar).not.toBeNull();
    expect(phone).not.toBeNull();
    // The inline strip is gated to `md`; the phone row is the inverse.
    expect(topbar!.className).toMatch(/\bhidden\b/);
    expect(topbar!.className).toMatch(/\bmd:flex\b/);
    expect(phone!.className).toMatch(/\bgrid-cols-2\b/);
    expect(phone!.className).toMatch(/\bmd:hidden\b/);
    // The inline strip is the topbar's centre slot; the row sits under the bar.
    expect(host!.querySelector('[data-testid="topbar"] [data-shopify-sections="topbar"]')).not.toBeNull();
    expect(host!.querySelector('[data-testid="topbar"] [data-shopify-sections="phone"]')).toBeNull();
    // Every section, both placements, 36px on a phone and 26px from md.
    for (const strip of [topbar!, phone!]) {
      const buttons = strip.querySelectorAll("button");
      expect(buttons).toHaveLength(4);
      for (const button of buttons) {
        expect(button.className).toMatch(/\bh-9\b/);
        expect(button.className).toMatch(/\bmd:h-6\.5\b/);
      }
    }
    expect(phone!.querySelector('button[aria-pressed="true"]')?.textContent).toBe(en.shopifyApp.tabDraft);
  });
});
