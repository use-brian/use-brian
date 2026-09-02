# Brian Siri companion

This is a windowless macOS App Intents host bundled inside the Electron app. It
does not have a Dock icon (`LSUIElement`) or a user-facing window.

The shortcut phrases are "Ask Brian ..." and "Tell Brian ...". The intent URL
encodes dictated text as `usebrian://ask?prompt=...`; Electron validates that
deep link, opens the companion chat for the active workspace, and sends the
prompt through the existing chat flow. The Swift intent can call a dedicated
endpoint and return Brian's answer directly once that endpoint contract is
ready.

## Build

On macOS with Xcode installed:

```sh
pnpm --filter @use-brian/app-desktop run build:siri
```

The macOS package command builds the companion automatically and
electron-builder embeds it at `Use Brian.app/Contents/Library/LoginItems/Brian
Siri.app`. The parent packaging process signs and notarizes the nested app with
the same Developer ID identity.

The Electron app launches the agent once after startup so Launch Services and
Siri discover its App Shortcuts. No separate installation or App Store listing
is required.
