// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Synthetic tests never load workspace dotenv; the config calls it at import.
vi.mock("dotenv", () => ({ default: { config: () => ({ parsed: {} }) } }));

const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const NODE_TIMER_MAX_MS = 2 ** 31 - 1;

async function loadConfig() {
  vi.resetModules();
  return (await import("../../next.config")).default;
}

afterEach(() => vi.unstubAllEnvs());

describe("[COMP:app-web/dev-api-proxy] development /api rewrite proxy", () => {
  it("raises the Next proxy idle timeout past a silent chat preparation", async () => {
    const config = await loadConfig();
    const timeout = config.experimental?.proxyTimeout;
    expect(timeout).toBe(THIRTY_MINUTES_MS);
    // Larger than Node's timer limit would collapse to a 1 ms timeout.
    expect(timeout).toBeLessThan(NODE_TIMER_MAX_MS);
  });

  it("proxies /api to API_URL only under next dev", async () => {
    vi.stubEnv("API_URL", "http://127.0.0.1:4999");
    vi.stubEnv("NODE_ENV", "development");
    const dev = await loadConfig();
    expect(await dev.rewrites?.()).toEqual([
      { source: "/api/:path*", destination: "http://127.0.0.1:4999/api/:path*" },
    ]);

    vi.stubEnv("NODE_ENV", "production");
    const built = await loadConfig();
    expect(await built.rewrites?.()).toEqual([]);
  });

  it("matches the installed Next proxy, which reads experimental.proxyTimeout as a socket idle timeout", () => {
    const nextRoot = dirname(createRequire(import.meta.url).resolve("next/package.json"));
    const proxy = readFileSync(join(nextRoot, "dist/server/lib/router-utils/proxy-request.js"), "utf8");
    const router = readFileSync(join(nextRoot, "dist/server/lib/router-server.js"), "utf8");
    expect(proxy).toContain("proxyTimeout || 30000");
    expect(router).toContain("config.experimental.proxyTimeout");
  });
});
