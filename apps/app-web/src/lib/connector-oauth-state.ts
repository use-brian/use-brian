/**
 * Connector OAuth `state` — build + parse + CSRF verification.
 *
 * The connector-connect flow (`gcal`/`gmail`/`gdrive`/`notion`/`fathom`) builds
 * its own provider authorize URL client-side and threads context through the
 * OAuth `state` parameter. Historically that state was an UNSIGNED
 * `<connector>[:add]:<workspaceId>` string, so the callback trusted whatever it
 * received: an attacker who obtained a valid `code` for their OWN account could
 * lure a signed-in victim to `…/callback/<provider>?code=<attacker>&state=<forged>`
 * and have the attacker's refresh token bound to the VICTIM's user by
 * `store-credentials` (cross-user connector injection — WS3 #5).
 *
 * The fix is the double-submit state-nonce (the canonical OAuth-state CSRF
 * defence): the browser mints a random nonce, embeds it in `state`, AND commits
 * the same nonce to a short-lived `SameSite=Lax` cookie before redirecting to
 * the provider. On the callback we require the `state` nonce to equal the cookie
 * nonce; a forged callback carries no matching cookie for the victim (the
 * attacker cannot set a cookie on our origin), so it is rejected before any
 * token is stored. `SameSite=Lax` still rides the top-level callback navigation,
 * so the legitimate round-trip carries the cookie.
 *
 * This module is the pure seam: format + parse + constant-time compare. The
 * cookie is set / read by `oauth-state-cookie.ts`; the callbacks call
 * `parseConnectorState` then `verifyConnectorState`.
 *
 * Spec: docs/architecture/integrations/notion.md → "State CSRF protection".
 */

/** Name of the companion nonce cookie set before the provider redirect. */
export const CONNECTOR_OAUTH_STATE_COOKIE = "conn_oauth_state";

/** Nonce lifetime — long enough for a consent round-trip, short enough to bound replay. */
export const CONNECTOR_OAUTH_STATE_TTL_SECONDS = 60 * 15;

/** A URL-safe nonce is base64url; this bounds length + alphabet at the boundary. */
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;

export type ConnectorOauthState = {
  /** Provider slug — `gcal` | `gmail` | `gdrive` | `notion` | `fathom`. */
  connector: string;
  /** Active workspace to redirect back into. Undefined for a bare (legacy) slug. */
  workspaceId: string | undefined;
  /** "Add another account" intent — mint a fresh instance, don't overwrite. */
  createNew: boolean;
  /** The CSRF nonce; matched against the companion cookie in the callback. */
  nonce: string | undefined;
};

/**
 * Build the `state` string for the provider authorize URL:
 *   `<connector>[:add]:<workspaceId>:<nonce>`
 *
 * The nonce is appended as the LAST colon-segment (workspace ids are UUIDs and
 * the nonce is base64url — neither contains a colon), so the legacy 3-part
 * parse is a strict prefix of the 4-part parse.
 */
export function buildConnectorState(input: {
  connector: string;
  workspaceId: string;
  createNew?: boolean;
  nonce: string;
}): string {
  const add = input.createNew ? ":add" : "";
  return `${input.connector}${add}:${input.workspaceId}:${input.nonce}`;
}

/**
 * Parse a connector `state`. Accepts both the new 4-part form (with a trailing
 * nonce) and the legacy 3-part form (no nonce) so a callback can tell "old
 * unsigned state" (→ reject as un-verifiable) from a malformed value.
 *
 * `<connector>[:add]:<workspaceId>[:<nonce>]`
 */
export function parseConnectorState(raw: string): ConnectorOauthState {
  const parts = raw.split(":");
  // [connector, (add)?, workspaceId, (nonce)?] — walk from the front for the
  // connector + optional `add`, then the tail is workspaceId (+ optional nonce).
  if (parts.length === 0 || !parts[0]) {
    return { connector: "", workspaceId: undefined, createNew: false, nonce: undefined };
  }
  const connector = parts[0];
  let idx = 1;
  const createNew = parts[idx] === "add";
  if (createNew) idx += 1;

  const workspaceId = parts[idx] || undefined;
  const nonceRaw = parts[idx + 1];
  const nonce = nonceRaw && NONCE_RE.test(nonceRaw) ? nonceRaw : undefined;

  return { connector, workspaceId, createNew, nonce };
}

/**
 * Constant-time string equality (avoids leaking match length via early return).
 * Both operands are short opaque nonces, so a fixed-cost compare is cheap.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The CSRF gate. The state is valid iff BOTH the state and the cookie carry a
 * well-formed nonce and the two match. A forged callback (no state nonce, or no
 * cookie, or a mismatch) is rejected — the legitimate flow set both to the same
 * value before redirecting.
 */
export function verifyConnectorState(input: {
  stateNonce: string | undefined;
  cookieNonce: string | undefined | null;
}): boolean {
  const { stateNonce, cookieNonce } = input;
  if (!stateNonce || !cookieNonce) return false;
  if (!NONCE_RE.test(stateNonce) || !NONCE_RE.test(cookieNonce)) return false;
  return timingSafeEqual(stateNonce, cookieNonce);
}
