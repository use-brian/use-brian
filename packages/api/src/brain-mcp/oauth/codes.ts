/**
 * OAuth signed-blob helpers.
 *
 * Two signed payloads cross trust boundaries during the OAuth flow:
 *
 *   1. **Consent request blob.** Built at GET /authorize, sent via the
 *      browser to the web app's consent page, then echoed back on POST
 *      /consent. Carries the OAuth params plus an expiry. If anything along
 *      the way tampers with it, the HMAC fails and the consent page errors.
 *
 *   2. **Authorization codes.** Issued as `oac_<id>_<secret>` and verified
 *      via the oauth-authorization-store (single-use, scrypt-hashed at
 *      rest). Helpers here are only for the request blob.
 *
 * The HMAC secret reuses `JWT_SECRET` — there is exactly one server-side
 * signing secret in this codebase, and adding a second would just be a
 * second thing to leak.
 *
 * Component tag: [COMP:api/brain-oauth].
 */

import { signOAuthState, verifyOAuthState } from '../../oauth-state.js'

export type OAuthConsentRequest = {
  clientId: string
  redirectUri: string
  codeChallenge: string
  codeChallengeMethod: 'S256'
  scope: 'read' | 'read_write'
  state: string | null
  /** Epoch seconds when this consent request is no longer valid. */
  exp: number
}

export const CONSENT_REQUEST_TTL_SECONDS = 10 * 60

/**
 * HMAC-sign a consent request. The browser carries the result through the
 * web app and back to /consent; tampering breaks the signature and the
 * server returns 400.
 */
export function signConsentRequest(req: OAuthConsentRequest, secret: string): string {
  return signOAuthState(JSON.stringify(req), secret)
}

/**
 * Verify a signed consent request. Returns null on a bad signature, a
 * structural problem, or expiry — caller renders a uniform error.
 */
export function verifyConsentRequest(
  signed: string,
  secret: string,
): OAuthConsentRequest | null {
  const raw = verifyOAuthState(signed, secret)
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const req = parsed as Partial<OAuthConsentRequest>
  if (
    typeof req.clientId !== 'string' ||
    typeof req.redirectUri !== 'string' ||
    typeof req.codeChallenge !== 'string' ||
    req.codeChallengeMethod !== 'S256' ||
    (req.scope !== 'read' && req.scope !== 'read_write') ||
    typeof req.exp !== 'number'
  ) {
    return null
  }
  // state is optional (RFC 6749 §4.1.1 — recommended but not required).
  if (req.state !== null && req.state !== undefined && typeof req.state !== 'string') {
    return null
  }
  if (req.exp <= Math.floor(Date.now() / 1000)) return null
  return {
    clientId: req.clientId,
    redirectUri: req.redirectUri,
    codeChallenge: req.codeChallenge,
    codeChallengeMethod: 'S256',
    scope: req.scope,
    state: req.state ?? null,
    exp: req.exp,
  }
}
