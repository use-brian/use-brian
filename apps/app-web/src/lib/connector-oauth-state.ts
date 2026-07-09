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

/** A UUID bounds the reconnect-target segment at the parse boundary. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export type ConnectorOauthState = {
  /** Provider slug — `gcal` | `gmail` | `gdrive` | `notion` | `fathom`. */
  connector: string;
  /** Active workspace to redirect back into. Undefined for a bare (legacy) slug. */
  workspaceId: string | undefined;
  /** "Add another account" intent — mint a fresh instance, don't overwrite. */
  createNew: boolean;
  /**
   * Reconnect target — re-point an EXISTING instance's credential instead of
   * minting one. Set when reconnecting a workspace-owned OAuth connector (a
   * cleared teammate re-auths with their own account). Mutually exclusive with
   * `createNew`. Undefined for the connect / add-another flows.
   */
  instanceId: string | undefined;
  /** The CSRF nonce; matched against the companion cookie in the callback. */
  nonce: string | undefined;
};

/**
 * Build the `state` string for the provider authorize URL. Three shapes,
 * disambiguated by the second segment (workspace ids, instance ids, and the
 * base64url nonce never contain a colon, so the split stays unambiguous):
 *   connect      `<connector>:<workspaceId>:<nonce>`
 *   add another  `<connector>:add:<workspaceId>:<nonce>`
 *   reconnect    `<connector>:re:<instanceId>:<workspaceId>:<nonce>`
 */
export function buildConnectorState(input: {
  connector: string;
  workspaceId: string;
  createNew?: boolean;
  instanceId?: string;
  nonce: string;
}): string {
  // Reconnect wins over add-another — they are mutually exclusive intents.
  if (input.instanceId) {
    return `${input.connector}:re:${input.instanceId}:${input.workspaceId}:${input.nonce}`;
  }
  const add = input.createNew ? ":add" : "";
  return `${input.connector}${add}:${input.workspaceId}:${input.nonce}`;
}

/**
 * Parse a connector `state`. Accepts the connect / add-another / reconnect
 * shapes above plus the legacy no-nonce form (→ rejected downstream as
 * un-verifiable). A malformed reconnect instance id is dropped (treated as a
 * plain connect) rather than trusted.
 */
export function parseConnectorState(raw: string): ConnectorOauthState {
  const parts = raw.split(":");
  if (parts.length === 0 || !parts[0]) {
    return { connector: "", workspaceId: undefined, createNew: false, instanceId: undefined, nonce: undefined };
  }
  const connector = parts[0];
  let idx = 1;
  let createNew = false;
  let instanceId: string | undefined;
  if (parts[idx] === "add") {
    createNew = true;
    idx += 1;
  } else if (parts[idx] === "re") {
    idx += 1;
    const raw = parts[idx];
    instanceId = raw && UUID_RE.test(raw) ? raw : undefined;
    idx += 1;
  }

  const workspaceId = parts[idx] || undefined;
  const nonceRaw = parts[idx + 1];
  const nonce = nonceRaw && NONCE_RE.test(nonceRaw) ? nonceRaw : undefined;

  return { connector, workspaceId, createNew, instanceId, nonce };
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
