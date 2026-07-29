import { describe, expect, it } from "vitest";
import {
  FIREFOX_EXTENSION_ID,
  FIREFOX_NATIVE_HOST_NAME,
  buildFirefoxNativeHostManifest,
  firefoxNativeHostManifestPath,
  isFirefoxNativeHostArgv,
} from "../firefox-native-registration.js";

describe("[COMP:app-desktop/firefox-native-host] native-host registration", () => {
  it("builds a Firefox-only manifest pointing at the desktop executable", () => {
    expect(buildFirefoxNativeHostManifest("/Applications/Use Brian.app/Contents/MacOS/Use Brian")).toEqual({
      name: FIREFOX_NATIVE_HOST_NAME,
      description: "Use Brian Firefox browser-control companion",
      path: "/Applications/Use Brian.app/Contents/MacOS/Use Brian",
      type: "stdio",
      allowed_extensions: [FIREFOX_EXTENSION_ID],
    });
  });

  it("uses each platform's per-user Mozilla registration location", () => {
    expect(
      firefoxNativeHostManifestPath({ platform: "darwin", home: "/Users/a", userData: "/unused" }),
    ).toBe(
      "/Users/a/Library/Application Support/Mozilla/NativeMessagingHosts/ai.usebrian.browser.json",
    );
    expect(
      firefoxNativeHostManifestPath({ platform: "win32", home: "C:\\Users\\a", userData: "C:\\Data" }),
    ).toBe("C:\\Data/native-messaging/ai.usebrian.browser.json");
    expect(
      firefoxNativeHostManifestPath({ platform: "linux", home: "/home/a", userData: "/unused" }),
    ).toBe("/home/a/.mozilla/native-messaging-hosts/ai.usebrian.browser.json");
  });

  it("selects native-host mode only for Firefox's authorized launch arguments", () => {
    expect(isFirefoxNativeHostArgv(["Use Brian", FIREFOX_EXTENSION_ID])).toBe(true);
    expect(isFirefoxNativeHostArgv(["Use Brian.exe", "moz-extension://generated-uuid/"])).toBe(true);
    expect(
      isFirefoxNativeHostArgv([
        "Use Brian",
        "/Users/a/Library/Application Support/Mozilla/NativeMessagingHosts/ai.usebrian.browser.json",
      ]),
    ).toBe(true);
    expect(isFirefoxNativeHostArgv(["Use Brian", "usebrian://capture"])).toBe(false);
  });
});
