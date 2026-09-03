# Brian Siri extension

This macOS ExtensionKit App Intents extension exposes the "Use Brian" action to
Apple Shortcuts. macOS does not automatically install an app-owned Siri phrase,
so users add this action to a personal shortcut, set Request to Ask Each Time,
and name the shortcut "Use Brian". The action opens
a bounded `usebrian://use?prompt=...` handoff to the containing Electron app.

Build it on macOS with:

```sh
pnpm --filter @use-brian/app-desktop run build:siri
```

The build reads the version from `apps/app-desktop/package.json`.
electron-builder embeds the result at
`Use Brian.app/Contents/Extensions/Brian Siri.appex`; its `afterPack` hook signs
the extension before signing and notarizing the parent app.
Without Developer ID credentials, local packages ad-hoc sign both the extension
and all nested Electron code, restore the extension's sandbox entitlement, seal
the parent app last, then deep-verify the complete bundle. Release packages use
the configured Developer ID identity instead.

Install the resulting app in `/Applications` and open it once. Settings →
Preferences shows "Set up Siri" in the macOS Electron app; it opens the bundled,
Apple-signed `Use Brian.shortcut` import. The template already contains "Use
Brian" with Request set to Ask Each Time, so review it and click "Add Shortcut".
Restart Shortcuts if the action is missing.
After replacing a development build, delete and recreate stale shortcut actions
so macOS indexes the new intent metadata.

This extension targets macOS only. It does not make the action runnable on an
iPhone or iPad through iCloud shortcut sync.

`UseBrianIntent` is the active action and the only discoverable shortcut. A
non-discoverable `AskBrianIntent` adapter remains solely because the bundled
Apple-signed template was serialized with that identifier; it forwards to the
same `openUseBrian` implementation.
