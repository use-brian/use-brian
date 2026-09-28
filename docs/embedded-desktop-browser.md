# Embedded desktop browser

The Electron desktop app can be the executor for an existing **My Browser** profile. It uses the existing authenticated pairing endpoint and browser relay, not a separate browser installation or extension. Web users retain the extension workflow.

## Use

1. Open **Browsers / browser profiles** in the desktop app and select or create a local browser profile.
2. Choose **Connect in-app browser** and approve the native confirmation. Pairing replaces any extension or other desktop instance connected to that profile.
3. Brian can open task tabs automatically. Alternatively, open a website with the browser toolbar, sign in manually, then choose **Allow Brian on this tab** and confirm.
4. Use **Stop Brian** to disconnect control immediately. The window remains available for manual browsing. Reconnect from the profile panel to start another session.

A relay must be configured on the deployment, just as for extension-based My Browser. Website cookies persist per deployment/account/relay/workspace/profile. Relay credentials are held only in main-process memory: restart, sign-out, account/deployment switch, authentication rejection, disconnect, or closing the browser requires explicit reconnection. Reconnecting closes the previous browser window; its cookies remain in its isolated partition.

## Supported operations

- Navigation, URL/title, accessibility snapshots, click, type, batch form filling.
- Open/list/select/close tabs using opaque handles.
- Screenshot frames and user takeover mouse, keyboard, scroll, and navigation input.
- Saved login-state export only after a separate native confirmation.
- `task_tabs` only exposes task-created or explicitly approved tabs. `full_browser` requires an additional native grant, and means **all tabs in this embedded window**, never the Use Brian renderer or system browser.

### Explicit limitations

This is not a full Chrome replacement. Downloads, protected credential filling, camera/microphone/device permissions, and popups are disabled. Popup destinations are shown as manual-opening guidance rather than converting a POST popup into a GET. Opener-dependent OAuth, embedded-browser-blocked sign-ins, DRM, CAPTCHAs, extension APIs, and specialized file-upload workflows are not guaranteed to work. Cookies are not imported from the user's normal browser.

## Architecture and security

- `apps/app-desktop/src/embedded-browser.ts`: main-process relay client, native grants, serialized command dispatch and revocation fences.
- `embedded-browser-host.ts`: sandboxed `WebContentsView` tabs in a dedicated persistent partition, below a separate trusted toolbar. Websites receive no preload or app-auth bridge. Navigation is HTTP(S)-only; permissions and downloads default to deny.
- `embedded-browser-preload.cjs` / `.html`: fixed toolbar commands. IPC requires the exact toolbar web contents, main frame, and local URL.
- `main.ts` / `preload.cjs`: trusted app-frame pairing bridge, active-account validation, and lifecycle revocation. Pair-token claims are used for storage names only; the relay authenticates them before a browser is opened.
- `packages/browser-control`: shared injected CDP executor, snapshot/form helpers, and relay state machine. Extension modules re-export this package. Build it before consuming its declarations or running extension tests directly on a fresh checkout.
- The relay recognizes `clientKind: electron` only to avoid irrelevant extension-build warnings. This does not grant protected-fill capability or bypass authentication.

Stop invalidates queued/in-flight operations before debugger detachment and relay disconnection. It cannot undo a click or request already delivered to a website.

## Verification

Automated coverage includes pairing/consent, real relay-client and executor paths with mocked Electron hosts, tab scope, native approval, Stop during queued/in-flight work, identity transitions, URL/IPC policy, and web pairing UI. These tests do not substitute for a native Electron smoke test.

Native acceptance checklist (macOS, Windows, Linux):

1. Build desktop and renderer, start with a configured relay, and connect a local profile.
2. Navigate to a controlled test page, snapshot, click/type/fill, manage two tabs, capture a frame, and exercise takeover.
3. Open a manual tab: verify it is excluded in task mode until **Allow Brian on this tab** is approved. Reject full-browser approval, then allow it and verify scope.
4. Stop while a navigation or form operation is waiting; verify no subsequent input is delivered and manual browsing still works.
5. Sign out, reject a token refresh, switch account/deployment, disconnect the relay, close the browser, and pair another client to the same profile; verify control ends each time.
6. Reconnect and verify website cookies persist only in the same profile. Verify another account/profile cannot see them.
7. Try `file:`, `javascript:`, custom protocols, popups, downloads, and permission requests; verify they are blocked without exposing the toolbar/app bridge.
