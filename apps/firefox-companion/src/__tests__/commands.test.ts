import { describe, expect, it, vi } from "vitest";
import {
  companionExecutableCandidates,
  companionProfilesRoots,
  runCompanionCommand,
  type CompanionCommandDeps,
} from "../commands.js";

function commandDeps(overrides: Partial<CompanionCommandDeps> = {}): Partial<CompanionCommandDeps> {
  return {
    platform: "linux",
    env: {},
    home: "/home/brian",
    executablePath: "/opt/use-brian/dist/cli.js",
    writeOut: vi.fn(),
    writeError: vi.fn(),
    chmodFile: vi.fn(async () => undefined),
    registerHost: vi.fn(async () => "/home/brian/.mozilla/native-messaging-hosts/ai.usebrian.browser.json"),
    findExecutable: vi.fn(async () => "/usr/bin/firefox"),
    discoverEndpoint: vi.fn(async () => null),
    launchFirefox: vi.fn(),
    waitForEndpoint: vi.fn(async () => ({
      wsHost: "127.0.0.1",
      wsPort: 9222,
      profileDir: "/home/brian/.mozilla/firefox/default",
      modifiedAtMs: 100,
    })),
    now: vi.fn(() => 1_000),
    ...overrides,
  };
}

describe("[COMP:ext/firefox-companion] standalone commands", () => {
  it("registers the CLI executable as Firefox's native host", async () => {
    const deps = commandDeps();
    expect(await runCompanionCommand(["install"], deps)).toBe(0);
    expect(deps.chmodFile).toHaveBeenCalledWith("/opt/use-brian/dist/cli.js", 0o755);
    expect(deps.registerHost).toHaveBeenCalledWith(expect.objectContaining({
      platform: "linux",
      executablePath: "/opt/use-brian/dist/cli.js",
    }));
  });

  it("launches Firefox and waits for a fresh loopback endpoint", async () => {
    const deps = commandDeps();
    expect(await runCompanionCommand(["start"], deps)).toBe(0);
    expect(deps.launchFirefox).toHaveBeenCalledWith("/usr/bin/firefox");
    expect(deps.waitForEndpoint).toHaveBeenCalledWith(
      ["/home/brian/.mozilla/firefox", "/home/brian/.config/mozilla/firefox"],
      { afterMs: 0 },
    );
  });

  it("accepts only absolute server overrides", () => {
    expect(companionExecutableCandidates("linux", { USE_BRIAN_FIREFOX_PATH: "/srv/firefox" }, "/home/brian")[0])
      .toBe("/srv/firefox");
    expect(companionProfilesRoots("linux", { USE_BRIAN_FIREFOX_PROFILE_ROOT: "/srv/profile-root" }, "/home/brian"))
      .toEqual(["/srv/profile-root"]);
    expect(() => companionProfilesRoots("linux", { USE_BRIAN_FIREFOX_PROFILE_ROOT: "relative" }, "/home/brian"))
      .toThrow("absolute path");
  });

  it("keeps Windows on the packaged desktop executable", async () => {
    const deps = commandDeps({ platform: "win32" });
    expect(await runCompanionCommand(["install"], deps)).toBe(1);
    expect(deps.registerHost).not.toHaveBeenCalled();
    expect(deps.writeError).toHaveBeenCalledWith(expect.stringContaining("desktop app on Windows"));
  });
});
