/**
 * Desktop connector OAuth (Google / Notion) — the BUILD half of the loopback
 * handoff. The app-web PARSE half is
 * `apps/app-web/src/lib/connector-oauth-desktop.ts`; keep the state format in
 * sync with it.
 *
 * Why this exists: connecting a Google/Notion connector from the shell can't use
 * the web flow's browser-cookie CSRF — consent runs in the SYSTEM browser, a
 * different cookie jar than the Electron renderer that set the nonce, so the
 * callback's `verifyConnectorState` always fails there (the bug). So we mirror
 * desktop SIGN-IN (`desktop-auth.ts`): an ephemeral `http://127.0.0.1:<port>/cb`
 * loopback (RFC 8252 §7.3) receives the OAuth `code` back, bound to a state
 * nonce; the shell then hands the code to the API's `exchange-and-store` over
 * TLS with its OWN bearer. Client secrets never touch the shell, and the code
 * transits the loopback URL exactly as sign-in's does.
 *
 * Everything here is pure / IO-injectable so it unit-tests with no Electron.
 * Spec: docs/architecture/features/app-desktop.md → "Connector OAuth" and
 * docs/plans/desktop-connector-oauth-return.md.
 * [COMP:app-desktop/connector-oauth]
 */

import { randomBytes } from "node:crypto";

/** Marks the `state` as the desktop (loopback) shape, v1. Matches app-web. */
export const DESKTOP_CONNECTOR_STATE_PREFIX = "d1.";

/** Provider authorize hosts the shell will open for a connector connect. */
const ALLOWED_AUTHORIZE_HOSTS = ["accounts.google.com", "api.notion.com"];

const CONNECTOR_RE = /^[a-z0-9_-]{1,40}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A validated connector-connect request from the (untrusted) renderer. */
export interface ConnectorConnectRequest {
  connector: string;
  /** Provider authorize URL, params built, WITHOUT `state` (we append our own). */
  authorizeUrl: string;
  /** The provider redirect_uri the API must reuse for the token exchange. */
  redirectUri: string;
  workspaceId: string;
  createNew: boolean;
  instanceId?: string;
}

/**
 * Validate the renderer's connect payload. Returns null (caller ignores) for
 * anything malformed or pointing the browser at a non-provider host — the shell
 * must never `openExternal` an arbitrary URL on the renderer's say-so.
 */
export function parseConnectRequest(raw: unknown): ConnectorConnectRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const connector = typeof r.connector === "string" ? r.connector : "";
  const authorizeUrl = typeof r.authorizeUrl === "string" ? r.authorizeUrl : "";
  const redirectUri = typeof r.redirectUri === "string" ? r.redirectUri : "";
  const workspaceId = typeof r.workspaceId === "string" ? r.workspaceId : "";
  if (!CONNECTOR_RE.test(connector) || !authorizeUrl || !redirectUri || !workspaceId) return null;

  let authHost: string;
  try {
    authHost = new URL(authorizeUrl).hostname;
  } catch {
    return null;
  }
  if (!ALLOWED_AUTHORIZE_HOSTS.includes(authHost)) return null;

  // The redirect_uri must be an https app-origin callback (the shell reuses it
  // verbatim for the exchange) — never a loopback or a foreign scheme.
  try {
    if (new URL(redirectUri).protocol !== "https:") return null;
  } catch {
    return null;
  }

  const createNew = r.createNew === true;
  const instanceId =
    typeof r.instanceId === "string" && UUID_RE.test(r.instanceId) ? r.instanceId : undefined;
  return { connector, authorizeUrl, redirectUri, workspaceId, createNew, instanceId };
}

/** Mint a URL-safe nonce (base64url; matches app-web's NONCE_RE, 16-128 chars). */
export function generateConnectorNonce(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * Build the desktop connector `state` blob the app-web callback parses
 * (`parseDesktopConnectorState`): base64url JSON with a `d1.` prefix carrying the
 * loopback + nonce so the callback forwards the code back to THIS shell.
 */
export function buildDesktopConnectorState(input: {
  connector: string;
  workspaceId: string;
  nonce: string;
  loopback: string;
  createNew?: boolean;
  instanceId?: string;
}): string {
  const obj: Record<string, unknown> = {
    c: input.connector,
    w: input.workspaceId,
    n: input.nonce,
    l: input.loopback,
  };
  if (input.createNew) obj.a = 1;
  if (input.instanceId) obj.i = input.instanceId;
  return DESKTOP_CONNECTOR_STATE_PREFIX + Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/** Append the desktop `state` to the provider authorize URL. */
export function buildConnectorAuthorizeUrl(authorizeUrl: string, state: string): string {
  const sep = authorizeUrl.includes("?") ? "&" : "?";
  return `${authorizeUrl}${sep}state=${encodeURIComponent(state)}`;
}

/**
 * The branded page the loopback tab lands on once the code is captured, so the
 * user never lingers on the bare `127.0.0.1:<port>/cb?code=…` URL. `error` swaps
 * to the "didn't finish" copy.
 */
export function buildConnectorConnectedPageUrl(appUrl: string, opts: { error?: boolean } = {}): string {
  const base = `${appUrl}/desktop/connector-connected`;
  return opts.error ? `${base}?status=error` : base;
}

/** The connectors path the shell navigates the app window to after connecting. */
export function buildConnectorsReturnPath(
  workspaceId: string,
  opts: { connector?: string; instanceId?: string; error?: string } = {},
): string {
  const sp = new URLSearchParams();
  if (opts.error) {
    sp.set("error", opts.error);
  } else {
    if (opts.connector) sp.set("connected", opts.connector);
    if (opts.instanceId) sp.set("instance", opts.instanceId);
  }
  const qs = sp.toString();
  return `/w/${workspaceId}/studio/connectors${qs ? `?${qs}` : ""}`;
}

type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Hand the OAuth `code` to the API's `exchange-and-store` with the shell's own
 * bearer. The API exchanges server-side (secret stays there) and stores on a
 * connector_instance. Returns the minted/updated instance id, or throws on a
 * non-OK response (the caller shows a dialog + returns to the connectors page).
 */
export async function exchangeAndStore(
  apiUrl: string,
  accessToken: string,
  req: { connector: string; code: string; redirectUri: string; createNew?: boolean; instanceId?: string },
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<string | undefined> {
  const res = await fetchImpl(`${apiUrl}/api/connectors/${req.connector}/exchange-and-store`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      code: req.code,
      redirectUri: req.redirectUri,
      ...(req.instanceId ? { instanceId: req.instanceId } : req.createNew ? { createNew: true } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Connector exchange failed (HTTP ${res.status})`);
  const data = (await res.json()) as { connectorInstanceId?: string };
  return data.connectorInstanceId;
}
