import { describe, expect, it } from "vitest";
import {
  isFirefoxUa,
  isMacUa,
  surfaceShortcutLabel,
  surfaceShortcutModifierPressed,
} from "../surface-shortcuts";

const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MAC_FIREFOX =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0";
const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const WIN_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const WIN_FIREFOX =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0";
const LINUX_FIREFOX =
  "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0";
// The app-desktop shell: Chromium UA, never "Firefox" — keeps the ⌘ binding.
const MAC_ELECTRON =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) use-brian/1.0.0 Chrome/124.0.6367.243 Electron/30.0.9 Safari/537.36";

const key = (mods: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>>) => ({
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe("[COMP:app-web/surface-shortcuts] Surface-shortcut modifier per browser", () => {
  it("detects Firefox and mac from the UA", () => {
    expect(isFirefoxUa(MAC_FIREFOX)).toBe(true);
    expect(isFirefoxUa(MAC_CHROME)).toBe(false);
    expect(isFirefoxUa(MAC_ELECTRON)).toBe(false);
    expect(isMacUa(MAC_SAFARI)).toBe(true);
    expect(isMacUa(WIN_FIREFOX)).toBe(false);
  });

  it("accepts the native Accel key outside Firefox (⌘ on mac, Ctrl elsewhere)", () => {
    expect(surfaceShortcutModifierPressed(key({ metaKey: true }), MAC_CHROME)).toBe(true);
    expect(surfaceShortcutModifierPressed(key({ ctrlKey: true }), WIN_CHROME)).toBe(true);
    expect(surfaceShortcutModifierPressed(key({ metaKey: true }), MAC_ELECTRON)).toBe(true);
    expect(surfaceShortcutModifierPressed(key({}), MAC_CHROME)).toBe(false);
  });

  it("remaps to plain Ctrl in Firefox and leaves ⌘+digit to the browser's tab switch", () => {
    expect(surfaceShortcutModifierPressed(key({ ctrlKey: true }), MAC_FIREFOX)).toBe(true);
    // ⌘+digit is Firefox's reserved tab switch — matching it too would make a
    // surface jump double up with the tab switch, so it must NOT match.
    expect(surfaceShortcutModifierPressed(key({ metaKey: true }), MAC_FIREFOX)).toBe(false);
    expect(
      surfaceShortcutModifierPressed(key({ metaKey: true, ctrlKey: true }), MAC_FIREFOX),
    ).toBe(false);
    expect(surfaceShortcutModifierPressed(key({ ctrlKey: true }), WIN_FIREFOX)).toBe(true);
    expect(surfaceShortcutModifierPressed(key({ ctrlKey: true }), LINUX_FIREFOX)).toBe(true);
  });

  it("always leaves Shift/Alt-modified combos alone", () => {
    for (const ua of [MAC_CHROME, MAC_FIREFOX, WIN_CHROME, WIN_FIREFOX]) {
      expect(
        surfaceShortcutModifierPressed(key({ metaKey: true, shiftKey: true }), ua),
      ).toBe(false);
      expect(
        surfaceShortcutModifierPressed(key({ ctrlKey: true, altKey: true }), ua),
      ).toBe(false);
    }
  });

  it("labels the tooltip chip per browser (⌘n / ⌃n / Ctrl+n)", () => {
    expect(surfaceShortcutLabel(1, MAC_CHROME)).toBe("⌘1");
    expect(surfaceShortcutLabel(1, MAC_SAFARI)).toBe("⌘1");
    expect(surfaceShortcutLabel(1, MAC_ELECTRON)).toBe("⌘1");
    expect(surfaceShortcutLabel(2, MAC_FIREFOX)).toBe("⌃2");
    expect(surfaceShortcutLabel(3, WIN_CHROME)).toBe("Ctrl+3");
    expect(surfaceShortcutLabel(4, WIN_FIREFOX)).toBe("Ctrl+4");
    // SSR fallback (navigator undefined → empty UA): never reaches paint —
    // the tooltip popup only mounts on hover — but must not throw.
    expect(surfaceShortcutLabel(1, "")).toBe("Ctrl+1");
  });
});
