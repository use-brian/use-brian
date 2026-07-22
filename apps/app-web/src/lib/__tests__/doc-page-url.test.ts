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
  docEntryPath,
  docPagePath,
  blockIdFromHash,
  isCaptureRequest,
  isPanelId,
  PANEL_IDS,
  pageIdFromInAppHref,
  pageIdFromPathname,
  panelFromSearch,
  panelFromTabEntry,
  panelTabEntry,
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
    expect(surfaceFromPathname("/w/w1/feed")).toBe("feed");
    expect(surfaceFromPathname("/w/w1/feed/inbox")).toBe("feed");
    expect(surfaceFromPathname("/w/w1/feed/threads/insights")).toBe("feed");
    // The Tasks operator surface (Home app-bar).
    expect(surfaceFromPathname("/w/w1/tasks")).toBe("tasks");
    expect(surfaceFromPathname("/w/w1/tasks?filter=stale")).toBe("tasks");
    // The CRM operator surface (Home app-bar, 4th slot).
    expect(surfaceFromPathname("/w/w1/crm")).toBe("crm");
    expect(surfaceFromPathname("/w/w1/crm?filter=overdue")).toBe("crm");
    expect(surfaceFromPathname("/w/w1/approvals")).toBe("approvals");
    // The single-recording detail route a `[H:MM:SS]` citation deep-links into.
    // The recordings BOARD is a panel under `/p`, so it classifies as "p".
    expect(surfaceFromPathname("/w/w1/recordings/rec-1")).toBe("recordings");
    expect(surfaceFromPathname("/w/w1/p?panel=recordings")).toBe("p");
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

describe("[COMP:app-web/page-url] panel tabs", () => {
  it("isPanelId accepts the known panels only", () => {
    expect(isPanelId("approvals")).toBe(true);
    expect(isPanelId("goals")).toBe(true);
    expect(isPanelId("recordings")).toBe(true);
    expect(isPanelId("brain")).toBe(false);
    expect(isPanelId("")).toBe(false);
    expect(isPanelId(null)).toBe(false);
    expect(isPanelId(undefined)).toBe(false);
  });

  it("panelFromSearch reads the panel off a search string / params", () => {
    expect(panelFromSearch("?panel=approvals")).toBe("approvals");
    expect(panelFromSearch("panel=goals")).toBe("goals");
    expect(panelFromSearch("?foo=bar&panel=approvals")).toBe("approvals");
    expect(panelFromSearch(new URLSearchParams("panel=goals"))).toBe("goals");
    expect(panelFromSearch("?panel=nope")).toBeNull();
    expect(panelFromSearch("?other=1")).toBeNull();
    expect(panelFromSearch("")).toBeNull();
    expect(panelFromSearch(null)).toBeNull();
    expect(panelFromSearch(undefined)).toBeNull();
  });

  it("panelTabEntry / panelFromTabEntry round-trip the prefixed form", () => {
    expect(panelTabEntry("approvals")).toBe("panel:approvals");
    expect(panelTabEntry("goals")).toBe("panel:goals");
    expect(panelTabEntry("recordings")).toBe("panel:recordings");
    expect(panelFromTabEntry("panel:approvals")).toBe("approvals");
    expect(panelFromTabEntry("panel:goals")).toBe("goals");
    expect(panelFromTabEntry("panel:recordings")).toBe("recordings");
  });

  it("every panel round-trips through its URL and its tab entry", () => {
    // The two encodings must agree for EVERY panel, not just the ones a test
    // remembered to name — a panel that only half round-trips opens as a tab
    // and then resolves to nothing on reload.
    for (const panel of PANEL_IDS) {
      expect(panelFromTabEntry(panelTabEntry(panel))).toBe(panel);
      expect(panelFromSearch(`?panel=${panel}`)).toBe(panel);
      expect(docEntryPath("w1", panelTabEntry(panel))).toBe(`/w/w1/p?panel=${panel}`);
    }
  });

  it("panelFromTabEntry returns null for a page-id entry or unknown panel", () => {
    // A bare UUID page id is the common entry — never a panel.
    expect(panelFromTabEntry("1e02c8a4-1e02-4c8a-8e02-c8a41e02c8a4")).toBeNull();
    expect(panelFromTabEntry("panel:brain")).toBeNull();
    expect(panelFromTabEntry("panel:")).toBeNull();
    expect(panelFromTabEntry(null)).toBeNull();
    expect(panelFromTabEntry(undefined)).toBeNull();
  });

  it("docEntryPath maps an entry to its doc-shell URL", () => {
    expect(docEntryPath("w1", panelTabEntry("approvals"))).toBe(
      "/w/w1/p?panel=approvals",
    );
    expect(docEntryPath("w1", panelTabEntry("goals"))).toBe(
      "/w/w1/p?panel=goals",
    );
    // A page id falls through to the canonical page path.
    expect(docEntryPath("w1", "p1")).toBe("/w/w1/p/p1");
    // Null → the Suggested-for-you index.
    expect(docEntryPath("w1", null)).toBe("/w/w1/p");
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
