/**
 * [COMP:app-web/shopify-app] — the pasted product link.
 *
 * "Give my product a page like that one" arrives as a URL the owner copied out
 * of a browser bar, which means it carries whatever else was in there: a
 * variant query string, a locale or collection prefix, a trailing slash, a
 * fragment. Getting the handle wrong turns a working link into "no product
 * with that handle", which reads as the store's fault rather than the parse's.
 */

import { describe, expect, it } from "vitest";
import { productHandleFromUrl } from "../draft-tab";

describe("[COMP:app-web/shopify-app] product handle from a pasted link", () => {
  it("reads a plain product URL", () => {
    expect(productHandleFromUrl("https://shop.example.com/products/immunity-boost")).toBe(
      "immunity-boost",
    );
  });

  it("drops a variant query string, which every share link carries", () => {
    expect(
      productHandleFromUrl("https://shop.example.com/products/immunity-boost?variant=123456"),
    ).toBe("immunity-boost");
  });

  it("survives a locale or collection prefix", () => {
    expect(productHandleFromUrl("https://shop.example.com/en-gb/products/greens")).toBe("greens");
    expect(productHandleFromUrl("https://shop.example.com/collections/all/products/greens")).toBe(
      "greens",
    );
  });

  it("ignores a trailing slash and a fragment", () => {
    expect(productHandleFromUrl("https://shop.example.com/products/greens/")).toBe("greens");
    expect(productHandleFromUrl("https://shop.example.com/products/greens#reviews")).toBe("greens");
  });

  it("decodes an escaped handle", () => {
    expect(productHandleFromUrl("https://shop.example.com/products/caf%C3%A9-blend")).toBe(
      "café-blend",
    );
  });

  it("accepts a bare path, since people paste those too", () => {
    expect(productHandleFromUrl("/products/greens")).toBe("greens");
  });

  it("refuses a link that is not a product page", () => {
    // A collection or the storefront root has no handle to copy a layout from,
    // and guessing one would send the owner a "product not found" for a link
    // that was simply the wrong kind of link.
    expect(productHandleFromUrl("https://shop.example.com/collections/all")).toBeNull();
    expect(productHandleFromUrl("https://shop.example.com/")).toBeNull();
    expect(productHandleFromUrl("")).toBeNull();
    expect(productHandleFromUrl("   ")).toBeNull();
  });
});
