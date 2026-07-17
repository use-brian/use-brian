/**
 * Desktop sign-in — RFC 8252 (OAuth for Native Apps) + PKCE (RFC 7636).
 *
 * The window never hosts the OAuth flow. Instead the app opens the SYSTEM
 * browser at the canvas `/desktop/auth` bridge; the browser completes Google
 * login and hands a short-lived single-use code back to the app; the app
 * exchanges that code (with the PKCE verifier) for the JWT pair over TLS and
 * writes the session cookies into its own cookie jar. Tokens never transit a URL.
 *
 * The code returns to the app over a **loopback redirect** (RFC 8252 §7.3): the
 * shell starts an ephemeral `http://127.0.0.1:<port>/cb` server, passes that URL
 * to the bridge, and the browser 302s the code straight back to it. This works
 * in an unpackaged `dist/main.js` dev run, which the `usebrian://auth` custom
 * scheme cannot (macOS only routes a custom scheme to a packaged `.app` whose
 * Info.plist declares it). The custom scheme is kept as a fallback for older
 * builds and remains the transport for non-auth deep links.
 *
 * Everything here is pure / IO-injectable so it unit-tests with no Electron:
 * `exchangeCode` takes a `fetch` impl, `buildSessionCookies` takes the clock.
 *
 * Spec: docs/architecture/features/app-desktop.md → "Sign-in" and
 * docs/architecture/platform/auth.md → "Desktop app sign-in (PKCE handoff)".
 * [COMP:app-desktop/desktop-auth]
 */

import { createHash, randomBytes } from "node:crypto";

// ── PKCE ───────────────────────────────────────────────────────

/** A random base64url code verifier (RFC 7636 §4.1 — 43 chars from 32 bytes). */
export function generateVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** The S256 challenge for a verifier: base64url(sha256(verifier)) (RFC 7636 §4.2). */
export function deriveChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

export function generatePkcePair(): PkcePair {
  const verifier = generateVerifier();
  return { verifier, challenge: deriveChallenge(verifier) };
}

// ── Pending-verifier persistence ───────────────────────────────
//
// The PKCE verifier must survive across processes: on macOS the
// `usebrian://auth` callback often arrives in a different (cold-started or
// relaunched) process than the one that started sign-in, so an in-memory-only
// verifier is lost. `main.ts` writes it to a small file in `userData` on
// `startSignIn` and reads it back in `completeSignIn`. These two helpers are the
// pure serialize/validate seam; the file I/O lives in `main.ts`.

/** Default lifetime of a persisted verifier — comfortably over the code TTL. */
export const PENDING_VERIFIER_TTL_MS = 5 * 60 * 1000;

/** A parsed pending sign-in: the PKCE verifier plus whether it's an add-account flow. */
export interface PendingVerifier {
  verifier: string;
  /** True when this sign-in adds a second account rather than replacing the active one. */
  addAccount: boolean;
}

export function serializePendingVerifier(
  verifier: string,
  nowMs: number,
  addAccount = false,
): string {
  return JSON.stringify({ verifier, createdAt: nowMs, addAccount });
}

/**
 * Parse a persisted verifier blob, returning the verifier (and its add-account
 * intent) only if it is well-formed and not older than `maxAgeMs`. Returns
 * `null` otherwise (bad JSON, wrong shape, stale, or a clock that ran
 * backwards). The `addAccount` flag survives the cross-process `usebrian://auth`
 * fallback so the handling process still knows to stash rather than replace.
 */
export function parsePendingVerifier(
  raw: string,
  nowMs: number,
  maxAgeMs: number = PENDING_VERIFIER_TTL_MS,
): PendingVerifier | null {
  let obj: { verifier?: unknown; createdAt?: unknown; addAccount?: unknown };
  try {
    obj = JSON.parse(raw) as typeof obj;
  } catch {
    return null;
  }
  if (typeof obj.verifier !== "string" || !/^[A-Za-z0-9_-]+$/.test(obj.verifier)) return null;
  if (typeof obj.createdAt !== "number") return null;
  const age = nowMs - obj.createdAt;
  if (age < 0 || age > maxAgeMs) return null;
  return { verifier: obj.verifier, addAccount: obj.addAccount === true };
}

// ── URLs ───────────────────────────────────────────────────────

/**
 * The system-browser URL that starts the sign-in flow.
 *
 * When `opts.redirectUri` is given (the loopback `http://127.0.0.1:<port>/cb`
 * the shell is listening on), the bridge 302s the code back there instead of to
 * the `usebrian://auth` scheme — see the module header. `opts.state` is an
 * unguessable nonce the bridge echoes back so the loopback server can reject a
 * callback that isn't from this sign-in attempt.
 */
export function buildDesktopAuthStartUrl(
  appUrl: string,
  challenge: string,
  opts: { redirectUri?: string; state?: string; addAccount?: boolean } = {},
): string {
  const params = new URLSearchParams({ challenge });
  if (opts.redirectUri) params.set("redirect", opts.redirectUri);
  if (opts.state) params.set("state", opts.state);
  // Add-account: the bridge routes through `/login?addAccount=1` (Google account
  // chooser) so a DIFFERENT account is chosen, instead of silently reusing the
  // browser's current session. See apps/app-web/src/app/desktop/auth/route.ts.
  if (opts.addAccount) params.set("addAccount", "1");
  return `${appUrl}/desktop/auth?${params.toString()}`;
}

/** The loopback redirect URI the bridge sends the code back to (RFC 8252 §7.3). */
export function buildLoopbackRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}/cb`;
}

/**
 * The branded page the loopback tab lands on once the code is captured. The
 * ephemeral `/cb` server 302s the browser here so the user never sees the bare
 * `http://127.0.0.1:<port>/cb?code=…` URL — the address bar settles on the
 * canvas origin and the code is gone from the visible URL. `opts.error` swaps
 * the page to its "sign-in didn't complete" variant.
 */
export function buildSignedInPageUrl(appUrl: string, opts: { error?: boolean } = {}): string {
  const base = `${appUrl}/desktop/signed-in`;
  return opts.error ? `${base}?status=error` : base;
}

/** An unguessable nonce binding a loopback callback to the sign-in that started it. */
export function generateStateNonce(): string {
  return randomBytes(16).toString("base64url");
}

export type AuthCallback =
  | { kind: "code"; code: string }
  | { kind: "error"; error: string };

/**
 * Parse a `usebrian://auth?code=…` (or `?error=…`) callback. Returns `null`
 * for anything that is not an auth callback on our scheme, so `main.ts` can
 * fall through to `resolveDeepLink` for navigation deep links.
 */
export function parseAuthCallback(rawUrl: string, protocolScheme: string): AuthCallback | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${protocolScheme}:`) return null;
  if (url.hostname !== "auth") return null;

  const error = url.searchParams.get("error");
  if (error) return { kind: "error", error };

  const code = url.searchParams.get("code");
  if (code) return { kind: "code", code };

  return { kind: "error", error: "no_code" };
}

/**
 * Parse an incoming loopback request target (`/cb?code=…` / `?error=…`) handled
 * by the ephemeral sign-in server. Returns `null` (so the server replies 404 and
 * stays open) for any path other than `/cb`, or when the echoed `state` does not
 * match the nonce this sign-in started with — a stray/forged request can't drive
 * `completeSignIn`. `expectedState` is `null` only when no nonce was issued.
 */
export function parseLoopbackCallback(
  requestTarget: string,
  expectedState: string | null,
): AuthCallback | null {
  let url: URL;
  try {
    // requestTarget is a path+query (e.g. "/cb?code=…"); resolve against a dummy base.
    url = new URL(requestTarget, "http://127.0.0.1");
  } catch {
    return null;
  }
  if (url.pathname !== "/cb") return null;
  if (expectedState !== null && url.searchParams.get("state") !== expectedState) return null;

  const error = url.searchParams.get("error");
  if (error) return { kind: "error", error };

  const code = url.searchParams.get("code");
  if (code) return { kind: "code", code };

  return { kind: "error", error: "no_code" };
}

// ── Token exchange ─────────────────────────────────────────────

export interface DesktopSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresIn: number;
  readonly refreshTokenExpiresIn: number;
  readonly user?: {
    id: string;
    name: string;
    email: string;
    plan?: string;
  };
}

type FetchLike = (input: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Exchange a single-use code + PKCE verifier for the JWT pair, over TLS,
 * directly with the API. Throws on a non-OK response.
 */
export async function exchangeCode(
  apiUrl: string,
  code: string,
  verifier: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<DesktopSession> {
  const res = await fetchImpl(`${apiUrl}/auth/desktop/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, verifier }),
  });
  if (!res.ok) {
    throw new Error(`Desktop exchange failed (HTTP ${res.status})`);
  }
  return (await res.json()) as DesktopSession;
}

// ── Session keep-alive ─────────────────────────────────────────
//
// The web's refresh protocol can't run inside the thin shell: in production
// app-web refreshes by bouncing the page to the auth primary, which the nav
// policy treats as an external origin — and the shell's host-only cookie jar
// is one the primary could never write anyway. So the shell refreshes its own
// session: main.ts ticks `shouldRefreshSession` and calls `refreshSession`
// before the access token lapses. Spec: features/app-desktop.md → "Session
// lifetime — shell-owned keep-alive".

/** Refresh when the access token is within this margin of its `exp`. */
export const SESSION_REFRESH_MARGIN_SECONDS = 10 * 60;

/** How often the keep-alive re-checks the jar. */
export const SESSION_REFRESH_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** Decode a JWT's `exp` (unix seconds). Returns 0 when unparseable. */
export function jwtExpSeconds(token: string): number {
  try {
    const payload = token.split(".")[1];
    if (!payload) return 0;
    const json = JSON.parse(Buffer.from(payload, "base64url").toString()) as { exp?: number };
    return typeof json.exp === "number" ? json.exp : 0;
  } catch {
    return 0;
  }
}

/**
 * True when the access token needs a proactive refresh: missing, unparseable,
 * or within `marginSeconds` of its `exp`. Pure — the keep-alive tick and the
 * launch check share this one decision.
 */
export function shouldRefreshSession(
  accessToken: string | null,
  nowSeconds: number,
  marginSeconds: number = SESSION_REFRESH_MARGIN_SECONDS,
): boolean {
  if (!accessToken) return true;
  const exp = jwtExpSeconds(accessToken);
  if (exp === 0) return true;
  return exp - marginSeconds <= nowSeconds;
}

/**
 * Rotate the JWT pair at `POST /auth/refresh`. Returns the new session, or
 * `null` when the backend definitively rejects the refresh token (400/401 —
 * dead session, the caller should clear the jar and prompt sign-in). Throws on
 * anything transient (network, 5xx) so the caller can keep the session and
 * retry on the next tick.
 */
export async function refreshSession(
  apiUrl: string,
  refreshToken: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<DesktopSession | null> {
  const res = await fetchImpl(`${apiUrl}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  if (res.status === 400 || res.status === 401) return null;
  if (!res.ok) {
    throw new Error(`Session refresh failed (HTTP ${res.status})`);
  }
  return (await res.json()) as DesktopSession;
}

// ── Cookie specs ───────────────────────────────────────────────

/** Subset of Electron's `CookiesSetDetails` we use; defined here to stay Electron-free. */
export interface SessionCookieSpec {
  url: string;
  name: string;
  value: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "no_restriction" | "lax" | "strict";
  expirationDate?: number;
}

/**
 * Build the three auth cookies the canvas web app reads (`access_token`,
 * `refresh_token`, `user`), mirroring the web's `auth-cookies.ts` attributes.
 * The caller writes them into Electron's session cookie jar.
 *
 * @param nowSeconds injectable clock (unix seconds) for deterministic tests
 */
export function buildSessionCookies(
  appUrl: string,
  session: DesktopSession,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SessionCookieSpec[] {
  const secure = appUrl.startsWith("https://");
  const base = { url: appUrl, secure, sameSite: "lax" as const };

  const userValue = JSON.stringify({
    id: session.user?.id ?? "",
    name: session.user?.name ?? "",
    email: session.user?.email ?? "",
    plan: session.user?.plan ?? "free",
    effectivePlan: session.user?.plan ?? "free",
  });

  return [
    {
      ...base,
      name: "access_token",
      value: session.accessToken,
      httpOnly: false,
      expirationDate: nowSeconds + session.accessTokenExpiresIn,
    },
    {
      ...base,
      name: "refresh_token",
      value: session.refreshToken,
      httpOnly: true,
      expirationDate: nowSeconds + session.refreshTokenExpiresIn,
    },
    {
      ...base,
      name: "user",
      value: userValue,
      httpOnly: false,
      expirationDate: nowSeconds + session.refreshTokenExpiresIn,
    },
  ];
}
