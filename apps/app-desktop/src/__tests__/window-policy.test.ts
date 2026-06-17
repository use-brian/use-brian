import { describe, it, expect } from "vitest";

import {
  classifyNavigation,
  isConnectorOAuth,
  isLoginNavigation,
  parseRefreshBounce,
} from "../window-policy.js";

const CANVAS_ORIGIN = "https://app.sidan.ai";

/** A Google connector-connect OAuth URL (Drive/Gmail/Calendar) — redirect_uri at the connector callback. */
function connectorOAuthUrl(redirectOrigin = CANVAS_ORIGIN): string {
  const sp = new URLSearchParams({
    client_id: "x.apps.googleusercontent.com",
    redirect_uri: `${redirectOrigin}/api/auth/callback/google-connector`,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/drive.readonly",
    state: "gdrive:ws-123",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${sp}`;
}

describe("[COMP:app-desktop/window-policy] classifyNavigation", () => {
  it("keeps the canvas origin in-window (any path)", () => {
    expect(classifyNavigation("https://app.sidan.ai/w/x/p/y", CANVAS_ORIGIN)).toBe("internal");
    expect(classifyNavigation("https://app.sidan.ai/?capture=1", CANVAS_ORIGIN)).toBe("internal");
  });

  it("sends every other origin to the system browser (incl. OAuth, now external)", () => {
    expect(classifyNavigation("https://example.com/", CANVAS_ORIGIN)).toBe("external");
    expect(classifyNavigation("https://accounts.google.com/o/oauth2/v2/auth", CANVAS_ORIGIN)).toBe(
      "external",
    );
    // A different scheme on the same host is a different origin.
    expect(classifyNavigation("http://app.sidan.ai/", CANVAS_ORIGIN)).toBe("external");
  });

  it("fails safe (external) on an unparseable URL", () => {
    expect(classifyNavigation("not a url", CANVAS_ORIGIN)).toBe("external");
    expect(classifyNavigation("", CANVAS_ORIGIN)).toBe("external");
  });
});

describe("[COMP:app-desktop/window-policy] isLoginNavigation", () => {
  it("flags any app's /login page (canvas or the auth primary)", () => {
    expect(isLoginNavigation("https://app.sidan.ai/login")).toBe(true);
    expect(isLoginNavigation("https://app.sidan.ai/login?next=/w/x")).toBe(true);
    expect(isLoginNavigation("https://sidan.ai/login?next=https://app.sidan.ai/w/x")).toBe(true);
  });

  it("flags a hop to an OAuth provider", () => {
    expect(isLoginNavigation("https://accounts.google.com/o/oauth2/v2/auth?x=1")).toBe(true);
    expect(isLoginNavigation("https://oauth2.googleapis.com/token")).toBe(true);
  });

  it("does NOT flag a connector-connect OAuth hop (it goes to the system browser, not the sign-in landing)", () => {
    // Connecting Google Drive/Gmail/Calendar hops to accounts.google.com too, but
    // its redirect_uri is the connector callback — it must not bounce to sign-in.
    expect(isLoginNavigation(connectorOAuthUrl())).toBe(false);
  });

  it("does not flag normal canvas pages", () => {
    expect(isLoginNavigation("https://app.sidan.ai/w/x/p/y")).toBe(false);
    expect(isLoginNavigation("https://app.sidan.ai/")).toBe(false);
    // A page whose path merely contains "login" elsewhere is not a login page.
    expect(isLoginNavigation("https://app.sidan.ai/w/x/p/about-login")).toBe(false);
  });

  it("returns false on an unparseable URL", () => {
    expect(isLoginNavigation("not a url")).toBe(false);
  });
});

describe("[COMP:app-desktop/window-policy] isConnectorOAuth", () => {
  it("flags a Google connector connect by its connector-callback redirect_uri", () => {
    expect(isConnectorOAuth(connectorOAuthUrl())).toBe(true);
    // The redirect_uri origin is irrelevant — dev runs on a different origin.
    expect(isConnectorOAuth(connectorOAuthUrl("http://localhost:3003"))).toBe(true);
  });

  it("does not flag a login OAuth hop (no redirect_uri, or a non-connector callback)", () => {
    expect(isConnectorOAuth("https://accounts.google.com/o/oauth2/v2/auth?x=1")).toBe(false);
    const loginCallback = new URLSearchParams({
      redirect_uri: "https://app.sidan.ai/api/auth/callback/google",
    });
    expect(isConnectorOAuth(`https://accounts.google.com/o/oauth2/v2/auth?${loginCallback}`)).toBe(
      false,
    );
  });

  it("does not flag a non-provider host even with a connector-looking redirect_uri", () => {
    const sp = new URLSearchParams({
      redirect_uri: "https://app.sidan.ai/api/auth/callback/google-connector",
    });
    expect(isConnectorOAuth(`https://evil.example/o/oauth2/v2/auth?${sp}`)).toBe(false);
  });

  it("returns false on a malformed URL or unparseable redirect_uri", () => {
    expect(isConnectorOAuth("not a url")).toBe(false);
    expect(
      isConnectorOAuth("https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=not%20a%20url"),
    ).toBe(false);
  });
});

describe("[COMP:app-desktop/window-policy] parseRefreshBounce", () => {
  it("returns the in-app next URL from a primary refresh bounce", () => {
    const next = "https://app.sidan.ai/w/x/p/y?tab=1";
    const bounce = `https://sidan.ai/api/auth/refresh-and-return?next=${encodeURIComponent(next)}`;
    expect(parseRefreshBounce(bounce, CANVAS_ORIGIN)).toBe(next);
  });

  it("falls back to the app root for an off-origin, malformed, or absent next", () => {
    const offOrigin =
      "https://sidan.ai/api/auth/refresh-and-return?next=" +
      encodeURIComponent("https://evil.example/steal");
    expect(parseRefreshBounce(offOrigin, CANVAS_ORIGIN)).toBe(CANVAS_ORIGIN);
    expect(
      parseRefreshBounce("https://sidan.ai/api/auth/refresh-and-return?next=not%20a%20url", CANVAS_ORIGIN),
    ).toBe(CANVAS_ORIGIN);
    expect(parseRefreshBounce("https://sidan.ai/api/auth/refresh-and-return", CANVAS_ORIGIN)).toBe(
      CANVAS_ORIGIN,
    );
  });

  it("ignores everything that is not a refresh bounce", () => {
    expect(parseRefreshBounce("https://app.sidan.ai/w/x/p/y", CANVAS_ORIGIN)).toBeNull();
    expect(parseRefreshBounce("https://sidan.ai/api/auth/logout?next=x", CANVAS_ORIGIN)).toBeNull();
    expect(parseRefreshBounce("not a url", CANVAS_ORIGIN)).toBeNull();
  });
});
