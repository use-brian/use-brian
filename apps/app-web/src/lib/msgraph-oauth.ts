/**
 * Microsoft Graph (Teams) OAuth - endpoints, scope resolution, authorize-URL
 * builder, id_token claim reader.
 *
 * Shared by the two halves of the round trip so they can never disagree: the
 * Studio connect handler (client) builds the authorize URL, and
 * `/api/auth/callback/msgraph` (server) exchanges the code with the SAME scope
 * string. A second hardcoded scope list in the callback is exactly how an
 * authorize/exchange pair drifts.
 *
 * Auth model: standard env-var OAuth, like `notion` and `fathom`. One Use
 * Brian-owned Entra app; `NEXT_PUBLIC_MSGRAPH_CLIENT_ID` in the browser,
 * `MSGRAPH_CLIENT_SECRET` server-side only. Delegated authorization-code grant
 * with `offline_access`, so the credential is per-user and rotating.
 *
 * See docs/architecture/integrations/msgraph.md.
 */

import { OFFICIAL_OAUTH_SCOPES } from "@use-brian/shared/builtin-connectors";

/**
 * Tenant segment of the Entra endpoints. `organizations` restricts the account
 * picker to work/school accounts, the only population this connector can serve:
 * every Teams delegated permission publishes "Delegated (personal Microsoft
 * account): Not supported", so under `common` a user could pick a personal MSA,
 * complete consent *successfully*, and then have all nine tools fail at runtime
 * with nothing actionable to tell them. Microsoft is explicit about the consent
 * half too - "Do not use 'common', as personal accounts cannot provide admin
 * consent except in the context of a tenant" - and `ChannelMessage.Read.All`
 * requires admin consent unconditionally. Research note §2.2 + the multitenant
 * decision table; the app registers as `signInAudience: AzureADMultipleOrgs`.
 *
 * The env override exists to pin a single tenant id or domain, which is
 * strictly narrower than `organizations`. Authorize and token must use the SAME
 * segment, which is why both derive from this one const - and it must stay in
 * step with `DEFAULT_TENANT` in `packages/api/src/msgraph/token.ts`, which owns
 * the refresh half of the same round trip.
 */
const MSGRAPH_TENANT = process.env.NEXT_PUBLIC_MSGRAPH_TENANT?.trim() || "organizations";

export const MSGRAPH_AUTHORIZE_URL = `https://login.microsoftonline.com/${MSGRAPH_TENANT}/oauth2/v2.0/authorize`;
export const MSGRAPH_TOKEN_URL = `https://login.microsoftonline.com/${MSGRAPH_TENANT}/oauth2/v2.0/token`;

/**
 * OIDC baseline scopes, requested alongside whatever Graph permissions the
 * registry declares.
 *
 * They deliberately do NOT live in `OFFICIAL_OAUTH_SCOPES.msgraph`: that table
 * is the inventory of *Graph resource permissions* an admin reads on the
 * consent screen, and Entra collapses openid/profile/email into a single "Sign
 * you in and read your profile" line. `offline_access` is what makes a refresh
 * token appear at all - without it the connection dies about an hour after
 * connecting.
 *
 * `openid` is also what produces the `id_token` we read the tenant id and the
 * connected account's address from, so the connect flow needs no extra Graph
 * call to label the instance.
 */
const MSGRAPH_BASE_SCOPES = ["offline_access", "openid", "profile", "email"];

/**
 * The full scope set for the authorize request and the code exchange.
 * The Graph half is derived from the registry, never restated here.
 */
export function msGraphScopes(): string[] {
  const graphScopes = OFFICIAL_OAUTH_SCOPES.msgraph ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const scope of [...MSGRAPH_BASE_SCOPES, ...graphScopes]) {
    if (seen.has(scope)) continue;
    seen.add(scope);
    out.push(scope);
  }
  return out;
}

/**
 * Build the Entra authorize URL. `response_mode=query` keeps the code in the
 * query string, which is what the callback route reads.
 */
export function buildMsGraphAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  /** Built by `buildConnectorState` - carries the connector, workspace, and CSRF nonce. */
  state: string;
  /** Defaults to `msGraphScopes()`; injectable for tests. */
  scopes?: string[];
}): string {
  const sp = new URLSearchParams({
    client_id: input.clientId,
    response_type: "code",
    redirect_uri: input.redirectUri,
    response_mode: "query",
    scope: (input.scopes ?? msGraphScopes()).join(" "),
    state: input.state,
  });
  return `${MSGRAPH_AUTHORIZE_URL}?${sp}`;
}

export type MsGraphIdTokenClaims = {
  /** Entra tenant id (`tid`) the user signed in from. */
  tenantId?: string;
  /** Connected account address, for the "Connected: <email>" UI and the instance label. */
  email?: string;
};

/**
 * Read `tid` and the account address out of an `id_token`.
 *
 * The signature is intentionally NOT verified: this token arrived over TLS in a
 * direct server-to-server response from the token endpoint, which OIDC Core
 * §3.1.3.7 names as the case where a client may skip signature validation. The
 * claims are used for display metadata only - never for authorization, which is
 * carried entirely by the session cookie and the access token.
 *
 * Returns an empty object for anything unparseable; a missing id_token is an
 * expected outcome (no `openid` scope granted), not an error.
 */
export function decodeMsGraphIdToken(idToken: string | undefined): MsGraphIdTokenClaims {
  if (!idToken) return {};
  const payload = idToken.split(".")[1];
  if (!payload) return {};
  try {
    const claims = JSON.parse(base64UrlDecode(payload)) as {
      tid?: unknown;
      email?: unknown;
      preferred_username?: unknown;
      upn?: unknown;
    };
    const tenantId = typeof claims.tid === "string" ? claims.tid : undefined;
    const email = [claims.email, claims.preferred_username, claims.upn].find(
      (value): value is string => typeof value === "string" && value.includes("@"),
    );
    return { ...(tenantId ? { tenantId } : {}), ...(email ? { email } : {}) };
  } catch {
    return {};
  }
}

/** base64url -> UTF-8. `atob` + `TextDecoder` so this works in the browser bundle too. */
function base64UrlDecode(segment: string): string {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
