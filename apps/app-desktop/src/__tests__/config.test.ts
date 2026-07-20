import { describe, it, expect } from "vitest";

import { resolveConfig, PROTOCOL_SCHEME } from "../config.js";
import { serializePersistedTarget } from "../target-store.js";

describe("[COMP:app-desktop/config] resolveConfig", () => {
  it("defaults to the production app + API URLs with no env override", () => {
    const cfg = resolveConfig({});
    // Post-consolidation default: the authenticated app is app.usebrian.ai
    // `deriveApiUrl` maps the app. host -> the sibling api. backend.
    expect(cfg.appUrl).toBe("https://app.usebrian.ai");
    expect(cfg.appOrigin).toBe("https://app.usebrian.ai");
    expect(cfg.apiUrl).toBe("https://api.usebrian.ai");
    expect(cfg.protocolScheme).toBe(PROTOCOL_SCHEME);
  });

  it("honours USEBRIAN_APP_URL and strips a trailing slash", () => {
    const cfg = resolveConfig({ USEBRIAN_APP_URL: "http://localhost:3003/" });
    expect(cfg.appUrl).toBe("http://localhost:3003");
    expect(cfg.appOrigin).toBe("http://localhost:3003");
  });

  it("honours an explicit USEBRIAN_API_URL and strips a trailing slash", () => {
    const cfg = resolveConfig({ USEBRIAN_API_URL: "http://localhost:4000/" });
    expect(cfg.apiUrl).toBe("http://localhost:4000");
  });

  it("derives the API URL from the app URL when USEBRIAN_API_URL is unset", () => {
    // Local canvas pairs with the local API (the mismatch that 404'd the exchange).
    expect(resolveConfig({ USEBRIAN_APP_URL: "http://localhost:3003" }).apiUrl).toBe(
      "http://localhost:4000",
    );
    // Prod canvas pairs with prod API.
    expect(resolveConfig({}).apiUrl).toBe("https://api.usebrian.ai");
    // canvas.<domain> -> api.<domain>.
    expect(resolveConfig({ USEBRIAN_APP_URL: "https://canvas.example.com" }).apiUrl).toBe(
      "https://api.example.com",
    );
    // app.<domain> -> api.<domain> (the post-Phase-3 authenticated origin; §9 #1).
    expect(resolveConfig({ USEBRIAN_APP_URL: "https://app.example.com" }).apiUrl).toBe(
      "https://api.example.com",
    );
    // app.usebrian.ai -> api.usebrian.ai: the shell keeps working after the cutover
    // even before DEFAULT_APP_URL flips, as long as the env points at it.
    expect(resolveConfig({ USEBRIAN_APP_URL: "https://app.usebrian.ai" }).apiUrl).toBe(
      "https://api.usebrian.ai",
    );
  });

  it("lets an explicit API URL override the derivation", () => {
    const cfg = resolveConfig({
      USEBRIAN_APP_URL: "http://localhost:3003",
      USEBRIAN_API_URL: "https://api.usebrian.ai",
    });
    expect(cfg.apiUrl).toBe("https://api.usebrian.ai");
  });

  it("derives the origin from a URL that carries a path", () => {
    const cfg = resolveConfig({ USEBRIAN_APP_URL: "https://staging.example.com/canvas" });
    expect(cfg.appOrigin).toBe("https://staging.example.com");
  });

  it("defaults the quick-capture hotkey and lets env override it", () => {
    expect(resolveConfig({}).quickCaptureHotkey).toBe("CommandOrControl+Shift+Space");
    expect(
      resolveConfig({ USEBRIAN_QUICK_CAPTURE_HOTKEY: "CommandOrControl+Alt+K" }).quickCaptureHotkey,
    ).toBe("CommandOrControl+Alt+K");
  });

  it("ignores blank env values and falls back to defaults", () => {
    const cfg = resolveConfig({ USEBRIAN_APP_URL: "  ", USEBRIAN_QUICK_CAPTURE_HOTKEY: "" });
    expect(cfg.appUrl).toBe("https://app.usebrian.ai");
    expect(cfg.quickCaptureHotkey).toBe("CommandOrControl+Shift+Space");
  });

  it("defaults bundled mode off and reads USEBRIAN_BUNDLED (1/true, case-insensitive)", () => {
    expect(resolveConfig({}).bundled).toBe(false);
    expect(resolveConfig({ USEBRIAN_BUNDLED: "1" }).bundled).toBe(true);
    expect(resolveConfig({ USEBRIAN_BUNDLED: "true" }).bundled).toBe(true);
    expect(resolveConfig({ USEBRIAN_BUNDLED: "TRUE" }).bundled).toBe(true);
    expect(resolveConfig({ USEBRIAN_BUNDLED: "0" }).bundled).toBe(false);
    expect(resolveConfig({ USEBRIAN_BUNDLED: "no" }).bundled).toBe(false);
  });

  it("defaults auto-update on and reads USEBRIAN_DISABLE_AUTO_UPDATE (1/true, case-insensitive)", () => {
    expect(resolveConfig({}).autoUpdate).toBe(true);
    expect(resolveConfig({ USEBRIAN_DISABLE_AUTO_UPDATE: "1" }).autoUpdate).toBe(false);
    expect(resolveConfig({ USEBRIAN_DISABLE_AUTO_UPDATE: "true" }).autoUpdate).toBe(false);
    expect(resolveConfig({ USEBRIAN_DISABLE_AUTO_UPDATE: "TRUE" }).autoUpdate).toBe(false);
    expect(resolveConfig({ USEBRIAN_DISABLE_AUTO_UPDATE: "0" }).autoUpdate).toBe(true);
    expect(resolveConfig({ USEBRIAN_DISABLE_AUTO_UPDATE: "no" }).autoUpdate).toBe(true);
  });

  it("returns a frozen config", () => {
    const cfg = resolveConfig({});
    expect(Object.isFrozen(cfg)).toBe(true);
  });
});

describe("[COMP:app-desktop/config] resolveConfig target resolution (§2.1)", () => {
  it("defaults to the cloud target with no persisted record (today's behavior, byte for byte)", () => {
    const cfg = resolveConfig({});
    expect(cfg.target).toBe("cloud");
    expect(cfg.targetAuth).toBe("pkce");
    expect(cfg.targetLabel).toBe("Use Brian Cloud");
    expect(cfg.envTargetOverride).toBe(false);
    expect(cfg.appUrl).toBe("https://app.usebrian.ai");
    expect(cfg.apiUrl).toBe("https://api.usebrian.ai");
  });

  it("resolves a persisted local record to its address, paired API, and local-session auth", () => {
    const cfg = resolveConfig({}, serializePersistedTarget("local", "http://localhost:3003"));
    expect(cfg.target).toBe("local");
    expect(cfg.targetAuth).toBe("local-session");
    expect(cfg.targetLabel).toBe("Local Brain (localhost:3003)");
    expect(cfg.appUrl).toBe("http://localhost:3003");
    expect(cfg.apiUrl).toBe("http://localhost:4000");
  });

  it("pairs a self-hosted address with its own backend, never the cloud API", () => {
    const cfg = resolveConfig({}, serializePersistedTarget("local", "https://brain.example.com"));
    expect(cfg.appUrl).toBe("https://brain.example.com");
    expect(cfg.apiUrl).toBe("https://brain.example.com:4000");
  });

  it("keeps a persisted cloud record on cloud (the remembered local address is inert)", () => {
    const cfg = resolveConfig({}, serializePersistedTarget("cloud", "http://myserver:3003"));
    expect(cfg.target).toBe("cloud");
    expect(cfg.appUrl).toBe("https://app.usebrian.ai");
  });

  it("falls back to cloud on a corrupt record", () => {
    const cfg = resolveConfig({}, "{not json");
    expect(cfg.target).toBe("cloud");
    expect(cfg.appUrl).toBe("https://app.usebrian.ai");
  });

  it("lets the env override win the whole target (dev semantics, PKCE auth) and flags it honestly", () => {
    const cfg = resolveConfig(
      { USEBRIAN_APP_URL: "http://localhost:3003" },
      serializePersistedTarget("local", "http://myserver:3003"),
    );
    expect(cfg.appUrl).toBe("http://localhost:3003");
    expect(cfg.apiUrl).toBe("http://localhost:4000");
    expect(cfg.target).toBe("cloud");
    expect(cfg.targetAuth).toBe("pkce");
    // The flag lets main.ts refuse a target switch that could never survive
    // the relaunch, and the label stops the indicator claiming "Cloud".
    expect(cfg.envTargetOverride).toBe(true);
    expect(cfg.targetLabel).toBe("Dev override (localhost:3003)");
  });

  it("lets an explicit USEBRIAN_API_URL override a persisted local pairing", () => {
    const cfg = resolveConfig(
      { USEBRIAN_API_URL: "http://localhost:5000" },
      serializePersistedTarget("local", "http://localhost:3003"),
    );
    expect(cfg.appUrl).toBe("http://localhost:3003");
    expect(cfg.apiUrl).toBe("http://localhost:5000");
    expect(cfg.targetAuth).toBe("local-session");
  });
});
