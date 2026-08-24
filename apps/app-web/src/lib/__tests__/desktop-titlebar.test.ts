/**
 * Regression coverage for the macOS traffic-light clearance across Electron
 * page zoom levels.
 *
 * [COMP:app-web/desktop-titlebar]
 */

import { describe, expect, it } from "vitest";

import {
  MACOS_TRAFFIC_LIGHT_CLEARANCE_PX,
  desktopTitlebarInsetCssPx,
  resolveDesktopZoomFactor,
} from "../desktop-titlebar";

describe("[COMP:app-web/desktop-titlebar] desktopTitlebarInsetCssPx", () => {
  it("keeps the traffic-light clearance constant in window coordinates", () => {
    for (const zoomFactor of [0.5, 0.8, 1, 1.25, 1.5, 2, 3]) {
      const cssInset = desktopTitlebarInsetCssPx(zoomFactor);
      expect(cssInset * zoomFactor).toBeCloseTo(
        MACOS_TRAFFIC_LIGHT_CLEARANCE_PX,
      );
    }
  });

  it("falls back to 100% for invalid factors", () => {
    expect(desktopTitlebarInsetCssPx(0)).toBe(
      MACOS_TRAFFIC_LIGHT_CLEARANCE_PX,
    );
    expect(desktopTitlebarInsetCssPx(Number.NaN)).toBe(
      MACOS_TRAFFIC_LIGHT_CLEARANCE_PX,
    );
    expect(desktopTitlebarInsetCssPx(Number.POSITIVE_INFINITY)).toBe(
      MACOS_TRAFFIC_LIGHT_CLEARANCE_PX,
    );
  });
});

describe("[COMP:app-web/desktop-titlebar] resolveDesktopZoomFactor", () => {
  it("prefers the exact zoom factor reported by the current shell", () => {
    expect(
      resolveDesktopZoomFactor(1.5, { outerWidth: 1280, innerWidth: 640 }),
    ).toBe(1.5);
  });

  it("infers zoom from frameless window geometry for an older shell", () => {
    expect(
      resolveDesktopZoomFactor(undefined, {
        outerWidth: 1280,
        innerWidth: 800,
      }),
    ).toBe(1.6);
  });

  it("falls back to 100% when neither source is valid", () => {
    expect(
      resolveDesktopZoomFactor(undefined, { outerWidth: 0, innerWidth: 0 }),
    ).toBe(1);
  });
});
