import { describe, it, expect } from "vitest";

import { resolveConfig, PROTOCOL_SCHEME } from "../config.js";

describe("[COMP:app-desktop/config] resolveConfig", () => {
  it("defaults to the production app + API URLs with no env override", () => {
    const cfg = resolveConfig({});
    // Post-consolidation default: the authenticated app is app.sidan.ai
    // `deriveApiUrl` maps the app. host -> the sibling api. backend.
    expect(cfg.appUrl).toBe("https://app.sidan.ai");
    expect(cfg.appOrigin).toBe("https://app.sidan.ai");
    expect(cfg.apiUrl).toBe("https://api.sidan.ai");
    expect(cfg.protocolScheme).toBe(PROTOCOL_SCHEME);
  });

  it("honours SIDANCLAW_APP_URL and strips a trailing slash", () => {
    const cfg = resolveConfig({ SIDANCLAW_APP_URL: "http://localhost:3003/" });
    expect(cfg.appUrl).toBe("http://localhost:3003");
    expect(cfg.appOrigin).toBe("http://localhost:3003");
  });

  it("honours an explicit SIDANCLAW_API_URL and strips a trailing slash", () => {
    const cfg = resolveConfig({ SIDANCLAW_API_URL: "http://localhost:4000/" });
    expect(cfg.apiUrl).toBe("http://localhost:4000");
  });

  it("derives the API URL from the app URL when SIDANCLAW_API_URL is unset", () => {
    // Local canvas pairs with the local API (the mismatch that 404'd the exchange).
    expect(resolveConfig({ SIDANCLAW_APP_URL: "http://localhost:3003" }).apiUrl).toBe(
      "http://localhost:4000",
    );
    // Prod canvas pairs with prod API.
    expect(resolveConfig({}).apiUrl).toBe("https://api.sidan.ai");
    // canvas.<domain> -> api.<domain>.
    expect(resolveConfig({ SIDANCLAW_APP_URL: "https://canvas.example.com" }).apiUrl).toBe(
      "https://api.example.com",
    );
    // app.<domain> -> api.<domain> (the post-Phase-3 authenticated origin; §9 #1).
    expect(resolveConfig({ SIDANCLAW_APP_URL: "https://app.example.com" }).apiUrl).toBe(
      "https://api.example.com",
    );
    // app.sidan.ai -> api.sidan.ai: the shell keeps working after the cutover
    // even before DEFAULT_APP_URL flips, as long as the env points at it.
    expect(resolveConfig({ SIDANCLAW_APP_URL: "https://app.sidan.ai" }).apiUrl).toBe(
      "https://api.sidan.ai",
    );
  });

  it("lets an explicit API URL override the derivation", () => {
    const cfg = resolveConfig({
      SIDANCLAW_APP_URL: "http://localhost:3003",
      SIDANCLAW_API_URL: "https://api.sidan.ai",
    });
    expect(cfg.apiUrl).toBe("https://api.sidan.ai");
  });

  it("derives the origin from a URL that carries a path", () => {
    const cfg = resolveConfig({ SIDANCLAW_APP_URL: "https://staging.example.com/canvas" });
    expect(cfg.appOrigin).toBe("https://staging.example.com");
  });

  it("defaults the quick-capture hotkey and lets env override it", () => {
    expect(resolveConfig({}).quickCaptureHotkey).toBe("CommandOrControl+Shift+Space");
    expect(
      resolveConfig({ SIDANCLAW_QUICK_CAPTURE_HOTKEY: "CommandOrControl+Alt+K" }).quickCaptureHotkey,
    ).toBe("CommandOrControl+Alt+K");
  });

  it("ignores blank env values and falls back to defaults", () => {
    const cfg = resolveConfig({ SIDANCLAW_APP_URL: "  ", SIDANCLAW_QUICK_CAPTURE_HOTKEY: "" });
    expect(cfg.appUrl).toBe("https://app.sidan.ai");
    expect(cfg.quickCaptureHotkey).toBe("CommandOrControl+Shift+Space");
  });

  it("defaults bundled mode off and reads SIDANCLAW_BUNDLED (1/true, case-insensitive)", () => {
    expect(resolveConfig({}).bundled).toBe(false);
    expect(resolveConfig({ SIDANCLAW_BUNDLED: "1" }).bundled).toBe(true);
    expect(resolveConfig({ SIDANCLAW_BUNDLED: "true" }).bundled).toBe(true);
    expect(resolveConfig({ SIDANCLAW_BUNDLED: "TRUE" }).bundled).toBe(true);
    expect(resolveConfig({ SIDANCLAW_BUNDLED: "0" }).bundled).toBe(false);
    expect(resolveConfig({ SIDANCLAW_BUNDLED: "no" }).bundled).toBe(false);
  });

  it("defaults auto-update on and reads SIDANCLAW_DISABLE_AUTO_UPDATE (1/true, case-insensitive)", () => {
    expect(resolveConfig({}).autoUpdate).toBe(true);
    expect(resolveConfig({ SIDANCLAW_DISABLE_AUTO_UPDATE: "1" }).autoUpdate).toBe(false);
    expect(resolveConfig({ SIDANCLAW_DISABLE_AUTO_UPDATE: "true" }).autoUpdate).toBe(false);
    expect(resolveConfig({ SIDANCLAW_DISABLE_AUTO_UPDATE: "TRUE" }).autoUpdate).toBe(false);
    expect(resolveConfig({ SIDANCLAW_DISABLE_AUTO_UPDATE: "0" }).autoUpdate).toBe(true);
    expect(resolveConfig({ SIDANCLAW_DISABLE_AUTO_UPDATE: "no" }).autoUpdate).toBe(true);
  });

  it("returns a frozen config", () => {
    const cfg = resolveConfig({});
    expect(Object.isFrozen(cfg)).toBe(true);
  });
});
