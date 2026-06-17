/**
 * Twitter (X) OAuth 2.0 PKCE helpers.
 *
 * Platform-specific pieces of the OAuth flow — scope list, authorize URL
 * builder. Everything else (state signing, eligibility, connection persist,
 * PKCE math) lives in the shared helpers in
 * `packages/api/src/feed/oauth-helpers.ts`.
 *
 * See docs/architecture/feed/twitter.md.
 */

export const AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize'

/**
 * All scopes we request at connect time. Phase 1 uses `tweet.read`,
 * `tweet.write`, `users.read`, `offline.access`. Phase 1B adds `list.read`
 * for the Lists discovery UI used by inspiration-feed (Lists *content* is
 * already readable via tweet.read; this scope unlocks listing the user's
 * own / followed Lists for the workspace dropdown). Phase 2 adds
 * `tweet.moderate.write` for hide/unhide — we request it up front so users
 * don't re-consent when 2A ships.
 *
 * Scopes are space-separated in the authorize URL (unlike Threads' commas).
 *
 * See docs/architecture/feed/inspiration-feed.md for the list.read rationale.
 */
export const SCOPES = [
  'tweet.read',
  'tweet.write',
  'users.read',
  'offline.access',
  'list.read',
  'tweet.moderate.write',
]

export type BuildAuthorizeUrlParams = {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
}

/** Assemble the X consent-screen redirect URL. */
export function buildAuthorizeUrl(params: BuildAuthorizeUrlParams): string {
  const qs = new URLSearchParams({
    response_type: 'code',
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    scope: SCOPES.join(' '),
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
  })
  return `${AUTHORIZE_URL}?${qs.toString()}`
}
