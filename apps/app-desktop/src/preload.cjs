// Sandboxed preload (CommonJS — sandboxed preloads cannot be ESM).
//
// Exposes the bridge the renderer can reach. In every mode it offers `signIn()`
// (ask the main process to start the system-browser sign-in flow) and
// `signOut()` (ask the main process to clear this shell's own session — cookies
// in the thin shell, the safeStorage token in bundled mode — and reload to the
// sign-in landing). These are the only privileged surfaces the web/landing
// content can reach. In **bundled mode** (main passes `--usebrian-bundled` via
// webPreferences.additionalArguments) it additionally exposes the Bearer-token
// bridge that activates app-web's `desktopAuthSource` (lib/desktop-auth-source.ts).
// The thin remote shell does NOT pass that flag, so the token methods stay absent
// and `isDesktopAuth()` stays false — the cookie auth path is untouched.
//
// `signOut()` exists in BOTH modes (unlike the token bridge): the web logout UI
// must route through the shell so it clears the in-app session in place, instead
// of bouncing to the primary's `/api/auth/logout` — in Electron that primary URL
// is an external origin, so the nav policy opens it in the SYSTEM browser, which
// signs the user out of the *web* session while leaving the desktop session live.
//
// Spec: docs/architecture/features/app-desktop.md → "Sign-in landing" + "Sign-out";
//       docs/plans/canvas-desktop-bundled-offline.md → Phase 1 ("Remaining wiring").
const { contextBridge, ipcRenderer } = require("electron");

/** @type {Record<string, unknown>} */
const bridge = {
  // The host OS, so app-web can gate macOS-only chrome (e.g. the traffic-light
  // inset in `.is-canvas-desktop`) without shipping a new desktop build.
  platform: process.platform,
  signIn: () => ipcRenderer.send("Use Brian:sign-in"),
  signOut: () => ipcRenderer.send("Use Brian:sign-out"),
  // The offline landing's "Retry" button asks the shell to reload the app now.
  // Present in every mode (like signIn/out); the offline landing is shell-owned.
  retry: () => ipcRenderer.send("Use Brian:retry-load"),
  // Multi-account. `addAccount` starts the system-browser sign-in for a SECOND
  // account (stash, don't replace); `switchAccount` swaps the active account to a
  // saved one and resolves to `{ ok }` / `{ ok:false, error }` so the switcher
  // can show an inline message and clear its per-row spinner. Present in every
  // mode (like signIn/out); bundled mode stays single-account (switch errors).
  addAccount: () => ipcRenderer.send("Use Brian:add-account"),
  switchAccount: (id) => ipcRenderer.invoke("Use Brian:switch-account", id),
  // Dual target (docs/plans/consumer-local-experience.md §2.2). `runLocal`
  // probes a local/self-hosted brain's paired API (`null` = the launcher
  // default address) and resolves `{ ok }` / `{ ok:false, error, url }`; on
  // success the shell persists the target and RELAUNCHES. `useCloud` persists
  // the cloud target and relaunches. Present in every mode; the landing that
  // calls them is shell-owned.
  runLocal: (url) =>
    ipcRenderer.invoke("Use Brian:run-local", typeof url === "string" ? url : null),
  useCloud: () => ipcRenderer.send("Use Brian:use-cloud"),
  // Dock live recording (docs/architecture/media/live-capture.md): app-web
  // signals a latched capture starting/ending so the shell can show/close the
  // floating always-on-top recorder overlay window.
  setRecording: (on) => ipcRenderer.send("Use Brian:recording-state", on === true),
};

if (process.argv.includes("--usebrian-bundled")) {
  // Seed the token cache synchronously at load so the first authFetch has a
  // token without an async round-trip; the `AuthSource` getters are sync.
  let cache = ipcRenderer.sendSync("Use Brian:get-tokens") || null;

  bridge.getAccessToken = () => (cache && cache.accessToken) || null;
  bridge.getRefreshToken = () => (cache && cache.refreshToken) || null;
  bridge.setTokens = (tokens) => {
    // Update the local cache first (so a subsequent sync getAccessToken sees the
    // rotated token immediately), then persist to safeStorage via main.
    cache = tokens || null;
    ipcRenderer.send("Use Brian:set-tokens", tokens);
  };
  bridge.clear = () => {
    cache = null;
    ipcRenderer.send("Use Brian:clear-tokens");
  };
}

// Dual-expose during the rebrand transition: `usebrianDesktop` is canonical;
// `sidanclawDesktop` keeps pre-rebrand app-web builds (which read only the
// legacy name) working against this shell. app-web reads via its
// `desktopBridge()` accessor (canonical first). Drop the legacy expose only
// when no deployed app-web still reads it.
contextBridge.exposeInMainWorld("usebrianDesktop", bridge);
contextBridge.exposeInMainWorld("sidanclawDesktop", bridge);
