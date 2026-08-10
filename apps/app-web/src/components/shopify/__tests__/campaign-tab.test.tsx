// @vitest-environment jsdom
/** [COMP:app-web/shopify-campaign] Campaign preparation and retry behavior. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callTool = vi.fn();
const askAssistant = vi.fn();
vi.mock("@/lib/api/shopify", () => ({
  callTool: (...args: unknown[]) => callTool(...args),
  askAssistant: (...args: unknown[]) => askAssistant(...args),
  extractJson: (text: string) => JSON.parse(text),
  ShopifyCallError: class ShopifyCallError extends Error {},
}));

import { I18nProvider } from "@/lib/i18n/client";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { en } from "@/lib/i18n/dictionaries/en";
import { CampaignTab } from "../campaign-tab";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dict = en as unknown as Dictionary;
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const TOOLS = [
  "shopifyGetShop",
  "shopifyListProducts",
  "shopifyGetProduct",
  "shopifyListDiscounts",
  "shopifyPreviewCustomerSegment",
  "shopifyCreateCustomerSegment",
  "shopifyCreateDiscountCode",
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function mount(tools = TOOLS) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider locale="en" dict={dict}>
        <CampaignTab workspaceId={WORKSPACE} availableTools={tools} />
      </I18nProvider>,
    );
  });
  await settle();
}

function button(text: string): HTMLButtonElement {
  const match = [...container!.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.textContent?.trim() === text);
  if (!match) throw new Error(`button not found: ${text}`);
  return match;
}

function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const labelNode = [...container!.querySelectorAll("label")]
    .find((item) => item.querySelector("span")?.textContent === label);
  const input = labelNode?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
  if (!input) throw new Error(`field not found: ${label}`);
  return input;
}

async function click(target: HTMLElement) {
  await act(async () => target.click());
  await settle();
}

async function enter(target: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = target instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(target, value);
  await act(async () => target.dispatchEvent(new Event("input", { bubbles: true })));
}

function installBaseResponses() {
  callTool.mockImplementation(async (_workspaceId: string, tool: string, args: Record<string, unknown>) => {
    if (tool === "shopifyGetShop") {
      return {
        name: "Test Store",
        myshopify_domain: "test-store.myshopify.com",
        primary_domain: "shop.example",
        currency: "USD",
        timezone: "Asia/Hong_Kong",
      };
    }
    if (tool === "shopifyListProducts") {
      return {
        items: [{
          id: "gid://shopify/Product/42",
          title: "Restocked Widget",
          total_inventory: 8,
        }],
        has_next_page: false,
      };
    }
    if (tool === "shopifyListDiscounts" && args.query === "status:active") return { items: [] };
    throw new Error(`unexpected tool: ${tool}`);
  });
}

async function completeEditableFields() {
  await click(container!.querySelector('[aria-label="Restocked Widget"]')!);
  await click(button("Preview audience"));
  await enter(field("Subject"), "Back in stock");
  await enter(field("Body"), "The widget is available again.");
  await enter(field("Button label"), "Shop now");
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  installBaseResponses();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("[COMP:app-web/shopify-campaign] Campaign tab", () => {
  it("preserves a created segment and retries only the failed discount operation", async () => {
    let discountAttempts = 0;
    callTool.mockImplementation(async (_workspaceId: string, tool: string, args: Record<string, unknown>) => {
      if (tool === "shopifyGetShop") {
        return {
          name: "Test Store",
          myshopify_domain: "test-store.myshopify.com",
          primary_domain: "shop.example",
          currency: "USD",
          timezone: "Asia/Hong_Kong",
        };
      }
      if (tool === "shopifyListProducts") {
        return { items: [{ id: "gid://shopify/Product/42", title: "Restocked Widget", total_inventory: 8 }] };
      }
      if (tool === "shopifyListDiscounts") return { items: [] };
      if (tool === "shopifyPreviewCustomerSegment") {
        return { query: "email_subscription_status = 'SUBSCRIBED'", total_count: 24 };
      }
      if (tool === "shopifyGetProduct") return { title: "Restocked Widget", total_inventory: 7 };
      if (tool === "shopifyCreateCustomerSegment") {
        return {
          id: "gid://shopify/Segment/8",
          name: "Brian - Restock",
          query: "email_subscription_status = 'SUBSCRIBED'",
          admin_url: "https://test-store.myshopify.com/admin/customers/segments",
        };
      }
      if (tool === "shopifyCreateDiscountCode") {
        discountAttempts += 1;
        if (discountAttempts === 1) throw new Error("temporary discount failure");
        return {
          id: "gid://shopify/DiscountCodeNode/9",
          code: "RESTOCK10",
          starts_at: args.startsAt,
          ends_at: args.endsAt,
        };
      }
      throw new Error(`unexpected tool: ${tool}`);
    });
    await mount();
    await completeEditableFields();

    await click(button("Prepare campaign"));
    expect(container!.textContent).toContain("temporary discount failure");
    expect(button("Continue preparation")).toBeTruthy();

    await click(button("Continue preparation"));
    expect(container!.textContent).toContain("Campaign package ready");
    expect(callTool.mock.calls.filter((call) => call[1] === "shopifyCreateCustomerSegment")).toHaveLength(1);
    expect(callTool.mock.calls.filter((call) => call[1] === "shopifyCreateDiscountCode")).toHaveLength(2);
  });

  it("blocks preparation before writes when every selected product has sold out", async () => {
    callTool.mockImplementation(async (_workspaceId: string, tool: string, args: Record<string, unknown>) => {
      if (tool === "shopifyGetShop") {
        return {
          myshopify_domain: "test-store.myshopify.com",
          primary_domain: "shop.example",
          currency: "USD",
          timezone: "Asia/Hong_Kong",
        };
      }
      if (tool === "shopifyListProducts") {
        return { items: [{ id: "gid://shopify/Product/42", title: "Restocked Widget", total_inventory: 2 }] };
      }
      if (tool === "shopifyListDiscounts") return { items: [] };
      if (tool === "shopifyPreviewCustomerSegment") {
        return { query: "email_subscription_status = 'SUBSCRIBED'", total_count: 24 };
      }
      if (tool === "shopifyGetProduct") return { title: "Restocked Widget", total_inventory: 0 };
      throw new Error(`unexpected tool: ${tool} ${JSON.stringify(args)}`);
    });
    await mount();
    await completeEditableFields();

    await click(button("Prepare campaign"));
    expect(container!.textContent).toContain("All selected products are now out of stock");
    expect(callTool.mock.calls.some((call) => call[1] === "shopifyCreateCustomerSegment")).toBe(false);
    expect(callTool.mock.calls.some((call) => call[1] === "shopifyCreateDiscountCode")).toBe(false);
  });

  it("shows the action-grant blocker and disables audience preparation", async () => {
    await mount(TOOLS.filter((tool) => tool !== "shopifyCreateCustomerSegment"));
    expect(container!.textContent).toContain("missing one or more campaign actions");
    expect(button("Preview audience").disabled).toBe(true);
    expect(button("Prepare campaign").disabled).toBe(true);
  });
});
