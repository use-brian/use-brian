import { describe, it, expect } from "vitest";

import { resolveConfig, PROTOCOL_SCHEME } from "../config.js";
import { serializePersistedTarget } from "../target-store.js";

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

describe("[COMP:app-desktop/config] resolveConfig target resolution (§2.1)", () => {
  it("defaults to the cloud target with no persisted record (today's behavior, byte for byte)", () => {
    const cfg = resolveConfig({});
    expect(cfg.target).toBe("cloud");
    expect(cfg.targetAuth).toBe("pkce");
    expect(cfg.targetLabel).toBe("sidanclaw Cloud");
    expect(cfg.envTargetOverride).toBe(false);
    expect(cfg.appUrl).toBe("https://app.sidan.ai");
    expect(cfg.apiUrl).toBe("https://api.sidan.ai");
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
    expect(cfg.appUrl).toBe("https://app.sidan.ai");
  });

  it("falls back to cloud on a corrupt record", () => {
    const cfg = resolveConfig({}, "{not json");
    expect(cfg.target).toBe("cloud");
    expect(cfg.appUrl).toBe("https://app.sidan.ai");
  });

  it("lets the env override win the whole target (dev semantics, PKCE auth) and flags it honestly", () => {
    const cfg = resolveConfig(
      { SIDANCLAW_APP_URL: "http://localhost:3003" },
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

  it("lets an explicit SIDANCLAW_API_URL override a persisted local pairing", () => {
    const cfg = resolveConfig(
      { SIDANCLAW_API_URL: "http://localhost:5000" },
      serializePersistedTarget("local", "http://localhost:3003"),
    );
    expect(cfg.appUrl).toBe("http://localhost:3003");
    expect(cfg.apiUrl).toBe("http://localhost:5000");
    expect(cfg.targetAuth).toBe("local-session");
  });
});
