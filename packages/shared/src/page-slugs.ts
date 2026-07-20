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

/** `.suffix` entries match the suffix (and the bare apex); anything else is
 *  an exact hostname. No product hostnames live in code — the deployment
 *  passes its own (`PAGE_DOMAIN_BLOCKED_HOSTS` + derived origin hosts). */
export function hostMatchesEntry(hostname: string, entry: string): boolean {
  const e = entry.trim().toLowerCase();
  if (!e) return false;
  if (e.startsWith('.')) {
    const apex = e.slice(1);
    return hostname === apex || hostname.endsWith(e);
  }
  return hostname === e;
}

/**
 * Common multi-part public-suffix second levels (`example.co.uk`,
 * `example.com.au`). Not a bundled public-suffix list — just a guard so the
 * apex-derivation below never turns a registrable domain sitting directly under
 * one of these into a block on the whole suffix (`.co.uk`). Extend via config,
 * never a product hostname.
 */
const PUBLIC_SUFFIX_SECOND_LEVELS = new Set([
  'co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gr',
]);

/**
 * Derive `.apex` suffix-block entries from a deployment's own origin hosts, so
 * a subdomain of the product's OWN domain (which rides the product's wildcard
 * DNS) can never be attached as a "bring your own" custom domain. Such a host
 * resolves for free via the wildcard yet the edge 404s it, so without this it
 * would falsely verify as live — and it isn't a customer domain anyway.
 *
 * An origin with < 3 labels yields nothing: its exact host is already blocked,
 * and stripping a label off a 2-label apex would produce a bare TLD. A parent
 * that looks like a known public suffix (`co.uk`) is skipped so self-hosts on
 * multi-part TLDs don't block their whole registrar namespace. First-party
 * publishing under the product apex therefore needs an explicit operator
 * allowlist or a separate apex — see custom-domains.md.
 */
export function deriveOwnApexBlocks(originHosts: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of originHosts) {
    const host = raw.trim().toLowerCase().replace(/\.$/, '');
    const labels = host.split('.').filter(Boolean);
    if (labels.length < 3) continue;
    const parent = labels.slice(1);
    if (parent.length === 2 && PUBLIC_SUFFIX_SECOND_LEVELS.has(parent[0])) continue;
    out.add('.' + parent.join('.'));
  }
  return [...out];
}

/**
 * Normalize user input ("https://Docs.Acme.com/path" → "docs.acme.com").
 * Returns null when the input is not a usable public hostname. IDN input is
 * punycoded via the WHATWG URL parser (browser- and Node-consistent).
 *
 * Only universally non-routable inputs are rejected here (localhost, IPs,
 * single-label names, bad shapes). Which product hostnames a deployment
 * refuses is CONFIG, not code: pass them via `opts.block` (exact hosts or
 * `.suffix` entries — see `hostMatchesEntry`).
 */
export function normalizeHostname(
  input: string,
  opts?: { block?: readonly string[] },
): string | null {
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
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return null;
  for (const entry of opts?.block ?? []) {
    if (hostMatchesEntry(hostname, entry)) return null;
  }
  return hostname;
}
