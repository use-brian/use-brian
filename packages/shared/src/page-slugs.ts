/**
 * Page slug + custom-domain hostname helpers for published-page sites.
 *
 * Shared between the API (validation, suggestion, resolution) and app-web
 * (client-side suggestion preview in the Publish tab). Browser-safe: no Node
 * imports. Spec: docs/architecture/features/custom-domains.md.
 */

export const PAGE_SLUG_MAX_LENGTH = 64;

/** Lowercase kebab: letters/digits separated by single hyphens. */
export const PAGE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Single-segment paths the site router owns (or that would shadow app-web
 * routes if a custom host ever fell through to the app). Kept small and
 * flat: slugs can never contain `.` or `_`, so file-ish names like
 * robots.txt are unreachable by construction.
 */
export const RESERVED_PAGE_SLUGS: ReadonlySet<string> = new Set([
  'p',
  'api',
  'share',
  'site',
  'assets',
  'static',
  'login',
  'admin',
  'app',
  'w',
]);

export function isValidPageSlug(slug: string): boolean {
  return (
    slug.length > 0 &&
    slug.length <= PAGE_SLUG_MAX_LENGTH &&
    PAGE_SLUG_PATTERN.test(slug) &&
    !RESERVED_PAGE_SLUGS.has(slug)
  );
}

/**
 * Derive a slug suggestion from a page title. Mirrors the
 * fieldKeyFromHeading algorithm (lowercase, collapse non-alphanumerics to
 * hyphens, trim) and de-dupes against `taken` with -2, -3, … suffixes.
 * Falls back to 'page' for titles with no usable characters (e.g. CJK-only
 * titles in v1 — those keep the /p/<id> fallback until a slug is typed).
 */
export function suggestPageSlug(title: string, taken?: ReadonlySet<string>): string {
  let base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PAGE_SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
  if (!base || RESERVED_PAGE_SLUGS.has(base)) base = base ? `${base}-page` : 'page';
  if (!taken?.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, PAGE_SLUG_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Hostnames a customer may never claim: our own product surfaces and hosts
 * a platform can't serve (localhost, IPs, single-label names).
 */
const BLOCKED_HOST_SUFFIXES = ['sidan.ai', 'sidan.io', 'vercel.app', 'localhost'];

/**
 * Normalize user input ("https://Docs.Acme.com/path" → "docs.acme.com").
 * Returns null when the input is not a usable public hostname. IDN input is
 * punycoded via the WHATWG URL parser (browser- and Node-consistent).
 */
export function normalizeHostname(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  let hostname: string;
  try {
    hostname = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return null;
  }
  if (!hostname || hostname.length > 253) return null;
  const labels = hostname.split('.');
  if (labels.length < 2) return null; // single-label (localhost etc.)
  if (!labels.every((label) => HOSTNAME_LABEL.test(label))) return null;
  if (labels.every((label) => /^\d+$/.test(label))) return null; // IPv4
  if (hostname.includes(':')) return null; // IPv6 / port slipped through
  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (hostname === suffix || hostname.endsWith(`.${suffix}`)) return null;
  }
  return hostname;
}
