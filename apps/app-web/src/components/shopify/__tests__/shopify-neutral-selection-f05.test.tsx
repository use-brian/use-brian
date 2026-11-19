// @vitest-environment jsdom
/** [COMP:app-web/shopify-app] [COMP:app-web/shopify-campaign] F05 choice chrome. */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

const mocks = vi.hoisted(() => ({
  params: new URLSearchParams(),
  callTool: vi.fn(),
  askAssistant: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => mocks.params }));
vi.mock("@/lib/api/shopify", () => ({
  callTool: mocks.callTool,
  askAssistant: mocks.askAssistant,
  extractJson: JSON.parse,
  ShopifyCallError: class extends Error {},
}));
vi.mock("@/lib/use-doc-media", () => ({
  useDocMedia: () => ({ url: null, error: null }),
  useDocMediaDownload: () => vi.fn(),
}));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn(() => { throw new Error("Unexpected network call"); }) }));

import { AnalyseTab } from "../analyse-tab";
import { CampaignTab } from "../campaign-tab";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.params = new URLSearchParams();
  mocks.callTool.mockImplementation(async (_workspace: string, tool: string) => {
    if (tool === "shopifyGetShop") return { myshopify_domain: "fixture.myshopify.com", timezone: "UTC" };
    if (tool === "shopifyListProducts") return { items: [{
      id: "gid://shopify/Product/1", title: "Fixture product", total_inventory: 3,
      featured_image_url: "https://example.test/product.jpg",
    }] };
    if (tool === "shopifyListDiscounts") return { items: [] };
    throw new Error(`Unexpected tool: ${tool}`);
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render(child: ReactNode) {
  await act(async () => root.render(<I18nProvider locale="en" dict={en}>{child}</I18nProvider>));
}
async function click(target: HTMLElement) {
  await act(async () => target.click());
}
function button(label: string): HTMLButtonElement {
  const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) =>
    node.getAttribute("aria-label") === label || node.textContent?.includes(label));
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
function choice(node: Element, selected: boolean) {
  expect(node.classList.contains("border-interaction/60")).toBe(selected);
  expect(node.classList.contains("bg-interaction/5")).toBe(selected);
  if (!selected) {
    expect(node.classList.contains("hover:border-interaction/40")).toBe(true);
    expect(node.classList.contains("hover:bg-interaction/5")).toBe(true);
  }
  expect(node.className).not.toMatch(/(?:border|bg)-primary/);
}

describe("F05 neutral Shopify choice selection", () => {
  it("keeps analysis aria-pressed exclusive as the operator changes the default choice", async () => {
    await render(<AnalyseTab workspaceId="f05" />);
    const dropout = button(en.shopifyApp.anDropout);
    const device = button(en.shopifyApp.anDevice);
    choice(dropout, true);
    choice(device, false);
    expect(dropout.getAttribute("aria-pressed")).toBe("true");
    await click(device);
    choice(dropout, false);
    choice(device, true);
    expect(device.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
    expect(mocks.callTool).not.toHaveBeenCalled();
    expect(mocks.askAssistant).not.toHaveBeenCalled();
  });

  it("seeds analysis and custom dates from history without reseeding a later selection", async () => {
    mocks.params = new URLSearchParams("an=country&since=2026-01-01&until=2026-01-07");
    await render(<AnalyseTab workspaceId="f05" />);
    choice(button(en.shopifyApp.anCountry), true);
    expect([...host.querySelectorAll<HTMLInputElement>('input[type="date"]')].map((node) => node.value))
      .toEqual(["2026-01-01", "2026-01-07"]);
    await click(button(en.shopifyApp.anSells));
    mocks.params = new URLSearchParams("an=source");
    await render(<AnalyseTab workspaceId="f05" />);
    choice(button(en.shopifyApp.anSells), true);
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("updates product, audience, discount and photo choices without executing a campaign", async () => {
    await render(<CampaignTab workspaceId="f05" availableTools={[]} />);
    const product = host.querySelector<HTMLElement>('[role="checkbox"][aria-label="Fixture product"]')!;
    const productCard = product.closest("label")!;
    choice(productCard, false);
    await click(product);
    expect(product.getAttribute("aria-checked")).toBe("true");
    choice(productCard, true);

    const all = button(en.shopifyApp.campaignAllSubscribers);
    const buyers = button(en.shopifyApp.campaignPastBuyers);
    choice(all, true);
    choice(buyers, false);
    await click(buyers);
    choice(all, false);
    choice(buyers, true);

    const keep = button(en.shopifyApp.campaignKeepDiscounts);
    const pause = button(en.shopifyApp.campaignPauseDiscounts);
    choice(keep, true);
    await click(pause);
    choice(keep, false);
    choice(pause, true);

    const photo = button(en.shopifyApp.campaignUseProductPhoto.replace("{product}", "Fixture product"));
    const noPhoto = button(en.shopifyApp.campaignNoPhoto);
    choice(photo, true);
    await click(noPhoto);
    choice(photo, false);
    choice(noPhoto, true);
    expect(host.querySelector('[aria-label="' + en.shopifyApp.campaignMessagePreviewTitle + '"] img')).toBeNull();
    await click(photo);
    choice(photo, true);
    choice(noPhoto, false);

    await click(product);
    expect(product.getAttribute("aria-checked")).toBe("false");
    choice(productCard, false);
    // Only the three mocked mount reads occurred; choices themselves never execute tools.
    expect(mocks.callTool.mock.calls.map((call) => call[1]).sort()).toEqual([
      "shopifyGetShop", "shopifyListDiscounts", "shopifyListProducts",
    ]);
    expect(mocks.askAssistant).not.toHaveBeenCalled();
  });
});
