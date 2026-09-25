/**
 * [COMP:app-web/popup-clamp] Caret-anchored popup clamp + flip.
 *
 * The rule every caret popup (slash menu, `@` mention, link-to-page picker,
 * comment mention list) shares: stay inside the visible viewport
 * horizontally, open below the caret when it fits, flip above when only
 * above fits, and pin to the bottom margin when neither does. The viewport
 * handed in is the VISUAL one, so a raised keyboard (a shorter `height`,
 * a non-zero `top`) is what triggers the flip.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  POPUP_GAP,
  POPUP_MARGIN,
  clampPopupRect,
  measureViewport,
  onViewportChange,
  positionSuggestionPopup,
} from "@/lib/popup-clamp";

const PHONE = { top: 0, left: 0, width: 360, height: 640 };
const MENU = { width: 288, height: 320 };
const caret = (top: number, left: number) => ({ top, bottom: top + 20, left });

describe("[COMP:app-web/popup-clamp] clampPopupRect", () => {
  it("opens below the caret at the caret's left when everything fits", () => {
    const p = clampPopupRect(caret(100, 20), MENU, PHONE);
    expect(p).toEqual({ top: 120 + POPUP_GAP, left: 20, flipped: false });
  });

  it("pulls the popup back from the right edge on a 360px phone", () => {
    // A caret 200px in would push a 288px menu 128px past the edge.
    const p = clampPopupRect(caret(100, 200), MENU, PHONE);
    expect(p.left).toBe(360 - 288 - POPUP_MARGIN);
    expect(p.left + MENU.width).toBeLessThanOrEqual(360 - POPUP_MARGIN);
  });

  it("never places the popup left of the margin", () => {
    const p = clampPopupRect(caret(100, 0), MENU, PHONE);
    expect(p.left).toBe(POPUP_MARGIN);
  });

  it("flips above the caret when below would run under the keyboard", () => {
    // Keyboard up: the visual viewport is 640 - 300 tall. A caret at 336
    // leaves no room below the keys and 328px above the top margin.
    const keyboardUp = { ...PHONE, height: 340 };
    const p = clampPopupRect(caret(336, 20), MENU, keyboardUp);
    expect(p.flipped).toBe(true);
    expect(p.top).toBe(336 - POPUP_GAP - MENU.height);
    expect(p.top).toBeGreaterThanOrEqual(POPUP_MARGIN);
  });

  it("respects a scrolled visual viewport (offsetTop) when flipping", () => {
    // Visual viewport scrolled 100px into the layout viewport, 340 tall.
    // A caret 436px down: 4px below the band's floor, 328px above the ceiling.
    const vv = { top: 100, left: 0, width: 360, height: 340 };
    const p = clampPopupRect(caret(436, 20), MENU, vv);
    expect(p.flipped).toBe(true);
    expect(p.top).toBeGreaterThanOrEqual(vv.top + POPUP_MARGIN);
    expect(p.top + MENU.height).toBeLessThanOrEqual(436 - POPUP_GAP);
  });

  it("pins to the bottom margin when neither side fits", () => {
    const tiny = { ...PHONE, height: 300 };
    const p = clampPopupRect(caret(140, 20), MENU, tiny);
    expect(p.flipped).toBe(false);
    expect(p.top).toBe(POPUP_MARGIN); // floor - height would be < ceiling
    expect(p.top).toBeGreaterThanOrEqual(POPUP_MARGIN);
  });

  it("prefers below over above when both fit", () => {
    const p = clampPopupRect(caret(300, 20), { width: 200, height: 100 }, PHONE);
    expect(p.flipped).toBe(false);
    expect(p.top).toBe(320 + POPUP_GAP);
  });
});

describe("[COMP:app-web/popup-clamp] viewport measurement (SSR-safe)", () => {
  const g = globalThis as { window?: unknown };
  const original = g.window;
  afterEach(() => {
    if (original === undefined) delete g.window;
    else g.window = original;
  });

  it("returns a zero viewport and a no-op unsubscribe without a window", () => {
    delete g.window;
    expect(measureViewport()).toEqual({ top: 0, left: 0, width: 0, height: 0 });
    expect(() => onViewportChange(() => {})()).not.toThrow();
  });

  it("reads the visual viewport when the browser exposes one", () => {
    const listeners: string[] = [];
    g.window = {
      innerWidth: 360,
      innerHeight: 640,
      visualViewport: {
        offsetTop: 100,
        offsetLeft: 0,
        width: 360,
        height: 340,
        addEventListener: (type: string) => listeners.push(`add:${type}`),
        removeEventListener: (type: string) => listeners.push(`remove:${type}`),
      },
      addEventListener: (type: string) => listeners.push(`win-add:${type}`),
      removeEventListener: (type: string) => listeners.push(`win-remove:${type}`),
    };
    expect(measureViewport()).toEqual({ top: 100, left: 0, width: 360, height: 340 });
    const off = onViewportChange(() => {});
    expect(listeners).toContain("add:resize");
    expect(listeners).toContain("add:scroll");
    off();
    expect(listeners).toContain("remove:resize");
  });

  it("falls back to the window size when there is no visual viewport", () => {
    g.window = {
      innerWidth: 1280,
      innerHeight: 800,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    expect(measureViewport()).toEqual({ top: 0, left: 0, width: 1280, height: 800 });
  });

  it("makes a block renderer wrapper shrink-to-fit before measuring its popup", () => {
    g.window = {
      innerWidth: 1440,
      innerHeight: 900,
      scrollX: 0,
      scrollY: 0,
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    const style = {} as CSSStyleDeclaration;
    const el = {
      style,
      // ReactRenderer creates a block-level wrapper. Before it becomes
      // absolutely positioned that wrapper fills the viewport; afterwards it
      // shrink-wraps the 288px menu rendered inside it.
      get offsetWidth() {
        return style.position === "absolute" ? 288 : 1440;
      },
      offsetHeight: 320,
    } as HTMLElement;

    const placed = positionSuggestionPopup(el, caret(100, 600));

    expect(placed.left).toBe(600);
    expect(style.position).toBe("absolute");
    expect(style.left).toBe("600px");
  });
});
