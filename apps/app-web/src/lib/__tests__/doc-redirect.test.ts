/**
 * [COMP:app-web/url-refactor] Doc v1 URL redirect.
 *
 * Pure-logic tests for `computeDocRedirect()` — the proxy's legacy
 * doc-URL decider:
 *   - `/w/<wid>/doc?viewId=<vid>` → 301 → `/w/<wid>/p/<vid>`
 *   - `/w/<wid>/doc` (no viewId)  → 302 → `/w/<wid>/p`
 * Exercised against `NextRequest` rather than the full proxy so we don't
 * drag in the cookie / refresh path.
 *
 * Spec: `docs/plans/doc-v1-execution.md` §9.3 (URL redirects). The
 * edge cases (standard, trailing slash, hash preserved, extra query,
 * no-viewId 302) all map to real-world bookmarks + chat unfurls we
 * expect to land on the redirect for months after Phase 5 cutover.
 */

import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { computeDocRedirect } from "../doc-redirect";

function makeReq(url: string): NextRequest {
  return new NextRequest(new URL(url));
}

function locationOf(res: Response): string {
  return res.headers.get("location") ?? "";
}

describe("[COMP:app-web/url-refactor] computeDocRedirect", () => {
  it("301-redirects /w/<wid>/doc?viewId=<vid> to /w/<wid>/p/<vid>", () => {
    const res = computeDocRedirect(
      makeReq("https://app.sidan.ai/w/wid/doc?viewId=vid"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(301);
    expect(locationOf(res!)).toBe("https://app.sidan.ai/w/wid/p/vid");
  });

  it("handles a trailing slash on the legacy path", () => {
    const res = computeDocRedirect(
      makeReq("https://app.sidan.ai/w/wid/doc/?viewId=vid"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(301);
    // Target path is the canonical slashless form.
    expect(locationOf(res!)).toBe("https://app.sidan.ai/w/wid/p/vid");
  });

  it("preserves the URL hash on redirect", () => {
    const res = computeDocRedirect(
      makeReq("https://app.sidan.ai/w/wid/doc?viewId=vid#section"),
    );
    expect(res).not.toBeNull();
    expect(locationOf(res!)).toBe(
      "https://app.sidan.ai/w/wid/p/vid#section",
    );
  });

  it("preserves extra query params (only viewId is consumed)", () => {
    const res = computeDocRedirect(
      makeReq("https://app.sidan.ai/w/wid/doc?viewId=vid&theme=dark"),
    );
    expect(res).not.toBeNull();
    expect(locationOf(res!)).toBe(
      "https://app.sidan.ai/w/wid/p/vid?theme=dark",
    );
  });

  it("302-redirects /w/<wid>/doc with no viewId to the /p index", () => {
    const res = computeDocRedirect(
      makeReq("https://app.sidan.ai/w/wid/doc"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(302);
    expect(locationOf(res!)).toBe("https://app.sidan.ai/w/wid/p");
  });

  it("302s the no-viewId case even with a trailing slash", () => {
    const res = computeDocRedirect(
      makeReq("https://app.sidan.ai/w/wid/doc/"),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(302);
    expect(locationOf(res!)).toBe("https://app.sidan.ai/w/wid/p");
  });

  it("returns null for paths outside the doc surface", () => {
    // The proxy matcher catches `/w/:path*`, but other routes under
    // that prefix (e.g. /w/wid/settings) must pass through unchanged
    // even if they happen to carry a `viewId` query for some reason.
    const res = computeDocRedirect(
      makeReq("https://app.sidan.ai/w/wid/settings?viewId=vid"),
    );
    expect(res).toBeNull();
  });
});
