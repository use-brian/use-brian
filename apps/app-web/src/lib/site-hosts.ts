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

/** Extra app origins (staging), comma-separated, inlined at build time. */
const EXTRA_APP_HOSTS = (process.env.NEXT_PUBLIC_APP_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

export function isAppHost(host: string): boolean {
  if (!host) return true; // no Host header — never treat as a customer site
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (host.endsWith(".localhost")) return true;
  if (host === "sidan.ai" || host.endsWith(".sidan.ai")) return true;
  if (host === "sidan.io" || host.endsWith(".sidan.io")) return true;
  if (host.endsWith(".vercel.app")) return true;
  return EXTRA_APP_HOSTS.includes(host);
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
