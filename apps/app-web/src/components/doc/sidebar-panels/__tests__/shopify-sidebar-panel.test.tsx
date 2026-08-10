// @vitest-environment jsdom

/**
 * [COMP:app-web/shopify-app] — the sidebar panel's collapse rule.
 *
 * Each section's history is nested under it and open ONLY while that section is
 * being viewed. Three lists at once makes the panel taller than the screen and
 * buries the navigation it exists for, so "collapsed unless viewing" is the
 * behaviour, not a detail.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigation = vi.hoisted(() => ({ search: "section=draft" }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/ws-1/shopify",
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: { href: string; children: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const api = vi.hoisted(() => ({ listTools: vi.fn(), callTool: vi.fn() }));
vi.mock("@/lib/api/shopify", () => api);

const { ShopifySidebarPanel } = await import("../shopify-sidebar-panel");

let host: HTMLDivElement;
let root: Root;

async function mount(search: string) {
  navigation.search = search;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider locale="en" dict={en}>
        <ShopifySidebarPanel workspaceId="ws-1" />
      </I18nProvider>,
    );
  });
  // Let the store fetches settle so nothing passes on timing.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return host.textContent ?? "";
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(
    "shopify:runs:ws-1",
    JSON.stringify([
      {
        key: "dropout",
        title: "Where am I losing shoppers?",
        since: "2026-08-01",
        until: "2026-08-10",
        at: 1,
      },
    ]),
  );
  api.listTools.mockResolvedValue({ tools: ["shopifyGetShop"], connected: true });
  api.callTool.mockImplementation(async (_ws: string, tool: string) =>
    tool === "shopifyGetShop"
      ? { name: "Brian Test", myshopify_domain: "brian-test.myshopify.com" }
      : {
          items: [
            { id: "gid://shopify/Product/9", title: "Hojicha Black Maca", updated_at: "2026-08-06" },
          ],
        },
  );
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe("[COMP:app-web/shopify-app] sidebar collapse", () => {
  it("always shows all three section rows", async () => {
    const text = await mount("section=draft");
    expect(text).toContain("Draft a product");
    expect(text).toContain("Inventory vs orders");
    expect(text).toContain("Act on the numbers");
  });

  it("opens drafts under Draft a product, and leaves the questions shut", async () => {
    const text = await mount("section=draft");
    expect(text).toContain("Hojicha Black Maca");
    expect(text).not.toContain("Where am I losing shoppers?");
  });

  it("opens questions under Act on the numbers, and leaves the drafts shut", async () => {
    const text = await mount("section=analyse");
    expect(text).toContain("Where am I losing shoppers?");
    expect(text).not.toContain("Hojicha Black Maca");
  });

  it("collapses both while a section with no history is viewed", async () => {
    const text = await mount("section=inventory");
    expect(text).toContain("Brian Test"); // the fetch did settle
    expect(text).not.toContain("Hojicha Black Maca");
    expect(text).not.toContain("Where am I losing shoppers?");
  });

  it("says the question history is local, right where it is shown", async () => {
    // The list looks like every other synced sidebar list, so the one thing it
    // must not do is imply it follows the user to another browser.
    const text = await mount("section=analyse");
    expect(text).toContain("This browser only");
  });

  it("keeps the sections navigable when the store cannot be reached", async () => {
    // The panel is navigation first: a dead connector must not blank it.
    api.listTools.mockRejectedValue(new Error("store down"));
    const text = await mount("section=draft");
    expect(text).toContain("Draft a product");
    expect(text).toContain("Act on the numbers");
  });
});
