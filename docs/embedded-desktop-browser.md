# Embedded desktop browser

The Electron desktop app can be the executor for an existing **My Browser** profile. It uses the existing authenticated pairing endpoint and browser relay, not a separate browser installation or extension. Web users retain the extension workflow.

## Use

1. Open **Browsers / browser profiles** in the desktop app and select or create a local browser profile.
2. The desktop starts the local profile automatically. Approve the native permission once; approval is remembered for this deployment/account/relay/workspace/profile. There is no routine Connect or Stop step. Pairing replaces any extension or other desktop instance connected to that profile.
3. The browser opens docked on the **right side of the app**. After initial profile consent, Brian can use all embedded tabs, including tabs you open manually to sign in. There is no per-tab approval or additional full-browser grant. The compact, app-style toolbar is 128px high; type a domain, path, query, or port and the address bar defaults to HTTPS, while explicit HTTP/HTTPS addresses are preserved.
4. Drag the left divider to resize the browser (or focus the divider and use arrow keys/Home/End). The compact **Collapse browser panel** sidebar icon hides pages into a narrow rail; its **Expand browser panel** counterpart restores them. Icon controls have tooltips, accessible names and keyboard-focus continuity. Narrow app windows automatically use the rail until space is available.
5. **Detach** moves the same tabs into a separate window. **Dock**, or closing that detached window, brings them back to the app. These moves preserve page contents, form inputs, cookies, tab handles and the agent's debugger connection without reloading.
6. Use **Stop Brian** to stop current work and shut down the browser: all task and manual tabs, toolbar views, and any detached window close. Stop is available in both layouts and the collapsed rail. Collapsing/detaching alone does **not** stop the agent. Click the top-right browser button to start an empty browser again, or let Brian start it with a new HTTP(S) navigation/open-tab request. Cookies remain saved in the profile. Background polling never reopens a stopped browser. A failed connection offers **Retry**, without a background retry loop.

A relay must be configured on the deployment, just as for extension-based My Browser. Website cookies persist per deployment/account/relay/workspace/profile. Relay credentials are held only in main-process memory. Restart, sign-out, account/deployment switch, authentication rejection, disconnect, or closing the main app window revokes the live session. On a new launch, the workspace coordinator fetches fresh credentials for the configured local profile; standing native consent avoids another permission prompt. Reconnecting replaces the previous browser session; its cookies remain in its isolated partition.

One workspace-level coordinator observes the shared profile cache, so setup starts the browser even outside the profile page. It selects one owner-managed local profile deterministically, keeps an already active local profile, and never displaces another active workspace/profile merely because a card rendered. Removing its profile or switching its backend away from local disposes that session. Declining consent or pressing Stop blocks automatic pairing attempts during the current app launch. Declined consent requires an explicit **Start browser** action. Toolbar/agent Stop retains only the already-approved relay connection so Brian can start a new browser task; it does not keep any browser renderer or tab alive. Temporary connection failures require Retry. Profile cards and the browser entry button show status and Open/Start browser/Retry instead of Connect.

## Supported operations

- Navigation, URL/title, accessibility snapshots, click, type, batch form filling.
- Open/list/select/close tabs using opaque handles.
- Screenshot frames and user takeover mouse, keyboard, scroll, and navigation input.
- Saved login-state export only after a separate native confirmation.
- `task_tabs` and `full_browser` both allow **all tabs in this embedded browser** after initial profile consent, never the Use Brian renderer or system browser. `taskOwned` records task-created provenance, not access eligibility. Saved sign-in-state export still requires its separate native confirmation.

### Explicit limitations

This is not a full Chrome replacement. Downloads, protected credential filling, camera/microphone/device permissions, and popups are disabled. Popup destinations are shown as manual-opening guidance rather than converting a POST popup into a GET. Opener-dependent OAuth, embedded-browser-blocked sign-ins, DRM, CAPTCHAs, extension APIs, and specialized file-upload workflows are not guaranteed to work. Cookies are not imported from the user's normal browser.

## Architecture and security

- `apps/app-web/src/lib/automatic-desktop-browser.ts`: one renderer lifecycle owner with generation fencing, abortable pairing-token requests, deduplication and no automatic retry after failure or refusal. Mounted by the persistent workspace chrome, not individual profile cards.
- `apps/app-desktop/src/browser-approvals.ts`: native-only standing embedded-profile consent in the app data directory, keyed by opaque account/relay/workspace/profile partitions. No tokens or website credentials are stored here. Missing/corrupt storage asks again; there are no separate manual-tab or full-browser grants.
- `apps/app-desktop/src/embedded-browser.ts`: main-process relay client, profile consent and saved sign-in-state export confirmation, serialized command dispatch and revocation fences.
- `embedded-browser-host.ts`: sandboxed `WebContentsView` tabs in a dedicated persistent partition, below a separate trusted toolbar view. Toolbar and tab views move between the main window and a lazy detached `BaseWindow`; closing the main window disposes all owned views. Websites receive no preload or app-auth bridge. Navigation is HTTP(S)-only; permissions and downloads default to deny. Only typed toolbar addresses (navigate IPC) receive HTTPS normalization; tab creation, redirects, page navigation and network boundaries still require explicit HTTP(S). Typed addresses are trimmed; blank input, embedded whitespace, backslashes, credentials and other schemes are rejected.
- `embedded-browser-preload.cjs` / `.html`: fixed toolbar commands. IPC requires the exact toolbar web contents, main frame, and local URL.
- `main.ts` / `preload.cjs`: trusted app-frame pairing bridge, active-account validation, and lifecycle revocation. A main-process-only layout message reserves the right-hand pane in the app body, including fixed portals, with zoom-aware CSS dimensions. Renderer geometry helpers use the remaining app width and popup collision boundary. Pair-token claims are used for storage names only; the relay authenticates them before a browser is opened.
- `packages/browser-control`: shared injected CDP executor, snapshot/form helpers, and relay state machine. Extension modules re-export this package. Build it before consuming its declarations or running extension tests directly on a fresh checkout.
- The relay recognizes `clientKind: electron` only to avoid irrelevant extension-build warnings. This does not grant protected-fill capability or bypass authentication.

Stop invalidates queued/in-flight operations before debugger detachment and host destruction, and emits `stopped` to cancel pending relay commands. The approved relay remains as a control-only channel; a new `navigate` or `openTab` with a valid HTTP(S) URL can create a fresh host/executor. Snapshot, click, tab-list, and other follow-ups cannot reopen it. The native `show` action can also reopen it; the renderer's Start browser path can alternatively pair with fresh credentials. The Stop event includes a control epoch which the relay stamps onto subsequent commands, so navigation/input already in transit before Stop cannot revive the browser or affect the next session. Deploy the relay update alongside the desktop update: an older relay cannot echo this fence, so agent-driven restart fails closed until the user pairs again through Start browser. Disconnect, replacement, sign-out, account/deployment changes and app closure also discard the control channel, so it cannot revive a revoked session. Stop cannot undo a click or request already delivered to a website.

## Verification

Automated coverage includes pairing/consent, real relay-client and executor paths with mocked Electron hosts, all-embedded-tab eligibility, native profile/export approval, Stop during queued/in-flight work, identity transitions, URL/IPC policy, and web pairing UI. These tests do not substitute for a native Electron smoke test.

Run the native docking fixture on a Mac (no backend or account required):

```sh
pnpm --filter @use-brian/app-desktop test:browser-docking
```

It creates temporary profiles and loopback fixture pages, and exercises actual view moves, native input, cookies/form/CDP preservation, collapse/Stop, resize, reload, app zoom (80/100/125/150%), fixed-overlay containment and window-close cleanup for both file and HTTP app renderers. A sufficiently large display is required (at least 1280px wide); on Linux use Xvfb with a 1920x1080 screen. The fixture does not change production sandbox settings or test the backend relay.

Native acceptance checklist (macOS, Windows, Linux):

1. Build desktop and renderer, start with a configured relay, and create or select a local profile. Confirm automatic startup after one native approval, no repeated consent on relaunch, and no repeat prompts after choosing Not now. Navigate away from profile settings and verify the session stays available.
2. Verify the compact 128px toolbar shows **Browser** by default and an **example.com** address placeholder. Enter a schemeless domain/path/query/port and confirm HTTPS is used; verify an explicit HTTP address stays HTTP. Navigate to a controlled test page, snapshot, click/type/fill, manage two tabs, capture a frame, and exercise takeover.
3. Open a manual tab: verify Brian can use it in both task and full-browser modes without another grant. Confirm no per-tab approval button appears. Request saved sign-in-state export and verify it still prompts; rejecting the prompt must deny export.
4. Stop while a navigation or form operation is waiting; verify queued input is fenced, all manual/task tabs and the panel close, and polling leaves them closed. Reopen using the top-right browser button; repeat Stop and ask Brian to navigate/open a new tab. Both paths must start fresh tabs with the same saved profile cookies. Verify a late snapshot/click cannot reopen the browser and reopening within the consented profile does not prompt for per-tab or full-browser access.
5. Sign out, reject a token refresh, switch account/deployment, disconnect the relay, close the main app window, and pair another client to the same profile; verify control ends each time.
6. Reconnect and verify website cookies persist only in the same profile. Verify another account/profile cannot see them.
7. Try `file:`, `javascript:`, custom protocols, popups, downloads, and permission requests; verify they are blocked without exposing the toolbar/app bridge.
8. Dock/detach during navigation and typing; verify tabs and values persist. Close the detached window and verify it redocks without stopping the agent.
9. Resize/collapse, zoom the app, and open app dialogs/menus beside the browser. Confirm controls stay inside the app pane, Stop remains reachable, and app/site/address-bar focus works on macOS and Windows.
