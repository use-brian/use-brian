// @vitest-environment jsdom
/** [COMP:app-web/shopify-campaign] Campaign preparation and retry behavior. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callTool = vi.fn();
const askAssistant = vi.fn();
const authFetch = vi.fn();
const resolveDocFileSrc = vi.fn();
const fetchDocFileBlob = vi.fn();
vi.mock("@/lib/api/shopify", () => ({
  callTool: (...args: unknown[]) => callTool(...args),
  askAssistant: (...args: unknown[]) => askAssistant(...args),
  extractJson: (text: string) => JSON.parse(text),
  ShopifyCallError: class ShopifyCallError extends Error {},
}));
vi.mock("@/lib/auth-fetch", () => ({
  authFetch: (...args: unknown[]) => authFetch(...args),
}));
vi.mock("@/components/doc/doc-file-url", () => ({
  resolveDocFileSrc: (...args: unknown[]) => resolveDocFileSrc(...args),
  fetchDocFileBlob: (...args: unknown[]) => fetchDocFileBlob(...args),
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
          featured_image_url: "https://cdn.shopify.com/widget.jpg",
          featured_image_alt: "Restocked Widget pouch",
        }],
        has_next_page: false,
      };
    }
    if (tool === "shopifyListDiscounts" && args.query === "status:active") return { items: [] };
    if (tool === "shopifyGetProduct") {
      return { url: "https://shop.example/products/restocked-widget" };
    }
    if (tool === "shopifyPreviewCustomerSegment") {
      return { query: "email_subscription_status = 'SUBSCRIBED'", total_count: 0 };
    }
    throw new Error(`unexpected tool: ${tool}`);
  });
}

async function completeEditableFields() {
  await click(container!.querySelector('[aria-label="Restocked Widget"]')!);
  await click(button("Preview audience"));
  await enter(field("Subject"), "Back in stock");
  await enter(field("Body"), "The widget is available again.");
  await enter(field("Button text"), "Shop now");
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  resolveDocFileSrc.mockResolvedValue("https://signed.example/campaign-photo.jpg");
  fetchDocFileBlob.mockResolvedValue(new Blob(["photo"], { type: "image/jpeg" }));
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:download-photo"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
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
        return { items: [{
          id: "gid://shopify/Product/42",
          title: "Restocked Widget",
          total_inventory: 8,
          featured_image_url: "https://cdn.shopify.com/widget.jpg",
          featured_image_alt: "Restocked Widget pouch",
        }] };
      }
      if (tool === "shopifyListDiscounts") return { items: [] };
      if (tool === "shopifyPreviewCustomerSegment") {
        return { query: "email_subscription_status = 'SUBSCRIBED'", total_count: 24 };
      }
      if (tool === "shopifyGetProduct") return {
        title: "Restocked Widget",
        total_inventory: 7,
        featured_image_url: "https://cdn.shopify.com/widget.jpg",
        featured_image_alt: "Restocked Widget pouch",
      };
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
    expect(container!.textContent).toContain("Product photo URL");
    expect(container!.querySelector<HTMLImageElement>('img[src="https://cdn.shopify.com/widget.jpg"]')).toBeTruthy();
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
        return { items: [{
          id: "gid://shopify/Product/42",
          title: "Restocked Widget",
          total_inventory: 2,
          featured_image_url: "https://cdn.shopify.com/widget.jpg",
        }] };
      }
      if (tool === "shopifyListDiscounts") return { items: [] };
      if (tool === "shopifyPreviewCustomerSegment") {
        return { query: "email_subscription_status = 'SUBSCRIBED'", total_count: 24 };
      }
      if (tool === "shopifyGetProduct") return {
        title: "Restocked Widget",
        total_inventory: 0,
        featured_image_url: "https://cdn.shopify.com/widget.jpg",
      };
      throw new Error(`unexpected tool: ${tool} ${JSON.stringify(args)}`);
    });
    await mount();
    await completeEditableFields();

    await click(button("Prepare campaign"));
    expect(container!.textContent).toContain("All selected products are now out of stock");
    expect(callTool.mock.calls.some((call) => call[1] === "shopifyCreateCustomerSegment")).toBe(false);
    expect(callTool.mock.calls.some((call) => call[1] === "shopifyCreateDiscountCode")).toBe(false);
  });

  it("blocks preparation before writes when the selected product photo disappears", async () => {
    callTool.mockImplementation(async (_workspaceId: string, tool: string) => {
      if (tool === "shopifyGetShop") {
        return {
          myshopify_domain: "test-store.myshopify.com",
          primary_domain: "shop.example",
          currency: "USD",
          timezone: "Asia/Hong_Kong",
        };
      }
      if (tool === "shopifyListProducts") {
        return { items: [{
          id: "gid://shopify/Product/42",
          title: "Restocked Widget",
          total_inventory: 8,
          featured_image_url: "https://cdn.shopify.com/widget.jpg",
        }] };
      }
      if (tool === "shopifyListDiscounts") return { items: [] };
      if (tool === "shopifyPreviewCustomerSegment") {
        return { query: "email_subscription_status = 'SUBSCRIBED'", total_count: 24 };
      }
      if (tool === "shopifyGetProduct") return { title: "Restocked Widget", total_inventory: 7 };
      throw new Error(`unexpected tool: ${tool}`);
    });
    await mount();
    await completeEditableFields();

    await click(button("Prepare campaign"));
    expect(container!.textContent).toContain("selected product photo is no longer available");
    expect(callTool.mock.calls.some((call) => call[1] === "shopifyCreateCustomerSegment")).toBe(false);
    expect(callTool.mock.calls.some((call) => call[1] === "shopifyCreateDiscountCode")).toBe(false);
  });

  it("shows the action-grant blocker and disables audience preparation", async () => {
    await mount(TOOLS.filter((tool) => tool !== "shopifyCreateCustomerSegment"));
    expect(container!.textContent).toContain("missing one or more campaign actions");
    expect(button("Preview audience").disabled).toBe(true);
    expect(button("Prepare campaign").disabled).toBe(true);
  });

  it("drafts every message field except the product photo and resolves the product button URL", async () => {
    askAssistant.mockResolvedValue(JSON.stringify({
      subject: "The Restocked Widget is back",
      preview: "Save 10% with RESTOCK10 before the offer ends.",
      body: "The Restocked Widget is available again. Use RESTOCK10 for 10% off before the exact expiry.",
      ctaLabel: "Shop the restock",
    }));
    await mount();
    await click(container!.querySelector('[aria-label="Restocked Widget"]')!);

    await click(button("Draft message"));

    expect(field("Subject").value).toBe("The Restocked Widget is back");
    expect(field("Preview text").value).toBe("Save 10% with RESTOCK10 before the offer ends.");
    expect(field("Body").value).toContain("RESTOCK10");
    expect(field("Button text").value).toBe("Shop the restock");
    expect(field("Button destination URL").value)
      .toBe("https://shop.example/products/restocked-widget");
    expect(callTool).toHaveBeenCalledWith(
      WORKSPACE,
      "shopifyGetProduct",
      { productId: "gid://shopify/Product/42" },
    );
    const prompt = String(askAssistant.mock.calls[0]?.[1]);
    expect(prompt).toContain("Button destination URL: https://shop.example/products/restocked-widget");
    expect(prompt).toContain("merchant handles the photo separately");
  });

  it("links a zero-subscriber test audience to Shopify Customers with consent guidance", async () => {
    await mount();
    await click(button("Preview audience"));

    expect(container!.textContent).toContain("Customer agreed to receive marketing emails");
    expect(container!.textContent).toContain("Use All email subscribers");
    expect(container!.querySelector<HTMLAnchorElement>('a[href="https://test-store.myshopify.com/admin/customers"]'))
      .toBeTruthy();
  });

  it("shows edited copy, button destination, and the selected photo in the live preview", async () => {
    callTool.mockImplementation(async (_workspaceId: string, tool: string) => {
      if (tool === "shopifyGetShop") {
        return {
          myshopify_domain: "test-store.myshopify.com",
          primary_domain: "shop.example",
          currency: "USD",
          timezone: "Asia/Hong_Kong",
        };
      }
      if (tool === "shopifyListProducts") {
        return { items: [{
          id: "gid://shopify/Product/42",
          title: "Restocked Widget",
          total_inventory: 8,
          featured_image_url: "https://cdn.shopify.com/widget.jpg",
          featured_image_alt: "Restocked Widget pouch",
        }] };
      }
      if (tool === "shopifyListDiscounts") return { items: [] };
      if (tool === "shopifyPreviewCustomerSegment") {
        return { query: "email_subscription_status = 'SUBSCRIBED'", total_count: 24 };
      }
      throw new Error(`unexpected tool: ${tool}`);
    });
    await mount();
    await completeEditableFields();

    const preview = container!.querySelector('[aria-label="Message preview"]')!;
    expect(preview.textContent).toContain("Back in stock");
    expect(preview.textContent).toContain("The widget is available again.");
    expect(preview.textContent).toContain("Shop now");
    expect(preview.textContent).toContain("https://shop.example");
    expect(preview.querySelector<HTMLImageElement>('img[src="https://cdn.shopify.com/widget.jpg"]')?.alt)
      .toBe("Restocked Widget pouch");
  });

  it("uploads, previews and downloads the merchant's own photo without persisting its bytes", async () => {
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
        return { items: [{
          id: "gid://shopify/Product/42",
          title: "Restocked Widget",
          total_inventory: 8,
          featured_image_url: "https://cdn.shopify.com/widget.jpg",
        }] };
      }
      if (tool === "shopifyListDiscounts") return { items: [] };
      if (tool === "shopifyPreviewCustomerSegment") {
        return { query: "email_subscription_status = 'SUBSCRIBED'", total_count: 24 };
      }
      if (tool === "shopifyGetProduct") {
        return {
          title: "Restocked Widget",
          total_inventory: 7,
          featured_image_url: "https://cdn.shopify.com/widget.jpg",
        };
      }
      if (tool === "shopifyCreateCustomerSegment") {
        return {
          id: "gid://shopify/Segment/8",
          name: "Brian - Restock",
          query: "email_subscription_status = 'SUBSCRIBED'",
          admin_url: "https://test-store.myshopify.com/admin/customers/segments",
        };
      }
      if (tool === "shopifyCreateDiscountCode") {
        return {
          id: "gid://shopify/DiscountCodeNode/9",
          code: "RESTOCK10",
          starts_at: args.startsAt,
          ends_at: args.endsAt,
        };
      }
      throw new Error(`unexpected tool: ${tool}`);
    });
    authFetch.mockResolvedValue(new Response(JSON.stringify({
      files: [{ id: "workspace-file-7", mimeType: "image/jpeg", sizeBytes: 5 }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await mount();
    await completeEditableFields();

    const input = container!.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["SECRET_IMAGE_BYTES_7843"], "private-launch-photo.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await settle();
    await settle();

    expect(authFetch).toHaveBeenCalledWith(
      `http://localhost:4000/api/doc-files/${WORKSPACE}/upload`,
      expect.objectContaining({ method: "POST", body: expect.any(FormData) }),
    );
    const preview = container!.querySelector('[aria-label="Message preview"]')!;
    expect(preview.querySelector<HTMLImageElement>('img[src="https://signed.example/campaign-photo.jpg"]')?.alt)
      .toBe("Uploaded campaign photo");
    const raw = window.localStorage.getItem(`shopify:campaign:${WORKSPACE}:test-store.myshopify.com`) ?? "";
    expect(raw).toContain("workspace-file-7");
    expect(raw).not.toContain("private-launch-photo.jpg");
    expect(raw).not.toContain("signed.example");
    expect(raw).not.toContain("SECRET_IMAGE_BYTES_7843");

    await click(button("Prepare campaign"));
    expect(container!.textContent).toContain("Campaign package ready");
    expect(container!.textContent).toContain("upload it manually in Shopify Messaging");

    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await click(button("Download photo"));
    expect(fetchDocFileBlob).toHaveBeenCalledWith(WORKSPACE, "workspace-file-7");
    expect(anchorClick).toHaveBeenCalledOnce();
    anchorClick.mockRestore();
  });

  it("requires a photo decision and allows an explicit text-only campaign", async () => {
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
    expect(container!.textContent).toContain("Choose a product photo, upload your own photo, or select No photo");
    expect(callTool.mock.calls.some((call) => call[1] === "shopifyCreateCustomerSegment")).toBe(false);

    await click(container!.querySelector('[aria-label="No photo"]')!);
    await click(button("Prepare campaign"));
    expect(container!.textContent).toContain("Campaign package ready");
    expect(container!.textContent).not.toContain("Product photo URL");
  });
});
