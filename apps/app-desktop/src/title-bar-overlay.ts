import type { BrowserTheme } from "./browser-theme.js";

/**
 * Windows window-controls overlay (`titleBarStyle: "hidden"` + `titleBarOverlay`).
 * The OS title bar and menu bar go away; app-web's own top row becomes the
 * title bar and Windows draws only min / max / close over its right edge.
 * app-web insets that row by `env(titlebar-area-*)` (globals.css →
 * `.is-canvas-desktop-win`). See docs/architecture/features/app-desktop.md
 * → "Windows title bar".
 */

/** Matches app-web's top row (`h-11`, 44 CSS px at 100% zoom). */
export const TITLE_BAR_OVERLAY_HEIGHT = 44;

export type TitleBarOverlay = { color: string; symbolColor: string; height: number };

/** Pre-theme fallback: app-web's light / dark `--sidebar` + `--sidebar-foreground`. */
export function defaultTitleBarOverlay(dark: boolean): TitleBarOverlay {
  return dark
    ? { color: "#202020", symbolColor: "#D4D4D4", height: TITLE_BAR_OVERLAY_HEIGHT }
    : { color: "#F7F7F5", symbolColor: "#37352F", height: TITLE_BAR_OVERLAY_HEIGHT };
}

const RGB = /^rgba?\(\s*(\d{1,3})\s*,?\s*(\d{1,3})\s*,?\s*(\d{1,3})\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i;

/**
 * Normalize a resolved computed color to opaque `#rrggbb`, or null when it is
 * not an sRGB `rgb()`/`rgba()` value. Electron's overlay parser does not read
 * `oklch()` / `color()`, and a translucent overlay repaints wrong on hover, so
 * anything else falls back to the scheme default rather than being guessed.
 */
export function opaqueHex(color: string): string | null {
  const m = RGB.exec(color.trim());
  if (!m) return null;
  if (m[4] !== undefined) {
    const alpha = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (!(alpha >= 1)) return null;
  }
  const channels = [m[1], m[2], m[3]].map(Number);
  if (channels.some((c) => c > 255)) return null;
  return `#${channels.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** Overlay colors that match the app's top row for a published theme. */
export function titleBarOverlayFromTheme(theme: BrowserTheme): TitleBarOverlay {
  const fallback = defaultTitleBarOverlay(theme.colorScheme === "dark");
  return {
    color: opaqueHex(theme.colors.sidebar) ?? fallback.color,
    symbolColor: opaqueHex(theme.colors["sidebar-foreground"]) ?? fallback.symbolColor,
    height: TITLE_BAR_OVERLAY_HEIGHT,
  };
}
