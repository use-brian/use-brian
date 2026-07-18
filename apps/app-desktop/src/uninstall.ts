/**
 * One-click uninstall (macOS) — the pure planning half.
 *
 * macOS has no system uninstaller, so the shell offers "Uninstall Use Brian…"
 * in the app menu (packaged macOS builds only: Windows gets the NSIS
 * uninstaller for free, and a dev run has no bundle to remove). The electron
 * side (`main.ts`) confirms with a native dialog, then spawns the detached
 * teardown script built here and quits — the script waits for the process to
 * exit before touching anything, because macOS cannot delete a running app
 * cleanly and the userData dir is still being written until exit.
 *
 * Everything decision-shaped lives in this file so it unit-tests without
 * Electron: which paths to remove, how the script is assembled and quoted, and
 * where the .app bundle is. Removal covers BOTH brand generations — the
 * pre-rebrand app ("sidanclaw" / ai.sidan.desktop) and the current one
 * ("Use Brian" / ai.usebrian.desktop) — because installs that auto-updated
 * across the rebrand carry leftovers under both names. All removals are
 * best-effort (`|| true`): a missing path must never abort the teardown.
 *
 * The app's account/workspace data lives server-side; the local traces are
 * only the session token, caches, and window state, so uninstall loses nothing.
 *
 * Spec: docs/architecture/features/app-desktop.md → "uninstall.ts"
 * [COMP:app-desktop/uninstall]
 */

/** Both brand generations' identifiers (historical constants, not config). */
const GENERATIONS = [
  { productName: "Use Brian", appId: "ai.usebrian.desktop" },
  { productName: "sidanclaw", appId: "ai.sidan.desktop" }, // pre-rebrand (≤v0.0.4)
] as const;

/**
 * Every local trace the app may have written, across both generations.
 * Absolute paths under the given home dir; missing ones are fine (best-effort).
 */
export function collectUninstallPaths(home: string): string[] {
  const paths: string[] = [];
  for (const { productName, appId } of GENERATIONS) {
    paths.push(
      `${home}/Library/Application Support/${productName}`,
      `${home}/Library/Logs/${productName}`,
      `${home}/Library/Preferences/${appId}.plist`,
      `${home}/Library/Caches/${appId}`,
      `${home}/Library/Caches/${appId}.ShipIt`, // Squirrel.Mac update staging
      `${home}/Library/Saved Application State/${appId}.savedState`,
    );
  }
  return paths;
}

/**
 * The outermost `.app` bundle containing an executable path, or null when the
 * exe is not inside a deletable bundle:
 *  - not inside any `.app` (bare dev binary), or
 *  - mounted under `/Volumes` (running straight off the DMG — read-only, and
 *    "uninstalling" it would really be ejecting; the teardown then only cleans
 *    the local data traces).
 * Outermost (not nearest) so a helper-app exe still resolves to the real bundle.
 */
export function resolveBundlePath(exePath: string): string | null {
  const segments = exePath.split("/");
  const appIdx = segments.findIndex((s) => s.endsWith(".app") && s !== ".app");
  if (appIdx === -1) return null;
  const bundle = segments.slice(0, appIdx + 1).join("/");
  if (bundle.startsWith("/Volumes/")) return null;
  return bundle;
}

/** Single-quote a path for POSIX sh (the only escape needed inside '…' is '). */
function shQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

export interface UninstallScriptOptions {
  /** The running app's pid — the script waits for it to exit first. */
  readonly pid: number;
  /** Local trace paths to remove (from `collectUninstallPaths`). */
  readonly paths: readonly string[];
  /** The .app bundle to move to Trash, or null to leave the binary alone. */
  readonly bundlePath: string | null;
}

/**
 * Assemble the detached POSIX-sh teardown script. Order matters: wait for the
 * app to exit → remove data traces → move the bundle to Trash. The bundle goes
 * through Finder (recoverable from Trash, the mac-native uninstall gesture)
 * with a plain `rm -rf` fallback for when Finder scripting is unavailable.
 */
export function buildUninstallScript(opts: UninstallScriptOptions): string {
  const lines = [
    `#!/bin/sh`,
    // Poll instead of `wait`: the script is detached, so the app is not a child.
    `while kill -0 ${opts.pid} 2>/dev/null; do sleep 0.2; done`,
    ...opts.paths.map((p) => `rm -rf ${shQuote(p)} || true`),
  ];
  if (opts.bundlePath) {
    const quoted = shQuote(opts.bundlePath);
    lines.push(
      `osascript -e 'tell application "Finder" to delete (POSIX file "'${quoted}'" as alias)' >/dev/null 2>&1 || rm -rf ${quoted} || true`,
    );
  }
  return lines.join("\n") + "\n";
}
