/**
 * Auto-update — the pure decision core for shell binary self-update.
 *
 * The bundled renderer and native shell update together through a signed
 * desktop release; compatible backend changes deploy independently. The
 * Electron binding in `main.ts` feeds electron-updater lifecycle events through
 * `reduceUpdateState` and renders the result via `describeUpdateState` into the
 * single update item in the app menu + tray, so every decision here unit-tests
 * with no Electron and no network. Feed resolution, download, signature
 * verification, and install-on-quit belong to electron-updater; this module
 * owns only *whether* updating is allowed, *what* the UI shows, and *when* to
 * check.
 *
 * Spec: docs/architecture/features/app-desktop.md → "auto-update.ts"
 * [COMP:app-desktop/auto-update]
 */

// ── Gate ───────────────────────────────────────────────────────

export interface AutoUpdateGateInput {
  /** `app.isPackaged` — an unpackaged dev run has no app-update.yml feed. */
  readonly isPackaged: boolean;
  /** `cfg.autoUpdate` — the `USEBRIAN_DISABLE_AUTO_UPDATE` kill-switch (config.ts). */
  readonly autoUpdate: boolean;
}

export interface AutoUpdateGate {
  readonly enabled: boolean;
  /** Human-readable why, for the startup log line. */
  readonly reason: string;
}

/**
 * Whether the shell should run electron-updater at all. Disabled in unpackaged
 * dev runs (electron-builder only writes the `app-update.yml` feed descriptor
 * into a packaged bundle — electron-updater throws without it) and when the
 * operator/QA kill-switch is set. Platform needs no gate: macOS + Windows are
 * the only packaged targets and both are supported feeds.
 */
export function shouldEnableAutoUpdate(input: AutoUpdateGateInput): AutoUpdateGate {
  if (!input.isPackaged) {
    return { enabled: false, reason: "unpackaged dev run (no app-update.yml feed)" };
  }
  if (!input.autoUpdate) {
    return { enabled: false, reason: "USEBRIAN_DISABLE_AUTO_UPDATE is set" };
  }
  return { enabled: true, reason: "packaged build with a release feed" };
}

// ── State machine ──────────────────────────────────────────────

export type UpdateState =
  | { readonly phase: "idle" }
  | { readonly phase: "checking" }
  | { readonly phase: "downloading"; readonly version: string; readonly percent: number }
  | { readonly phase: "ready"; readonly version: string }
  | { readonly phase: "error"; readonly message: string };

/** electron-updater lifecycle events, reduced to the fields the UI needs. */
export type UpdateEvent =
  | { readonly kind: "checking" }
  | { readonly kind: "not-available" }
  | { readonly kind: "available"; readonly version: string }
  | { readonly kind: "progress"; readonly percent: number }
  | { readonly kind: "downloaded"; readonly version: string }
  | { readonly kind: "error"; readonly message: string };

export const INITIAL_UPDATE_STATE: UpdateState = { phase: "idle" };

/**
 * Fold an electron-updater event into the UI state.
 *
 * The one non-obvious rule: `ready` is STICKY. A downloaded update sits on disk
 * installable until quit/restart, so a later periodic check, a transient
 * network error, or a "no update" result must not clobber the restart
 * affordance. Only a *different-version* download supersedes it (and a
 * different-version `available` means that download already started).
 */
export function reduceUpdateState(state: UpdateState, event: UpdateEvent): UpdateState {
  if (event.kind === "downloaded") return { phase: "ready", version: event.version };
  if (state.phase === "ready") {
    if (event.kind === "available" && event.version !== state.version) {
      return { phase: "downloading", version: event.version, percent: 0 };
    }
    return state;
  }
  switch (event.kind) {
    case "checking":
      return { phase: "checking" };
    case "not-available":
      return { phase: "idle" };
    case "available":
      return { phase: "downloading", version: event.version, percent: 0 };
    case "progress":
      // Progress only means something mid-download; a stray event elsewhere
      // (out-of-order delivery) carries no version context, so ignore it.
      return state.phase === "downloading" ? { ...state, percent: event.percent } : state;
    case "error":
      return { phase: "error", message: event.message };
  }
}

// ── Menu item derivation ───────────────────────────────────────

export type UpdateAction = "check" | "restart" | "none";

export interface UpdateMenuItemState {
  readonly label: string;
  readonly enabled: boolean;
  /** What a click on the item does in this state. */
  readonly action: UpdateAction;
}

/**
 * The single update menu/tray item for a state. `error` renders as a plain
 * "Check for Updates…" again — the failure was already logged (and dialog-ed
 * for a manual check); the useful affordance afterwards is retry.
 */
export function describeUpdateState(state: UpdateState): UpdateMenuItemState {
  switch (state.phase) {
    case "checking":
      return { label: "Checking for Updates…", enabled: false, action: "none" };
    case "downloading":
      return {
        label: `Downloading Update… ${Math.round(state.percent)}%`,
        enabled: false,
        action: "none",
      };
    case "ready":
      return { label: `Restart to Update (v${state.version})`, enabled: true, action: "restart" };
    case "idle":
    case "error":
      return { label: "Check for Updates…", enabled: true, action: "check" };
  }
}

// ── Renderer status ────────────────────────────────────────────

/**
 * The slice of update state the app window renders as its footer chip, beside
 * the sync status. Only states the user can act on or should expect: an
 * in-flight download (so a restart now would not pick it up yet) and a staged
 * update (the restart button). Everything else renders nothing.
 */
export type RendererUpdateStatus =
  | { readonly phase: "downloading"; readonly version: string; readonly percent: number }
  | { readonly phase: "ready"; readonly version: string };

export function rendererUpdateStatus(state: UpdateState): RendererUpdateStatus | null {
  if (state.phase === "downloading") {
    return { phase: "downloading", version: state.version, percent: Math.round(state.percent) };
  }
  if (state.phase === "ready") return { phase: "ready", version: state.version };
  return null;
}

// ── Cadence ────────────────────────────────────────────────────

/** Delay before the launch check, so the first window paint never competes with it. */
export const UPDATE_INITIAL_CHECK_DELAY_MS = 5_000;

/** Cadence of background checks while the app stays running (tray-resident). */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Minimum spacing between checks fired by "the user opened the app" signals
 * (app activate, window focus, wake from sleep). Opening the app always checks,
 * but alt-tabbing ten times a minute must not hit the release feed ten times.
 */
export const UPDATE_OPEN_CHECK_MIN_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Whether a check should run in this state: skip only while electron-updater
 * is already busy (`checking` / `downloading`).
 *
 * `ready` DOES check. A staged update is not the end of the road: if a newer
 * release ships while v(N) sits downloaded, refusing to check strands the shell
 * on v(N) until the user restarts into it, and only then does it discover
 * v(N+1) (the "restart into an old new update" bug). electron-updater serves a
 * same-version re-check from its download cache without re-downloading, and the
 * reducer keeps `ready` sticky unless a different version arrives.
 */
export function shouldCheckInState(state: UpdateState): boolean {
  return state.phase !== "checking" && state.phase !== "downloading";
}

/** Whether an "app opened" signal should fire a check now (throttled). */
export function shouldCheckOnOpen(
  state: UpdateState,
  lastCheckAt: number | null,
  now: number,
): boolean {
  if (!shouldCheckInState(state)) return false;
  return lastCheckAt === null || now - lastCheckAt >= UPDATE_OPEN_CHECK_MIN_INTERVAL_MS;
}

// ── Auto-install ───────────────────────────────────────────────

/** How long the machine must sit idle before a staged update installs itself. */
export const UPDATE_AUTO_INSTALL_IDLE_SECONDS = 10 * 60;

/** Cadence of the auto-install opportunity probe. */
export const UPDATE_AUTO_INSTALL_PROBE_MS = 60 * 1000;

export interface AutoInstallInput {
  readonly state: UpdateState;
  /** Any app window currently visible on screen. */
  readonly windowVisible: boolean;
  /** A dock live recording is latched (the overlay is up). */
  readonly recording: boolean;
  /** `powerMonitor.getSystemIdleTime()` in seconds. */
  readonly systemIdleSeconds: number;
}

/**
 * Whether to apply a staged update now, without a click. Only when nobody is
 * using the app: no visible window, no live recording, and the machine idle
 * long enough that a relaunch interrupts nothing. Otherwise the footer button
 * and install-on-quit cover it; a restart is never forced on an active user.
 */
export function shouldAutoInstall(input: AutoInstallInput): boolean {
  return (
    input.state.phase === "ready" &&
    !input.windowVisible &&
    !input.recording &&
    input.systemIdleSeconds >= UPDATE_AUTO_INSTALL_IDLE_SECONDS
  );
}
