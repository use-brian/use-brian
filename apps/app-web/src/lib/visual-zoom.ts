/**
 * Pure zoom math for the visual-embed lightbox (`visual-lightbox.tsx`).
 *
 * Kept dependency-free and side-effect-free so the clamping / stepping /
 * formatting is unit-testable without a DOM — the component only owns the
 * React state + pointer wiring. Step zoom (the − / + buttons) snaps to the
 * grid so the readout stays clean (no `74.999%`); wheel zoom is continuous.
 *
 * [COMP:app-web/visual-zoom]
 */

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;
/** The "fit" / reset scale — the visual at its inline size. */
export const FIT_ZOOM = 1;

/** Clamp any candidate scale into the supported range; NaN snaps to fit. */
export function clampZoom(zoom: number): number {
  if (Number.isNaN(zoom)) return FIT_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Snap to the nearest step so button zoom lands on clean percentages. */
function snapToStep(zoom: number): number {
  return Math.round(zoom / ZOOM_STEP) * ZOOM_STEP;
}

/** One step in (the `+` button). */
export function zoomIn(zoom: number): number {
  return clampZoom(snapToStep(zoom + ZOOM_STEP));
}

/** One step out (the `−` button). */
export function zoomOut(zoom: number): number {
  return clampZoom(snapToStep(zoom - ZOOM_STEP));
}

/**
 * Continuous wheel / trackpad zoom. `deltaY < 0` (scroll up / pinch out)
 * zooms in; the exponential factor keeps zoom perceptually even across the
 * range instead of crawling near MAX and jumping near MIN.
 */
export function zoomByDelta(zoom: number, deltaY: number): number {
  return clampZoom(zoom * Math.exp(-deltaY * 0.0015));
}

/** Toolbar readout, e.g. `100%`. */
export function formatZoomPercent(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

/** Whether the `+` / `−` buttons should be enabled (tiny epsilon for floats). */
export function canZoomIn(zoom: number): boolean {
  return zoom < MAX_ZOOM - 1e-6;
}
export function canZoomOut(zoom: number): boolean {
  return zoom > MIN_ZOOM + 1e-6;
}
