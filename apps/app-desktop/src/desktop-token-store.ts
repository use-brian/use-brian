/**
 * Desktop token store — the Bearer-token persistence core for the **bundled**
 * desktop app (Phase 4, docs/plans/canvas-desktop-bundled-offline.md).
 *
 * The thin remote shell authenticates with `.usebrian.ai` cookies written into the
 * Electron cookie jar (`buildSessionCookies` in `desktop-auth.ts`). A bundled
 * app loads from a `file://` / `app://` origin where those cookies don't apply,
 * so it must hold the JWT pair itself — encrypted at rest via the OS keychain
 * (`safeStorage`) and handed to the renderer through the preload token bridge
 * (`window.sidanclawDesktop.getAccessToken` …), which activates the dormant
 * `desktopAuthSource` in app-web (`lib/desktop-auth-source.ts`).
 *
 * Everything here is **pure / IO-injectable** so it unit-tests with no Electron,
 * exactly like `desktop-auth.ts`: `serializeTokens` / `parseStoredTokens` are the
 * serialize-validate seam, and `encryptTokens` / `decryptTokens` take an injected
 * `TokenCipher`. The real `safeStorage`-backed cipher and the `userData` file I/O
 * live in `main.ts` (the IO shell) — same split as the pending-verifier file.
 *
 * Spec: docs/plans/canvas-desktop-bundled-offline.md → Phase 1 (client-side auth).
 * [COMP:app-desktop/token-store]
 */

import type { DesktopSession } from "./desktop-auth.js";

/**
 * The persisted token record. Mirrors the renderer-facing `DesktopTokens`
 * (`app-web/src/lib/desktop-auth-source.ts`) plus `accessTokenExpiresAt` so
 * the shell can refresh proactively before handing a stale token to the renderer.
 */
export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** Unix ms at which the access token expires. */
  accessTokenExpiresAt: number;
  user?: { id: string; name: string; email: string; plan?: string };
}

/**
 * Encrypt/decrypt seam. In production this wraps Electron's `safeStorage`
 * (OS-keychain-backed, authenticated — a tampered blob throws on decrypt). In
 * tests a fake (e.g. base64 round-trip) keeps the persistence logic pure.
 */
export interface TokenCipher {
  /** True when OS encryption is available; callers must not persist otherwise. */
  isAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(buf: Buffer): string;
}

/** Validate + narrow a raw `user` value to the stored shape, or `undefined`. */
function normalizeUser(raw: unknown): StoredTokens["user"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  if (typeof u.id !== "string" || typeof u.name !== "string" || typeof u.email !== "string") {
    return undefined;
  }
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    ...(typeof u.plan === "string" ? { plan: u.plan } : {}),
  };
}

/**
 * Serialize a freshly-exchanged session to the plaintext token blob (pre-
 * encryption). `accessTokenExpiresAt` is computed from the session's
 * `accessTokenExpiresIn` (seconds) against the injected clock.
 */
export function serializeTokens(session: DesktopSession, nowMs: number): string {
  const record: StoredTokens = {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    accessTokenExpiresAt: nowMs + session.accessTokenExpiresIn * 1000,
    user: session.user,
  };
  return JSON.stringify(record);
}

/**
 * Parse + validate a decrypted token blob. Returns `null` for anything that is
 * not a well-formed record (bad JSON, missing/blank tokens, non-numeric expiry),
 * so a corrupt or partially-written store reads as "signed out" rather than
 * crashing the shell.
 */
export function parseStoredTokens(raw: string): StoredTokens | null {
  let obj: {
    accessToken?: unknown;
    refreshToken?: unknown;
    accessTokenExpiresAt?: unknown;
    user?: unknown;
  };
  try {
    obj = JSON.parse(raw) as typeof obj;
  } catch {
    return null;
  }
  if (typeof obj.accessToken !== "string" || obj.accessToken.length === 0) return null;
  if (typeof obj.refreshToken !== "string" || obj.refreshToken.length === 0) return null;
  if (typeof obj.accessTokenExpiresAt !== "number" || !Number.isFinite(obj.accessTokenExpiresAt)) {
    return null;
  }

  const out: StoredTokens = {
    accessToken: obj.accessToken,
    refreshToken: obj.refreshToken,
    accessTokenExpiresAt: obj.accessTokenExpiresAt,
  };
  // `user` is optional and display-only; keep it only when it is the right shape.
  const user = normalizeUser(obj.user);
  if (user) out.user = user;
  return out;
}

/**
 * Decode the `exp` claim (unix seconds → ms) from a JWT access token, **without
 * verifying the signature** — this is only for the shell's proactive-refresh
 * timing; the API re-validates every call. Returns `null` for anything that
 * isn't a decodable three-part JWT with a numeric `exp`.
 */
export function decodeAccessTokenExpiryMs(accessToken: string): number | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

/**
 * Serialize tokens handed back by the renderer's client-side refresh
 * (`desktopAuthSource.refresh()` → `setTokens`). That payload is the
 * `DesktopTokens` shape (`{ accessToken, refreshToken, user? }`) with **no**
 * `expiresIn`, so the expiry is read from the access token's JWT `exp`, falling
 * back to `nowMs` (treat as expiring) when it isn't a decodable JWT. Returns the
 * blob to encrypt, or `null` when the IPC payload is malformed (defense in depth
 * — it crosses the renderer→main boundary).
 */
export function serializeRendererTokens(input: unknown, nowMs: number): string | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (typeof o.accessToken !== "string" || o.accessToken.length === 0) return null;
  if (typeof o.refreshToken !== "string" || o.refreshToken.length === 0) return null;
  const record: StoredTokens = {
    accessToken: o.accessToken,
    refreshToken: o.refreshToken,
    accessTokenExpiresAt: decodeAccessTokenExpiryMs(o.accessToken) ?? nowMs,
  };
  const user = normalizeUser(o.user);
  if (user) record.user = user;
  return JSON.stringify(record);
}

/**
 * Encrypt a plaintext token blob for at-rest storage. Returns `null` when OS
 * encryption is unavailable — callers must refuse to persist plaintext tokens
 * (falling back to a re-sign-in is safer than writing a readable JWT to disk).
 */
export function encryptBlob(cipher: TokenCipher, plain: string): Buffer | null {
  if (!cipher.isAvailable()) return null;
  return cipher.encryptString(plain);
}

/**
 * Encrypt a freshly-exchanged session for at-rest storage. Convenience over
 * `encryptBlob(cipher, serializeTokens(...))` for the sign-in code-exchange path.
 */
export function encryptTokens(
  cipher: TokenCipher,
  session: DesktopSession,
  nowMs: number,
): Buffer | null {
  return encryptBlob(cipher, serializeTokens(session, nowMs));
}

/**
 * Decrypt + parse a stored blob. Returns `null` on any failure (encryption
 * unavailable, authenticated-decrypt throw on a tampered/foreign blob, or a
 * malformed record) so the shell treats it as signed-out.
 */
export function decryptTokens(cipher: TokenCipher, buf: Buffer): StoredTokens | null {
  if (!cipher.isAvailable()) return null;
  let plain: string;
  try {
    plain = cipher.decryptString(buf);
  } catch {
    return null;
  }
  return parseStoredTokens(plain);
}

/**
 * True when the access token is within `skewMs` of expiry (or already expired).
 * The shell calls this before handing the cached token to the renderer to
 * decide whether to refresh first. Default skew leaves a comfortable margin
 * under the 1h access-token lifetime.
 */
export function isAccessTokenExpiring(
  tokens: StoredTokens,
  nowMs: number,
  skewMs = 60_000,
): boolean {
  return tokens.accessTokenExpiresAt - nowMs <= skewMs;
}
