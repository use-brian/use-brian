/**
 * Zoom-safe layout math for the macOS Electron titlebar.
 *
 * Native traffic lights stay in window coordinates while Chromium page zoom
 * scales CSS pixels. Keep the native clearance invariant by dividing its
 * window-pixel width by the current page zoom before writing the CSS inset.
 *
 * [COMP:app-web/desktop-titlebar]
 */

/** Native traffic-light group plus the intended breathing room at 100%. */
export const MACOS_TRAFFIC_LIGHT_CLEARANCE_PX = 76;

type WindowWidths = {
  outerWidth: number;
  innerWidth: number;
};

function validZoomFactor(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Resolve the Electron page zoom, preferring the exact preload value.
 *
 * Older deployed shells do not expose `webFrame.getZoomFactor()`. Their
 * frameless window has no horizontal browser chrome, so outer/inner width is a
 * useful compatibility estimate: outer width stays in window pixels while
 * inner width is expressed in the page's zoomed CSS pixels.
 */
export function resolveDesktopZoomFactor(
  reported: unknown,
  widths: WindowWidths,
): number {
  if (validZoomFactor(reported)) return reported;

  const inferred = widths.outerWidth / widths.innerWidth;
  return validZoomFactor(inferred) ? inferred : 1;
}

/** CSS-pixel inset that occupies a constant 76 pixels in window coordinates. */
export function desktopTitlebarInsetCssPx(zoomFactor: unknown): number {
  const normalized = validZoomFactor(zoomFactor) ? zoomFactor : 1;
  return MACOS_TRAFFIC_LIGHT_CLEARANCE_PX / normalized;
}
