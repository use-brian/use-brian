import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  discoverFirefoxRemoteEndpoint,
  firefoxExecutableCandidates,
  firefoxProfilesRoots,
  launchFirefoxForControl,
} from "../firefox-launcher.js";

describe("[COMP:app-desktop/firefox-native-host] Firefox launcher", () => {
  it("resolves standard executable and profile locations", () => {
    expect(firefoxExecutableCandidates("darwin", {}, "/Users/a")[0]).toBe(
      "/Applications/Firefox.app/Contents/MacOS/firefox",
    );
    expect(firefoxExecutableCandidates("win32", { ProgramFiles: "C:\\Program Files" }, "C:\\Users\\a")).toEqual([
      "C:\\Program Files/Mozilla Firefox/firefox.exe",
    ]);
    expect(firefoxProfilesRoots("darwin", {}, "/Users/a")).toEqual([
      "/Users/a/Library/Application Support/Firefox/Profiles",
    ]);
    expect(
      firefoxExecutableCandidates("linux", { PATH: "/run/current-system/sw/bin:/usr/bin" }, "/home/a"),
    ).toContain("/run/current-system/sw/bin/firefox");
    expect(firefoxProfilesRoots("linux", {}, "/home/a")).toEqual([
      "/home/a/.mozilla/firefox",
      "/home/a/.config/mozilla/firefox",
    ]);
    expect(firefoxProfilesRoots("linux", { XDG_CONFIG_HOME: "/xdg" }, "/home/a")).toContain(
      "/xdg/mozilla/firefox",
    );
  });

  it("discovers only a valid loopback endpoint and picks the newest profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "usebrian-firefox-"));
    const older = join(root, "older.default");
    const newer = join(root, "newer.default");
    await Promise.all([mkdir(older), mkdir(newer)]);
    await writeFile(join(older, "WebDriverBiDiServer.json"), JSON.stringify({ ws_host: "127.0.0.1", ws_port: 9222 }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(join(newer, "WebDriverBiDiServer.json"), JSON.stringify({ ws_host: "localhost", ws_port: 9555 }));
    const endpoint = await discoverFirefoxRemoteEndpoint([root]);
    expect(endpoint).toMatchObject({ wsHost: "localhost", wsPort: 9555, profileDir: newer });
  });

  it("rejects a non-loopback endpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "usebrian-firefox-"));
    const profile = join(root, "unsafe.default");
    await mkdir(profile);
    await writeFile(join(profile, "WebDriverBiDiServer.json"), JSON.stringify({ ws_host: "0.0.0.0", ws_port: 9222 }));
    expect(await discoverFirefoxRemoteEndpoint([root])).toBeNull();
  });

  it("normalizes Firefox's bracketed IPv6 loopback host", async () => {
    const root = await mkdtemp(join(tmpdir(), "usebrian-firefox-"));
    const profile = join(root, "ipv6.default");
    await mkdir(profile);
    await writeFile(join(profile, "WebDriverBiDiServer.json"), JSON.stringify({ ws_host: "[::1]", ws_port: 9222 }));
    expect(await discoverFirefoxRemoteEndpoint([root])).toMatchObject({ wsHost: "::1", wsPort: 9222 });
  });

  it("discovers an absolute custom profile registered in profiles.ini", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "usebrian-firefox-config-"));
    const profilesRoot = join(configRoot, "Profiles");
    const externalProfile = await mkdtemp(join(tmpdir(), "usebrian-firefox-external-"));
    await writeFile(
      join(configRoot, "profiles.ini"),
      `[Profile0]\nName=external\nIsRelative=0\nPath=${externalProfile}\nDefault=1\n`,
    );
    await writeFile(
      join(externalProfile, "WebDriverBiDiServer.json"),
      JSON.stringify({ ws_host: "127.0.0.1", ws_port: 9333 }),
    );
    expect(await discoverFirefoxRemoteEndpoint([profilesRoot])).toMatchObject({
      wsHost: "127.0.0.1",
      wsPort: 9333,
      profileDir: externalProfile,
    });
  });

  it("discovers an endpoint under Firefox's fresh-install XDG root", async () => {
    const legacyRoot = await mkdtemp(join(tmpdir(), "usebrian-firefox-legacy-"));
    const xdgRoot = await mkdtemp(join(tmpdir(), "usebrian-firefox-xdg-"));
    const profile = join(xdgRoot, "fresh.default");
    await mkdir(profile);
    await writeFile(
      join(profile, "WebDriverBiDiServer.json"),
      JSON.stringify({ ws_host: "127.0.0.1", ws_port: 9444 }),
    );
    expect(await discoverFirefoxRemoteEndpoint([legacyRoot, xdgRoot])).toMatchObject({
      wsPort: 9444,
      profileDir: profile,
    });
  });

  it("starts a new Firefox instance with Remote Agent enabled", () => {
    const child = { unref: vi.fn() };
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    launchFirefoxForControl("/usr/bin/firefox", spawnProcess);
    expect(spawnProcess).toHaveBeenCalledWith(
      "/usr/bin/firefox",
      ["--new-instance", "--remote-debugging-port=0"],
      { detached: true, stdio: "ignore" },
    );
    expect(child.unref).toHaveBeenCalled();
  });
});
