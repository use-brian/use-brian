# Build assets

Packaging assets, picked up because `directories.buildResources` in
`electron-builder.yml` points here.

| File | Used by | Status |
|---|---|---|
| `icon.png` | electron-builder (app icon — auto-detected from this dir; builder generates the `.icns`) | Committed (1024×1024, the cyan brand mark on a **rounded-squircle** tile with a subtle cyan rim light — macOS-native shape, transparent corners). Generated from `icon.original.png` by `make-dmg-art.py`. |
| `icon.ico` | electron-builder `win.icon` (the Windows exe, installer, shortcut and taskbar icon) | Committed. 14 entries (16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 256), each drawn at its own size by `make-dmg-art.py`: the same tile and mark as `icon.png`, but with **no grid seams** and every cell edge snapped to a whole pixel. It is deliberately not a resize of `icon.png` - Windows point-samples an icon down to taskbar sizes, and the master's thin seams alias into stray black lines across the mark. |
| `icon.original.png` | source for `make-dmg-art.py` | Committed (512×512, the original flat full-bleed mark from `apps/app-web/public/icon.png`). The pre-rounding master — edit this, then regenerate. |
| `background.tiff` (+ `background.png`, `background@2x.png`) | electron-builder `dmg.background` (the mounted install-window backdrop) | Committed. HiDPI 1×/2× backdrop (660×420), dark navy + cyan brand glow, wordmark, and a right-pointing **square-pixel** arrow echoing the mark's pixel-art style. Two slate **legibility plates** sit under where Finder draws the `Use Brian` / `Applications` icon labels: a DMG can't set the label color (Finder follows the *viewer's* Light/Dark appearance), so the plate luminance is tuned to keep both near-black (Light mode) and white (Dark mode) labels readable. The window size + icon centres are set in `../electron-builder.yml` under `dmg:` and must stay in sync with the art. |
| `make-dmg-art.py` | maintainers (regenerates `icon.png` + `icon.ico` + `background.*`) | Committed. `python3 build/make-dmg-art.py [--preview]` (needs Pillow, numpy, macOS `tiffutil`). `--ico` regenerates only `icon.ico` and needs no `tiffutil`. `--preview` writes `/tmp/dmg_preview.png`, a faux install window for eyeballing changes without a full `electron-builder` run. |
| `trayTemplate.png` + `trayTemplate@2x.png` | `main.ts` `createTray()` (menu-bar icon, a black template image; Electron auto-loads the `@2x` companion on Retina) | Committed (22×22 + 44×44, black-on-transparent silhouette of the brand mark — luminance-keyed from the mark, which is fully opaque so its alpha can't be used). `createTray` calls `setTemplateImage(true)`, so macOS recolours it for light/dark menu bars. |
| `entitlements.mac.plist` | electron-builder (hardened runtime) | Committed. |

A macOS template icon is a black-on-transparent PNG named `*Template.png`; macOS
inverts it automatically for dark/light menu bars. See the spec at
`docs/architecture/features/app-desktop.md`.
