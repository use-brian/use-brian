// @vitest-environment jsdom
/** [COMP:app-web/shopify-campaign] PII-free campaign state and shop time. */

import { beforeEach, describe, expect, it } from "vitest";
import {
  addLocalDays,
  campaignProductQuery,
  createDefaultCampaignDraft,
  readCampaignStorage,
  recordPreparedCampaign,
  writeCampaignStorage,
  zonedLocalToIso,
  type CampaignHistoryItem,
  type ShopifyCampaignDraft,
} from "../shopify-campaign";

const WS = "workspace-1";
const SHOP = "test-store.myshopify.com";
const fallback = () =>
  createDefaultCampaignDraft("Asia/Hong_Kong", "shop.example", new Date("2026-08-10T00:15:00Z"));

function prepared(id: string, at: number): CampaignHistoryItem {
  return {
    ...fallback(),
    selectedProducts: [{ id: "gid://shopify/Product/1", title: "Widget", totalInventory: 8 }],
    audienceCount: 12,
    audienceQuery: "email_subscription_status = 'SUBSCRIBED'",
    subject: "Back in stock",
    body: "The product is back.",
    ctaLabel: "Shop now",
    segment: {
      id: `gid://shopify/Segment/${id}`,
      name: "Brian - Restock",
      query: "email_subscription_status = 'SUBSCRIBED'",
      adminUrl: `https://${SHOP}/admin/customers/segments`,
    },
    discount: {
      id: `gid://shopify/DiscountCodeNode/${id}`,
      code: `RESTOCK${id}`,
      startsAt: "2026-08-10T01:00:00.000Z",
      endsAt: "2026-08-17T01:00:00.000Z",
    },
    preparedAt: at,
  };
}

beforeEach(() => window.localStorage.clear());

describe("[COMP:app-web/shopify-campaign] campaign state", () => {
  it("uses the shop timezone for send and expiry instants", () => {
    expect(zonedLocalToIso("2026-08-10T09:00", "Asia/Hong_Kong")).toBe(
      "2026-08-10T01:00:00.000Z",
    );
    expect(zonedLocalToIso("2026-08-10T09:00", "America/New_York")).toBe(
      "2026-08-10T13:00:00.000Z",
    );
    expect(addLocalDays("2026-08-10T09:00", 7)).toBe("2026-08-17T09:00");
  });

  it("defaults to a seven-day code window in the shop timezone", () => {
    const draft = fallback();
    expect(draft.sendAt).toBe("2026-08-10T09:00");
    expect(draft.expiresAt).toBe("2026-08-17T09:00");
    expect(draft.oncePerCustomer).toBe(true);
    expect(draft.audience).toBe("all_subscribers");
    expect(draft.includeProductImage).toBe(true);
  });

  it("keeps campaign state separate by workspace and shop", () => {
    const draft = { ...fallback(), code: "RESTOCK20" };
    writeCampaignStorage(WS, SHOP, draft, []);
    expect(readCampaignStorage(WS, SHOP, fallback()).draft.code).toBe("RESTOCK20");
    expect(readCampaignStorage("workspace-2", SHOP, fallback()).draft.code).toBe("RESTOCK10");
    expect(readCampaignStorage(WS, "other.myshopify.com", fallback()).draft.code).toBe("RESTOCK10");
  });

  it("keeps campaign packages saved before the photo picker text-only", () => {
    const { includeProductImage: _newDecision, ...legacyDraft } = fallback();
    window.localStorage.setItem(
      `shopify:campaign:${WS}:${SHOP}`,
      JSON.stringify({ version: 1, draft: legacyDraft, history: [] }),
    );
    expect(readCampaignStorage(WS, SHOP, fallback()).draft.includeProductImage).toBe(false);
  });

  it("drops unknown recipient data instead of persisting it again", () => {
    const unsafeDraft = {
      ...fallback(),
      selectedProducts: [{
        id: "gid://shopify/Product/1",
        title: "Widget",
        totalInventory: 8,
        imageUrl: "https://cdn.shopify.com/widget.jpg",
        imageAlt: "Widget pouch",
        binary: "secret-bytes",
      }],
      selectedImage: {
        productId: "gid://shopify/Product/1",
        url: "https://cdn.shopify.com/widget.jpg",
        alt: "Widget pouch",
        customerEmail: "customer@example.com",
      },
      recipientEmails: ["customer@example.com"],
      customers: [{ email: "customer@example.com" }],
    };
    writeCampaignStorage(WS, SHOP, unsafeDraft as unknown as ShopifyCampaignDraft, []);
    const raw = window.localStorage.getItem(`shopify:campaign:${WS}:${SHOP}`) ?? "";
    expect(raw).not.toContain("recipientEmails");
    expect(raw).not.toContain("customers");
    expect(raw).not.toContain("customer@example.com");
    expect(raw).not.toContain("secret-bytes");
    expect(raw).toContain("https://cdn.shopify.com/widget.jpg");
    expect(readCampaignStorage(WS, SHOP, fallback()).draft.selectedImage).toEqual({
      kind: "product",
      productId: "gid://shopify/Product/1",
      url: "https://cdn.shopify.com/widget.jpg",
      alt: "Widget pouch",
    });
  });

  it("persists only a durable reference for a merchant-uploaded photo", () => {
    const unsafeDraft = {
      ...fallback(),
      selectedImage: {
        kind: "upload",
        fileId: "campaign-photo-1",
        mimeType: "image/jpeg",
        sizeBytes: 1234,
        name: "private-launch-photo.jpg",
        url: "blob:secret-preview-bytes",
      },
    };
    writeCampaignStorage(WS, SHOP, unsafeDraft as unknown as ShopifyCampaignDraft, []);
    const raw = window.localStorage.getItem(`shopify:campaign:${WS}:${SHOP}`) ?? "";
    expect(raw).toContain("campaign-photo-1");
    expect(raw).toContain("image/jpeg");
    expect(raw).not.toContain("private-launch-photo.jpg");
    expect(raw).not.toContain("secret-preview-bytes");
    expect(readCampaignStorage(WS, SHOP, fallback()).draft.selectedImage).toEqual({
      kind: "upload",
      fileId: "campaign-photo-1",
      mimeType: "image/jpeg",
      sizeBytes: 1234,
    });
  });

  it("drops unsafe image URLs from local state", () => {
    const unsafeDraft = {
      ...fallback(),
      selectedProducts: [{
        id: "gid://shopify/Product/1",
        title: "Widget",
        totalInventory: 8,
        imageUrl: "javascript:alert(1)",
      }],
      selectedImage: {
        productId: "gid://shopify/Product/1",
        url: "javascript:alert(1)",
        alt: "Widget",
      },
    };
    writeCampaignStorage(WS, SHOP, unsafeDraft as unknown as ShopifyCampaignDraft, []);
    const stored = readCampaignStorage(WS, SHOP, fallback()).draft;
    expect(stored.selectedProducts[0]?.imageUrl).toBeUndefined();
    expect(stored.selectedImage).toBeUndefined();
  });

  it("records prepared packages newest first and replaces the same discount", () => {
    const first = prepared("1", 1);
    const second = prepared("2", 2);
    let history = recordPreparedCampaign([], first);
    history = recordPreparedCampaign(history, second);
    history = recordPreparedCampaign(history, { ...first, preparedAt: 3 });
    expect(history.map((item) => item.discount.code)).toEqual(["RESTOCK1", "RESTOCK2"]);
    expect(history[0].preparedAt).toBe(3);
  });
  it("composes a prefix search query the merchant never has to write", () => {
    expect(campaignProductQuery("")).toBe("status:active");
    expect(campaignProductQuery("   ")).toBe("status:active");
    expect(campaignProductQuery("winter jack")).toBe("status:active winter* jack*");
    // Hyphens inside a SKU survive; a leading one is the NOT modifier and does not.
    expect(campaignProductQuery("ABC-123")).toBe("status:active ABC-123*");
    expect(campaignProductQuery("-shirt")).toBe("status:active shirt*");
    // Grammar characters are stripped so a stray quote cannot change the query.
    expect(campaignProductQuery('title:"green (hoodie)"')).toBe("status:active title* green* hoodie*");
    expect(campaignProductQuery("*")).toBe("status:active");
    // A query is bounded: five words is a search, more is a scan.
    expect(campaignProductQuery("a b c d e f g")).toBe("status:active a* b* c* d* e*");
  });
});
