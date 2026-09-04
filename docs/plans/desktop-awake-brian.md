# Brian Companion

## Goal

The Electron app can keep Brian available while its main window is closed. A user-controlled **Keep Brian Nearby** setting keeps the app ready in the background and shows a small Brian companion above normal windows. Clicking the companion opens a dedicated chat-only window backed by the existing workspace chat popup.

The companion uses the canonical transparent Use Brian logo image as its base. Small state overlays may blink the eyes, open a mouth, show thinking motion, celebrate a completed response, or call attention to required user action; the underlying mark is never reconstructed or placed on an artificial background. It is not a general pet runtime or a third-party sprite-pack loader.

## User Contract

- **Keep Brian Nearby** is an explicit, persisted checkbox in both the application menu and tray menu. It is off by default.
- Enabling it starts Electron's `prevent-app-suspension` power-save blocker. The operating system may still turn off the display; Use Brian must not request `prevent-display-sleep`.
- While enabled, a transparent, always-on-top Brian companion is visible near the lower-right corner of the primary display. The visible character is the canonical transparent `apps/app-web/public/icon.png` asset copied byte-for-byte into the app bundle. It stays available when the main window is closed and has no black tile behind it.
- Dragging the companion relocates it without opening chat; a stationary click still toggles chat. The shell persists the position, clamps it to an available display on launch or monitor changes, and keeps the attached panel aligned while dragging.
- Clicking or keyboard-activating the companion toggles a frameless chat panel attached to the companion's left edge. Clicking anywhere outside the panel, including the companion itself, hides it. The route clears the global page canvas to transparent while mounted, so no app background or shadow paints outside the rounded panel and its connector. The panel must not show, focus, navigate, or recreate the main application window, and must move with the companion when the primary display changes.
- The chat window mounts the existing app-web `FloatingChat` in side-panel mode for the last workspace observed by the desktop shell. It does not create a second chat implementation or send an empty message automatically.
- A macOS personal shortcut using the **Use Brian** App Intent routes a bounded prompt to exactly one visible chat surface and sends it once. When **Keep Brian Nearby** is enabled, the shortcut opens (or raises) the companion's dedicated chat window without focusing, navigating, or recreating the main window. When it is disabled, the shortcut activates the main window, reveals the bottom-right floating chat (leaving it mounted across navigation), and sends there. A shortcut request is an open action, never the companion click's toggle-to-hide action.
- A successfully dispatched shortcut request finishes silently in Shortcuts: the visible chat opening is the acknowledgement, so the App Intent returns no redundant "Opening Brian" result dialog. Validation and app-open failures still surface their actionable error text.
- On macOS, Settings → Preferences shows a **Set up Siri** card only inside an Electron shell whose preload exposes the macOS setup bridge. The button opens the Apple-signed `Use Brian.shortcut` template bundled with the app; it already contains **Use Brian** with **Request** set to **Ask Each Time**, so the user only reviews it and confirms **Add Shortcut**. Browsers, other operating systems, and older shells render nothing. The OS-owned import confirmation remains mandatory because macOS does not silently install a personal shortcut.
- If a Nearby shortcut request arrives before the shell has observed a trusted workspace, the shell keeps the prompt pending until the main renderer reports its resolved workspace/assistant context; it does not guess an identifier or leak the prompt into a URL. A newer unconsumed request supersedes the older one.
- The main workspace's bottom-right chat is suppressed only while Brian Nearby is enabled (or another documented embedded/full-chat surface owns the chat affordance). Disabling Nearby publishes the setting change to the renderer immediately, restoring the bottom-right launcher without a reload.
- Closing the chat window leaves the main app and the always-awake companion unchanged. A later companion activation recreates only the chat window.
- The companion mirrors the chat's real lifecycle: loading while the workspace assistant resolves, thinking before reply text, responding while text streams, action-required while a confirmation or question waits, and a short completion reaction when a response finishes. Active tool descriptions use the same localized narration emitted by `FloatingChat`.
- Disabling the setting immediately closes the companion and stops the power-save blocker.
- Quitting the app stops any active blocker. A malformed or unreadable preference file safely falls back to disabled.

## Security Boundary

- The companion loads only a bundled local HTML file.
- Its sandboxed preload exposes no renderer API. It may send only the fixed `Use Brian:message-brian` IPC event after the bundled button is activated.
- The main process accepts only the fixed companion activation event, derives the last workspace from trusted same-app navigation, and loads the dedicated app-web desktop-chat route in a hardened attached window using the shared Electron session.
- The dedicated route mounts `FloatingChat`; no message content, credentials, assistant identifiers, or arbitrary URL crosses the companion preload IPC boundary.
- Shortcut text remains in the Electron main process. The selected trusted renderer (main workspace or dedicated Nearby chat) receives only a fixed `Use Brian:use-brian` wake-up event, then consumes the bounded pending text once through the preload bridge. The event is queued in preload until React subscribes, so window creation and hydration cannot drop it.
- The active implementation is named `UseBrianIntent` end to end and opens `usebrian://use`. The Apple-signed template's serialized `AskBrianIntent` identifier is served only by a non-discoverable compatibility adapter that forwards into the same Use Brian implementation.
- The app renderer may send only a bounded companion phase and short display label. The main process accepts that state only from the dedicated chat window and forwards it to the local companion page; arbitrary renderer IPC cannot animate the companion.
- If no trusted workspace has been observed yet, activation does nothing rather than opening the main application or guessing a workspace.

## Components

| COMP tag | Source | Test |
| --- | --- | --- |
| `[COMP:app-desktop/awake-brian]` | `apps/app-desktop/src/awake-brian.ts`, `apps/app-desktop/src/desktop-chat.ts`, `apps/app-desktop/src/main.ts`, `apps/app-desktop/src/brian-pet.html` | `apps/app-desktop/src/__tests__/awake-brian.test.ts`, `apps/app-desktop/src/__tests__/desktop-chat.test.ts` |
| `[COMP:app-desktop/menu-template]` | `apps/app-desktop/src/menu-template.ts` | `apps/app-desktop/src/__tests__/menu-template.test.ts` |
| `[COMP:app-web/desktop-auth-source]` | `apps/app-web/src/lib/desktop-auth-source.ts` | `apps/app-web/src/lib/__tests__/desktop-auth-source.test.ts` |
| `[COMP:app-web/views-shell]` | `apps/app-web/src/components/doc/workspace-chrome.tsx` | Bridge behavior is covered through `desktop-auth-source.test.ts`; workspace rendering remains covered by existing shell tests. |
| `[COMP:app-web/desktop-chat-window]` | `apps/app-web/src/components/chrome/desktop-chat-window.tsx`, `apps/app-web/src/app/desktop/chat/[workspaceId]/page.tsx`, `apps/app-web/src/lib/companion-chat-state.ts`, `apps/app-web/desktop/app.tsx` | `apps/app-web/src/lib/__tests__/site-hosts.test.ts`, `apps/app-web/src/lib/__tests__/companion-chat-state.test.ts` |
| `[COMP:app-web/siri-use-brian]` | `apps/app-web/src/lib/siri-use-brian.ts`, `apps/app-web/src/components/doc/workspace-chrome.tsx`, `apps/app-web/src/components/chrome/desktop-chat-window.tsx` | `apps/app-web/src/lib/__tests__/siri-use-brian.test.ts` |
| `[COMP:app-web/siri-settings]` | `apps/app-web/src/components/settings-modal/sections/siri-setup-card.tsx`, `apps/app-web/src/components/settings-modal/sections/general-section.tsx`, `apps/app-web/src/lib/desktop-auth-source.ts`, `apps/app-desktop/src/preload.cjs`, `apps/app-desktop/src/main.ts` | `apps/app-web/src/components/settings-modal/sections/__tests__/siri-setup-card.test.tsx`, `apps/app-web/src/lib/__tests__/desktop-auth-source.test.ts`, `apps/app-desktop/src/__tests__/siri-packaging.test.ts` |

## Persistence

The shell stores `awake-brian.json` under Electron's `userData` directory:

```json
{"v":1,"keepAwake":true}
```

Only `{ v: 1, keepAwake: true }` enables the feature. Missing, stale, malformed, and false values resolve to disabled.

The last dragged position is stored separately in `brian-position.json` as `{ "v": 1, "x": number, "y": number }`. Invalid or off-screen values fall back or clamp to an available display.
