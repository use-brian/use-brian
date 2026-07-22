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

import {
  CLOUD_APP_URL,
  deriveApiUrl,
  resolveTargetFromPersisted,
  type TargetAuth,
  type TargetKind,
} from "./target-store.js";

/** The custom URL scheme the app registers for deep links + the auth callback. */
export const PROTOCOL_SCHEME = "usebrian";

// The authenticated product is served at `app.usebrian.ai`. `deriveApiUrl`
// (target-store.ts) maps the `app.` host to the sibling `api.` backend (the
// legacy `canvas.` prefix is kept as a tolerant fallback). `USEBRIAN_APP_URL`
// overrides for dev (the app-web port, http://localhost:3003); the persisted
// target record (target-store.ts) is the consumer mechanism.
const DEFAULT_QUICK_CAPTURE_HOTKEY = "CommandOrControl+Shift+Space";
const DEFAULT_RECORD_HOTKEY = "CommandOrControl+Shift+R";

export interface DesktopConfig {
  /** Base URL the shell loads (no trailing slash). */
  readonly appUrl: string;
  /** Origin of `appUrl` — the one origin the app window trusts. */
  readonly appOrigin: string;
  /** Base URL of the backend API for the desktop sign-in code exchange (no trailing slash). */
  readonly apiUrl: string;
  /**
   * Which brain this launch fronts (docs/plans/consumer-local-experience.md
   * §2). Resolved once at startup from the persisted `target.json` record
   * (`target-store.ts`); the env override keeps today's cloud/dev semantics.
   * Switching targets rewrites the record and relaunches the shell.
   */
  readonly target: TargetKind;
  /** The target's auth strategy: system-browser PKCE (cloud) or the local-owner session mint. */
  readonly targetAuth: TargetAuth;
  /** Human indicator for the menu/tray/title, e.g. `Local Brain (localhost:3003)`. */
  readonly targetLabel: string;
  /**
   * True when `USEBRIAN_APP_URL` overrode the target (dev). The persisted
   * record is ignored for this launch, so `main.ts` refuses target switching
   * with an explanation while this is set — otherwise a switch persists the
   * record but never survives the relaunch, which reads as it silently not
   * working. The indicator label becomes `Dev override (<host>)`.
   */
  readonly envTargetOverride: boolean;
  /** Accelerator string for the global quick-capture hotkey. */
  readonly quickCaptureHotkey: string;
  /** Accelerator string for the global start-recording hotkey. */
  readonly recordHotkey: string;
  /** Custom URL scheme for deep links + the auth callback. */
  readonly protocolScheme: string;
  /**
   * Bundled mode (Phase 4, docs/plans/canvas-desktop-bundled-offline.md): the
   * shell loads the client bundle from disk and authenticates with a Bearer
   * token held in `safeStorage` instead of `.usebrian.ai` cookies. Off by default —
   * the shipped thin remote shell keeps the cookie path. When on, `main.ts`
   * passes `--usebrian-bundled` to the preload (which then exposes the token
   * bridge that activates app-web's `desktopAuthSource`) and persists tokens
   * rather than cookies on sign-in.
   */
  readonly bundled: boolean;
  /**
   * Whether the packaged shell checks the GitHub Releases feed for shell
   * binary updates (electron-updater — see `auto-update.ts`). On by default;
   * `USEBRIAN_DISABLE_AUTO_UPDATE` (`1`/`true`) is the operator/QA
   * kill-switch (e.g. a locally-packaged unsigned .app, which Squirrel.Mac
   * could never apply an update onto anyway).
   */
  readonly autoUpdate: boolean;
}

/**
 * Resolve the desktop config from the environment plus the persisted target
 * record (`main.ts` reads `userData/target.json` and passes its raw contents;
 * see `target-store.ts`). Precedence: env override (dev) > persisted target >
 * cloud default.
 *
 * - `USEBRIAN_APP_URL` overrides the app base URL (dev points it at
 *   `http://localhost:3003`, the app-web dev port).
 * - `USEBRIAN_API_URL` overrides the backend API base URL. When unset it is
 *   **derived from the app URL** so the two never drift: a local app
 *   (`localhost`) pairs with the local API (`http://localhost:4000`), and an
 *   authenticated-app host (`canvas.<domain>` or `app.<domain>`) pairs with
 *   `api.<domain>`. This matters because the sign-in code is minted by whatever
 *   API the web app talks to, and the desktop app must exchange it against the
 *   *same* API — a mismatch is a 404.
 * - `USEBRIAN_QUICK_CAPTURE_HOTKEY` overrides the global hotkey accelerator.
 * - `USEBRIAN_RECORD_HOTKEY` overrides the global start-recording accelerator.
 * - `USEBRIAN_BUNDLED` (`1`/`true`) turns on bundled mode (Bearer/`safeStorage`
 *   auth + the preload token bridge). Off by default — the thin shell stays on
 *   cookies.
 * - `USEBRIAN_DISABLE_AUTO_UPDATE` (`1`/`true`) turns off the shell's
 *   electron-updater checks (`autoUpdate: false`). On by default.
 *
 * A trailing slash on the URLs is stripped so callers can concatenate absolute
 * paths unambiguously.
 */
export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
  persistedTargetRaw: string | null = null,
): DesktopConfig {
  const envAppUrl = env.USEBRIAN_APP_URL?.trim() || "";
  // The env override wins the WHOLE target and keeps today's cloud/dev
  // semantics (PKCE interception, no title suffix) regardless of any persisted
  // record — it is the dev mechanism, the record is the consumer one (§2.1).
  const target = envAppUrl ? null : resolveTargetFromPersisted(persistedTargetRaw);
  const appUrl = (envAppUrl || target?.appUrl || CLOUD_APP_URL).replace(/\/+$/, "");
  const apiUrl = (env.USEBRIAN_API_URL?.trim() || target?.apiUrl || deriveApiUrl(appUrl)).replace(
    /\/+$/,
    "",
  );
  const quickCaptureHotkey =
    env.USEBRIAN_QUICK_CAPTURE_HOTKEY?.trim() || DEFAULT_QUICK_CAPTURE_HOTKEY;
  const recordHotkey = env.USEBRIAN_RECORD_HOTKEY?.trim() || DEFAULT_RECORD_HOTKEY;
  const bundledFlag = env.USEBRIAN_BUNDLED?.trim().toLowerCase();
  const bundled = bundledFlag === "1" || bundledFlag === "true";
  const noUpdateFlag = env.USEBRIAN_DISABLE_AUTO_UPDATE?.trim().toLowerCase();
  const autoUpdate = !(noUpdateFlag === "1" || noUpdateFlag === "true");

  return Object.freeze({
    appUrl,
    appOrigin: new URL(appUrl).origin,
    apiUrl,
    target: target?.kind ?? "cloud",
    targetAuth: target?.auth ?? "pkce",
    targetLabel: envAppUrl
      ? `Dev override (${new URL(appUrl).host})`
      : target?.label ?? "Use Brian Cloud",
    envTargetOverride: Boolean(envAppUrl),
    quickCaptureHotkey,
    recordHotkey,
    protocolScheme: PROTOCOL_SCHEME,
    bundled,
    autoUpdate,
  });
}
