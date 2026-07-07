/**
 * Companion nonce cookie for the connector-connect OAuth-state CSRF defence
 * (see `connector-oauth-state.ts` for the threat model).
 *
 * The nonce is minted and committed to a cookie *in the browser* right before
 * the full-page redirect to the provider — the same client component that
 * builds the authorize URL. It is a `SameSite=Lax` cookie so it rides the
 * top-level callback navigation back from the provider; `Secure` in production
 * so it never leaks over plaintext. It is intentionally NOT `HttpOnly`: the
 * client has to write it via `document.cookie`, and the CSRF property does not
 * need HttpOnly — an attacker cannot set this cookie in the victim's browser, so
 * a forged callback's `state` nonce can never match the victim's cookie.
 *
 * Kept separate from `auth-cookies.ts` (server-set auth tokens) because this one
 * is client-set and short-lived; the two share only the `.sidan.ai` domain +
 * `Secure`-in-prod conventions.
 */

import {
  CONNECTOR_OAUTH_STATE_COOKIE,
  CONNECTOR_OAUTH_STATE_TTL_SECONDS,
} from "@/lib/connector-oauth-state";

const isSecure = process.env.NODE_ENV === "production";

/**
 * Build the `document.cookie` attribute string for the nonce cookie. Pure so it
 * can be unit-tested; the caller assigns the result to `document.cookie`.
 *
 * Domain is deliberately omitted: the connector callback is same-origin with
 * the connectors page (both on the app origin), so a host-only cookie suffices
 * and avoids the `.sidan.ai` domain-cookie surface for a value that lives for
 * one round-trip.
 */
export function connectorOauthStateCookieString(nonce: string): string {
  const attrs = [
    `${CONNECTOR_OAUTH_STATE_COOKIE}=${nonce}`,
    "Path=/",
    `Max-Age=${CONNECTOR_OAUTH_STATE_TTL_SECONDS}`,
    "SameSite=Lax",
  ];
  if (isSecure) attrs.push("Secure");
  return attrs.join("; ");
}

/**
 * Mint a URL-safe nonce (base64url, ~128 bits) using the Web Crypto API present
 * in the browser + modern Node. Matches the `NONCE_RE` alphabet + length bound
 * enforced in `connector-oauth-state.ts`.
 */
export function mintOauthStateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Client-only: mint a nonce, commit it to the cookie, and return it so the
 * caller can embed it in the OAuth `state`. Must run in the browser (uses
 * `document`); the connect handlers are client components, so this is always
 * called from a click handler.
 */
export function armConnectorOauthState(): string {
  const nonce = mintOauthStateNonce();
  document.cookie = connectorOauthStateCookieString(nonce);
  return nonce;
}
