/**
 * Desktop connector-OAuth `state` — the server-side PARSE half.
 *
 * The desktop shell (apps/app-desktop) can't complete the browser-cookie CSRF
 * the web connector flow uses: consent runs in the SYSTEM browser, a different
 * cookie jar than the Electron renderer that set the nonce, so
 * `verifyConnectorState` always fails there (this was the bug —
 * docs/plans/desktop-connector-oauth-return.md). Instead the shell drives an
 * RFC 8252 loopback flow (mirroring desktop sign-in) and encodes its loopback
 * target + a CSRF nonce into the OAuth `state` as a base64url-JSON blob with a
 * `d1.` prefix. Google/Notion echo `state` verbatim on the callback; this module
 * parses it so the callback can forward the raw `code` to the shell's loopback
 * (host-validated by `loopbackRedirectBase`) instead of exchanging in the
 * browser. The exchange + store then happen shell-side with the shell's own
 * session.
 *
 * The matching BUILD half lives in the shell
 * (apps/app-desktop/src/desktop-connector-oauth.ts) — keep the two in sync.
 *
 * Server-only (kept out of `connector-oauth-state.ts` so the client bundle never
 * pulls `Buffer`).
 * [COMP:app-web/connector-oauth-desktop]
 */

import { loopbackRedirectBase } from "@/lib/desktop-loopback";

/** Marks a `state` string as the desktop (loopback) shape, version 1. */
export const DESKTOP_CONNECTOR_STATE_PREFIX = "d1.";

// Local copies of the boundary regexes (kept private to this server module).
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export type DesktopConnectorState = {
  connector: string;
  workspaceId: string | undefined;
  createNew: boolean;
  instanceId: string | undefined;
  nonce: string;
  /** The shell's loopback base (unvalidated here; caller runs `loopbackRedirectBase`). */
  loopback: string;
};

/**
 * Parse a desktop connector `state`. Returns null for a non-desktop state (the
 * web colon format) or any malformed/invalid blob — the caller then falls back
 * to the web `parseConnectorState`. A missing connector, a bad nonce, a
 * non-string loopback, or a malformed instance id is rejected here; the loopback
 * HOST is validated by the caller (`loopbackRedirectBase`) before any redirect.
 */
export function parseDesktopConnectorState(raw: string): DesktopConnectorState | null {
  if (!raw || !raw.startsWith(DESKTOP_CONNECTOR_STATE_PREFIX)) return null;
  let obj: Record<string, unknown>;
  try {
    const b64 = raw.slice(DESKTOP_CONNECTOR_STATE_PREFIX.length);
    obj = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const connector = typeof obj.c === "string" ? obj.c : "";
  const nonce = typeof obj.n === "string" ? obj.n : "";
  const loopback = typeof obj.l === "string" ? obj.l : "";
  if (!connector || !NONCE_RE.test(nonce) || !loopback) return null;
  const workspaceId = typeof obj.w === "string" && obj.w ? obj.w : undefined;
  const instanceRaw = typeof obj.i === "string" ? obj.i : "";
  const instanceId = instanceRaw && UUID_RE.test(instanceRaw) ? instanceRaw : undefined;
  const createNew = obj.a === 1 || obj.a === true;
  return { connector, workspaceId, createNew, instanceId, nonce, loopback };
}

/**
 * Build the loopback URL a connector callback should 302 the OAuth result to on
 * the desktop path: `<loopback>/cb?code=<code>&state=<nonce>` (or `?error=…`).
 * The loopback HOST is validated here (`loopbackRedirectBase`) so a tampered
 * `state.loopback` can never turn the callback into an open redirect that leaks
 * the code off the machine. Returns null when the loopback is invalid — the
 * caller then falls back to a web error redirect (the shell never gets the
 * code, so nothing is stored). The shell re-verifies the echoed `state` nonce
 * against the one it minted before acting on the code (`parseLoopbackCallback`).
 */
export function buildLoopbackForwardUrl(
  state: DesktopConnectorState,
  result: { code?: string | null; error?: string | null },
): string | null {
  const base = loopbackRedirectBase(state.loopback);
  if (!base) return null;
  const qs = new URLSearchParams({ state: state.nonce });
  if (result.error) qs.set("error", result.error);
  else if (result.code) qs.set("code", result.code);
  else qs.set("error", "no_code");
  return `${base}?${qs.toString()}`;
}
