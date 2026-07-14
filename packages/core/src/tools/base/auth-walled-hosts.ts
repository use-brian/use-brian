/**
 * Auth-walled hosts — pages whose body sits behind a login wall.
 *
 * The HTTP fetch stack (readability → jina → raw) cannot read these without a
 * signed-in session: the site returns a 403/999 or, worse, serves the "sign in
 * to continue" interstitial as if it were the real content. LinkedIn member
 * profiles are the canonical case — a `urlReader` on `linkedin.com/in/<slug>`
 * dead-ends, and the model, told to chain `webSearch → urlReader → cite`, then
 * concludes it cannot even surface the URL and punts back to the user
 * (the David-Yeung incident, 2026-07-14).
 *
 * `url-reader.ts` consults `isAuthWalledUrl` up-front and short-circuits with
 * `authWalledGuidance` instead of running the stack, so a login wall never
 * masquerades as content and the model is told, in-band, that the URL it
 * already has IS the deliverable. This mirrors the X-host treatment in the
 * fetch stack, where readability/jina/raw refuse `x.com` for the same reason
 * (see docs/architecture/integrations/search-and-fetch.md → "Auth-walled
 * hosts: discovery vs reading").
 *
 * DISCOVERY IS UNAFFECTED. `webSearch` still returns these URLs (Google indexes
 * the public profile card, so Serper/Brave/DDG surface it) — finding the URL
 * is a search-layer job and needs no login. This module governs only the
 * separate job of reading the page body, which genuinely requires a session.
 *
 * The rule list is deliberately narrow and extensible: match only paths that
 * are reliably login-gated (LinkedIn member + organisation pages), leaving
 * incidentally-public paths (e.g. `linkedin.com/pulse/<article>`) to the
 * normal stack. Add a rule here when a new host proves it dead-ends the stack.
 *
 * [COMP:tools/fetch]
 */

type AuthWalledRule = {
  /** Registrable-host matcher — anchored so `notlinkedin.com` never matches. */
  host: RegExp
  /** Optional pathname matcher. Omitted → the whole host is auth-walled. */
  path?: RegExp
}

const AUTH_WALLED_RULES: AuthWalledRule[] = [
  // LinkedIn: member profiles (/in/, /pub/) and organisation pages
  // (/company/, /school/) are login-gated for anything but the truncated
  // public card. Articles (/pulse/) and job posts (/jobs/) are left to the
  // normal stack because they are often readable.
  { host: /(^|\.)linkedin\.com$/i, path: /^\/(in|pub|company|school)\//i },
  // Instagram is uniformly login-gated for non-browser scrapers, profiles
  // and posts alike.
  { host: /(^|\.)instagram\.com$/i },
]

/**
 * True when `rawUrl` points at a page whose body the HTTP fetch stack cannot
 * read without a signed-in session. Malformed URLs return false (the stack
 * will reject them on its own).
 */
export function isAuthWalledUrl(rawUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  return AUTH_WALLED_RULES.some(
    (rule) => rule.host.test(parsed.hostname) && (!rule.path || rule.path.test(parsed.pathname)),
  )
}

/**
 * In-band guidance returned in place of a fetch when the URL is auth-walled.
 * Written to stop the model treating an unreadable page as a dead end: the URL
 * itself is the answer for a "find the profile" task, so surface it and cite
 * the search snippet rather than reporting that nothing was found.
 */
export function authWalledGuidance(url: string): string {
  return (
    `This page is behind a login wall, so its body cannot be fetched without a signed-in session. ` +
    `The URL itself is valid and is the answer for a "find the page/profile" request: ${url}. ` +
    `Give the user this URL and cite the webSearch result's title and snippet as the source. ` +
    `Do NOT report that the lookup failed or that no URL could be found. ` +
    `Reading the full page body (beyond the public snippet) needs a live, signed-in browser session, not urlReader.`
  )
}
