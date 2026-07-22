import type { NextConfig } from "next";
import dotenv from "dotenv";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, sep } from "node:path";

// Load .env from monorepo root
dotenv.config({ path: resolve(import.meta.dirname, "..", "..", ".env") });

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const nextPackagePath = realpathSync(
  createRequire(import.meta.url).resolve("next/package.json"),
);
const workspaceRoot = nextPackagePath.slice(
  0,
  nextPackagePath.indexOf(`${sep}node_modules${sep}`),
);

const nextConfig: NextConfig = {
  // app-web runs both standalone and absorbed into the platform workspace.
  // Follow the physical pnpm store so Turbopack can resolve Next in either.
  turbopack: {
    root: workspaceRoot,
  },
  env: {
    NEXT_PUBLIC_GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? "",
    // The un-blanked origin for URLs DISPLAYED to users — see lib/display-api-url.ts.
    // This is deliberately inlined: client components render it.
    //
    // `API_URL` is NOT inlined here. Server-side machine-to-machine callers
    // (proxy.ts, /api/auth/*, lib/server-fetch.ts) must resolve it at RUNTIME so
    // a deploy can point them at a private origin (localhost) while the browser
    // keeps dialing the public one. Inlining froze both to the same public URL,
    // which sent app-web's own sign-in fetch out through the CDN — where
    // Cloudflare Access answered with an HTML login page and the handler died on
    // JSON.parse. Same freezing trap as NODE_ENV in PR #66.
    NEXT_PUBLIC_DISPLAY_API_URL: API_URL,
    // Dev defaults to "" (browser uses the /api rewrite). But the dev rewrite
    // BUFFERS gzip SSE responses, so streaming endpoints (WhatsApp QR connect)
    // hang. An explicit NEXT_PUBLIC_API_URL override lets dev hit the API
    // directly (CORS-allowed), bypassing the rewrite.
    NEXT_PUBLIC_API_URL:
      process.env.NEXT_PUBLIC_API_URL ??
      (process.env.NODE_ENV === "development" ? "" : API_URL),
    NEXT_PUBLIC_CORE_WEB_URL: process.env.NEXT_PUBLIC_CORE_WEB_URL ?? "https://usebrian.ai",
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? "",
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? "",
  },
  async rewrites() {
    if (process.env.NODE_ENV !== "development") return [];
    return [{ source: "/api/:path*", destination: `${API_URL}/api/:path*` }];
  },
  async redirects() {
    return [
      // Company-brain §1: team -> workspace IA rename. Old feed-web bookmarks
      // /t/<id>/* land on /w/<id>/* via 308 (cacheable permanent redirect —
      // UUIDs are preserved unchanged because the database column was renamed
      // in place).
      // Remove after 2026-06-08.
      {
        source: "/t/:workspaceId/:path*",
        destination: "/w/:workspaceId/:path*",
        permanent: true,
      },
      {
        source: "/t/:workspaceId",
        destination: "/w/:workspaceId",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
