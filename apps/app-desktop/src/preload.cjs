// Sandboxed preload (CommonJS — sandboxed preloads cannot be ESM).
//
// Exposes the bridge the renderer can reach. In every mode it offers `signIn()`
// (ask the main process to start the system-browser sign-in flow) and
// `signOut()` (ask the main process to clear this shell's own session — cookies
// in the thin shell, the safeStorage token in bundled mode — and reload to the
// sign-in landing). The bridge also exposes fixed native actions such as
// macOS Siri setup; arbitrary setup URLs never cross this boundary. In
// **bundled mode** (main passes `--usebrian-bundled` via
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
const { contextBridge, ipcRenderer, webFrame } = require("electron");

const deploymentListeners = new Set();
let pendingDeployment = null;
ipcRenderer.on("Use Brian:choose-deployment", (_event, url) => {
  if (typeof url !== "string") return;
  pendingDeployment = url;
  if (deploymentListeners.size) {
    pendingDeployment = null;
    for (const callback of deploymentListeners) callback(url);
  }
});
const messageBrianListeners = new Set();
let messageBrianPending = false;
const useBrianListeners = new Set();
let useBrianPending = false;
const brianNearbyListeners = new Set();
const linkNavigationListeners = new Set();
const linkDeliveryListeners = new Set();
let pendingLinkDelivery = null;
let brianNearby = ipcRenderer.sendSync("Use Brian:get-brian-nearby-state") === true;
ipcRenderer.on("Use Brian:message-brian", () => {
  if (messageBrianListeners.size === 0) {
    messageBrianPending = true;
    return;
  }
  for (const listener of messageBrianListeners) listener();
});
ipcRenderer.on("Use Brian:use-brian", () => {
  if (useBrianListeners.size === 0) {
    useBrianPending = true;
    return;
  }
  for (const listener of useBrianListeners) listener();
});
ipcRenderer.on("Use Brian:brian-nearby-state", (_event, enabled) => {
  brianNearby = enabled === true;
  for (const listener of brianNearbyListeners) listener(brianNearby);
});
ipcRenderer.on("Use Brian:link-navigation-state", (_event, state) => {
  for (const listener of linkNavigationListeners) listener(state || null);
});
ipcRenderer.on("Use Brian:link-navigation-delivery", (_event, requestId) => {
  if (typeof requestId !== "string") return;
  if (linkDeliveryListeners.size === 0) {
    pendingLinkDelivery = requestId;
    return;
  }
  for (const listener of linkDeliveryListeners) listener(requestId);
});

/** @type {Record<string, unknown>} */
const bridge = {
  // The host OS, so app-web can gate macOS-only chrome (e.g. the traffic-light
  // inset in `.is-canvas-desktop`) without shipping a new desktop build.
  platform: process.platform,
  // Native macOS traffic lights stay in window coordinates while page zoom
  // scales app-web's CSS pixels. Expose only the current numeric factor so the
  // workspace chrome can keep its 76px clearance invariant. `webFrame` is used
  // here in preload because the sandboxed renderer cannot import Electron.
  getZoomFactor: () => webFrame.getZoomFactor(),
  // Local/self-hosted targets may put their browser-facing API on a separate
  // gateway-protected origin. The renderer uses this non-secret marker to opt
  // REST/SSE into Chromium credentials so that origin's gateway cookie is sent.
  gatewayCredentials: process.argv.includes("--usebrian-local-target"),
  // Dock recorder capability. The renderer uses this explicit promise instead
  // of guessing from a user agent; old shells omit it and remain mic-only.
  systemAudioCapture: process.platform === "darwin" || process.platform === "win32",
  // Screen-capture source picker (docs/architecture/media/live-capture.md ->
  // "Capture sources"): the renderer lists shareable windows and points the
  // shell's NEXT display-media grant at the picked one. Old shells omit these
  // and the recorder hides the specific-window option.
  captureSourcePicker: true,
  listCaptureSources: (kind) =>
    ipcRenderer.invoke(
      "Use Brian:list-capture-sources",
      kind === "screen" ? "screen" : "window",
    ),
  setCaptureSource: (id) =>
    ipcRenderer.send(
      "Use Brian:set-capture-source",
      typeof id === "string" ? id : null,
    ),
  signIn: () => ipcRenderer.send("Use Brian:sign-in"),
  signOut: () => ipcRenderer.send("Use Brian:sign-out"),
  // macOS Settings -> Preferences uses this fixed, argument-free action to
  // open the bundled shortcut import. app-web hides it on every other OS.
  openSiriSetup: () => ipcRenderer.invoke("Use Brian:open-siri-setup"),
  // One-shot native Ask payload. Only the selected trusted app renderer can
  // consume the prompt; app-web routes carry at most a `useBrian=1` signal.
  takeUseBrianPrompt: () =>
    ipcRenderer.sendSync("Use Brian:take-use-brian-prompt"),
  // Fixed wake-up event for a native Use Brian request. The prompt itself
  // stays main-process-only until the trusted renderer consumes it above.
  // Queue one event so a window load cannot outrun React hydration.
  onUseBrian: (callback) => {
    if (typeof callback !== "function") return () => {};
    useBrianListeners.add(callback);
    if (useBrianPending) {
      useBrianPending = false;
      queueMicrotask(() => callback());
    }
    return () => useBrianListeners.delete(callback);
  },
  isBrianNearby: () => brianNearby,
  onBrianNearbyChange: (callback) => {
    if (typeof callback !== "function") return () => {};
    brianNearbyListeners.add(callback);
    return () => brianNearbyListeners.delete(callback);
  },
  setCompanionContext: (workspaceId, assistantId) =>
    ipcRenderer.send("Use Brian:set-companion-context", workspaceId, assistantId),
  // The offline landing's "Retry" button asks the shell to reload the app now.
  // Present in every mode (like signIn/out); the offline landing is shell-owned.
  retry: () => ipcRenderer.send("Use Brian:retry-load"),
  // Multi-account. `addAccount` starts the system-browser sign-in for a SECOND
  // account (stash, don't replace); `switchAccount` swaps the active account to a
  // saved one and resolves to `{ ok }` / `{ ok:false, error }` so the switcher
  // can show an inline message and clear its per-row spinner. Present in every
  // mode (like signIn/out); bundled mode keeps a deployment-scoped directory.
  addAccount: () => ipcRenderer.send("Use Brian:add-account"),
  listAccounts: () => ipcRenderer.invoke("Use Brian:list-accounts"),
  selectAccount: (key) => ipcRenderer.invoke("Use Brian:select-account", key),
  removeAccount: (key) => ipcRenderer.invoke("Use Brian:remove-account", key),
  selectCloud: () => ipcRenderer.invoke("Use Brian:select-cloud"),
  chooseDeployment: () => ipcRenderer.send("Use Brian:choose-deployment"),
  onChooseDeployment: (callback) => {
    if (typeof callback !== "function") return () => {};
    deploymentListeners.add(callback);
    ipcRenderer.send("Use Brian:account-dialog-ready", true);
    // Defer consumption until after StrictMode's mount/unmount probe.
    queueMicrotask(() => {
      if (deploymentListeners.has(callback) && pendingDeployment !== null) {
        const url = pendingDeployment;
        pendingDeployment = null;
        callback(url);
      }
    });
    return () => {
      deploymentListeners.delete(callback);
      if (!deploymentListeners.size) ipcRenderer.send("Use Brian:account-dialog-ready", false);
    };
  },
  switchAccount: (id) => ipcRenderer.invoke("Use Brian:switch-account", id),
  // Dual target (docs/plans/consumer-local-experience.md §2.2). `runLocal`
  // probes a local/self-hosted brain's paired API (`null` = the launcher
  // default address) and resolves `{ ok }` / `{ ok:false, error, url }`; on
  // success the shell opens the saved deployment in this running app. `useCloud`
  // opens the cloud account. Present in every mode; the landing that
  // calls them is shell-owned.
  runLocal: (url) =>
    ipcRenderer.invoke("Use Brian:run-local", typeof url === "string" ? url : null),
  // Deployment-aware navigation recovery. State contains only display-safe
  // origin/account labels and fixed actions; credentials and fetch stay in main.
  getLinkNavigation: () => ipcRenderer.invoke("Use Brian:get-link-navigation"),
  onLinkNavigation: (callback) => {
    if (typeof callback !== "function") return () => {};
    linkNavigationListeners.add(callback);
    return () => linkNavigationListeners.delete(callback);
  },
  linkNavigationAction: (requestId, action, key) =>
    ipcRenderer.invoke("Use Brian:link-navigation-action", { requestId, action, key }),
  onLinkNavigationDelivery: (callback) => {
    if (typeof callback !== "function") return () => {};
    linkDeliveryListeners.add(callback);
    if (pendingLinkDelivery !== null) {
      const requestId = pendingLinkDelivery;
      pendingLinkDelivery = null;
      queueMicrotask(() => {
        if (linkDeliveryListeners.has(callback)) callback(requestId);
      });
    }
    return () => linkDeliveryListeners.delete(callback);
  },
  // Cloudflare Access Managed OAuth progress for the shell-owned local-target
  // landing. The callback receives status strings only; credentials and
  // endpoint metadata never cross into the renderer. Return an unsubscribe
  // function so a future SPA landing can clean up just as safely.
  onAccessAuthState: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, state) => {
      if (state === "checking" || state === "browser" || state === "approved") {
        callback(state);
      }
    };
    ipcRenderer.on("Use Brian:access-auth-state", listener);
    return () => ipcRenderer.removeListener("Use Brian:access-auth-state", listener);
  },
  useCloud: () => ipcRenderer.send("Use Brian:use-cloud"),
  // Dock live recording (docs/architecture/media/live-capture.md): app-web
  // signals a latched capture starting/ending so the shell can show/close the
  // floating always-on-top recorder overlay window.
  setRecording: (on) => ipcRenderer.send("Use Brian:recording-state", on === true),
  // Connector OAuth (Google / Notion). The web flow's browser-cookie CSRF can't
  // survive the Electron→system-browser jar split, so the connectors page hands
  // the built provider authorize URL (minus `state`) to the shell, which drives
  // an RFC 8252 loopback flow and navigates back to the connectors page on done.
  // Spec: docs/plans/desktop-connector-oauth-return.md.
  connectConnector: (req) => ipcRenderer.send("Use Brian:connect-connector", req),
  // The always-on-top Brian companion asks the already-mounted workspace
  // chrome to reveal its existing composer. Queue one intent until hydration
  // subscribes so a cold window can never drop the click.
  onMessageBrian: (callback) => {
    if (typeof callback !== "function") return () => {};
    messageBrianListeners.add(callback);
    if (messageBrianPending) {
      messageBrianPending = false;
      queueMicrotask(() => {
        callback();
      });
    }
    return () => messageBrianListeners.delete(callback);
  },
  acknowledgeMessageBrian: () => ipcRenderer.send("Use Brian:message-brian-consumed"),
  // The dedicated chat renderer mirrors its display-only lifecycle onto the
  // local companion. Main validates both sender identity and payload shape.
  setCompanionState: (state) => ipcRenderer.send("Use Brian:companion-state", state),
};

if (process.argv.includes("--usebrian-bundled")) {
  // Seed the token cache synchronously at load so the first authFetch has a
  // token without an async round-trip; the `AuthSource` getters are sync.
  let cache = ipcRenderer.sendSync("Use Brian:get-tokens") || null;

  bridge.getAccessToken = () => (cache && cache.accessToken) || null;
  bridge.getRefreshToken = () => (cache && cache.refreshToken) || null;
  // The file: renderer has no app-domain `user` cookie. Expose only the
  // display identity from the encrypted token record so app-web can use the
  // same name/email/photo as the browser without exposing any extra credential.
  bridge.getCurrentUser = () => (cache && cache.user) || null;
  // Local authored caches use the active native identity, not file:// cookies.
  bridge.getUserId = () => (cache && cache.user && cache.user.id) || null;
  bridge.refreshTokens = async () => {
    // Main owns the selected deployment's transport and durable session. Update
    // only this renderer's cache; a second set/clear IPC could race a switch.
    const result = await ipcRenderer.invoke("Use Brian:refresh-tokens");
    if (result.kind === "ok") cache = result.tokens;
    else if (result.kind === "unauthenticated") cache = null;
    return result;
  };
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
