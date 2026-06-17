/**
 * Desktop auth source — the Bearer-token half of the auth seam.
 *
 * The web app authenticates via `.sidan.ai` cookies (`auth-fetch.ts`). A
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
 * Spec: docs/plans/doc-web-app-consolidation.md §12 (auth token-source seam).
 * [COMP:app-web/desktop-auth-source]
 */

/** Tokens handed back by the desktop refresh exchange / stored by the shell. */
export interface DesktopTokens {
  accessToken: string;
  refreshToken: string;
  user?: { id: string; name: string; email: string; plan?: string };
}

/**
 * The bridge the Electron preload exposes on `window`. `signIn` / `signOut` are
 * present in every mode (thin shell + bundled); the token methods are added only
 * by the bundled app.
 */
export interface DesktopBridge {
  signIn: () => void;
  /**
   * Ask the shell to clear its own session (cookies in the thin shell, the
   * safeStorage token in bundled mode) and reload to the sign-in landing.
   */
  signOut?: () => void;
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
 * primary (`sidan.ai`) is an external origin, so the nav policy opens its
 * `/api/auth/logout` in the SYSTEM browser — clearing the `.sidan.ai` cookies of
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

export interface AuthSource {
  /** Synchronously read the current access token, or null. */
  getAccessToken(): string | null;
  /** Refresh and return a fresh access token, or null. */
  refresh(): Promise<string | null>;
  /** Send the user to sign in. */
  redirectToLogin(): void;
}

/**
 * The desktop source. Reads tokens from the bridge; refreshes by calling the
 * API's `/auth/refresh` directly (no same-origin Next route, no `.sidan.ai`
 * cookie redirect); "login" opens the system-browser PKCE flow via the shell.
 */
export const desktopAuthSource: AuthSource = {
  getAccessToken() {
    return window.sidanclawDesktop?.getAccessToken?.() ?? null;
  },

  async refresh() {
    const bridge = window.sidanclawDesktop;
    const refreshToken = bridge?.getRefreshToken?.();
    if (!refreshToken) {
      bridge?.clear?.();
      return null;
    }
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        bridge?.clear?.();
        return null;
      }
      const data = (await res.json()) as Partial<DesktopTokens>;
      if (data.accessToken && data.refreshToken) {
        bridge?.setTokens?.({
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          user: data.user,
        });
      }
      return data.accessToken ?? null;
    } catch {
      return null;
    }
  },

  redirectToLogin() {
    window.sidanclawDesktop?.signIn?.();
  },
};
