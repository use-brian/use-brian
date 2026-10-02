/**
 * The app's OS-level identity. `APP_ID` is electron-builder's `appId`
 * (electron-builder.yml) restated for runtime; a test holds the two equal.
 *
 * On Windows it doubles as the AppUserModelID. The NSIS installer stamps that
 * id on the Start Menu and desktop shortcuts, and the taskbar groups a window
 * with a pinned shortcut only when both carry the same one. A process that
 * never claims an id inherits one from whatever launched it: started from the
 * shortcut it matches, started any other way (a `usebrian://` link, the
 * Firefox companion, and as reported the relaunch after an update) it gets a
 * path-derived id and shows up as a second app beside its own pin. Claiming
 * the id explicitly makes the grouping independent of the launch route. See
 * docs/architecture/features/app-desktop.md → "Windows shell identity".
 */
export const APP_ID = "ai.usebrian.desktop";

/**
 * The AppUserModelID to claim, or null when there is nothing to claim: other
 * platforms have no such id, and an unpackaged dev run must not join the
 * installed app's taskbar group.
 */
export function windowsAppUserModelId(platform: NodeJS.Platform, isPackaged: boolean): string | null {
  return platform === "win32" && isPackaged ? APP_ID : null;
}
