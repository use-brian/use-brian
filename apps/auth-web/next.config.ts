import type { NextConfig } from "next";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const openRoot = resolve(import.meta.dirname, "../..");
const platformRoot = resolve(openRoot, "..");
const workspaceRoot = existsSync(resolve(platformRoot, "pnpm-workspace.yaml")) ? platformRoot : openRoot;
const portalDevHost = (() => {
  if (!process.env.AUTH_PORTAL_URL) return null;
  try {
    return new URL(process.env.AUTH_PORTAL_URL).hostname;
  } catch {
    return null;
  }
})();

const config: NextConfig = {
  ...(portalDevHost ? { allowedDevOrigins: [portalDevHost] } : {}),
  output: "standalone",
  outputFileTracingRoot: workspaceRoot,
  turbopack: { root: workspaceRoot },
  poweredByHeader: false,
  async headers() {
    return [{
      source: "/(.*)",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'" },
      ],
    }];
  },
};

export default config;
