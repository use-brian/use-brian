import { describe, it, expect } from "vitest";

import {
  classifyNavigation,
  isConnectorOAuth,
  isLoginNavigation,
  parseRefreshBounce,
  decideLoadFailureAction,
  decideLoginAction,
  shouldAttemptLocalMint,
  LOCAL_MINT_COOLDOWN_MS,
} from "../window-policy.js";

const CANVAS_ORIGIN = "https://app.usebrian.ai";

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
    expect(classifyNavigation("https://app.usebrian.ai/w/x/p/y", CANVAS_ORIGIN)).toBe("internal");
    expect(classifyNavigation("https://app.usebrian.ai/?capture=1", CANVAS_ORIGIN)).toBe("internal");
  });

  it("sends every other origin to the system browser (incl. OAuth, now external)", () => {
    expect(classifyNavigation("https://example.com/", CANVAS_ORIGIN)).toBe("external");
    expect(classifyNavigation("https://accounts.google.com/o/oauth2/v2/auth", CANVAS_ORIGIN)).toBe(
      "external",
    );
    // A different scheme on the same host is a different origin.
    expect(classifyNavigation("http://app.usebrian.ai/", CANVAS_ORIGIN)).toBe("external");
  });

  it("fails safe (external) on an unparseable URL", () => {
    expect(classifyNavigation("not a url", CANVAS_ORIGIN)).toBe("external");
    expect(classifyNavigation("", CANVAS_ORIGIN)).toBe("external");
  });
});

describe("[COMP:app-desktop/window-policy] isLoginNavigation", () => {
  it("flags any app's /login page (canvas or the auth primary)", () => {
    expect(isLoginNavigation("https://app.usebrian.ai/login")).toBe(true);
    expect(isLoginNavigation("https://app.usebrian.ai/login?next=/w/x")).toBe(true);
    expect(isLoginNavigation("https://usebrian.ai/login?next=https://app.usebrian.ai/w/x")).toBe(true);
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
    expect(isLoginNavigation("https://app.usebrian.ai/w/x/p/y")).toBe(false);
    expect(isLoginNavigation("https://app.usebrian.ai/")).toBe(false);
    // A page whose path merely contains "login" elsewhere is not a login page.
    expect(isLoginNavigation("https://app.usebrian.ai/w/x/p/about-login")).toBe(false);
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
      redirect_uri: "https://app.usebrian.ai/api/auth/callback/google",
    });
    expect(isConnectorOAuth(`https://accounts.google.com/o/oauth2/v2/auth?${loginCallback}`)).toBe(
      false,
    );
  });

  it("does not flag a non-provider host even with a connector-looking redirect_uri", () => {
    const sp = new URLSearchParams({
      redirect_uri: "https://app.usebrian.ai/api/auth/callback/google-connector",
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
    const next = "https://app.usebrian.ai/w/x/p/y?tab=1";
    const bounce = `https://usebrian.ai/api/auth/refresh-and-return?next=${encodeURIComponent(next)}`;
    expect(parseRefreshBounce(bounce, CANVAS_ORIGIN)).toBe(next);
  });

  it("falls back to the app root for an off-origin, malformed, or absent next", () => {
    const offOrigin =
      "https://usebrian.ai/api/auth/refresh-and-return?next=" +
      encodeURIComponent("https://evil.example/steal");
    expect(parseRefreshBounce(offOrigin, CANVAS_ORIGIN)).toBe(CANVAS_ORIGIN);
    expect(
      parseRefreshBounce("https://usebrian.ai/api/auth/refresh-and-return?next=not%20a%20url", CANVAS_ORIGIN),
    ).toBe(CANVAS_ORIGIN);
    expect(parseRefreshBounce("https://usebrian.ai/api/auth/refresh-and-return", CANVAS_ORIGIN)).toBe(
      CANVAS_ORIGIN,
    );
  });

  it("ignores everything that is not a refresh bounce", () => {
    expect(parseRefreshBounce("https://app.usebrian.ai/w/x/p/y", CANVAS_ORIGIN)).toBeNull();
    expect(parseRefreshBounce("https://usebrian.ai/api/auth/logout?next=x", CANVAS_ORIGIN)).toBeNull();
    expect(parseRefreshBounce("not a url", CANVAS_ORIGIN)).toBeNull();
  });
});

describe("[COMP:app-desktop/window-policy] decideLoadFailureAction", () => {
  const REMOTE = "https://app.usebrian.ai/w/x/p/y";

  it("signs in only when there is NO session", () => {
    expect(
      decideLoadFailureAction({ errorCode: -106, isMainFrame: true, failedUrl: REMOTE, hasSession: false }),
    ).toBe("signin");
  });

  it("shows the offline landing (never sign-in) when a session exists — the offline→logout fix", () => {
    // ERR_INTERNET_DISCONNECTED (-106), ERR_NAME_NOT_RESOLVED (-105), timeout (-7):
    // any network failure with a live session keeps the user signed in.
    for (const errorCode of [-106, -105, -7, -2, -118]) {
      expect(
        decideLoadFailureAction({ errorCode, isMainFrame: true, failedUrl: REMOTE, hasSession: true }),
      ).toBe("offline-retry");
    }
  });

  it("ignores sub-frame failures and our own intentional aborts (ERR_ABORTED -3)", () => {
    expect(
      decideLoadFailureAction({ errorCode: -106, isMainFrame: false, failedUrl: REMOTE, hasSession: true }),
    ).toBe("ignore");
    expect(
      decideLoadFailureAction({ errorCode: -3, isMainFrame: true, failedUrl: REMOTE, hasSession: false }),
    ).toBe("ignore");
  });

  it("just surfaces the window if our own file: landing fails to load (packaging bug, not a logout)", () => {
    expect(
      decideLoadFailureAction({
        errorCode: -6,
        isMainFrame: true,
        failedUrl: "file:///app/dist/signin.html",
        hasSession: false,
      }),
    ).toBe("show-window");
  });
});

describe("[COMP:app-desktop/window-policy] decideLoginAction (per-target, §2.3)", () => {
  const LOCAL_ORIGIN = "http://localhost:3003";
  const cloud = { auth: "pkce" as const, appOrigin: CANVAS_ORIGIN };
  const local = { auth: "local-session" as const, appOrigin: LOCAL_ORIGIN };

  it("cloud target: every login navigation starts the PKCE flow (today's behavior)", () => {
    expect(decideLoginAction("https://app.usebrian.ai/login", cloud)).toBe("pkce");
    expect(decideLoginAction("https://usebrian.ai/login?next=/w/x", cloud)).toBe("pkce");
    expect(decideLoginAction("https://accounts.google.com/o/oauth2/v2/auth?x=1", cloud)).toBe(
      "pkce",
    );
  });

  it("local target: the app origin's own /login mints the local-owner session", () => {
    expect(decideLoginAction("http://localhost:3003/login", local)).toBe("local-session");
    expect(decideLoginAction("http://localhost:3003/login?next=/w/x", local)).toBe(
      "local-session",
    );
  });

  it("local target: NEVER starts PKCE — off-origin logins and OAuth hops fall through", () => {
    expect(decideLoginAction("https://usebrian.ai/login", local)).toBe("none");
    expect(decideLoginAction("https://accounts.google.com/o/oauth2/v2/auth?x=1", local)).toBe(
      "none",
    );
  });

  it("a connector OAuth hop is not a login for either target", () => {
    expect(decideLoginAction(connectorOAuthUrl(), cloud)).toBe("none");
    expect(decideLoginAction(connectorOAuthUrl(LOCAL_ORIGIN), local)).toBe("none");
  });

  it("a non-login navigation is none for either target", () => {
    expect(decideLoginAction("https://app.usebrian.ai/w/x/p/y", cloud)).toBe("none");
    expect(decideLoginAction("http://localhost:3003/w/x", local)).toBe("none");
    expect(decideLoginAction("not a url", local)).toBe("none");
  });
});

describe("[COMP:app-desktop/window-policy] shouldAttemptLocalMint", () => {
  it("always allows the first attempt, blocks within the cooldown, re-allows after it", () => {
    expect(shouldAttemptLocalMint(null, 1_000)).toBe(true);
    expect(shouldAttemptLocalMint(1_000, 1_000 + LOCAL_MINT_COOLDOWN_MS - 1)).toBe(false);
    expect(shouldAttemptLocalMint(1_000, 1_000 + LOCAL_MINT_COOLDOWN_MS)).toBe(true);
  });
});

describe("[COMP:app-desktop/window-policy] decideLoadFailureAction (local target, §2.2)", () => {
  const LOCAL = "http://localhost:3003/w/x";

  it("routes any main-frame failure on a local target to the brain-unreachable landing", () => {
    for (const hasSession of [true, false]) {
      expect(
        decideLoadFailureAction({
          errorCode: -102, // ERR_CONNECTION_REFUSED — the brain isn't running
          isMainFrame: true,
          failedUrl: LOCAL,
          hasSession,
          target: "local",
        }),
      ).toBe("local-unreachable");
    }
  });

  it("keeps the ignore + file: precedence rules under a local target", () => {
    expect(
      decideLoadFailureAction({
        errorCode: -3,
        isMainFrame: true,
        failedUrl: LOCAL,
        hasSession: true,
        target: "local",
      }),
    ).toBe("ignore");
    expect(
      decideLoadFailureAction({
        errorCode: -102,
        isMainFrame: false,
        failedUrl: LOCAL,
        hasSession: true,
        target: "local",
      }),
    ).toBe("ignore");
    expect(
      decideLoadFailureAction({
        errorCode: -6,
        isMainFrame: true,
        failedUrl: "file:///app/dist/signin.html",
        hasSession: false,
        target: "local",
      }),
    ).toBe("show-window");
  });

  it("an explicit cloud target keeps the session-driven behavior", () => {
    expect(
      decideLoadFailureAction({
        errorCode: -106,
        isMainFrame: true,
        failedUrl: "https://app.usebrian.ai/w/x",
        hasSession: true,
        target: "cloud",
      }),
    ).toBe("offline-retry");
  });
});
