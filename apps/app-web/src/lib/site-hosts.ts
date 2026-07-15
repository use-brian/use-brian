/**
 * Host + path classification for the middleware (`src/proxy.ts`) — extracted
 * pure so the custom-domain routing boundary is unit-testable.
 *
 * App origins serve the product; any other Host is a customer's custom
 * domain and gets rewritten wholesale to the public `/site/<host>/...`
 * renderer. See docs/architecture/features/custom-domains.md.
 *
 * [COMP:app-web/site-route]
 */

/**
 * The deployment's own origins — the ONLY config that decides app vs
 * customer-site routing. Comma-separated, inlined at build time; entries are
 * exact hosts (`app.example.com`) or `.suffix` matchers (`.vercel.app` for
 * platform previews). No product hostname lives in code.
 *
 * FAIL-SAFE: unset in production means custom-domain serving stays DARK —
 * every host classifies as an app origin, exactly the pre-feature behavior.
 * A misconfigured deploy can never route its own app origin into the public
 * site renderer. Dev (no config) falls back to "localhost family = app,
 * anything else = customer site" so local testing needs no setup.
 */
const APP_HOSTS = (process.env.NEXT_PUBLIC_APP_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

function isLocalHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".localhost")
  );
}

function matchesEntry(host: string, entry: string): boolean {
  if (entry.startsWith(".")) {
    return host === entry.slice(1) || host.endsWith(entry);
  }
  return host === entry;
}

export function isAppHost(host: string): boolean {
  if (!host) return true; // no Host header — never treat as a customer site
  if (isLocalHost(host)) return true;
  if (APP_HOSTS.length === 0) {
    // Unconfigured: dark in prod (everything is the app), permissive in dev.
    return process.env.NODE_ENV === "production";
  }
  return APP_HOSTS.some((entry) => matchesEntry(host, entry));
}

/** Lowercased hostname without port from a raw Host / X-Forwarded-Host value. */
export function normalizeHostHeader(raw: string): string {
  return raw.split(",")[0].trim().toLowerCase().replace(/:\d+$/, "");
}

/** The auth-guarded operator prefixes — mirrors the pre-custom-domain
 *  matcher. The matcher now also carries a broad entry (host routing needs
 *  to see every path), so the guard must scope itself. */
const GUARDED_EXACT = new Set(["/teams", "/redeem"]);
const GUARDED_PREFIXES = [
  "/w",
  "/home",
  "/brain",
  "/studio",
  "/workflow",
  "/chat",
  "/settings",
  "/workspaces",
  "/approvals",
  "/knowledge-base",
  "/memories",
];

export function isGuardedPath(pathname: string): boolean {
  if (GUARDED_EXACT.has(pathname)) return true;
  return GUARDED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
