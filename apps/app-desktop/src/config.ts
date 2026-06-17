/**
 * Runtime configuration for the canvas desktop shell.
 *
 * Pure: `resolveConfig` takes an env bag and returns a frozen config, so it
 * unit-tests with no Electron and no real `process.env`. The Electron wiring
 * in `main.ts` calls `resolveConfig()` once at startup.
 *
 * Spec: docs/architecture/features/app-desktop.md → "config.ts"
 * [COMP:app-desktop/config]
 */

/** The custom URL scheme the app registers for deep links + the auth callback. */
export const PROTOCOL_SCHEME = "sidanclaw";

// The authenticated product is served at `app.sidan.ai`. `deriveApiUrl` maps the
// `app.` host to the sibling `api.` backend (the legacy `canvas.` prefix is kept
// as a tolerant fallback). `SIDANCLAW_APP_URL` overrides for dev (the app-web
// port, http://localhost:3003).
const DEFAULT_APP_URL = "https://app.sidan.ai";
const DEFAULT_API_URL = "https://api.sidan.ai";
const DEFAULT_QUICK_CAPTURE_HOTKEY = "CommandOrControl+Shift+Space";

/**
 * Host prefixes that identify the authenticated app origin; each maps to the
 * sibling `api.<domain>` backend. `canvas.` is the pre-consolidation origin,
 * `app.` is the post-flip origin (§9 #1). Both pair to the same API so the
 * sign-in mint (web → API) and the desktop code exchange (desktop → API) always
 * hit one backend.
 */
const APP_HOST_PREFIXES = ["app.", "canvas."] as const;

export interface DesktopConfig {
  /** Base URL the shell loads (no trailing slash). */
  readonly appUrl: string;
  /** Origin of `appUrl` — the one origin the app window trusts. */
  readonly appOrigin: string;
  /** Base URL of the backend API for the desktop sign-in code exchange (no trailing slash). */
  readonly apiUrl: string;
  /** Accelerator string for the global quick-capture hotkey. */
  readonly quickCaptureHotkey: string;
  /** Custom URL scheme for deep links + the auth callback. */
  readonly protocolScheme: string;
  /**
   * Bundled mode (Phase 4, docs/plans/canvas-desktop-bundled-offline.md): the
   * shell loads the client bundle from disk and authenticates with a Bearer
   * token held in `safeStorage` instead of `.sidan.ai` cookies. Off by default —
   * the shipped thin remote shell keeps the cookie path. When on, `main.ts`
   * passes `--sidanclaw-bundled` to the preload (which then exposes the token
   * bridge that activates app-web's `desktopAuthSource`) and persists tokens
   * rather than cookies on sign-in.
   */
  readonly bundled: boolean;
  /**
   * Whether the packaged shell checks the GitHub Releases feed for shell
   * binary updates (electron-updater — see `auto-update.ts`). On by default;
   * `SIDANCLAW_DISABLE_AUTO_UPDATE` (`1`/`true`) is the operator/QA
   * kill-switch (e.g. a locally-packaged unsigned .app, which Squirrel.Mac
   * could never apply an update onto anyway).
   */
  readonly autoUpdate: boolean;
}

/**
 * Resolve the desktop config from the environment.
 *
 * - `SIDANCLAW_APP_URL` overrides the app base URL (dev points it at
 *   `http://localhost:3003`, the app-web dev port).
 * - `SIDANCLAW_API_URL` overrides the backend API base URL. When unset it is
 *   **derived from the app URL** so the two never drift: a local app
 *   (`localhost`) pairs with the local API (`http://localhost:4000`), and an
 *   authenticated-app host (`canvas.<domain>` or `app.<domain>`) pairs with
 *   `api.<domain>`. This matters because the sign-in code is minted by whatever
 *   API the web app talks to, and the desktop app must exchange it against the
 *   *same* API — a mismatch is a 404.
 * - `SIDANCLAW_QUICK_CAPTURE_HOTKEY` overrides the global hotkey accelerator.
 * - `SIDANCLAW_BUNDLED` (`1`/`true`) turns on bundled mode (Bearer/`safeStorage`
 *   auth + the preload token bridge). Off by default — the thin shell stays on
 *   cookies.
 * - `SIDANCLAW_DISABLE_AUTO_UPDATE` (`1`/`true`) turns off the shell's
 *   electron-updater checks (`autoUpdate: false`). On by default.
 *
 * A trailing slash on the URLs is stripped so callers can concatenate absolute
 * paths unambiguously.
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): DesktopConfig {
  const appUrl = (env.SIDANCLAW_APP_URL?.trim() || DEFAULT_APP_URL).replace(/\/+$/, "");
  const apiUrl = (env.SIDANCLAW_API_URL?.trim() || deriveApiUrl(appUrl)).replace(/\/+$/, "");
  const quickCaptureHotkey =
    env.SIDANCLAW_QUICK_CAPTURE_HOTKEY?.trim() || DEFAULT_QUICK_CAPTURE_HOTKEY;
  const bundledFlag = env.SIDANCLAW_BUNDLED?.trim().toLowerCase();
  const bundled = bundledFlag === "1" || bundledFlag === "true";
  const noUpdateFlag = env.SIDANCLAW_DISABLE_AUTO_UPDATE?.trim().toLowerCase();
  const autoUpdate = !(noUpdateFlag === "1" || noUpdateFlag === "true");

  return Object.freeze({
    appUrl,
    appOrigin: new URL(appUrl).origin,
    apiUrl,
    quickCaptureHotkey,
    protocolScheme: PROTOCOL_SCHEME,
    bundled,
    autoUpdate,
  });
}

/**
 * Pair the API base URL to the app base URL so the sign-in mint (web → API)
 * and the desktop exchange (desktop → API) always hit the same backend:
 *  - `localhost` / `127.0.0.1` app → `http://localhost:4000`
 *  - `app.<domain>` / `canvas.<domain>` → `<scheme>//api.<domain>`
 *  - anything else → the production API default.
 */
function deriveApiUrl(appUrl: string): string {
  try {
    const u = new URL(appUrl);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
      return "http://localhost:4000";
    }
    for (const prefix of APP_HOST_PREFIXES) {
      if (u.hostname.startsWith(prefix)) {
        return `${u.protocol}//api.${u.hostname.slice(prefix.length)}`;
      }
    }
  } catch {
    /* fall through to the default */
  }
  return DEFAULT_API_URL;
}
