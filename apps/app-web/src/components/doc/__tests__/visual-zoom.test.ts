/**
 * [COMP:app-web/visual-zoom] Visual-lightbox zoom math.
 *
 * Pure helpers, no DOM — clamping, button stepping (snapped to the grid),
 * continuous wheel zoom, the percentage readout, and the +/- enable gates.
 */

import { describe, expect, it } from "vitest";
import {
  MIN_ZOOM,
  MAX_ZOOM,
  FIT_ZOOM,
  clampZoom,
  zoomIn,
  zoomOut,
  zoomByDelta,
  formatZoomPercent,
  canZoomIn,
  canZoomOut,
} from "@/lib/visual-zoom";

describe("[COMP:app-web/visual-zoom] Visual lightbox zoom math", () => {
  it("clamps into [MIN, MAX] and maps NaN to the fit scale", () => {
    expect(clampZoom(10)).toBe(MAX_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(1.5)).toBe(1.5);
    expect(clampZoom(Number.NaN)).toBe(FIT_ZOOM);
  });

  it("steps in/out by one grid step and snaps drift back onto the grid", () => {
    expect(zoomIn(1)).toBeCloseTo(1.25);
    expect(zoomOut(1)).toBeCloseTo(0.75);
    // A drifted value (e.g. left over from wheel zoom) snaps to a clean step.
    expect(zoomIn(0.7499999)).toBeCloseTo(1);
    expect(zoomOut(1.2600001)).toBeCloseTo(1);
  });

  it("never steps past the bounds", () => {
    expect(zoomIn(MAX_ZOOM)).toBe(MAX_ZOOM);
    expect(zoomOut(MIN_ZOOM)).toBe(MIN_ZOOM);
  });

  it("wheel zoom: scroll up zooms in, down zooms out, both clamped", () => {
    expect(zoomByDelta(1, -100)).toBeGreaterThan(1);
    expect(zoomByDelta(1, 100)).toBeLessThan(1);
    expect(zoomByDelta(MAX_ZOOM, -10000)).toBe(MAX_ZOOM);
    expect(zoomByDelta(MIN_ZOOM, 10000)).toBe(MIN_ZOOM);
  });

  it("formats a clean integer percentage", () => {
    expect(formatZoomPercent(1)).toBe("100%");
    expect(formatZoomPercent(0.25)).toBe("25%");
    expect(formatZoomPercent(1.5)).toBe("150%");
  });

  it("gates the +/- buttons at the range bounds", () => {
    expect(canZoomIn(1)).toBe(true);
    expect(canZoomIn(MAX_ZOOM)).toBe(false);
    expect(canZoomOut(1)).toBe(true);
    expect(canZoomOut(MIN_ZOOM)).toBe(false);
  });
});
