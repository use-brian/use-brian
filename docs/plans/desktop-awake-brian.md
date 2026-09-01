# Awake Brian Desktop Companion

## Goal

The Electron app can keep Brian available while its main window is closed. A user-controlled **Keep Brian Awake** setting keeps the app from being suspended and shows a small Brian companion above normal windows. Clicking the companion opens a dedicated chat-only window backed by the existing workspace chat popup.

The companion uses the canonical Use Brian logo image without reconstructing, recoloring, blinking, or deforming it. It is not a general pet runtime or a third-party sprite-pack loader.

## User Contract

- **Keep Brian Awake** is an explicit, persisted checkbox in both the application menu and tray menu. It is off by default.
- Enabling it starts Electron's `prevent-app-suspension` power-save blocker. The operating system may still turn off the display; Use Brian must not request `prevent-display-sleep`.
- While enabled, a transparent, always-on-top Brian companion is visible near the lower-right corner of the primary display. The visible character is the canonical `apps/app-desktop/build/icon.original.png` asset copied byte-for-byte into the app bundle. It stays available when the main window is closed.
- Clicking or keyboard-activating the companion opens or focuses a small dedicated Electron chat window. It must not show, focus, navigate, or recreate the main application window.
- The chat window mounts the existing app-web `FloatingChat` in side-panel mode for the last workspace observed by the desktop shell. It does not create a second chat implementation or send an empty message automatically.
- Closing the chat window leaves the main app and the always-awake companion unchanged. A later companion activation recreates only the chat window.
- Disabling the setting immediately closes the companion and stops the power-save blocker.
- Quitting the app stops any active blocker. A malformed or unreadable preference file safely falls back to disabled.

## Security Boundary

- The companion loads only a bundled local HTML file.
- Its sandboxed preload exposes no renderer API. It may send only the fixed `Use Brian:message-brian` IPC event after the bundled button is activated.
- The main process accepts only the fixed companion activation event, derives the last workspace from trusted same-app navigation, and loads the dedicated app-web desktop-chat route in a hardened window using the shared Electron session.
- The dedicated route mounts `FloatingChat`; no message content, credentials, assistant identifiers, or arbitrary URL crosses the companion preload IPC boundary.
- If no trusted workspace has been observed yet, activation does nothing rather than opening the main application or guessing a workspace.

## Components

| COMP tag | Source | Test |
| --- | --- | --- |
| `[COMP:app-desktop/awake-brian]` | `apps/app-desktop/src/awake-brian.ts`, `apps/app-desktop/src/desktop-chat.ts`, `apps/app-desktop/src/main.ts`, `apps/app-desktop/src/brian-pet.html` | `apps/app-desktop/src/__tests__/awake-brian.test.ts`, `apps/app-desktop/src/__tests__/desktop-chat.test.ts` |
| `[COMP:app-desktop/menu-template]` | `apps/app-desktop/src/menu-template.ts` | `apps/app-desktop/src/__tests__/menu-template.test.ts` |
| `[COMP:app-web/desktop-auth-source]` | `apps/app-web/src/lib/desktop-auth-source.ts` | `apps/app-web/src/lib/__tests__/desktop-auth-source.test.ts` |
| `[COMP:app-web/views-shell]` | `apps/app-web/src/components/doc/workspace-chrome.tsx` | Bridge behavior is covered through `desktop-auth-source.test.ts`; workspace rendering remains covered by existing shell tests. |
| `[COMP:app-web/desktop-chat-window]` | `apps/app-web/src/components/chrome/desktop-chat-window.tsx`, `apps/app-web/src/app/desktop/chat/[workspaceId]/page.tsx`, `apps/app-web/desktop/app.tsx` | `apps/app-web/src/lib/__tests__/site-hosts.test.ts` guards the live route; component behavior reuses the existing floating-chat tests. |

## Persistence

The shell stores `awake-brian.json` under Electron's `userData` directory:

```json
{"v":1,"keepAwake":true}
```

Only `{ v: 1, keepAwake: true }` enables the feature. Missing, stale, malformed, and false values resolve to disabled.
