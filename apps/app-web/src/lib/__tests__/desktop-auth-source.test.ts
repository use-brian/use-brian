/**
 * Unit tests for the desktop auth source — the Bearer-token half of the auth
 * seam. The web path stays cookie-based (auth-fetch.ts); this source activates
 * only when the Electron token bridge is present.
 *
 * [COMP:app-web/desktop-auth-source]
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isDesktopAuth,
  desktopAuthSource,
  desktopSignOut,
  classifyRefreshStatus,
} from "../desktop-auth-source";

const realFetch = globalThis.fetch;

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function setBridge(bridge: unknown) {
  (globalThis as { window?: unknown }).window = { sidanclawDesktop: bridge };
}

describe("[COMP:app-web/desktop-auth-source] isDesktopAuth", () => {
  it("is false with no window (SSR / tests)", () => {
    expect(isDesktopAuth()).toBe(false);
  });

  it("is false for a thin-shell bridge that only exposes signIn", () => {
    setBridge({ signIn: () => {} });
    expect(isDesktopAuth()).toBe(false);
  });

  it("is true only when the token bridge (getAccessToken) is present", () => {
    setBridge({ signIn: () => {}, getAccessToken: () => "tok" });
    expect(isDesktopAuth()).toBe(true);
  });
});

describe("[COMP:app-web/desktop-auth-source] desktopSignOut", () => {
  it("is false (not handled) with no window (SSR / tests)", () => {
    expect(desktopSignOut()).toBe(false);
  });

  it("is false for a web page with no desktop bridge", () => {
    (globalThis as { window?: unknown }).window = {};
    expect(desktopSignOut()).toBe(false);
  });

  it("is false for a thin-shell bridge that predates signOut", () => {
    setBridge({ signIn: () => {} });
    expect(desktopSignOut()).toBe(false);
  });

  it("calls the shell bridge and reports handled in the thin shell", () => {
    const signOut = vi.fn();
    setBridge({ signIn: () => {}, signOut });
    expect(desktopSignOut()).toBe(true);
    expect(signOut).toHaveBeenCalledOnce();
  });

  it("calls the shell bridge and reports handled in bundled mode", () => {
    const signOut = vi.fn();
    setBridge({ signIn: () => {}, signOut, getAccessToken: () => "tok" });
    expect(desktopSignOut()).toBe(true);
    expect(signOut).toHaveBeenCalledOnce();
  });
});

describe("[COMP:app-web/desktop-auth-source] desktopAuthSource", () => {
  it("reads the access token from the bridge", () => {
    setBridge({ signIn: () => {}, getAccessToken: () => "abc" });
    expect(desktopAuthSource.getAccessToken()).toBe("abc");
  });

  it("redirectToLogin triggers the shell sign-in flow", () => {
    const signIn = vi.fn();
    setBridge({ signIn, getAccessToken: () => null });
    desktopAuthSource.redirectToLogin();
    expect(signIn).toHaveBeenCalledOnce();
  });

  it("refresh is unauthenticated and clears when there is no refresh token", async () => {
    const clear = vi.fn();
    setBridge({ signIn: () => {}, getAccessToken: () => null, getRefreshToken: () => null, clear });
    expect(await desktopAuthSource.refresh()).toEqual({ kind: "unauthenticated" });
    expect(clear).toHaveBeenCalledOnce();
  });

  it("refresh exchanges the refresh token, stores the rotated pair, returns ok+token", async () => {
    const setTokens = vi.fn();
    setBridge({
      signIn: () => {},
      getAccessToken: () => "old",
      getRefreshToken: () => "rt",
      setTokens,
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ accessToken: "newA", refreshToken: "newR", user: { id: "u1" } }),
    }) as unknown as typeof fetch;

    expect(await desktopAuthSource.refresh()).toEqual({ kind: "ok", token: "newA" });
    expect(setTokens).toHaveBeenCalledWith({
      accessToken: "newA",
      refreshToken: "newR",
      user: { id: "u1" },
    });
    const [, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ refreshToken: "rt" });
  });

  it("refresh clears and is unauthenticated on a 401 (dead session)", async () => {
    const clear = vi.fn();
    setBridge({ signIn: () => {}, getAccessToken: () => "old", getRefreshToken: () => "rt", clear });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }) as unknown as typeof fetch;
    expect(await desktopAuthSource.refresh()).toEqual({ kind: "unauthenticated" });
    expect(clear).toHaveBeenCalledOnce();
  });

  it("refresh is transient and does NOT clear on a 5xx (server blip)", async () => {
    const clear = vi.fn();
    setBridge({ signIn: () => {}, getAccessToken: () => "old", getRefreshToken: () => "rt", clear });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }) as unknown as typeof fetch;
    expect(await desktopAuthSource.refresh()).toEqual({ kind: "transient" });
    expect(clear).not.toHaveBeenCalled();
  });

  it("refresh is transient and does NOT clear when the network fetch throws (offline)", async () => {
    const clear = vi.fn();
    setBridge({ signIn: () => {}, getAccessToken: () => "old", getRefreshToken: () => "rt", clear });
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new TypeError("Failed to fetch")) as unknown as typeof fetch;
    expect(await desktopAuthSource.refresh()).toEqual({ kind: "transient" });
    expect(clear).not.toHaveBeenCalled();
  });
});

describe("[COMP:app-web/desktop-auth-source] classifyRefreshStatus", () => {
  it("maps 2xx to ok", () => {
    expect(classifyRefreshStatus(200)).toBe("ok");
    expect(classifyRefreshStatus(204)).toBe("ok");
  });

  it("maps 400/401/403 to unauthenticated (a dead session)", () => {
    expect(classifyRefreshStatus(400)).toBe("unauthenticated");
    expect(classifyRefreshStatus(401)).toBe("unauthenticated");
    expect(classifyRefreshStatus(403)).toBe("unauthenticated");
  });

  it("maps everything else (5xx, 429, 0) to transient — never a logout", () => {
    expect(classifyRefreshStatus(500)).toBe("transient");
    expect(classifyRefreshStatus(502)).toBe("transient");
    expect(classifyRefreshStatus(429)).toBe("transient");
    expect(classifyRefreshStatus(0)).toBe("transient");
  });
});
