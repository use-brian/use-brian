# Brian Siri extension

This macOS ExtensionKit App Intents extension exposes the "Ask Brian" and
"Tell Brian" Siri phrases. Siri asks for the required Request value and opens a
bounded `usebrian://ask?prompt=...` handoff to the containing Electron app.

Build it on macOS with:

```sh
pnpm --filter @use-brian/app-desktop run build:siri
```

The build reads the version from `apps/app-desktop/package.json`.
electron-builder embeds the result at
`Use Brian.app/Contents/Extensions/Brian Siri.appex`; its `afterPack` hook signs
the extension before signing and notarizing the parent app.
Without Developer ID credentials, local packages ad-hoc sign both the extension
and parent app, then deep-verify the complete bundle. Release packages use the
configured Developer ID identity instead.

Install the resulting app in `/Applications` and open it once. Restart
Shortcuts, then search its action library for "Ask Brian". After replacing a
development build, delete and recreate stale shortcut actions so macOS indexes
the new intent metadata.

This extension targets macOS only. It does not make the action runnable on an
iPhone or iPad through iCloud shortcut sync.
