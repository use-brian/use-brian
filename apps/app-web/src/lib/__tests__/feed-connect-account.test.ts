import { describe, it, expect } from "vitest";
import { buildAuthorizeUrl, buildReturnTo, OAUTH_PATH } from "@/lib/feed-connect-account";

// Ported from apps/feed-web/src/lib/__tests__/connect-account.test.ts —
// `return_to` now lands on the app-web Feed surface (/w/<id>/feed).
describe("[COMP:app-web/feed-connect-account] connect-account helper", () => {
  it("maps platforms to oauth authorize paths", () => {
    expect(OAUTH_PATH.threads).toBe("/api/threads-oauth/authorize");
    expect(OAUTH_PATH.twitter).toBe("/api/twitter-oauth/authorize");
  });

  it("builds a threads authorize url with assistantId and a platform-settings return_to", () => {
    const url = buildAuthorizeUrl({
      apiUrl: "http://localhost:4000",
      platform: "threads",
      assistantId: "a-1",
      origin: "https://app.usebrian.ai",
      workspaceId: "ws-1",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      "http://localhost:4000/api/threads-oauth/authorize",
    );
    expect(parsed.searchParams.get("assistantId")).toBe("a-1");
    expect(parsed.searchParams.get("return_to")).toBe(
      "https://app.usebrian.ai/w/ws-1/feed/threads/settings?connected=threads",
    );
  });

  it("builds an X authorize url returning to the /w/<id>/feed surface", () => {
    const url = buildAuthorizeUrl({
      apiUrl: "http://localhost:4000",
      platform: "twitter",
      assistantId: "a-2",
      origin: "https://app.usebrian.ai",
      workspaceId: "ws-9",
    });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/twitter-oauth/authorize");
    expect(parsed.searchParams.get("return_to")).toContain("/w/ws-9/feed");
    expect(parsed.searchParams.get("return_to")).not.toContain("/t/");
  });

  it("uses the app origin when the API is same-origin", () => {
    const url = buildAuthorizeUrl({
      apiUrl: "",
      platform: "twitter",
      assistantId: "a-2",
      origin: "https://app.example.com",
      workspaceId: "ws-9",
    });

    expect(new URL(url).origin).toBe("https://app.example.com");
  });

  it("returns the web to the same origin's X settings page", () => {
    expect(
      buildReturnTo({ platform: "twitter", origin: "https://app.usebrian.ai", workspaceId: "ws-1", desktop: false }),
    ).toBe("https://app.usebrian.ai/w/ws-1/feed/twitter/settings?connected=twitter");
  });

  it("returns the desktop app through its usebrian://open deep link, even from file://", () => {
    for (const origin of ["file://", "https://app.usebrian.ai"]) {
      const out = new URL(
        buildReturnTo({ platform: "twitter", origin, workspaceId: "ws-1", desktop: true }),
      );
      expect(out.protocol).toBe("usebrian:");
      expect(out.hostname).toBe("open");
      expect(out.searchParams.get("path")).toBe(
        "/w/ws-1/feed/twitter/settings?connected=twitter",
      );
    }
  });

  it("builds a desktop authorize url against the absolute API from a file:// renderer", () => {
    const url = new URL(
      buildAuthorizeUrl({
        apiUrl: "https://api.usebrian.ai",
        platform: "twitter",
        assistantId: "a-3",
        origin: "file://",
        workspaceId: "ws-2",
        desktop: true,
      }),
    );
    expect(url.origin).toBe("https://api.usebrian.ai");
    expect(url.searchParams.get("return_to")).toMatch(/^usebrian:\/\/open\?path=/);
  });
});
