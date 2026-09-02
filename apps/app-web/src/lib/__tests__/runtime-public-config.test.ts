// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  desktopApiOverride,
  publicRuntimeConfig,
  resolveRuntimePublicConfig,
  runtimePublicConfigScript,
} from "@/lib/runtime-public-config";

describe("[COMP:app-web/runtime-public-config] runtime public config", () => {
  afterEach(() => {
    delete window.__USE_BRIAN_PUBLIC_CONFIG__;
    window.history.replaceState({}, "", "/");
  });

  it("derives public URLs from runtime domain variables", () => {
    expect(
      resolveRuntimePublicConfig({
        API_DOMAIN: "api.example.com",
        DOC_SYNC_DOMAIN: "docs.example.com",
        PUBLIC_APP_URL: "https://marketing.example.com",
        USEBRIAN_EDITION: "oss",
      }),
    ).toMatchObject({
      apiUrl: "https://api.example.com",
      displayApiUrl: "https://api.example.com",
      docSyncUrl: "wss://docs.example.com",
      appUrl: "https://marketing.example.com",
      edition: "oss",
    });
  });

  it("preserves an intentionally empty same-origin API URL", () => {
    const config = resolveRuntimePublicConfig({
      PUBLIC_API_URL: "",
      PUBLIC_DISPLAY_API_URL: "https://api.example.com",
    });
    expect(config.apiUrl).toBe("");
    expect(config.displayApiUrl).toBe("https://api.example.com");
  });

  it("prefers an explicit display URL over the browser API origin", () => {
    const config = resolveRuntimePublicConfig({
      PUBLIC_API_URL: "https://browser-api.example.com",
      PUBLIC_DISPLAY_API_URL: "https://canonical-api.example.com",
    });
    expect(config.displayApiUrl).toBe("https://canonical-api.example.com");
  });

  it("accepts ordinary runtime names for public provider metadata", () => {
    expect(
      resolveRuntimePublicConfig({
        GOOGLE_CLIENT_ID: "google-client",
        PUBLIC_GOOGLE_API_KEY: "google-key",
        GOOGLE_PROJECT_NUMBER: "123",
        NOTION_CLIENT_ID: "notion-client",
        FATHOM_CLIENT_ID: "fathom-client",
      }),
    ).toMatchObject({
      googleClientId: "google-client",
      googleApiKey: "google-key",
      googleProjectNumber: "123",
      notionClientId: "notion-client",
      fathomClientId: "fathom-client",
    });
  });

  it("uses same-origin browser requests when no public API is configured", () => {
    expect(resolveRuntimePublicConfig({ NODE_ENV: "production" }).apiUrl).toBe("");
  });

  it("prefers runtime provider ids over compatibility build values", () => {
    const config = resolveRuntimePublicConfig({
      GOOGLE_CLIENT_ID: "runtime-google",
      NEXT_PUBLIC_GOOGLE_CLIENT_ID: "legacy-google",
      NOTION_CLIENT_ID: "runtime-notion",
      NEXT_PUBLIC_NOTION_CLIENT_ID: "legacy-notion",
      FATHOM_CLIENT_ID: "runtime-fathom",
      NEXT_PUBLIC_FATHOM_CLIENT_ID: "legacy-fathom",
    });
    expect(config.googleClientId).toBe("runtime-google");
    expect(config.notionClientId).toBe("runtime-notion");
    expect(config.fathomClientId).toBe("runtime-fathom");
  });

  it("reads the config injected into the initial HTML", () => {
    const config = resolveRuntimePublicConfig({
      PUBLIC_API_URL: "https://runtime.example.com",
    });
    window.__USE_BRIAN_PUBLIC_CONFIG__ = config;
    expect(publicRuntimeConfig()).toBe(config);
  });

  it("ignores an API query override on an ordinary web page", () => {
    window.__USE_BRIAN_PUBLIC_CONFIG__ = resolveRuntimePublicConfig({
      PUBLIC_API_URL: "https://web.example.com",
    });
    window.history.replaceState({}, "", "/?api=https%3A%2F%2Fdesktop.example.com");
    expect(publicRuntimeConfig().apiUrl).toBe("https://web.example.com");
  });

  it("accepts the API query override only for the packaged file renderer", () => {
    expect(
      desktopApiOverride({
        protocol: "file:",
        search: "?api=https%3A%2F%2Fdesktop.example.com",
      }),
    ).toBe("https://desktop.example.com");
    expect(
      desktopApiOverride({
        protocol: "https:",
        search: "?api=https%3A%2F%2Fattacker.example.com",
      }),
    ).toBeNull();
  });

  it("escapes values that could terminate the inline script", () => {
    const config = resolveRuntimePublicConfig({
      PUBLIC_API_URL: "https://example.com/</script><script>alert(1)</script>",
    });
    const script = runtimePublicConfigScript(config);
    expect(script).not.toContain("</script>");
    expect(script).toContain("\\u003c/script>");
  });
});
