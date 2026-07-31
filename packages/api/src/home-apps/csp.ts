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
export function buildBundleCsp(params: {
  /** The API origin the bridge lives on. */
  apiOrigin: string
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
    // The bundle is already inside our frame; it must not be framed elsewhere.
    "frame-ancestors 'self'",
    "base-uri 'none'",
  ].join('; ')
}
