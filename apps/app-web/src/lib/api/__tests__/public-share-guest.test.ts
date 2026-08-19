/**
 * [COMP:app-web/share-dialog] Guest-comment SDK + identity key across the three
 * public address families (token link / published URL / custom-domain site).
 *
 * The public viewer is parameterized over a `PublicSource`; guest comments
 * must hit the matching family's endpoint (a published page has no token to
 * put in the URL) and scope to the viewed sub-page only where the family
 * scopes (`?page=` for link + site, never for published). The identity key
 * decides which sessionStorage slot the guest's name/token live in - it must
 * follow the SHARE, not the page, so a guest keeps one identity across a
 * published subtree.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// The public SDK uses a PLAIN fetch (no auth); the owner-side publishPage
// goes through authFetch. Both are captured so payloads can be asserted.
const fetchMock = vi.hoisted(() => vi.fn());
const authFetch = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", fetchMock);
vi.mock("@/lib/auth-fetch", () => ({ authFetch }));

import { listGuestComments, postGuestComment } from "../public-share";
import { publishPage } from "../views";
import { guestIdentityKey } from "@/components/doc/guest-comments";

const okJson = { ok: true, status: 200, json: async () => ({ threads: [], threadId: "t1", guestSessionToken: "g1", published: true, indexable: true, role: "comment" }) };

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(okJson);
  authFetch.mockReset();
  authFetch.mockResolvedValue(okJson);
});

describe("[COMP:app-web/share-dialog] guest comment endpoints per public family", () => {
  it("published: posts to /public/published/:pageId/comment-threads with no ?page scope", async () => {
    await postGuestComment({ kind: "published", pageId: "page-1" }, { guestName: "Ada", body: "hi" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/public\/published\/page-1\/comment-threads$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ guestName: "Ada", body: "hi" });
  });

  it("link: posts to /public/pages/:token and scopes a sub-page with ?page=", async () => {
    await postGuestComment({ kind: "link", token: "tok-1", pageId: "child-1" }, { guestName: "Ada", body: "hi" });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toMatch(/\/api\/public\/pages\/tok-1\/comment-threads\?page=child-1$/);
  });

  it("site: posts to /public/sites/:host and scopes with ?page= when a sub-page is viewed", async () => {
    await postGuestComment(
      { kind: "site", host: "docs.example", path: "/guide", pageId: "child-2" },
      { guestName: "Ada", body: "hi" },
    );
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toMatch(/\/api\/public\/sites\/docs\.example\/comment-threads\?page=child-2$/);
  });

  it("listing carries the guest token (and the page scope for link/site)", async () => {
    await listGuestComments({ kind: "published", pageId: "page-1" }, "guest-1");
    expect((fetchMock.mock.calls[0] as [string])[0]).toMatch(
      /\/api\/public\/published\/page-1\/comments\?guestSessionToken=guest-1$/,
    );
    await listGuestComments({ kind: "link", token: "tok-1", pageId: "child-1" }, "guest-1");
    expect((fetchMock.mock.calls[1] as [string])[0]).toMatch(
      /\/api\/public\/pages\/tok-1\/comments\?guestSessionToken=guest-1&page=child-1$/,
    );
  });

  it("returns null / [] when the family no longer allows commenting (404)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    expect(await postGuestComment({ kind: "published", pageId: "p" }, { guestName: "A", body: "b" })).toBeNull();
    expect(await listGuestComments({ kind: "published", pageId: "p" }, "g")).toEqual([]);
  });
});

describe("[COMP:app-web/share-dialog] guest identity key follows the share, not the page", () => {
  it("link -> the token; site -> the host; published -> the published root", () => {
    expect(guestIdentityKey({ kind: "link", token: "tok-1", pageId: "child" })).toBe("link:tok-1");
    expect(guestIdentityKey({ kind: "site", host: "docs.example", path: "/x", pageId: "child" })).toBe(
      "site:docs.example",
    );
    // A sub-page of a published subtree shares the root's identity slot...
    expect(guestIdentityKey({ kind: "published", pageId: "child" }, "root-1")).toBe("published:root-1");
    // ...and the root itself (no breadcrumb) keys on its own id.
    expect(guestIdentityKey({ kind: "published", pageId: "root-1" })).toBe("published:root-1");
  });
});

describe("[COMP:app-web/share-dialog] publishPage sends the visitor role only when given", () => {
  it("omits role on an indexing-only re-publish so the stored role survives", async () => {
    await publishPage("view-1", true);
    const [, init] = authFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ indexable: true });
    await publishPage("view-1", true, "comment");
    const [, init2] = authFetch.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init2.body))).toEqual({ indexable: true, role: "comment" });
  });
});
