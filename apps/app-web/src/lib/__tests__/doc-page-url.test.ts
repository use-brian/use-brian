/**
 * Unit tests for `lib/doc-page-url.ts` — the pure canonical-URL
 * helpers that keep in-app doc navigation on the path-based
 * `/w/<wid>/p/<pageId>` surface (never the legacy `?viewId=` URL the
 * proxy would 301-redirect, which forces a full-page reload).
 *
 * [COMP:app-web/page-url]
 */

import { describe, expect, it } from "vitest";
import {
  docBlockHash,
  docPagePath,
  blockIdFromHash,
  isCaptureRequest,
  pageIdFromInAppHref,
  pageIdFromPathname,
  surfaceFromPathname,
} from "../doc-page-url";

describe("[COMP:app-web/page-url] docPagePath", () => {
  it("builds the canonical per-page path", () => {
    expect(docPagePath("w1", "p1")).toBe("/w/w1/p/p1");
  });

  it("builds the latest-or-empty index path when pageId is omitted", () => {
    expect(docPagePath("w1")).toBe("/w/w1/p");
  });

  it("treats null pageId as the index path", () => {
    expect(docPagePath("w1", null)).toBe("/w/w1/p");
  });

  it("never emits the legacy `/doc?viewId=` form", () => {
    const url = docPagePath("w1", "p1");
    expect(url).not.toContain("/doc");
    expect(url).not.toContain("viewId");
  });
});

describe("[COMP:app-web/page-url] pageIdFromPathname", () => {
  it("extracts the page id from a canonical path", () => {
    expect(pageIdFromPathname("/w/w1/p/p1")).toBe("p1");
  });

  it("ignores a trailing slash after the page id", () => {
    expect(pageIdFromPathname("/w/w1/p/p1/")).toBe("p1");
  });

  it("returns null at the `/p` index (no page segment)", () => {
    expect(pageIdFromPathname("/w/w1/p")).toBeNull();
  });

  it("returns null for the legacy `/doc` path", () => {
    expect(pageIdFromPathname("/w/w1/doc")).toBeNull();
  });

  it("returns null for unrelated paths", () => {
    expect(pageIdFromPathname("/teams")).toBeNull();
    expect(pageIdFromPathname("/")).toBeNull();
  });

  it("returns null for nullish input", () => {
    expect(pageIdFromPathname(null)).toBeNull();
    expect(pageIdFromPathname(undefined)).toBeNull();
    expect(pageIdFromPathname("")).toBeNull();
  });

  it("round-trips with docPagePath", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    expect(pageIdFromPathname(docPagePath("w9", id))).toBe(id);
  });
});

describe("[COMP:app-web/page-url] pageIdFromInAppHref", () => {
  // The exact href the assistant emitted in the "hallucinated link"
  // incident: a real page id pasted bare as the markdown link target.
  const REAL_ID = "c286123f-0d24-41fd-b527-9b7f47aa1952";

  it("resolves a bare page id (the incident shape)", () => {
    expect(pageIdFromInAppHref(REAL_ID)).toBe(REAL_ID);
  });

  it("resolves the canonical in-chat `/p/<pageId>` form", () => {
    expect(pageIdFromInAppHref(`/p/${REAL_ID}`)).toBe(REAL_ID);
  });

  it("resolves the fully-qualified `/w/<wid>/p/<pageId>` form", () => {
    expect(pageIdFromInAppHref(`/w/w1/p/${REAL_ID}`)).toBe(REAL_ID);
  });

  it("ignores a trailing block hash or query on any form", () => {
    expect(pageIdFromInAppHref(`${REAL_ID}#b-blk1`)).toBe(REAL_ID);
    expect(pageIdFromInAppHref(`/p/${REAL_ID}#b-blk1`)).toBe(REAL_ID);
    expect(pageIdFromInAppHref(`/w/w1/p/${REAL_ID}?x=1`)).toBe(REAL_ID);
  });

  it("round-trips with docPagePath", () => {
    expect(pageIdFromInAppHref(docPagePath("w9", REAL_ID))).toBe(REAL_ID);
  });

  it("returns null for external and non-page hrefs", () => {
    expect(pageIdFromInAppHref("https://example.com")).toBeNull();
    expect(pageIdFromInAppHref("mailto:a@b.com")).toBeNull();
    expect(pageIdFromInAppHref("/w/w1/brain")).toBeNull();
    expect(pageIdFromInAppHref("not-a-uuid")).toBeNull();
    // A plausible-looking slug that is not a UUID must not be treated as a page.
    expect(pageIdFromInAppHref("trading-strategies")).toBeNull();
  });

  it("returns null for nullish input", () => {
    expect(pageIdFromInAppHref(null)).toBeNull();
    expect(pageIdFromInAppHref(undefined)).toBeNull();
    expect(pageIdFromInAppHref("")).toBeNull();
  });
});

describe("[COMP:app-web/page-url] docBlockHash + blockIdFromHash", () => {
  it("builds a #b-<id> deep link on the canonical page path", () => {
    expect(docBlockHash("w1", "p1", "blk1")).toBe("/w/w1/p/p1#b-blk1");
  });

  it("round-trips a block id back out of the built link", () => {
    const url = docBlockHash("w1", "p1", "blk1");
    expect(blockIdFromHash(url.slice(url.indexOf("#")))).toBe("blk1");
  });

  it("reads a block id with or without the leading hash", () => {
    expect(blockIdFromHash("#b-abc")).toBe("abc");
    expect(blockIdFromHash("b-abc")).toBe("abc");
  });

  it("returns null for empty, bare, id-less, or non-block hashes", () => {
    expect(blockIdFromHash("")).toBeNull();
    expect(blockIdFromHash("#")).toBeNull();
    expect(blockIdFromHash("#b-")).toBeNull();
    expect(blockIdFromHash("#comment-x")).toBeNull();
    expect(blockIdFromHash(null)).toBeNull();
    expect(blockIdFromHash(undefined)).toBeNull();
  });
});

describe("[COMP:app-web/page-url] surfaceFromPathname", () => {
  it("classifies the doc page surface (index + page + legacy alias)", () => {
    expect(surfaceFromPathname("/w/w1/p")).toBe("p");
    expect(surfaceFromPathname("/w/w1/p/p1")).toBe("p");
    // The legacy `/doc?viewId=` route is the same doc page surface.
    expect(surfaceFromPathname("/w/w1/doc")).toBe("p");
  });

  it("classifies each top-level surface segment", () => {
    expect(surfaceFromPathname("/w/w1/brain")).toBe("brain");
    expect(surfaceFromPathname("/w/w1/brain/entity-123")).toBe("brain");
    expect(surfaceFromPathname("/w/w1/studio")).toBe("studio");
    expect(surfaceFromPathname("/w/w1/studio/connectors")).toBe("studio");
    expect(surfaceFromPathname("/w/w1/workflow")).toBe("workflow");
    expect(surfaceFromPathname("/w/w1/workflow/wf-1")).toBe("workflow");
    expect(surfaceFromPathname("/w/w1/approvals")).toBe("approvals");
    expect(surfaceFromPathname("/w/w1/knowledge-base")).toBe("knowledge-base");
    expect(surfaceFromPathname("/w/w1/knowledge-base/gaps")).toBe(
      "knowledge-base",
    );
    expect(surfaceFromPathname("/w/w1/inbox")).toBe("inbox");
  });

  it("returns null at the workspace root (no surface segment)", () => {
    expect(surfaceFromPathname("/w/w1")).toBeNull();
    expect(surfaceFromPathname("/w/w1/")).toBeNull();
  });

  it("returns null for an unknown segment", () => {
    expect(surfaceFromPathname("/w/w1/settings")).toBeNull();
    expect(surfaceFromPathname("/w/w1/whatever")).toBeNull();
  });

  it("returns null for non-workspace and nullish paths", () => {
    expect(surfaceFromPathname("/teams")).toBeNull();
    expect(surfaceFromPathname("/")).toBeNull();
    expect(surfaceFromPathname("/login")).toBeNull();
    expect(surfaceFromPathname(null)).toBeNull();
    expect(surfaceFromPathname(undefined)).toBeNull();
    expect(surfaceFromPathname("")).toBeNull();
  });
});

describe("[COMP:app-web/page-url] isCaptureRequest", () => {
  it("detects the desktop quick-capture param (with or without leading ?)", () => {
    expect(isCaptureRequest("?capture=1")).toBe(true);
    expect(isCaptureRequest("capture=1")).toBe(true);
    expect(isCaptureRequest("?foo=bar&capture=1")).toBe(true);
    expect(isCaptureRequest(new URLSearchParams("capture=1"))).toBe(true);
  });

  it("is false for absent, empty, or non-matching values", () => {
    expect(isCaptureRequest("")).toBe(false);
    expect(isCaptureRequest("?capture=0")).toBe(false);
    expect(isCaptureRequest("?capture=true")).toBe(false);
    expect(isCaptureRequest("?other=1")).toBe(false);
    expect(isCaptureRequest(null)).toBe(false);
    expect(isCaptureRequest(undefined)).toBe(false);
  });
});
