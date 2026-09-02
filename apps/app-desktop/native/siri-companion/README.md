# Brian Siri companion

This is a macOS App Intents extension bundled inside the Electron app. macOS
launches it only while an intent runs, so it has no window, Dock icon, login
item, or persistent process.

The shortcut phrases are "Ask Brian" and "Tell Brian". Siri then asks for the
request because App Shortcuts only permit `AppEntity` and `AppEnum` parameters,
not arbitrary text, inside registered phrases. The intent URL encodes the reply
as `usebrian://ask?prompt=...`; Electron validates that deep link, opens the
companion chat for the active workspace, and sends the prompt through the
existing chat flow. The Swift intent can call a dedicated endpoint and return
Brian's answer directly once that endpoint contract is ready.

## Build

On macOS with Xcode installed:

```sh
pnpm --filter @use-brian/app-desktop run build:siri
```

The macOS package command builds the companion automatically and
electron-builder embeds it at `Use Brian.app/Contents/PlugIns/Brian Siri.appex`.
The `afterPack` hook signs the sandboxed extension with the available Developer
ID identity before electron-builder signs and notarizes the parent app. Local
packages use an ad-hoc signature.

Installing and opening the signed parent app lets macOS discover the extension's
compiled App Intents metadata. The extension is not launched manually and is
normally visible in Activity Monitor only while Siri or Shortcuts runs it. No
separate installation or App Store listing is required.
