/**
 * Navigation policy — the security spine of the shell.
 *
 * The app window only ever hosts the canvas origin; everything else opens in
 * the system browser. Sign-in is special: any navigation toward a login page or
 * an OAuth provider is intercepted and handed to the system-browser PKCE flow
 * (see desktop-auth.ts) rather than loaded in-window — Google refuses embedded
 * user agents, and tokens should never be minted inside the app frame.
 *
 * Pure: both predicates take a URL (+ the canvas origin) and return a verdict,
 * so they unit-test with no Electron.
 *
 * Spec: docs/architecture/features/app-desktop.md → "window-policy.ts"
 * [COMP:app-desktop/window-policy]
 */

export type NavDecision = "internal" | "external";

/**
 * Decide whether a navigation should load inside the app window
 * (`internal` — the canvas origin only) or be handed to the system browser
 * (`external`). A URL that fails to parse is treated as external (fail safe).
 *
 * Call `isLoginNavigation` FIRST in the navigation handler — a login/OAuth URL
 * is neither loaded in-window nor merely opened externally; it triggers the
 * desktop sign-in flow.
 */
export function classifyNavigation(targetUrl: string, appOrigin: string): NavDecision {
  let origin: string;
  try {
    origin = new URL(targetUrl).origin;
  } catch {
    return "external";
  }
  return origin === appOrigin ? "internal" : "external";
}

/**
 * Parse a sub-app refresh bounce: `<any origin>/api/auth/refresh-and-return?next=<url>`.
 *
 * In a browser this navigation lets the auth primary rotate the shared
 * `.usebrian.ai` cookies and return. Inside the shell it can never work — the
 * primary is an external origin (the bounce would open uselessly in the system
 * browser) and the shell's session is a separate host-only cookie jar the
 * primary couldn't write anyway. The navigation handler intercepts it, runs the
 * shell's own refresh, and loads the returned URL: the bounce's `next` when it
 * is on the app origin, else the app root (a crafted `next` can't navigate the
 * window off-origin). Returns `null` when the URL is not a refresh bounce.
 *
 * Call it AFTER `isLoginNavigation` and BEFORE `classifyNavigation`.
 */
export function parseRefreshBounce(targetUrl: string, appOrigin: string): string | null {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  if (url.pathname !== "/api/auth/refresh-and-return") return null;
  const next = url.searchParams.get("next");
  if (next) {
    try {
      const nextUrl = new URL(next);
      if (nextUrl.origin === appOrigin) return nextUrl.toString();
    } catch {
      /* fall through to the app root */
    }
  }
  return appOrigin;
}

/** OAuth provider hosts whose appearance means "the app is trying to sign in". */
const OAUTH_PROVIDER_HOSTS = ["accounts.google.com", "oauth2.googleapis.com"];

/**
 * The `redirect_uri` callback path that marks a Google OAuth hop as a *connector*
 * connect (linking Drive/Gmail/Calendar to an already-signed-in workspace) rather
 * than a Use Brian sign-in. The connectors page builds its OAuth URL with this
 * `redirect_uri` (apps/app-web `.../studio/connectors`).
 */
const CONNECTOR_OAUTH_CALLBACK_PATH = "/api/auth/callback/google-connector";

/**
 * True when an OAuth-provider navigation is a *connector* connect, not a sign-in.
 * A connector connect hops through the same provider host as login
 * (`accounts.google.com`), so the two are told apart by the `redirect_uri`: a
 * connector flow points it back at the connector callback on the app. A connector
 * connect must NOT trigger the sign-in landing — it is handed to the system
 * browser like any other external origin (`classifyNavigation` → external), where
 * the browser's own `.usebrian.ai` session (left over from desktop sign-in) completes
 * Google's redirect back to the callback. Loading it in-window is not an option:
 * Google refuses embedded user agents (see "Sign-in"). Returns false for a
 * non-provider host, a missing/unparseable `redirect_uri`, or a parse failure.
 */
export function isConnectorOAuth(targetUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return false;
  }
  if (!OAUTH_PROVIDER_HOSTS.includes(url.hostname)) return false;
  const redirect = url.searchParams.get("redirect_uri");
  if (!redirect) return false;
  try {
    return new URL(redirect).pathname === CONNECTOR_OAUTH_CALLBACK_PATH;
  } catch {
    return false;
  }
}

/**
 * True if a navigation is a sign-in attempt: any app's `/login` page (canvas or
 * the auth primary both use that path) or a hop to an OAuth provider. The
 * navigation handler intercepts these and launches the system-browser PKCE flow
 * instead of loading them in-window.
 *
 * A *connector* OAuth hop (`isConnectorOAuth`) is the one exception: it also
 * lands on an OAuth provider host but is not a sign-in, so it returns false and
 * falls through to `classifyNavigation` (→ system browser). Without this carve-
 * out, connecting a Google connector (Drive/Gmail/Calendar) would bounce the
 * window to the sign-in landing — reading as a spurious sign-out.
 */
export function isLoginNavigation(targetUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return false;
  }
  if (isConnectorOAuth(targetUrl)) return false;
  if (OAUTH_PROVIDER_HOSTS.includes(url.hostname)) return true;
  return url.pathname === "/login" || url.pathname.startsWith("/login/");
}

export type LoginNavAction = "pkce" | "local-session" | "none";

/**
 * Per-target routing of an intercepted login navigation (§2.3 of
 * docs/plans/consumer-local-experience.md). `isLoginNavigation` decides
 * WHETHER a navigation is a sign-in attempt; this decides WHAT the shell does
 * about it for the active target:
 *
 *  - cloud (`auth: "pkce"`) → `"pkce"`: the system-browser PKCE flow, exactly
 *    as before.
 *  - local (`auth: "local-session"`) → `"local-session"` for the app origin's
 *    own `/login` (the shell mints the oss local-owner session by loading the
 *    app-web trigger route in-window — a local brain has no login); any OTHER
 *    login URL (an OAuth provider host, another origin's `/login`) → `"none"`,
 *    falling through to `classifyNavigation` → the system browser. A local
 *    target must never start a PKCE exchange, and one-origin-per-window means
 *    an off-origin login page is just an external link to it.
 *
 *  - not a login navigation at all → `"none"`.
 */
export function decideLoginAction(
  targetUrl: string,
  opts: { auth: "pkce" | "local-session"; appOrigin: string },
): LoginNavAction {
  if (!isLoginNavigation(targetUrl)) return "none";
  if (opts.auth !== "local-session") return "pkce";
  try {
    if (new URL(targetUrl).origin === opts.appOrigin) return "local-session";
  } catch {
    /* unparseable — not ours to handle */
  }
  return "none";
}

/**
 * Cooldown between local-owner session mints. If the mint "succeeds" but the
 * brain bounces straight back to `/login` (an edition/gate mismatch — e.g. a
 * self-hosted HOSTED-edition brain, where the trigger route 404s), re-minting
 * on every bounce would loop forever. Within the cooldown the shell shows the
 * brain-problem landing instead of re-attempting.
 */
export const LOCAL_MINT_COOLDOWN_MS = 10_000;

/** True when enough time has passed since the last mint attempt to try again. */
export function shouldAttemptLocalMint(lastAttemptAtMs: number | null, nowMs: number): boolean {
  return lastAttemptAtMs === null || nowMs - lastAttemptAtMs >= LOCAL_MINT_COOLDOWN_MS;
}

export type LoadFailureAction =
  | "ignore"
  | "show-window"
  | "offline-retry"
  | "signin"
  | "local-unreachable";

/**
 * Decide what a main-frame load failure (`did-fail-load`) should do. A signed-in
 * user must NEVER be bounced to the sign-in landing by a transient load failure
 * (offline, the canvas origin unreachable) — that was the "Mac goes offline →
 * logged out" bug. The decision is driven by SESSION PRESENCE, not a network
 * error-code taxonomy: a user with a live session is shown the offline landing
 * and auto-reconnected; only a user with no session goes to sign-in.
 *
 *  - non-main-frame, or `errorCode === -3` (ERR_ABORTED — our own intentional
 *    redirect cancels, see `handleNavigation`) → `ignore`.
 *  - the failed URL is our own `file:` landing (a packaging bug, not a network
 *    failure) → `show-window` rather than reload it in a loop.
 *  - a LOCAL target (`target: "local"`) → `local-unreachable`, session or not:
 *    the dominant failure is the brain not running, and its landing carries
 *    every recovery (retry / custom URL / switch to cloud). §2.2 of
 *    docs/plans/consumer-local-experience.md.
 *  - a session exists (a refresh token in the jar) → `offline-retry`.
 *  - otherwise (no session) → `signin`.
 *
 * Pure: unit-tests with no Electron. Spec:
 * docs/architecture/features/app-desktop.md → "Offline resilience".
 */
export function decideLoadFailureAction(opts: {
  errorCode: number;
  isMainFrame: boolean;
  failedUrl: string;
  hasSession: boolean;
  target?: "cloud" | "local";
}): LoadFailureAction {
  if (!opts.isMainFrame || opts.errorCode === -3) return "ignore";
  if (opts.failedUrl.startsWith("file:")) return "show-window";
  if (opts.target === "local") return "local-unreachable";
  return opts.hasSession ? "offline-retry" : "signin";
}
