# Awake Brian Desktop Companion

## Goal

The Electron app can keep Brian available while its main window is closed. A user-controlled **Keep Brian Awake** setting keeps the app from being suspended and shows a small Brian companion above normal windows. Clicking the companion summons Use Brian and opens the message composer.

The companion borrows the useful parts of Codex pets: an ambient pixel character, a quiet idle animation, and a direct interaction. It is not a general pet runtime or a third-party sprite-pack loader.

## User Contract

- **Keep Brian Awake** is an explicit, persisted checkbox in both the application menu and tray menu. It is off by default.
- Enabling it starts Electron's `prevent-app-suspension` power-save blocker. The operating system may still turn off the display; Use Brian must not request `prevent-display-sleep`.
- While enabled, a transparent, always-on-top Brian companion is visible near the lower-right corner of the primary display. It stays available when the main window is closed.
- Clicking or keyboard-activating the companion focuses or recreates the main window and opens the existing workspace chat composer. It does not create a second chat implementation or send an empty message automatically.
- If the active surface deliberately suppresses the shared dock because it owns another embedded chat, the click navigates to the workspace page surface before revealing the canonical dock.
- Disabling the setting immediately closes the companion and stops the power-save blocker.
- Quitting the app stops any active blocker. A malformed or unreadable preference file safely falls back to disabled.

## Security Boundary

- The companion loads only a bundled local HTML file.
- Its sandboxed preload exposes no renderer API. It may send only the fixed `Use Brian:message-brian` IPC event after the bundled button is activated.
- The main window receives a one-shot message intent through its existing preload bridge. The web app consumes it in `WorkspaceChrome`, which already owns the single persistent chat dock.
- The main process retains that intent until `WorkspaceChrome` subscribes and the preload acknowledges delivery. Sign-in and other full-page reloads therefore cannot drop a cold-start click.
- No message content, credentials, workspace identifiers, or assistant identifiers cross the new IPC boundary.

## Components

| COMP tag | Source | Test |
| --- | --- | --- |
| `[COMP:app-desktop/awake-brian]` | `apps/app-desktop/src/awake-brian.ts`, `apps/app-desktop/src/main.ts`, `apps/app-desktop/src/brian-pet.html` | `apps/app-desktop/src/__tests__/awake-brian.test.ts` |
| `[COMP:app-desktop/menu-template]` | `apps/app-desktop/src/menu-template.ts` | `apps/app-desktop/src/__tests__/menu-template.test.ts` |
| `[COMP:app-web/desktop-auth-source]` | `apps/app-web/src/lib/desktop-auth-source.ts` | `apps/app-web/src/lib/__tests__/desktop-auth-source.test.ts` |
| `[COMP:app-web/views-shell]` | `apps/app-web/src/components/doc/workspace-chrome.tsx` | Bridge behavior is covered through `desktop-auth-source.test.ts`; workspace rendering remains covered by existing shell tests. |

## Persistence

The shell stores `awake-brian.json` under Electron's `userData` directory:

```json
{"v":1,"keepAwake":true}
```

Only `{ v: 1, keepAwake: true }` enables the feature. Missing, stale, malformed, and false values resolve to disabled.
