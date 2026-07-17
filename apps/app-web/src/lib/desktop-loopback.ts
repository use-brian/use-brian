/**
 * Loopback redirect validation for the desktop sign-in bridge (RFC 8252 §7.3).
 *
 * The Electron shell listens on an ephemeral `http://127.0.0.1:<port>/cb` server
 * and asks `/desktop/auth` to 302 the single-use code there. Because that route
 * redirects the *browser* to whatever it's handed, the target MUST be locked to
 * a loopback host — otherwise `?redirect=https://evil.example/cb` would turn the
 * bridge into an open redirect that leaks the code off the user's machine.
 *
 * Pure so it unit-tests with no Next.js. Used by
 * `src/app/desktop/auth/route.ts` ([COMP:app-web/desktop-auth-bridge]).
 * [COMP:app-web/desktop-loopback]
 */

/**
 * Validate the shell's loopback redirect param. Returns the bare `origin + /cb`
 * (callers append their own query) only for an `http://` URL on a loopback host
 * with a port and the `/cb` path; `null` for anything else, so callers fall back
 * to the `usebrian://auth` scheme.
 */
export function loopbackRedirectBase(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:") return null;
  // The shell only ever listens on 127.0.0.1 (`buildLoopbackRedirectUri`);
  // `localhost` is accepted as the conventional loopback alias.
  if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") return null;
  if (!u.port) return null;
  if (u.pathname !== "/cb") return null;
  return `${u.protocol}//${u.host}/cb`;
}
