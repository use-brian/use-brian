/**
 * Canvas Desktop — Electron main process (the IO shell).
 *
 * A hardened BrowserWindow loads the deployed canvas web app and adds the
 * native capabilities a browser cannot: a global quick-capture hotkey, a tray,
 * OS-level menus, a `sidanclaw://` deep-link protocol, and a system-browser
 * sign-in flow (RFC 8252 + PKCE). It owns no UI and no backend — every pixel is
 * served by apps/app-web. All decisions are delegated to the pure helpers
 * (config / window-policy / deep-link / quick-capture / desktop-auth) so this
 * file stays thin and they stay tested.
 *
 * Spec: docs/architecture/features/app-desktop.md → "main.ts"
 * [COMP:app-desktop/main]
 */

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  app,
  shell,
  globalShortcut,
  ipcMain,
  session,
  safeStorage,
  dialog,
  powerMonitor,
  net,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  nativeImage,
  type Event,
  type MenuItemConstructorOptions,
} from "electron";
// electron-updater is CommonJS; its named exports are lazy getters that Node's
// ESM-CJS interop cannot statically detect, so a named import (`import {
// autoUpdater }`) resolves at compile time but THROWS at runtime in this ESM
// main process. Default-import the module object and destructure instead.
import electronUpdater from "electron-updater";

import { resolveConfig } from "./config.js";
import {
  INITIAL_UPDATE_STATE,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_INITIAL_CHECK_DELAY_MS,
  describeUpdateState,
  reduceUpdateState,
  shouldCheckInState,
  shouldEnableAutoUpdate,
  type UpdateEvent,
  type UpdateState,
} from "./auto-update.js";
import {
  classifyNavigation,
  isLoginNavigation,
  parseRefreshBounce,
  decideLoadFailureAction,
} from "./window-policy.js";
import { resolveDeepLink } from "./deep-link.js";
import { quickCaptureUrl } from "./quick-capture.js";
import { buildAppMenu } from "./menu.js";
import {
  generatePkcePair,
  buildDesktopAuthStartUrl,
  buildLoopbackRedirectUri,
  buildSignedInPageUrl,
  generateStateNonce,
  parseAuthCallback,
  parseLoopbackCallback,
  exchangeCode,
  refreshSession,
  shouldRefreshSession,
  SESSION_REFRESH_CHECK_INTERVAL_MS,
  buildSessionCookies,
  serializePendingVerifier,
  parsePendingVerifier,
  type DesktopSession,
} from "./desktop-auth.js";
import {
  parseAccountStore,
  parseAccountDir,
  parseUserCookieValue,
  upsertAccountDir,
  stashAndAddAccount,
  applySwitchRotation,
  rotateActiveInStore,
  pruneAccount,
  planActiveLogout,
  buildAccountStoreCookies,
  MAX_ACCOUNTS,
  type AccountStore,
  type AccountDirEntry,
  type AccountCredential,
} from "./desktop-accounts.js";
import {
  type TokenCipher,
  type StoredTokens,
  encryptTokens,
  encryptBlob,
  decryptTokens,
  serializeRendererTokens,
} from "./desktop-token-store.js";

const { autoUpdater } = electronUpdater;

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfg = resolveConfig();
const isDev = !app.isPackaged;

const PRELOAD_PATH = join(__dirname, "preload.cjs");
const SIGNIN_PAGE = join(__dirname, "signin.html");
/**
 * The offline landing — shown (instead of the sign-in landing) when a signed-in
 * user's main-frame load fails for lack of network. Keeps the session intact and
 * auto-reconnects. See `showOffline` + "Offline resilience" in the spec.
 */
const OFFLINE_PAGE = join(__dirname, "offline.html");
/**
 * The bundled SPA index (Phase 4, docs/plans/canvas-desktop-bundled-offline.md).
 * Present only in a packaged bundled build (the client export is emitted to
 * `renderer/`); absent in dev + the thin shell, so `loadApp` falls back to the
 * remote canvas URL. Combined with `cfg.bundled`, this gates loadFile vs loadURL.
 */
const BUNDLE_INDEX = join(__dirname, "..", "renderer", "index.html");

const AUTH_COOKIE_NAMES = ["access_token", "refresh_token", "user"] as const;
/**
 * The saved-account cookies (mirroring the web's `.sidan.ai` store) the shell
 * keeps in its own host-only jar. Kept SEPARATE from `AUTH_COOKIE_NAMES`:
 * `signOut()` clears these too, but the per-tick keep-alive must NOT, or it would
 * wipe every saved account on each refresh. See `apps/app-desktop/desktop-accounts.ts`.
 */
const ACCOUNT_STORE_COOKIE_NAMES = ["accounts_store", "accounts_dir"] as const;

/** Outcome of a multi-account switch, surfaced to the renderer's inline error. */
type SwitchResult = { ok: true } | { ok: false; error: "switch" | "reauth" };

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** The PKCE verifier for an in-flight sign-in; held until the callback returns. */
let pendingVerifier: string | null = null;
/** Whether the in-flight sign-in adds a second account (stash) vs replaces the active one. */
let pendingAddAccount = false;
/** The loopback-callback nonce for an in-flight sign-in (CSRF guard). */
let pendingState: string | null = null;
/** The ephemeral `127.0.0.1` server receiving the sign-in code (RFC 8252 §7.3). */
let authServer: Server | null = null;
/** Auto-teardown for an abandoned sign-in's loopback server. */
let authServerTimer: ReturnType<typeof setTimeout> | null = null;
/** A deep link / auth callback delivered before the window exists (macOS cold-start). */
let pendingUrl: string | null = null;

// ── Window ─────────────────────────────────────────────────────

/**
 * Drag-region safety net. In a frameless window, a CSS `-webkit-app-region:
 * drag` element is an OS window-drag handle, so it swallows `mousedown` — the
 * element still shows `:hover` (the cursor moves over it) but **clicks never
 * fire**, which reads as "hoverable but not clickable". app-web opts its own
 * chrome's interactive descendants back out, but a non-doc page (the `/teams`
 * picker, `/login`) or an older deployed build can leave a draggable area over
 * real controls. We force every interactive element to opt out, app-wide, on
 * every load — a click is then always a click, while non-interactive chrome
 * stays draggable. Mirrors app-web's own `[data-doc-chrome] :is(button, a, …)`
 * rule, generalized so the shell never depends on the page tagging perfectly.
 */
const INTERACTIVE_NO_DRAG_CSS = `
  a, button, input, textarea, select, label, summary,
  [role="button"], [role="link"], [role="menuitem"], [role="tab"],
  [role="option"], [contenteditable], [data-no-drag] {
    -webkit-app-region: no-drag !important;
  }
`;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: app.name,
    // macOS only: frameless window with inset traffic lights — app-web draws its
    // own chrome and insets for the lights (app-web globals.css `.is-canvas-desktop`).
    // On Windows/Linux `hiddenInset` degrades to a frameless window with NO min/
    // close controls, so keep the standard OS frame there. The frameless-overlay
    // polish for Windows (titleBarOverlay + an app-web right-side control inset) is
    // deferred — see docs/architecture/features/app-desktop.md → "Windows (v1 frame)".
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // Bundled mode only: tell the preload to expose the Bearer token bridge.
      // Absent in the thin shell, so its `isDesktopAuth()` stays false (cookies).
      additionalArguments: cfg.bundled ? ["--sidanclaw-bundled"] : [],
    },
  });

  win.once("ready-to-show", () => {
    win.show();
    win.webContents.focus();
  });

  // Whenever the OS makes the window key again — the user returns to the app
  // after the browser sign-in hop, cmd-tabs back, or clicks the dock icon —
  // re-assert input focus on the web view. A window can be key while its web
  // contents are not first responder, which reads as "the page won't accept
  // clicks" (the post-login symptom). This is the durable counterpart to the
  // explicit focusWindow() calls. See focusWindow.
  win.on("focus", () => {
    if (!win.webContents.isDestroyed()) win.webContents.focus();
  });

  // Re-apply the drag-region safety net (see INTERACTIVE_NO_DRAG_CSS) on every
  // full load, so controls on the loaded page can never be silently turned into
  // window-drag handles that eat clicks. insertCSS persists across the page's
  // own SPA navigations, so re-applying per full load is enough.
  win.webContents.on("did-finish-load", () => {
    if (!win.webContents.isDestroyed()) void win.webContents.insertCSS(INTERACTIVE_NO_DRAG_CSS);
  });

  // Outbound links and untrusted origins open in the system browser; sign-in
  // navigations show the in-app landing; the app frame stays pinned to canvas.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isLoginNavigation(url)) promptSignIn();
    else void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", handleNavigation);
  win.webContents.on("will-redirect", handleNavigation);

  // Never leave a blank window on a main-frame load failure. A SIGNED-IN user
  // (a refresh token in the jar) whose load fails for lack of network gets the
  // offline landing + auto-retry, never the sign-in landing — a network blip is
  // not a sign-out. Only a user with no session goes to sign-in. The verdict is
  // the pure `decideLoadFailureAction`; this just enacts it. `-3` (ERR_ABORTED)
  // and our own `file:` landing are handled inside the helper.
  win.webContents.on("did-fail-load", (_e, errorCode, _desc, failedUrl, isMainFrame) => {
    void (async () => {
      const hasSession = !!(await readJarCookie("refresh_token"));
      switch (decideLoadFailureAction({ errorCode, isMainFrame, failedUrl, hasSession })) {
        case "ignore":
          return;
        case "show-window":
          win.show();
          return;
        case "offline-retry":
          showOffline(win);
          return;
        case "signin":
          promptSignIn();
          return;
      }
    })();
  });

  void loadApp(win);
  win.on("closed", () => {
    mainWindow = null;
  });
  return win;
}

function handleNavigation(event: Event, url: string): void {
  // A login page or OAuth hop must never load in-window — cancel it and show
  // the in-app sign-in landing (the user starts the system-browser PKCE flow
  // from there) instead of leaving a blank window.
  if (isLoginNavigation(url)) {
    event.preventDefault();
    promptSignIn();
    return;
  }
  // A sub-app refresh bounce (the proxy's redirect on a stale access token, or
  // a client authFetch redirect that raced the keep-alive) can't work in the
  // shell: the primary is an external origin, and the shell's host-only jar is
  // one the primary could never write. Refresh shell-side and resume at `next`.
  const bounceNext = cfg.bundled ? null : parseRefreshBounce(url, cfg.appOrigin);
  if (bounceNext) {
    event.preventDefault();
    void resumeAfterRefresh(bounceNext);
    return;
  }
  if (classifyNavigation(url, cfg.appOrigin) === "external") {
    event.preventDefault();
    void shell.openExternal(url);
  }
}

/** Show the built-in sign-in landing (never a blank window). */
function promptSignIn(): void {
  stopOfflineRetry(); // leaving the offline state for a real sign-out
  const win = ensureWindow();
  void win.webContents.loadFile(SIGNIN_PAGE).then(() => focusWindow(win));
}

// ── Offline landing + auto-retry ───────────────────────────────
//
// A signed-in user whose Mac drops off the network must never be bounced to the
// sign-in landing (that reads as a spurious logout). Instead the shell shows a
// branded offline landing and polls connectivity, reloading the app the moment
// the network returns. The jar's refresh token is untouched throughout. Spec:
// docs/architecture/features/app-desktop.md → "Offline resilience".

const OFFLINE_RETRY_INTERVAL_MS = 5 * 1000;
let offlineRetryTimer: ReturnType<typeof setInterval> | null = null;

function stopOfflineRetry(): void {
  if (offlineRetryTimer) {
    clearInterval(offlineRetryTimer);
    offlineRetryTimer = null;
  }
}

/**
 * Reload the app once connectivity is back. Clears the watcher first so a slow
 * load can't stack reloads; if the load fails again, `did-fail-load` re-arms the
 * watcher via `showOffline`. `net.isOnline()` only proves *some* network exists,
 * not that our origin is reachable — that's fine, a still-failing load just
 * re-shows the offline landing.
 */
async function retryLoad(win: BrowserWindow): Promise<void> {
  stopOfflineRetry();
  await loadApp(win);
}

/**
 * Show the offline landing and start polling for the network to return. Keeps
 * the session intact — only a real sign-out (`promptSignIn`) clears the user.
 */
function showOffline(win: BrowserWindow): void {
  void win.webContents.loadFile(OFFLINE_PAGE).then(() => focusWindow(win));
  stopOfflineRetry();
  offlineRetryTimer = setInterval(() => {
    if (net.isOnline()) void retryLoad(win);
  }, OFFLINE_RETRY_INTERVAL_MS);
}

/** Return the live window, recreating it if it was closed (tray app model). */
function ensureWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
  }
  return mainWindow;
}

function focusWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  // Sign-in completes in the *system browser* (the loopback/`sidanclaw://`
  // callback), so when we get here that browser is the frontmost macOS app and
  // we are a background process. `win.focus()` alone can't make our window key
  // from the background — macOS blocks focus stealing — so the window surfaces
  // but its web view never becomes first responder and the page silently
  // refuses clicks. `app.focus({ steal: true })` activates the whole app first;
  // only then does `webContents.focus()` actually stick.
  if (process.platform === "darwin") app.focus({ steal: true });
  win.show();
  win.focus();
  // Give the web contents keyboard/mouse focus too — a `BrowserWindow` can be
  // the key window (active traffic lights) while its `webContents` never took
  // input focus after a load, which reads as "the page won't accept clicks".
  if (!win.webContents.isDestroyed()) win.webContents.focus();
}

/** True when a packaged client bundle is present and bundled mode is on. */
function bundledAvailable(): boolean {
  return cfg.bundled && existsSync(BUNDLE_INDEX);
}

/**
 * Load the app into the window. In bundled mode with a present bundle, load the
 * SPA from disk (`loadFile`, offline-capable); otherwise load the live canvas
 * origin (`loadURL`) exactly as the thin shell always has. `capture` routes to
 * the quick-capture surface. Until a bundle is packaged, `bundledAvailable()`
 * is false and this is byte-for-byte the prior `loadURL` behavior.
 */
function loadApp(win: BrowserWindow, opts: { capture?: boolean } = {}): Promise<void> {
  if (bundledAvailable()) {
    // The bundled renderer loads from file://, so it has no env: hand it the API
    // base (and the capture intent) via the query string. The client reads
    // `?api=` to know which backend to call with its Bearer token.
    const query: Record<string, string> = { api: cfg.apiUrl };
    if (opts.capture) query.capture = "1";
    return win.webContents.loadFile(BUNDLE_INDEX, { query });
  }
  return win.webContents.loadURL(opts.capture ? quickCaptureUrl(cfg.appUrl) : cfg.appUrl);
}

function summonAndCapture(): void {
  const win = ensureWindow();
  focusWindow(win);
  void loadApp(win, { capture: true });
}

// ── Sign-in (RFC 8252 + PKCE) ──────────────────────────────────

/**
 * The PKCE verifier is persisted here as well as held in memory: on macOS the
 * `sidanclaw://auth` callback often arrives in a freshly-launched process (cold
 * start / relaunch), which has no in-memory verifier. Persisting it lets
 * whichever process handles the callback complete the exchange.
 */
function pendingVerifierFile(): string {
  return join(app.getPath("userData"), "pending-signin.json");
}

function readPersistedVerifier(): ReturnType<typeof parsePendingVerifier> {
  try {
    return parsePendingVerifier(readFileSync(pendingVerifierFile(), "utf8"), Date.now());
  } catch {
    return null;
  }
}

function clearPersistedVerifier(): void {
  try {
    rmSync(pendingVerifierFile(), { force: true });
  } catch {
    /* best-effort */
  }
}

// ── Bundled-mode token store (Bearer auth) ─────────────────────
//
// In bundled mode the renderer's origin isn't `app.sidan.ai`, so cookies
// don't apply — it authenticates with a Bearer token the shell holds, encrypted
// via the OS keychain (`safeStorage`) in `tokens.bin`. The preload bridge seeds
// the renderer from `get-tokens` and persists rotations via `set-tokens`. The
// pure serialize/validate/crypto logic lives in `desktop-token-store.ts` (tested);
// only the keychain + file I/O is here. All of this is inert unless `cfg.bundled`.

/** safeStorage-backed cipher; `isAvailable` gates persistence (no plaintext on disk). */
const tokenCipher: TokenCipher = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (plain) => safeStorage.encryptString(plain),
  decryptString: (buf) => safeStorage.decryptString(buf),
};

function tokensFile(): string {
  return join(app.getPath("userData"), "tokens.bin");
}

/** Read + decrypt the stored tokens, or null (missing / unreadable / tampered). */
function readStoredTokens(): StoredTokens | null {
  try {
    return decryptTokens(tokenCipher, readFileSync(tokensFile()));
  } catch {
    return null;
  }
}

function writeTokenBlob(blob: Buffer | null): void {
  if (!blob) {
    console.warn("OS encryption unavailable; refusing to persist tokens in plaintext.");
    return;
  }
  writeFileSync(tokensFile(), blob);
}

/** Encrypt + persist a freshly-exchanged session (the sign-in code-exchange path). */
function persistSession(sess: DesktopSession): void {
  writeTokenBlob(encryptTokens(tokenCipher, sess, Date.now()));
}

/** Persist tokens handed back by the renderer's client-side refresh (validated). */
function persistRendererTokens(input: unknown): void {
  const serialized = serializeRendererTokens(input, Date.now());
  if (!serialized) return; // malformed IPC payload — ignore
  writeTokenBlob(encryptBlob(tokenCipher, serialized));
}

function clearStoredTokens(): void {
  try {
    rmSync(tokensFile(), { force: true });
  } catch {
    /* best-effort */
  }
}

/** How long an unattended sign-in's loopback server stays open before teardown. */
const LOOPBACK_SERVER_TTL_MS = 5 * 60 * 1000;

/** Tear down the ephemeral sign-in server (if any) and cancel its timeout. */
function closeAuthServer(): void {
  if (authServerTimer) {
    clearTimeout(authServerTimer);
    authServerTimer = null;
  }
  if (authServer) {
    authServer.close();
    authServer = null;
  }
  pendingState = null;
}

/**
 * Open the system browser to complete OAuth. The single-use code returns over an
 * ephemeral `http://127.0.0.1:<port>/cb` loopback redirect (RFC 8252 §7.3) — this
 * works in an unpackaged dev run, unlike the `sidanclaw://auth` scheme. If the
 * loopback server can't bind, fall back to the scheme (packaged builds only).
 */
function startSignIn(opts: { addAccount?: boolean } = {}): void {
  const { verifier, challenge } = generatePkcePair();
  pendingVerifier = verifier;
  pendingAddAccount = opts.addAccount ?? false;
  pendingState = generateStateNonce();
  // Capture once so the async closures below can't read a flag mutated by a
  // later sign-in started before this one's callback fires.
  const addAccount = pendingAddAccount;
  try {
    writeFileSync(
      pendingVerifierFile(),
      serializePendingVerifier(verifier, Date.now(), addAccount),
    );
  } catch (err) {
    console.warn("Failed to persist sign-in state:", err);
  }

  closeAuthServer();
  const state = pendingState;
  const server = createServer((req, res) => {
    // A non-/cb request (e.g. favicon) or a stale/forged `state` parses to null:
    // reply 404 and leave the server open. A real callback 302s the browser to
    // the branded canvas page (so the bare loopback URL + code never linger in
    // the address bar), tears the server down, then finishes sign-in.
    const cb = req.url ? parseLoopbackCallback(req.url, state) : null;
    if (!cb) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end("Not found");
      return;
    }
    res.writeHead(302, {
      Location: buildSignedInPageUrl(cfg.appUrl, { error: cb.kind !== "code" }),
      "Cache-Control": "no-store",
    });
    res.end();
    closeAuthServer();
    if (cb.kind === "code") void completeSignIn(cb.code);
    else dialog.showErrorBox("Sign-in failed", `The sign-in could not complete (${cb.error}).`);
  });
  server.on("error", (err) => {
    // Bind failure — fall back to the custom scheme (works on packaged builds).
    console.warn("Loopback sign-in server failed; falling back to scheme:", err);
    closeAuthServer();
    void shell.openExternal(buildDesktopAuthStartUrl(cfg.appUrl, challenge, { addAccount }));
  });
  authServer = server;
  authServerTimer = setTimeout(closeAuthServer, LOOPBACK_SERVER_TTL_MS);
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as AddressInfo).port;
    void shell.openExternal(
      buildDesktopAuthStartUrl(cfg.appUrl, challenge, {
        redirectUri: buildLoopbackRedirectUri(port),
        state,
        addAccount,
      }),
    );
  });
}

async function completeSignIn(code: string): Promise<void> {
  // In-memory state is authoritative for the loopback transport (same process);
  // the persisted blob covers the cross-process `sidanclaw://auth` fallback. Both
  // carry the add-account intent so the right process knows to stash vs replace.
  const pending = pendingVerifier
    ? { verifier: pendingVerifier, addAccount: pendingAddAccount }
    : readPersistedVerifier();
  if (!pending) {
    dialog.showErrorBox(
      "Sign-in failed",
      "This sign-in link is no longer valid. Please start sign-in again from the app.",
    );
    return;
  }
  const { verifier, addAccount } = pending;
  pendingVerifier = null;
  pendingAddAccount = false;
  clearPersistedVerifier();
  closeAuthServer(); // idempotent — the loopback path already closed it
  try {
    const result = await exchangeCode(cfg.apiUrl, code, verifier);
    if (cfg.bundled) {
      // Bundled (Bearer tokens, not cookies) stays single-account — add replaces.
      persistSession(result);
    } else {
      // Add-account: stash the active account into the saved-account store before
      // its canonical trio is overwritten with the new account. At capacity we
      // keep the current session untouched and surface the cap.
      if (addAccount && !(await stashCurrentAccount(result))) {
        dialog.showErrorBox(
          "Can't add account",
          `You can keep up to ${MAX_ACCOUNTS} accounts signed in at once. Sign out of one first.`,
        );
        focusWindow(ensureWindow());
        return;
      }
      for (const spec of buildSessionCookies(cfg.appUrl, result)) {
        await session.defaultSession.cookies.set(spec);
      }
    }
    const win = ensureWindow();
    await loadApp(win);
    focusWindow(win); // focus AFTER the reload so the fresh contents take input
  } catch (err) {
    dialog.showErrorBox("Sign-in failed", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Add-account stash: fold the current active account into the saved-account
 * store before its canonical cookies are overwritten with the newly
 * authenticated `next` session, then add `next`. Returns `false` (writing
 * nothing) when the store is at capacity and `next` is brand-new — the caller
 * keeps the active session and surfaces the cap. A session with no usable id
 * can't be keyed, so it falls through to a plain replace (`true`).
 */
async function stashCurrentAccount(next: DesktopSession): Promise<boolean> {
  if (!next.user?.id) return true; // unkeyable — replace, as the single-account path always did
  const prevRefresh = await readJarCookie("refresh_token");
  const prevUser = parseUserCookieValue(await readJarCookie("user"));
  const prev: AccountCredential | null =
    prevRefresh && prevUser ? { account: prevUser, refreshToken: prevRefresh } : null;
  const res = stashAndAddAccount(
    await readAccountStoreFromJar(),
    await readAccountDirFromJar(),
    prev,
    {
      account: { id: next.user.id, name: next.user.name, email: next.user.email },
      refreshToken: next.refreshToken,
    },
  );
  if (res.atCapacity) return false;
  await writeAccountStoreToJar(res.store, res.dir);
  return true;
}

/**
 * Switch the active account to `accountId` (the renderer's switcher row). The
 * shell can't delegate to the primary's `switch-account-and-return` (an external
 * origin, opened in the system browser), so it does the same work locally:
 * refresh with the chosen account's stored token and reinstall the canonical
 * trio, with the R1 write-back of the account being switched away from. Mirrors
 * `apps/web/src/app/api/auth/switch-account-and-return/route.ts`.
 */
async function switchAccount(accountId: string): Promise<SwitchResult> {
  // Bundled mode authenticates with a single Bearer token, not the cookie store.
  if (cfg.bundled) return { ok: false, error: "switch" };

  const store = await readAccountStoreFromJar();
  const dir = await readAccountDirFromJar();
  const stored = store[accountId];
  if (!stored) return { ok: false, error: "reauth" };

  // R1 — capture the current active account's latest jar token so it's written
  // back (the keep-alive may have rotated it since it was last stored).
  const curRefresh = await readJarCookie("refresh_token");
  const curUser = parseUserCookieValue(await readJarCookie("user"));
  const prevActive: AccountCredential | null =
    curRefresh && curUser ? { account: curUser, refreshToken: curRefresh } : null;

  let result: DesktopSession | null;
  try {
    result = await refreshSession(cfg.apiUrl, stored);
  } catch (err) {
    console.warn("Account switch refresh failed (transient):", err);
    return { ok: false, error: "switch" }; // keep the active session; let the user retry
  }
  if (!result) {
    // Stored token is dead (revoked / >30d idle). Prune so the row stops
    // offering a broken switch; the active session is left untouched.
    const pruned = pruneAccount(store, dir, accountId);
    await writeAccountStoreToJar(pruned.store, pruned.dir);
    return { ok: false, error: "reauth" };
  }

  const switchedAccount: AccountDirEntry = result.user
    ? { id: result.user.id, name: result.user.name, email: result.user.email }
    : dir.find((e) => e.id === accountId) ?? { id: accountId, name: "", email: "" };
  const rotated = applySwitchRotation(store, dir, prevActive, {
    account: switchedAccount,
    refreshToken: result.refreshToken,
  });
  await writeAccountStoreToJar(rotated.store, rotated.dir);
  for (const spec of buildSessionCookies(cfg.appUrl, result)) {
    await session.defaultSession.cookies.set(spec);
  }
  const win = ensureWindow();
  await loadApp(win); // reload so the new account's workspace/page resolves cleanly
  focusWindow(win);
  return { ok: true };
}

async function signOut(): Promise<void> {
  if (cfg.bundled) {
    // Bundled mode is single-account (Bearer tokens, no saved-account store).
    clearStoredTokens();
    const win = ensureWindow();
    focusWindow(win);
    await loadApp(win);
    return;
  }

  // "Log out" signs out only the ACTIVE account and switches into the next
  // saved one — the jar-local mirror of the web's `/api/auth/logout?scope=active`.
  // Same machinery as `switchAccount`, minus the R1 write-back of the account
  // we're signing out: it's dropped from the store rather than kept. A dead
  // candidate token is pruned and the next tried; a full sign-out (clear the
  // trio AND the store) is the fallback when nothing remains to switch into.
  const activeUser = parseUserCookieValue(await readJarCookie("user"));
  const plan = planActiveLogout(
    await readAccountStoreFromJar(),
    await readAccountDirFromJar(),
    activeUser?.id ?? null,
  );
  const store = plan.store;
  let dir = plan.dir;

  for (const nextId of plan.candidates) {
    const token = store[nextId];
    if (!token) continue;
    let result: DesktopSession | null;
    try {
      result = await refreshSession(cfg.apiUrl, token);
    } catch (err) {
      console.warn("Logout switch refresh failed (transient):", err);
      continue; // try the next candidate; don't prune a maybe-good token
    }
    if (!result) {
      delete store[nextId]; // dead stored token — prune and try the next
      dir = dir.filter((e) => e.id !== nextId);
      continue;
    }
    const switched: AccountDirEntry = result.user
      ? { id: result.user.id, name: result.user.name, email: result.user.email }
      : dir.find((e) => e.id === nextId) ?? { id: nextId, name: "", email: "" };
    store[switched.id] = result.refreshToken; // R1 for the now-active account
    dir = upsertAccountDir(dir, switched);
    await writeAccountStoreToJar(store, dir);
    for (const spec of buildSessionCookies(cfg.appUrl, result)) {
      await session.defaultSession.cookies.set(spec);
    }
    const win = ensureWindow();
    await loadApp(win); // reload as the switched-into account
    focusWindow(win);
    return;
  }

  // No saved account left to switch into → full sign-out.
  for (const name of AUTH_COOKIE_NAMES) {
    await session.defaultSession.cookies.remove(cfg.appUrl, name);
  }
  for (const name of ACCOUNT_STORE_COOKIE_NAMES) {
    await session.defaultSession.cookies.remove(cfg.appUrl, name);
  }
  // Reloading re-seeds the (now empty) renderer auth, which redirects to login:
  // in the thin shell canvas 302s to /login (intercepted to start the PKCE flow);
  // in bundled mode the preload seeds no token and `desktopAuthSource` calls
  // `redirectToLogin()` → `signIn()`.
  const win = ensureWindow();
  focusWindow(win);
  await loadApp(win);
}

// ── Session keep-alive (thin shell) ────────────────────────────
//
// The shell owns its session lifetime end to end: the web's production refresh
// (a full-page bounce to the auth primary) can never run in-window here, so
// without this the session hard-dies on every 1h access-token expiry and the
// user is thrown back to sign-in. A periodic tick rotates the JWT pair against
// the API directly and rewrites the jar cookies; `handleNavigation` intercepts
// any refresh bounce that still fires as the fallback. Spec:
// docs/architecture/features/app-desktop.md → "Session lifetime".

async function readJarCookie(name: string): Promise<string | null> {
  const cookies = await session.defaultSession.cookies.get({ url: cfg.appUrl, name });
  return cookies[0]?.value ?? null;
}

// ── Saved-account store (jar I/O) ──────────────────────────────
// The shell's host-only copy of the web's `accounts_store`/`accounts_dir`. Pure
// reads/transforms live in `desktop-accounts.ts`; only the jar I/O is here.

async function readAccountStoreFromJar(): Promise<AccountStore> {
  return parseAccountStore(await readJarCookie("accounts_store"));
}

async function readAccountDirFromJar(): Promise<AccountDirEntry[]> {
  return parseAccountDir(await readJarCookie("accounts_dir"));
}

async function writeAccountStoreToJar(
  store: AccountStore,
  dir: AccountDirEntry[],
): Promise<void> {
  for (const spec of buildAccountStoreCookies(cfg.appUrl, store, dir)) {
    await session.defaultSession.cookies.set(spec);
  }
}

type RefreshOutcome = "refreshed" | "signed-out" | "failed";

let sessionRefreshInFlight: Promise<RefreshOutcome> | null = null;

/**
 * Rotate the JWT pair against the API and rewrite the jar cookies.
 * Single-flight: concurrent callers (tick / wake / bounce interception) share
 * one refresh. Outcomes: `refreshed` (cookies rewritten), `signed-out` (no
 * refresh token, or the backend rejected it — jar cleared), `failed`
 * (transient error — session kept for a later retry).
 */
function refreshSessionInPlace(): Promise<RefreshOutcome> {
  if (sessionRefreshInFlight) return sessionRefreshInFlight;
  const run = (async (): Promise<RefreshOutcome> => {
    const refreshToken = await readJarCookie("refresh_token");
    if (!refreshToken) return "signed-out";
    let result: DesktopSession | null;
    try {
      result = await refreshSession(cfg.apiUrl, refreshToken);
    } catch (err) {
      console.warn("Session refresh failed (will retry):", err);
      return "failed";
    }
    if (!result) {
      // The refresh token itself is dead (revoked or >30d idle) — a real sign-out.
      for (const name of AUTH_COOKIE_NAMES) {
        await session.defaultSession.cookies.remove(cfg.appUrl, name);
      }
      return "signed-out";
    }
    // The refresh response carries no `plan`, so keep the display-only `user`
    // cookie's current value — only its expiry slides with the new window.
    const existingUser = await readJarCookie("user");
    for (const spec of buildSessionCookies(cfg.appUrl, result)) {
      const value = spec.name === "user" && existingUser ? existingUser : spec.value;
      await session.defaultSession.cookies.set({ ...spec, value });
    }
    // R1 — if this jar holds a saved-account store, keep the active account's
    // stored refresh token in sync with the rotation above so a later
    // switch-back doesn't rely on a token rotated out from under it. No-ops for
    // single-account sessions (no store). Mirrors the web's `rotateActiveAccount`.
    const activeUser = parseUserCookieValue(existingUser);
    if (activeUser) {
      const synced = rotateActiveInStore(
        await readAccountStoreFromJar(),
        await readAccountDirFromJar(),
        { account: activeUser, refreshToken: result.refreshToken },
      );
      if (synced) await writeAccountStoreToJar(synced.store, synced.dir);
    }
    return "refreshed";
  })();
  sessionRefreshInFlight = run;
  void run.finally(() => {
    sessionRefreshInFlight = null;
  });
  return run;
}

/**
 * Complete an intercepted refresh bounce: refresh shell-side, then load the
 * bounce's validated `next`. Both failure shapes fall to the sign-in landing —
 * the intercepted navigation was already cancelled, so loading nothing could
 * leave a blank window, and re-loading `next` unauthenticated would just
 * bounce again in a tight loop while the API is unreachable.
 */
async function resumeAfterRefresh(nextUrl: string): Promise<void> {
  const outcome = await refreshSessionInPlace();
  if (outcome === "refreshed") {
    try {
      await ensureWindow().webContents.loadURL(nextUrl);
    } catch (err) {
      console.warn("Post-refresh resume load failed:", err); // did-fail-load shows the landing
    }
    return;
  }
  if (outcome === "failed") {
    // Transient (offline / 5xx) — the refresh token is still valid. Show the
    // offline landing and auto-retry; do NOT bounce to sign-in. This was a
    // path of the "Mac goes offline → logged out" bug.
    showOffline(ensureWindow());
    return;
  }
  promptSignIn(); // "signed-out" — the refresh token is dead
}

/** Keep the thin shell's session alive across access-token expiries. */
function startSessionKeepalive(): void {
  if (cfg.bundled) return; // bundled mode: the renderer owns Bearer-token refresh
  const tick = async (): Promise<void> => {
    try {
      if (!(await readJarCookie("refresh_token"))) return; // signed out — nothing to keep alive
      const accessToken = await readJarCookie("access_token");
      if (!shouldRefreshSession(accessToken, Math.floor(Date.now() / 1000))) return;
      const outcome = await refreshSessionInPlace();
      if (outcome === "signed-out" && mainWindow && !mainWindow.isDestroyed()) {
        // Quietly swap to the landing — a background tick must not steal focus
        // (and must not conjure a window when the app is tray-resident).
        void mainWindow.webContents.loadFile(SIGNIN_PAGE);
      }
    } catch (err) {
      console.warn("Session keep-alive tick failed:", err);
    }
  };
  setInterval(() => void tick(), SESSION_REFRESH_CHECK_INTERVAL_MS);
  // Timers don't run during sleep, so a wake can land past the token's exp.
  powerMonitor.on("resume", () => void tick());
  // Heal a stale session at launch. Runs concurrently with the first load —
  // if the load's proxy bounce gets intercepted, both paths share the same
  // single-flight refresh.
  void tick();
}

// ── Auto-update (shell binary) ─────────────────────────────────
//
// Product updates ship through the remote web app on every load (thin shell);
// this updates the SHELL BINARY itself. electron-updater reads the packaged
// `app-update.yml` (electron-builder writes it from the `publish:` block),
// resolves the latest `sidanclaw/sidanclaw` GitHub release, compares its
// `latest-mac.yml` / `latest.yml` feed against the running version, downloads
// in the background, and installs on quit (`autoInstallOnAppQuit`) or on the
// explicit "Restart to Update" click. Every decision (gate / state / labels /
// cadence) lives in the pure `auto-update.ts`; this is only the event wiring
// plus the menu + tray rebuild. Spec: docs/architecture/features/app-desktop.md
// → "Auto-update".

let updateState: UpdateState = INITIAL_UPDATE_STATE;
/** True once startAutoUpdate passed the gate — gates the menu/tray item. */
let autoUpdateActive = false;
/** Whether the in-flight check came from the menu item (gates result dialogs). */
let manualCheckInFlight = false;

/** The update menu/tray item state, or null to omit it (gate disabled). */
function updateMenuItem(): { label: string; enabled: boolean } | null {
  if (!autoUpdateActive) return null;
  const d = describeUpdateState(updateState);
  return { label: d.label, enabled: d.enabled };
}

function dispatchUpdateEvent(event: UpdateEvent): void {
  updateState = reduceUpdateState(updateState, event);
  refreshAppMenu();
  refreshTrayMenu();
}

/** The single update item's click: check from idle/error, restart when ready. */
function handleUpdateMenuClick(): void {
  const { action } = describeUpdateState(updateState);
  if (action === "restart") {
    // Quit from outside the menu-click callback. quitAndInstall tears the app
    // down itself; the tray-resident `window-all-closed` no-op does not block it.
    setImmediate(() => autoUpdater.quitAndInstall());
  } else if (action === "check") {
    manualCheckInFlight = true;
    void checkForUpdates();
  }
}

async function checkForUpdates(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    // The 'error' listener owns state + dialogs; this catch only prevents an
    // unhandled rejection (the promise rejects on the same failures).
    console.warn("Update check failed:", err);
  }
}

function startAutoUpdate(): void {
  const gate = shouldEnableAutoUpdate({ isPackaged: app.isPackaged, autoUpdate: cfg.autoUpdate });
  if (!gate.enabled) {
    console.log(`Auto-update off: ${gate.reason}`);
    return;
  }
  autoUpdateActive = true;
  // Download in the background as soon as a check finds a release, and apply on
  // the next quit even if the user never clicks "Restart to Update".
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => dispatchUpdateEvent({ kind: "checking" }));
  autoUpdater.on("update-available", (info) =>
    dispatchUpdateEvent({ kind: "available", version: info.version }),
  );
  autoUpdater.on("update-not-available", () => {
    dispatchUpdateEvent({ kind: "not-available" });
    if (manualCheckInFlight) {
      manualCheckInFlight = false;
      void dialog.showMessageBox({
        type: "info",
        message: "You're up to date",
        detail: `sidanclaw v${app.getVersion()} is the latest version.`,
      });
    }
  });
  autoUpdater.on("download-progress", (progress) =>
    dispatchUpdateEvent({ kind: "progress", percent: progress.percent }),
  );
  autoUpdater.on("update-downloaded", (info) => {
    const alreadyReady = updateState.phase === "ready" && updateState.version === info.version;
    manualCheckInFlight = false;
    dispatchUpdateEvent({ kind: "downloaded", version: info.version });
    // One passive nudge per downloaded version; the menu + tray carry the
    // affordance after that. Never force a restart — install-on-quit covers
    // the user who ignores it.
    if (!alreadyReady && Notification.isSupported()) {
      new Notification({
        title: "Update ready",
        body: `Restart sidanclaw to finish updating to v${info.version}.`,
      }).show();
    }
  });
  autoUpdater.on("error", (err) => {
    dispatchUpdateEvent({ kind: "error", message: err.message });
    if (manualCheckInFlight) {
      manualCheckInFlight = false;
      dialog.showErrorBox("Update check failed", err.message);
    }
  });

  // First check shortly after launch (never during it), then on a slow cadence.
  // `shouldCheckInState` skips while electron-updater is busy and once an
  // update is ready (restart applies it; re-checking would re-download it).
  setTimeout(() => void checkForUpdates(), UPDATE_INITIAL_CHECK_DELAY_MS);
  setInterval(() => {
    if (shouldCheckInState(updateState)) void checkForUpdates();
  }, UPDATE_CHECK_INTERVAL_MS);
}

// ── Deep links + auth callback ─────────────────────────────────

function handleIncomingUrl(rawUrl: string): void {
  const auth = parseAuthCallback(rawUrl, cfg.protocolScheme);
  if (auth) {
    if (auth.kind === "code") void completeSignIn(auth.code);
    else dialog.showErrorBox("Sign-in failed", `The sign-in could not complete (${auth.error}).`);
    return;
  }
  const target = resolveDeepLink(rawUrl, cfg);
  if (target) {
    const win = ensureWindow();
    focusWindow(win);
    void win.webContents.loadURL(target);
  }
}

/** Pull the first `sidanclaw://` argument out of a process argv (relaunch). */
function appUrlFromArgv(argv: readonly string[]): string | null {
  return argv.find((arg) => arg.startsWith(`${cfg.protocolScheme}://`)) ?? null;
}

// ── Menus + tray ───────────────────────────────────────────────

/**
 * (Re)build + install the application menu. Called at startup and again on
 * every update-state change, so the update item's label tracks the state
 * (Electron menus are immutable once built — rebuild is the supported path).
 */
function refreshAppMenu(): void {
  Menu.setApplicationMenu(
    buildAppMenu({
      onQuickCapture: summonAndCapture,
      onSignIn: startSignIn,
      onSignOut: () => void signOut(),
      onUpdate: handleUpdateMenuClick,
      isDev,
      update: updateMenuItem(),
    }),
  );
}

/**
 * The tray context menu (rebuilt on update-state changes). The tray carries the
 * update item too because on Windows the menu bar lives in the window frame —
 * with the window closed (tray-resident), the tray is the only affordance left.
 */
function buildTrayMenu(): Menu {
  const update = updateMenuItem();
  const template: MenuItemConstructorOptions[] = [
    { label: "Open sidanclaw", click: () => focusWindow(ensureWindow()) },
    { label: "Quick Capture", click: () => summonAndCapture() },
    { type: "separator" },
    { label: "Sign In", click: () => startSignIn() },
    { label: "Sign Out", click: () => void signOut() },
  ];
  if (update) {
    template.push(
      { type: "separator" },
      { label: update.label, enabled: update.enabled, click: () => handleUpdateMenuClick() },
    );
  }
  template.push({ type: "separator" }, { role: "quit" });
  return Menu.buildFromTemplate(template);
}

function refreshTrayMenu(): void {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function createTray(): Tray {
  // macOS wants a monochrome *template* image (the OS tints it for the light/dark
  // menu bar); Windows/Linux want a full-color icon, sized down for the notification
  // area. Fall back to an empty image so the tray never crashes when the asset is
  // absent during early development.
  const isMac = process.platform === "darwin";
  const iconPath = isMac
    ? join(__dirname, "..", "build", "trayTemplate.png")
    : join(__dirname, "..", "build", "icon.png");
  let icon = existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();
  if (isMac) {
    if (!icon.isEmpty()) icon.setTemplateImage(true);
  } else if (!icon.isEmpty()) {
    icon = icon.resize({ width: 16, height: 16 });
  }

  const t = new Tray(icon);
  t.setToolTip(app.name);
  t.setContextMenu(buildTrayMenu());
  t.on("click", () => focusWindow(ensureWindow()));
  return t;
}

// ── Lifecycle ──────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (mainWindow) focusWindow(mainWindow);
    const url = appUrlFromArgv(argv);
    if (url) handleIncomingUrl(url);
  });

  // macOS delivers deep links + the auth callback via open-url; before the
  // window exists, stash it and replay once ready.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (app.isReady()) handleIncomingUrl(url);
    else pendingUrl = url;
  });

  // The sign-in landing's button asks the main process to start the flow.
  ipcMain.on("sidanclaw:sign-in", () => startSignIn());

  // The offline landing's "Retry" button asks the shell to reload the app now
  // (the watcher already auto-retries every few seconds; this is the manual
  // path). Stops the watcher first so the manual load isn't double-fired.
  ipcMain.on("sidanclaw:retry-load", () => void retryLoad(ensureWindow()));

  // The web logout UI (workspace switcher / settings) asks the shell to sign
  // out in place. Registered in EVERY mode (unlike the bundled token bridge):
  // the thin shell clears its own cookie jar here, which the web UI cannot do
  // for itself without bouncing to the primary's external logout (→ system
  // browser → logs out the *web* session, not this app). See `signOut()`.
  ipcMain.on("sidanclaw:sign-out", () => void signOut());

  // Multi-account. The web switcher's "Add another account" / account-switch
  // rows route through the shell in Electron: the primary (where the web's
  // shared `.sidan.ai` account cookies live) is an external origin the
  // host-only jar can't reach, so the shell owns its own saved-account store.
  // Registered in every mode like sign-in/out; bundled mode (Bearer tokens, not
  // cookies) stays single-account — `switchAccount` returns an error there.
  ipcMain.on("sidanclaw:add-account", () => startSignIn({ addAccount: true }));
  ipcMain.handle("sidanclaw:switch-account", (_event, accountId: unknown): Promise<SwitchResult> =>
    typeof accountId === "string"
      ? switchAccount(accountId)
      : Promise.resolve({ ok: false, error: "switch" }),
  );

  // Bundled-mode token bridge: the preload reads/writes the Bearer token here.
  // Registered only in bundled mode so the thin shell exposes no token surface.
  if (cfg.bundled) {
    ipcMain.on("sidanclaw:get-tokens", (event) => {
      const t = readStoredTokens();
      // Synchronous reply (the renderer's AuthSource getters are sync). Hand back
      // only the renderer-facing subset, never the raw stored record.
      event.returnValue = t
        ? { accessToken: t.accessToken, refreshToken: t.refreshToken, user: t.user }
        : null;
    });
    ipcMain.on("sidanclaw:set-tokens", (_event, tokens: unknown) => persistRendererTokens(tokens));
    ipcMain.on("sidanclaw:clear-tokens", () => clearStoredTokens());
  }

  app.whenReady().then(() => {
    // macOS resolves `sidanclaw://` through the bundle Info.plist (the `protocols:`
    // block in electron-builder.yml). Windows/Linux register the running executable
    // with the OS; an UNPACKAGED Windows dev run must pass execPath + the script
    // path explicitly, or the scheme would point at the bare electron binary.
    if (process.platform === "win32" && !app.isPackaged) {
      app.setAsDefaultProtocolClient(cfg.protocolScheme, process.execPath, [
        resolve(process.argv[1] ?? ""),
      ]);
    } else {
      app.setAsDefaultProtocolClient(cfg.protocolScheme);
    }

    startSessionKeepalive();
    // Before the first menu/tray build so their update item reflects the gate.
    startAutoUpdate();
    mainWindow = createWindow();
    refreshAppMenu();
    tray = createTray();

    const ok = globalShortcut.register(cfg.quickCaptureHotkey, summonAndCapture);
    if (!ok) console.warn(`Failed to register hotkey: ${cfg.quickCaptureHotkey}`);

    if (pendingUrl) {
      handleIncomingUrl(pendingUrl);
      pendingUrl = null;
    }

    app.on("activate", () => focusWindow(ensureWindow()));
  });

  // Tray app on every desktop OS: stay resident when the window is closed so the
  // brain is one click away from the tray and the global quick-capture hotkey keeps
  // working. Quit is explicit (tray / app-menu Quit). Previously this quit on
  // non-darwin, which on Windows tore down the tray + hotkey the instant the window
  // closed — defeating the always-available model the tray exists for. The window
  // is recreated on demand by `ensureWindow()` (tray click / hotkey / deep link).
  app.on("window-all-closed", () => {
    // intentional no-op — stay resident until the user quits explicitly.
  });

  app.on("will-quit", () => globalShortcut.unregisterAll());
}

// Keep the tray reference alive for the GC.
void tray;
