/**
 * [COMP:app-web/shopify-app] — the section codec.
 *
 * Two controls drive this state (topbar pills, sidebar rows), so the codec is
 * the thing that keeps them agreeing. The assertions that matter are the
 * fallbacks: a stale or malformed `?section=` must land somewhere usable rather
 * than render an empty surface, which looks like a broken page rather than a
 * bad link.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHOPIFY_SECTION,
  SHOPIFY_SECTIONS,
  isShopifySection,
  shopifySectionFromParams,
  shopifySectionHref,
} from "../shopify-view";

const params = (qs: string) => new URLSearchParams(qs);

describe("[COMP:app-web/shopify-app] section codec", () => {
  it("reads each real section back", () => {
    for (const section of SHOPIFY_SECTIONS) {
      expect(shopifySectionFromParams(params(`section=${section}`))).toBe(section);
    }
  });

  it("falls back when the URL says nothing", () => {
    expect(shopifySectionFromParams(params(""))).toBe(DEFAULT_SHOPIFY_SECTION);
  });

  it("falls back on a section that does not exist", () => {
    // A stale link, or one from a build where the section was named
    // differently. Rendering nothing here reads as a broken page.
    expect(shopifySectionFromParams(params("section=orders"))).toBe(DEFAULT_SHOPIFY_SECTION);
    expect(shopifySectionFromParams(params("section="))).toBe(DEFAULT_SHOPIFY_SECTION);
  });

  it("survives no params at all, which is the SSR first paint", () => {
    expect(shopifySectionFromParams(null)).toBe(DEFAULT_SHOPIFY_SECTION);
    expect(shopifySectionFromParams(undefined)).toBe(DEFAULT_SHOPIFY_SECTION);
  });

  it("does not treat arbitrary values as sections", () => {
    expect(isShopifySection("draft")).toBe(true);
    expect(isShopifySection("Draft")).toBe(false);
    expect(isShopifySection(null)).toBe(false);
    expect(isShopifySection(undefined)).toBe(false);
    expect(isShopifySection(0)).toBe(false);
  });

  it("writes the default section explicitly, so no href is section-less", () => {
    // A bare `/w/<id>/shopify` href would leave the sidebar's active-row
    // highlight with nothing to match on.
    const href = shopifySectionHref("ws-1", DEFAULT_SHOPIFY_SECTION);
    expect(href).toBe("/w/ws-1/shopify?section=draft");
    expect(shopifySectionFromParams(params(href.split("?")[1]))).toBe(DEFAULT_SHOPIFY_SECTION);
  });

  it("round-trips every section through its own href", () => {
    for (const section of SHOPIFY_SECTIONS) {
      const qs = shopifySectionHref("ws-1", section).split("?")[1];
      expect(shopifySectionFromParams(params(qs))).toBe(section);
    }
  });
});
