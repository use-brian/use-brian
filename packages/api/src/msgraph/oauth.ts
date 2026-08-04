/**
 * `oauth.ts` — server-side half of the Microsoft Graph connect round trip.
 *
 * The authorize URL is still built in the browser (app-web's
 * `lib/msgraph-oauth.ts`), because that half needs no secret. The **exchange**
 * runs here, in the API, for the reason the Shopify BYO flow states plainly:
 * a workspace-owned client secret must never leave this process, and app-web
 * has no database to read it from anyway.
 *
 * The scope string both halves send comes from `@use-brian/shared`
 * (`msGraphScopes`), not from a list in either package — an authorize call and
 * a code exchange that disagree about scope is a failure mode that only shows
 * up as a consent screen missing a permission.
 *
 * See docs/architecture/integrations/msgraph.md → "Auth".
 */

export type MsGraphIdTokenClaims = {
  /** Entra tenant id (`tid`) the user signed in from. */
  tenantId?: string
  /** Connected account address, for the "Connected: <email>" UI and instance label. */
  email?: string
}

/** base64url → UTF-8. */
function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(padded, 'base64').toString('utf8')
}

/**
 * Read `tid` and the account address out of an `id_token`.
 *
 * The signature is intentionally NOT verified: this token arrived over TLS in a
 * direct server-to-server response from the token endpoint, which OIDC Core
 * §3.1.3.7 names as the case where a client may skip signature validation. The
 * claims are used for display metadata and the refresh authority only — never
 * for authorization, which is carried entirely by the session and the access
 * token.
 *
 * Returns an empty object for anything unparseable; a missing id_token is an
 * expected outcome (no `openid` granted), not an error.
 */
export function decodeMsGraphIdToken(idToken: string | undefined): MsGraphIdTokenClaims {
  if (!idToken) return {}
  const payload = idToken.split('.')[1]
  if (!payload) return {}
  try {
    const claims = JSON.parse(base64UrlDecode(payload)) as {
      tid?: unknown
      email?: unknown
      preferred_username?: unknown
      upn?: unknown
    }
    const tenantId = typeof claims.tid === 'string' ? claims.tid : undefined
    const email = [claims.email, claims.preferred_username, claims.upn].find(
      (value): value is string => typeof value === 'string' && value.includes('@'),
    )
    return { ...(tenantId ? { tenantId } : {}), ...(email ? { email } : {}) }
  } catch {
    return {}
  }
}
