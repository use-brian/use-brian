/**
 * Auto-update — the pure decision core for shell binary self-update.
 *
 * Two-layer update story: PRODUCT updates ship through the remote web app on
 * every load (thin shell — nothing to do here); this module is about updating
 * the SHELL BINARY itself (window policy, tray, hotkey, auth wiring). The
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
  /** `cfg.autoUpdate` — the `SIDANCLAW_DISABLE_AUTO_UPDATE` kill-switch (config.ts). */
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
    return { enabled: false, reason: "SIDANCLAW_DISABLE_AUTO_UPDATE is set" };
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

// ── Cadence ────────────────────────────────────────────────────

/** Delay before the first background check, so launch never competes with it. */
export const UPDATE_INITIAL_CHECK_DELAY_MS = 15_000;

/** Cadence of background checks while the app stays running (tray-resident). */
export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * Whether a background tick should call `checkForUpdates()` in this state:
 * skip while electron-updater is already busy (`checking` / `downloading`) and
 * once an update is `ready` (restart applies it; re-checking the same version
 * would just re-download it).
 */
export function shouldCheckInState(state: UpdateState): boolean {
  return state.phase === "idle" || state.phase === "error";
}
