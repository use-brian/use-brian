import { describe, it, expect } from "vitest";

import {
  buildUninstallScript,
  collectUninstallPaths,
  resolveBundlePath,
} from "../uninstall.js";

const HOME = "/Users/alice";

describe("[COMP:app-desktop/uninstall] uninstall planning", () => {
  it("collects local traces for BOTH brand generations under the given home", () => {
    const paths = collectUninstallPaths(HOME);
    // Current generation.
    expect(paths).toContain("/Users/alice/Library/Application Support/Use Brian");
    expect(paths).toContain("/Users/alice/Library/Preferences/ai.usebrian.desktop.plist");
    expect(paths).toContain("/Users/alice/Library/Caches/ai.usebrian.desktop.ShipIt");
    // Pre-rebrand generation (auto-updated installs carry both).
    expect(paths).toContain("/Users/alice/Library/Application Support/sidanclaw");
    expect(paths).toContain("/Users/alice/Library/Preferences/ai.sidan.desktop.plist");
    expect(paths).toContain(
      "/Users/alice/Library/Saved Application State/ai.sidan.desktop.savedState",
    );
    for (const p of paths) expect(p.startsWith(`${HOME}/Library/`)).toBe(true);
  });

  it("resolves the outermost .app bundle from a packaged exe path", () => {
    expect(
      resolveBundlePath("/Applications/Use Brian.app/Contents/MacOS/Use Brian"),
    ).toBe("/Applications/Use Brian.app");
    // Helper exe inside a nested .app still resolves to the OUTER bundle.
    expect(
      resolveBundlePath(
        "/Applications/Use Brian.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper",
      ),
    ).toBe("/Applications/Use Brian.app");
  });

  it("returns null for non-bundle exes and DMG-mounted bundles", () => {
    expect(resolveBundlePath("/usr/local/bin/electron")).toBeNull();
    expect(
      resolveBundlePath("/Volumes/Use Brian/Use Brian.app/Contents/MacOS/Use Brian"),
    ).toBeNull();
  });

  it("script waits for the pid, then removes every path best-effort", () => {
    const script = buildUninstallScript({
      pid: 4242,
      paths: ["/Users/alice/Library/Application Support/Use Brian"],
      bundlePath: null,
    });
    const lines = script.trim().split("\n");
    expect(lines[1]).toBe("while kill -0 4242 2>/dev/null; do sleep 0.2; done");
    expect(lines[2]).toBe(
      "rm -rf '/Users/alice/Library/Application Support/Use Brian' || true",
    );
    // No bundle line when bundlePath is null.
    expect(script).not.toContain("osascript");
  });

  it("script trashes the bundle via Finder with an rm fallback, correctly quoted", () => {
    const script = buildUninstallScript({
      pid: 1,
      paths: [],
      bundlePath: "/Applications/Use Brian.app",
    });
    expect(script).toContain(
      `osascript -e 'tell application "Finder" to delete (POSIX file "'` +
        `'/Applications/Use Brian.app'` +
        `'" as alias)' >/dev/null 2>&1 || rm -rf '/Applications/Use Brian.app' || true`,
    );
    // The Finder step precedes nothing else: teardown ends with the bundle.
    expect(script.trim().split("\n").at(-1)).toContain("rm -rf '/Applications/Use Brian.app'");
  });

  it("quotes single quotes in paths for POSIX sh", () => {
    const script = buildUninstallScript({
      pid: 1,
      paths: ["/Users/o'brien/Library/Caches/ai.usebrian.desktop"],
      bundlePath: null,
    });
    expect(script).toContain(`rm -rf '/Users/o'\\''brien/Library/Caches/ai.usebrian.desktop' || true`);
  });
});
