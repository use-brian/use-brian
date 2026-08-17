# apps/browser-extension — "My Browser" local backend

The Chrome/Edge and Firefox extensions that let a Use Brian assistant drive the
user's own browser (the local backend, surfaced in-product as **My Browser**). Consent spec:
[`docs/plans/browser-extension-consent.md`](../../docs/plans/browser-extension-consent.md). Pairs to the account via the
browser-relay (`apps/browser-relay`); the app-web connect surface is
`[COMP:app-web/connect-browser]`.

## Modules

- `background.ts` — service worker: relay connection, consent prompt, command dispatch.
- `relay-client.ts` — this installed extension instance's one WebSocket to the relay (`hello` / command / result / event), bound by its token to one Use Brian Browser profile. Separate real Chrome/Edge profiles install and pair separate instances when identities must run simultaneously.
- `executor.ts` — the discrete browser ops against the currently selected allowed tab, via `chrome.debugger` (CDP) only.
- `task-gate.ts` — per-task consent and optional local pre-approval, opaque tab handles, task-created tab cleanup, profile-scope enforcement, and persistent Stop (`[COMP:ext/agent]`, `[COMP:ext/multi-tab-control]`).
- `tab-eligibility.ts` — which tabs can be controlled; consent selects the active tab from the last-focused normal browser window (never an extension popup), Firefox alone may use `about:blank`/`about:home`/`about:newtab` as a navigation launch surface, and an unattachable page raises `no_eligible_tab`, never `consent_denied`.
- `pairing.ts` — the credential transition behind every Connect, plus the `externally_connectable` sender check (`[COMP:ext/pairing]`).
- `snapshot.ts` — CDP accessibility tree into the shared snapshot shape.
- `popup.ts` / `popup-status.ts` / `allow.ts` — the pairing popup, its status wording, and the per-task allow prompt.
- `firefox-background.ts` / `firefox-native-client.ts` — Firefox relay/consent wiring and the fixed-operation native-messaging bridge to either the standalone companion or the installed Electron app (`[COMP:ext/firefox-agent]`).
- `firefox-popup.ts` / `firefox-allow.ts` — the Firefox pages, visually matched to the Chromium popup/allow pages.

## Browser-specific builds

- `pnpm build` compiles the Chromium entrypoints and their imports into `dist/`.
- `pnpm build:firefox` compiles the Firefox entrypoints and their imports into `dist-firefox/`.
- Each command cleans only its own output first. Never compile all `src/` files
  into `dist/`: that leaks Firefox code, declarations, source maps, and stale
  deleted files into the Chrome Web Store package.
- Package the contents of `dist/` for Chrome and `dist-firefox/` for Firefox;
  neither output is a combined cross-browser extension.

## Governance guardrail — WIDEN ONLY THROUGH PROFILE POLICY

The narrow surface **is** the feature. The extension:

- drives ONLY via `chrome.debugger` (CDP), attached to one eligible tab at a time — no content scripts, no `cookies` / `scripting` / `webRequest`;
- requests NO `host_permissions` (Chromium requires `tabs`/`storage` plus `debugger`, which Chrome forbids declaring as optional);
- gates every task on explicit consent or the user's local pre-approval setting (`task-gate.ts`), then enforces the server-supplied Browser-profile mode: `task_tabs` permits only the approved root plus tabs created by that task, while `full_browser` additionally permits eligible normal tabs in that installed Chrome/Edge profile; Stop always requires a fresh manual Allow before control resumes;
- keeps restricted pages, incognito, other OS browser profiles, and raw Chrome tab ids outside the model surface; and honors a persistent Stop that closes task-created tabs while preserving pre-existing user tabs.

Firefox has no WebExtension debugger API. Its build therefore requests only
`nativeMessaging`, `tabs`, and `storage`, and delegates the same fixed operation
vocabulary to the registered `ai.usebrian.browser` native host. The companion
connects to Firefox's loopback-only WebDriver BiDi endpoint; Firefox must have
been started through either `use-brian-firefox start` or the desktop app. The
Electron-free implementation lives in `apps/firefox-companion` and is shared by
both hosts (`[COMP:ext/firefox-companion]`).
This is not permission to add content scripts or host access. The Firefox manifest
test locks the same no-host/no-content-script boundary.

A broad `<all_urls>` / cookies / content-script grant is the **Manus Browser Operator anti-pattern** (Mindgard "Rubra" credential-exfil + Aurascape "SilentBridge" CVSS 9.8 zero-click takeover). Never add it. `src/__tests__/manifest.test.ts` locks the narrow permission set as a regression guard.

**`externally_connectable` is the one exception, and it is not a widening.** It admits `sendMessage` from our own app origins so the web app can hand over a pairing code (one-click pairing); it is inbound-only, carries pairing config alone, and grants the extension no reach into any page. Two rules keep it that way: the allowlist is pinned by `manifest.test.ts` (no wildcard, no bare TLD, https everywhere but loopback), and `background.ts` re-checks `sender.origin` against **the manifest's own list** via `chrome.runtime.getManifest()` — never a second hardcoded copy, because the copy that drifts would be the security boundary.
