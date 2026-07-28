import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverFirefoxRemoteEndpoint,
  firefoxExecutableCandidates,
  firefoxProfilesRoot,
} from "../firefox-launcher.js";

describe("[COMP:app-desktop/firefox-native-host] Firefox launcher", () => {
  it("resolves standard executable and profile locations", () => {
    expect(firefoxExecutableCandidates("darwin", {}, "/Users/a")[0]).toBe(
      "/Applications/Firefox.app/Contents/MacOS/firefox",
    );
    expect(firefoxExecutableCandidates("win32", { ProgramFiles: "C:\\Program Files" }, "C:\\Users\\a")).toEqual([
      "C:\\Program Files/Mozilla Firefox/firefox.exe",
    ]);
    expect(firefoxProfilesRoot("darwin", {}, "/Users/a")).toBe(
      "/Users/a/Library/Application Support/Firefox/Profiles",
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
    const endpoint = await discoverFirefoxRemoteEndpoint(root);
    expect(endpoint).toMatchObject({ wsHost: "localhost", wsPort: 9555, profileDir: newer });
  });

  it("rejects a non-loopback endpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "usebrian-firefox-"));
    const profile = join(root, "unsafe.default");
    await mkdir(profile);
    await writeFile(join(profile, "WebDriverBiDiServer.json"), JSON.stringify({ ws_host: "0.0.0.0", ws_port: 9222 }));
    expect(await discoverFirefoxRemoteEndpoint(root)).toBeNull();
  });
});
