/**
 * Desktop auth source — the Bearer-token half of the auth seam.
 *
 * The web app authenticates via `.usebrian.ai` cookies (`auth-fetch.ts`). A
 * *bundled* desktop app (see `docs/plans/doc-desktop-bundled-offline.md`)
 * loads from a `file://` / `app://` origin, where doc-domain cookies don't
 * apply — so it authenticates with a Bearer token held by the Electron shell
 * (in `safeStorage`) and exposed to the renderer through a preload bridge.
 *
 * `auth-fetch.ts` delegates its three variant primitives — `getAccessToken`,
 * `refresh`, `redirectToLogin` — to this source **only when the token bridge is
 * present** (`isDesktopAuth()`). The current thin-shell desktop exposes only
 * `signIn()` (no token methods), so this source stays dormant there and the app
 * keeps the cookie path. The shared orchestration (expiry check, 401→retry)
 * lives in `auth-fetch.ts` and is identical for both sources.
 *
 * Spec: docs/architecture/features/doc.md §12 (auth token-source seam).
 * [COMP:app-web/desktop-auth-source]
 */

/** Tokens handed back by the desktop refresh exchange / stored by the shell. */
interface DesktopTokens {
  accessToken: string;
  refreshToken: string;
  user?: { id: string; name: string; email: string; plan?: string };
}

/**
 * The bridge the Electron preload exposes on `window`. `signIn` / `signOut` are
 * present in every mode (thin shell + bundled); the token methods are added only
 * by the bundled app.
 */
interface DesktopBridge {
  signIn: () => void;
  /**
   * Ask the shell to clear its own session (cookies in the thin shell, the
   * safeStorage token in bundled mode) and reload to the sign-in landing.
   */
  signOut?: () => void;
  /**
   * Ask the shell to reload the app (the offline landing's "Retry" button).
   * Present in every shell mode; called from the shell-owned `offline.html`.
   */
  retry?: () => void;
  /**
   * Start the system-browser sign-in for a SECOND account (stash the active one
   * into the shell's saved-account store, don't replace it). Present in the
   * Electron shell only; the web switcher bounces to `/login?addAccount=1`
   * instead when it's absent.
   */
  addAccount?: () => void;
  /**
   * Switch the active account to a saved one (by id), in the shell's own cookie
   * jar. Resolves with the outcome so the switcher can show an inline message
   * and clear its spinner; on success the shell reloads the window itself.
   */
  switchAccount?: (
    id: string,
  ) => Promise<{ ok: true } | { ok: false; error: "switch" | "reauth" }>;
  getAccessToken?: () => string | null;
  getRefreshToken?: () => string | null;
  setTokens?: (tokens: DesktopTokens) => void;
  clear?: () => void;
}

declare global {
  interface Window {
    sidanclawDesktop?: DesktopBridge;
  }
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

/**
 * True when running inside a bundled desktop app whose bridge exposes the token
 * methods. False on the web and in the current thin shell (signIn-only bridge),
 * so the cookie path stays in force there.
 */
export function isDesktopAuth(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.sidanclawDesktop?.getAccessToken === "function"
  );
}

/**
 * When running inside the Electron desktop shell (thin OR bundled), route logout
 * through the shell: it clears its own session in place (cookie jar in the thin
 * shell, the safeStorage token in bundled mode) and reloads to the sign-in
 * landing. Returns `true` when the shell handled it, so the web logout handlers
 * can skip the browser/primary-auth path entirely.
 *
 * This MUST take precedence over `buildPrimaryAuthUrl(...)`: in Electron the
 * primary (`usebrian.ai`) is an external origin, so the nav policy opens its
 * `/api/auth/logout` in the SYSTEM browser — clearing the `.usebrian.ai` cookies of
 * the user's *web* session while the desktop app's separate cookie jar stays
 * signed in. Bridge-routed logout is the only way to sign the desktop app out.
 *
 * Unlike `isDesktopAuth()`, this is gated on `signOut` (exposed in every shell
 * mode), not the bundled-only token bridge — the thin shell needs it too.
 */
export function desktopSignOut(): boolean {
  const signOut =
    typeof window !== "undefined" ? window.sidanclawDesktop?.signOut : undefined;
  if (typeof signOut !== "function") return false;
  signOut();
  return true;
}

/**
 * Outcome of a token-refresh attempt — the shared contract of the cookie
 * refresh (`auth-fetch.ts` `tryRefreshToken`) and this desktop Bearer refresh.
 * Lives here (the leaf module) so the dependency stays one-directional:
 * `auth-fetch` imports this, never the reverse. The discriminant lets the
 * orchestration tell a **transient** network failure (offline / 5xx — keep the
 * session, surface a retryable error, NEVER a logout) apart from a **dead**
 * session (401/400 — clear it and sign in). See
 * docs/architecture/platform/auth.md → "On transient network failure".
 */
export type RefreshOutcome =
  | { kind: "ok"; token: string }
  /** A prod full-page bounce to the primary started; the page is unloading. */
  | { kind: "redirecting" }
  /** Offline / network error / 5xx — keep the session and retry later. */
  | { kind: "transient" }
  /** 401/400 or no refresh token — the session is dead, go to login. */
  | { kind: "unauthenticated" };

/**
 * Map a refresh-endpoint HTTP status to a verdict. 400/401/403 mean the session
 * is dead (clear it, sign in); every other non-2xx (5xx, 429, …) is transient
 * and must NOT log the user out — only an explicit auth rejection clears
 * cookies. Pure + exported for tests. Shared by both refresh paths.
 */
export function classifyRefreshStatus(
  status: number,
): "ok" | "unauthenticated" | "transient" {
  if (status >= 200 && status < 300) return "ok";
  if (status === 400 || status === 401 || status === 403) return "unauthenticated";
  return "transient";
}

export interface AuthSource {
  /** Synchronously read the current access token, or null. */
  getAccessToken(): string | null;
  /** Refresh the session, classifying the result (see `RefreshOutcome`). */
  refresh(): Promise<RefreshOutcome>;
  /** Send the user to sign in. */
  redirectToLogin(): void;
}

/**
 * The desktop source. Reads tokens from the bridge; refreshes by calling the
 * API's `/auth/refresh` directly (no same-origin Next route, no `.usebrian.ai`
 * cookie redirect); "login" opens the system-browser PKCE flow via the shell.
 */
export const desktopAuthSource: AuthSource = {
  getAccessToken() {
    return window.sidanclawDesktop?.getAccessToken?.() ?? null;
  },

  async refresh(): Promise<RefreshOutcome> {
    const bridge = window.sidanclawDesktop;
    const refreshToken = bridge?.getRefreshToken?.();
    if (!refreshToken) {
      bridge?.clear?.();
      return { kind: "unauthenticated" };
    }
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
    } catch {
      // A thrown fetch is a network failure (offline, DNS, reset). Keep the
      // stored tokens and retry later — clearing here would sign the user out
      // on a blip. See docs/architecture/platform/auth.md.
      return { kind: "transient" };
    }
    const verdict = classifyRefreshStatus(res.status);
    if (verdict === "unauthenticated") {
      bridge?.clear?.();
      return { kind: "unauthenticated" };
    }
    if (verdict === "transient") return { kind: "transient" };
    const data = (await res.json()) as Partial<DesktopTokens>;
    if (data.accessToken && data.refreshToken) {
      bridge?.setTokens?.({
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        user: data.user,
      });
    }
    return data.accessToken ? { kind: "ok", token: data.accessToken } : { kind: "transient" };
  },

  redirectToLogin() {
    window.sidanclawDesktop?.signIn?.();
  },
};
