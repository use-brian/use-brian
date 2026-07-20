import { describe, it, expect } from "vitest";
import { buildAuthorizeUrl, OAUTH_PATH } from "@/lib/feed-connect-account";

// Ported from apps/feed-web/src/lib/__tests__/connect-account.test.ts —
// `return_to` now lands on the app-web Feed surface (/w/<id>/feed).
describe("[COMP:app-web/feed-connect-account] connect-account helper", () => {
  it("maps platforms to oauth authorize paths", () => {
    expect(OAUTH_PATH.threads).toBe("/api/threads-oauth/authorize");
    expect(OAUTH_PATH.twitter).toBe("/api/twitter-oauth/authorize");
  });

  it("builds a threads authorize url with assistantId and a feed-surface return_to", () => {
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
      "https://app.usebrian.ai/w/ws-1/feed?connected=threads",
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
});
