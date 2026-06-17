import type { NextConfig } from "next";
import dotenv from "dotenv";
import { resolve } from "node:path";

// Load .env from monorepo root
dotenv.config({ path: resolve(import.meta.dirname, "..", "..", ".env") });

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? "",
    API_URL: API_URL,
    NEXT_PUBLIC_API_URL: process.env.NODE_ENV === "development" ? "" : API_URL,
    NEXT_PUBLIC_CORE_WEB_URL: process.env.NEXT_PUBLIC_CORE_WEB_URL ?? "https://sidan.ai",
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
