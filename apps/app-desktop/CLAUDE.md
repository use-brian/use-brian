# apps/app-desktop

The **macOS Electron desktop shell** for the canvas surface. A thin, hardened
`BrowserWindow` loads the deployed canvas web app (`https://app.sidan.ai`) and
runs the same Next.js app a browser would. It owns **no UI** (every pixel is
served by `apps/app-web`) and **no backend** (the web content makes all API
calls itself). It exists only to add native capabilities a browser/PWA cannot:
a global quick-capture hotkey, tray presence, OS notifications, and a
`sidanclaw://` deep-link protocol. **Read this first when entering this package.**
Project-wide rules in the root `CLAUDE.md`; the feature spec is
[`docs/architecture/features/app-desktop.md`](../../docs/architecture/features/app-desktop.md).

## What it does

- **Loads** the canvas web app in a hardened window (`contextIsolation`,
  `nodeIntegration: false`, `sandbox`). OAuth never runs in-window (Google
  refuses embedded user agents), so there is no UA spoof — sign-in happens in
  the system browser via the RFC 8252 + PKCE flow (`desktop-auth.ts`).
- **Pins** the app frame to one trusted origin (`window-policy.ts`): only the
  canvas origin loads in-window; everything else (incl. OAuth provider origins)
  opens in the system browser. The exception is a **connector** OAuth hop
  (`isConnectorOAuth` — connecting Google Drive/Gmail/Calendar): it is handed to
  the system browser like any other external origin rather than the sign-in
  landing, so a connect doesn't read as a spurious sign-out.
- **Summons + captures** via a global hotkey (`Cmd+Shift+Space`) and a tray menu.
- **Routes** `sidanclaw://` deep links to canvas pages (`deep-link.ts`).
- **Keeps its session alive** (thin shell): the web's primary-bounce refresh
  can't run in-window, so `main.ts` refreshes the JWT pair against the API
  directly before the 1h access token expires (5-min tick + wake-from-sleep)
  and intercepts any `refresh-and-return` bounce (`parseRefreshBounce`). One
  sign-in lasts while the app runs at least once per 30 days. Spec:
  `docs/architecture/features/app-desktop.md` → "Session lifetime".
- **Updates itself** (packaged builds): electron-updater against the
  `sidanclaw-desktop` GitHub release feed — background download, one update
  item in the app menu + tray ("Check for Updates…" → "Restart to Update"),
  install on quit. Product UI updates need no binary change (thin shell); this
  is for the shell itself. Decisions live in the pure `auto-update.ts`. Spec:
  `docs/architecture/features/app-desktop.md` → "auto-update.ts".

## Layout

Mirrors `apps/doc-sync`: a thin IO shell (`main.ts`) over pure, injectable
helpers that unit-test with no Electron.

| Module | Pure? | COMP tag |
|---|---|---|
| `config.ts` | yes | `[COMP:app-desktop/config]` |
| `window-policy.ts` | yes | `[COMP:app-desktop/window-policy]` |
| `deep-link.ts` | yes | `[COMP:app-desktop/deep-link]` |
| `quick-capture.ts` | yes | `[COMP:app-desktop/quick-capture]` |
| `desktop-auth.ts` | yes | `[COMP:app-desktop/desktop-auth]` |
| `desktop-accounts.ts` | yes | `[COMP:app-desktop/desktop-accounts]` |
| `auto-update.ts` | yes | `[COMP:app-desktop/auto-update]` |
| `desktop-token-store.ts` | yes (bundled-mode groundwork; dormant) | `[COMP:app-desktop/token-store]` |
| `version-gate.ts` | yes (bundled-mode groundwork; dormant) | `[COMP:app-desktop/version-gate]` |
| `menu-template.ts` | yes (platform-aware menu template) | `[COMP:app-desktop/menu-template]` |
| `menu.ts` | no (imports `electron`) | `[COMP:app-desktop/menu]` |
| `main.ts` | no (imports `electron`) | `[COMP:app-desktop/main]` |

## Run / verify

```bash
# Pure-helper tests (run under `pnpm test` too):
pnpm --filter @sidanclaw/app-desktop test
pnpm --filter @sidanclaw/app-desktop typecheck

# Launch against local app-web (run `pnpm --filter app-web dev` first):
SIDANCLAW_APP_URL=http://localhost:3003 pnpm --filter @sidanclaw/app-desktop dev

# Bundled mode (Phase 4 groundwork): loads renderer/index.html from file:// and
# uses the safeStorage Bearer token bridge instead of cookies. Today renderer/ is
# the Phase 0 connectivity spike (not the product UI — see the bundled-offline
# plan). Sign in, then read the spike rows (optionally ?probe= a route):
SIDANCLAW_BUNDLED=1 SIDANCLAW_APP_URL=http://localhost:3003 pnpm --filter @sidanclaw/app-desktop dev

# Package a macOS dmg/zip (needs Apple certs for a signed/notarized build):
pnpm --filter @sidanclaw/app-desktop package

# Package a Windows NSIS installer (Tier 1; RUN ON WINDOWS — a VM/CI — not via
# Wine on the Mac). Unsigned until a cloud-HSM cert is wired:
pnpm --filter @sidanclaw/app-desktop package:win
```

The Electron wiring (`main.ts` / `menu.ts`) is verified manually — confirm the
window loads canvas, sign-in completes, the hotkey summons from another app, the
tray works, and `open sidanclaw://open?path=/` focuses the app.

**Sign-in now completes from the `dist/main.js` dev run** (no packaging needed):
the single-use code returns over an ephemeral `http://127.0.0.1:<port>/cb`
loopback redirect the shell listens on (RFC 8252 §7.3), so it doesn't depend on
the OS routing `sidanclaw://` to the app. Only the `sidanclaw://auth` **fallback**
and non-auth deep links still need a packaged `.app` — macOS resolves a custom
scheme through the bundle `Info.plist` (the `protocols:` block in
`electron-builder.yml`), which a bare `electron dist/main.js` doesn't have. To
test the scheme/deep-link path, `pnpm … package` once and open the `release/`
app.

## Boundaries

- **macOS + Windows** (v1). macOS is the signed GA build; **Windows is Tier 1
  (ship-fast)** — `pnpm … package:win` builds an unsigned NSIS installer (sign
  later with a cloud-HSM cert; the `main.ts` branches handle frame/tray/menu/deep
  links). **Linux** deferred. See
  [`docs/architecture/features/app-desktop.md`](../../docs/architecture/features/app-desktop.md)
  → "Build, sign, ship (Windows)".
- **Thin remote shell** — not offline. SSR runs server-side as today.
- Reads only `SIDANCLAW_APP_URL` / `SIDANCLAW_API_URL` /
  `SIDANCLAW_QUICK_CAPTURE_HOTKEY` / `SIDANCLAW_BUNDLED` /
  `SIDANCLAW_DISABLE_AUTO_UPDATE` from the env (no
  `getEnv()` — it needs none of the model/DB vars). `SIDANCLAW_BUNDLED` is Phase-4
  groundwork (Bearer/`safeStorage` auth), **off by default**;
  `SIDANCLAW_DISABLE_AUTO_UPDATE` is the auto-update kill-switch (updates are
  **on by default** in packaged builds, always off in dev runs).
- One sandboxed CommonJS preload (`preload.cjs`). In every mode it exposes the
  auth-lifecycle bridge — `signIn()` / `signOut()` and the multi-account
  `addAccount()` / `switchAccount(id)` (→ `sidanclaw:*` IPC; sign-in/add open the
  system browser, switch swaps the active account in the shell's jar). In
  **bundled mode** (`--sidanclaw-bundled`, off by default) it
  additionally exposes the Bearer token bridge (`getAccessToken` / `getRefreshToken`
  / `setTokens` / `clear`, backed by `safeStorage` via main IPC) that activates
  app-web's `desktopAuthSource`. The built-in `signin.html` landing is shown
  when signed out so the window is never blank. Both static assets are `cp`-ed
  into `dist/` by the build/dev scripts.
