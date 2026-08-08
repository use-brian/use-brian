/**
 * Content-Security-Policy for custom Home app bundles.
 *
 * This is the codebase's FIRST CSP, and it is scoped to bundle serving only —
 * it does not apply to any first-party surface. That narrowness is the point:
 * a CSP over our own app would be a large, ongoing compatibility surface,
 * while a CSP over third-party bundles is a small, fixed contract the bundle
 * format already constrains.
 *
 * What it does NOT have to defend against, because the iframe already does:
 * the frame is `sandbox="allow-scripts allow-forms"` with **no
 * `allow-same-origin`**, so the bundle executes at an OPAQUE origin. It has no
 * cookies, no storage, and no reach into app-web — even though its bytes come
 * from our API origin. The CSP is the second layer: it bounds where the code
 * can *send* things, which the sandbox does not.
 *
 * `connect-src` is therefore the interesting directive. It carries the API
 * origin (the bridge) plus whatever `scopes.net` origins an admin explicitly
 * consented to, and nothing else. Every origin in that list was validated by
 * `isSafeNetOrigin` — a bare https origin with no path, no wildcard, and no
 * character that could terminate a directive — because these strings are
 * concatenated straight into a response header.
 *
 * Spec: docs/architecture/features/home-apps.md → "Serving + the bridge".
 * [COMP:api/home-app-bundle-route]
 */

import { isSafeNetOrigin } from '@use-brian/brian-app'

/**
 * Build the bundle CSP.
 *
 * `default-src 'none'` is the base — everything is denied and then narrowly
 * re-allowed, so a directive we forget fails closed.
 *
 * `'unsafe-inline'` is permitted for scripts and styles: bundles are hand- or
 * agent-authored single-page HTML, inline `<script>` and `<style>` are the
 * normal shape, and the opaque origin means inline code cannot reach anything
 * that is not already reachable. Nonce-per-request would break the static-file
 * model entirely (the HTML is stored, not templated).
 */
/**
 * Is this a safe origin to put in `frame-ancestors`?
 *
 * Deliberately NOT `isSafeNetOrigin`, which requires https — correct for a
 * `connect-src` origin an app asked for, wrong here, because the framer in
 * local development is `http://localhost:3003` and rejecting it would leave the
 * frame blocked on every developer's machine.
 *
 * The property that actually matters is the same either way: the string is
 * concatenated into a response header, so it must be a bare origin with no
 * path, no wildcard, and nothing that could terminate the directive.
 */
function isSafeFramerOrigin(value: string): boolean {
  if (/[;,'"\s]/.test(value)) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  if (url.username || url.password) return false
  if (url.hostname.includes('*')) return false
  // `origin` drops any path/query, so an input carrying one round-trips
  // unequal and is refused rather than silently truncated.
  return url.origin === value
}

export function buildBundleCsp(params: {
  /** The API origin the bridge lives on. */
  apiOrigin: string
  /**
   * The web origin allowed to FRAME the bundle — app-web.
   *
   * This cannot be `'self'`. The bundle is served from the API origin, so
   * `'self'` means "only the API may frame this", and the only thing that ever
   * frames it is app-web on a DIFFERENT origin (`app.usebrian.ai` vs
   * `api.usebrian.ai`; `:3003` vs `:4000` in dev). The browser blocked every
   * custom Home app frame, which Chrome reports as "refused to connect" —
   * indistinguishable from a dead server, which is why it read as one.
   *
   * Unset falls back to `'self'`: that is wrong for a split-origin deploy but
   * it is the pre-existing behaviour, and a CSP that silently allowed ANY
   * framer would be a far worse default than one that blocks.
   */
  appOrigin?: string
  /** Consented `scopes.net` origins. Anything unsafe is dropped, not trusted. */
  netOrigins?: readonly string[]
}): string {
  const connect = [
    "'self'",
    params.apiOrigin,
    ...(params.netOrigins ?? []).filter(isSafeNetOrigin),
  ]
  // De-dupe so a manifest naming our own origin does not produce a repeat.
  const connectSrc = [...new Set(connect)].join(' ')

  return [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    // No plugins, no nested framing, no form posts off-origin, and the bundle
    // may not itself frame anything.
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "form-action 'none'",
    // Only app-web may frame the bundle — see `appOrigin`. Never `'self'`
    // alone: the bundle's own origin is the API, which never frames anything.
    `frame-ancestors ${
      params.appOrigin && isSafeFramerOrigin(params.appOrigin)
        ? `'self' ${params.appOrigin}`
        : "'self'"
    }`,
    "base-uri 'none'",
  ].join('; ')
}
