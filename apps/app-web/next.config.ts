import type { NextConfig } from "next";
import dotenv from "dotenv";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";

const GIT_COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

function normalizedCommit(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && GIT_COMMIT_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

// Keep this resolution self-contained. Next loads its compiled config when a
// source-free release starts, so sibling TypeScript build helpers are absent.
function resolveOssGitCommitSha(): string {
  const configured =
    normalizedCommit(process.env.NEXT_PUBLIC_OSS_GIT_COMMIT_SHA) ??
    normalizedCommit(process.env.OSS_GIT_COMMIT_SHA);
  if (configured) return configured;

  try {
    const repositoryRoot = realpathSync(resolve(import.meta.dirname, "..", ".."));
    const discoveredGitRoot = realpathSync(
      execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
    if (discoveredGitRoot !== repositoryRoot) return "";

    return (
      normalizedCommit(
        execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: repositoryRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }),
      ) ?? ""
    );
  } catch {
    return "";
  }
}

// Load .env from monorepo root
dotenv.config({ path: resolve(import.meta.dirname, "..", "..", ".env") });

const API_URL = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const APP_DEV_HOST = (() => {
  const configured = process.env.AUTHED_APP_URL ?? process.env.NEXT_PUBLIC_AUTHED_APP_URL;
  if (!configured) return null;
  try {
    return new URL(configured).hostname;
  } catch {
    return null;
  }
})();
const OSS_GIT_COMMIT_SHA = resolveOssGitCommitSha();
const nextPackagePath = realpathSync(
  createRequire(import.meta.url).resolve("next/package.json"),
);
const workspaceRoot = nextPackagePath.slice(
  0,
  nextPackagePath.indexOf(`${sep}node_modules${sep}`),
);

// Keep this in the compiled config: Next's requireFromString cannot resolve
// sibling config helpers. The browser regression checks parity with Vite's
// scripts/collab-singletons.mjs, including actual import/require constructors.
const appRequire = createRequire(import.meta.url);
const pmRoot = resolve(dirname(appRequire.resolve("@tiptap/pm/view")), "../..");
const pm = JSON.parse(readFileSync(resolve(pmRoot, "package.json"), "utf8"));
const pmRequire = createRequire(resolve(pmRoot, "package.json"));
const collabSingletonAliases: Record<string, string> = Object.fromEntries(
  ["yjs", "y-prosemirror", ...Object.keys(pm.dependencies).filter(name => name.startsWith("prosemirror-"))]
    .map(name => {
      const entry = (name.startsWith("prosemirror-") ? pmRequire : appRequire).resolve(name);
      const root = resolve(dirname(entry), "..");
      const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
      return [name, realpathSync(resolve(root, manifest.module))];
    }),
);

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: workspaceRoot,
  ...(APP_DEV_HOST ? { allowedDevOrigins: [APP_DEV_HOST] } : {}),
  // app-web runs both standalone and absorbed into the platform workspace.
  // Follow the physical pnpm store so Turbopack can resolve Next in either.
  turbopack: {
    root: workspaceRoot,
    resolveAlias: Object.fromEntries(Object.entries(collabSingletonAliases).map(([name, path]) =>
      [name, `./${relative(import.meta.dirname, path).replaceAll("\\", "/")}`])),
  },
  webpack(config) {
    Object.assign(config.resolve.alias, collabSingletonAliases);
    return config;
  },
  env: {
    // Public build provenance for Settings. Prefer OSS_GIT_COMMIT_SHA when a
    // source archive omits .git; ordinary checkout builds resolve HEAD.
    NEXT_PUBLIC_OSS_GIT_COMMIT_SHA: OSS_GIT_COMMIT_SHA,
    // Preserve hosted build-only public provider metadata. Runtime config can
    // override these fallbacks; never inline server URLs or client secrets.
    NEXT_PUBLIC_GOOGLE_CLIENT_ID:
      process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID ?? "",
    NEXT_PUBLIC_GOOGLE_API_KEY:
      process.env.NEXT_PUBLIC_GOOGLE_API_KEY ?? process.env.GOOGLE_API_KEY ?? "",
    NEXT_PUBLIC_GOOGLE_PROJECT_NUMBER:
      process.env.NEXT_PUBLIC_GOOGLE_PROJECT_NUMBER ?? process.env.GOOGLE_PROJECT_NUMBER ?? "",
    // NOTE: no NEXT_PUBLIC_MSGRAPH_* here. The Entra app for Microsoft Teams is
    // resolved per WORKSPACE in the API (its own registration first, then
    // MSGRAPH_CLIENT_ID / MSGRAPH_CLIENT_SECRET from this deployment), and a
    // build-time env var cannot express "this workspace uses its own app". The
    // browser asks GET /api/connectors/msgraph/app-credentials for the client
    // id and tenant, which are public and ride in the authorize URL.
    // See docs/architecture/integrations/msgraph.md -> "Auth".
  },
  experimental: {
    // The development `/api` rewrite runs through Next's proxy, whose socket
    // idle timeout defaults to 30 s. It cut `POST /api/chat` SSE during a
    // silent turn preparation; built app-web has no rewrite and so no such
    // cut. 30 minutes matches the hosted API request cap
    // (deployment.md, Cloud Run `--timeout=1800`) and stays far below
    // Node's 2^31-1 ms timer limit. See deployment.md -> "Development /api
    // proxy". Regression: scripts/dev-proxy-silent-stream.mjs.
    proxyTimeout: 30 * 60 * 1000,
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
