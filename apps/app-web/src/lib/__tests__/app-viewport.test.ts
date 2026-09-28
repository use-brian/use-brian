/** [COMP:app-web/viewport] Native dock layout geometry, independent of media queries. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { appPopupBoundary, availableAppWidth, subscribeAppViewport } from "../app-viewport";

const eventName = "usebrian:browser-dock-layout";

afterEach(() => vi.unstubAllGlobals());

function browser(docked: boolean, clientWidth = 720, rectWidth = 719.5) {
  const window = Object.assign(new EventTarget(), { innerWidth: 1440 });
  const body = { clientWidth, getBoundingClientRect: () => ({ width: rectWidth }) };
  const document = {
    documentElement: { hasAttribute: (name: string) => docked && name === "data-native-browser-docked" },
    body,
  };
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  return { window, document, body };
}

describe("[COMP:app-web/viewport] available app geometry", () => {
  it("is SSR safe, including subscription cleanup", () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);
    expect(availableAppWidth()).toBe(0);
    expect(appPopupBoundary()).toBeUndefined();
    expect(() => subscribeAppViewport(() => {})()).not.toThrow();
  });

  it("preserves full window width and Base UI's default boundary on the web", () => {
    browser(false);
    expect(availableAppWidth()).toBe(1440);
    expect(appPopupBoundary()).toBeUndefined();
  });

  it("uses the constrained body only while docked, including undocking", () => {
    const { document, body } = browser(true);
    expect(availableAppWidth()).toBe(720);
    expect(appPopupBoundary()).toBe(body);
    document.documentElement.hasAttribute = () => false;
    expect(availableAppWidth()).toBe(1440);
    expect(appPopupBoundary()).toBeUndefined();
  });

  it("falls back to the body rectangle when clientWidth is unavailable", () => {
    browser(true, 0, 719.5);
    expect(availableAppWidth()).toBe(719.5);
  });

  it("subscribes to dock changes and real resize and removes both listeners", () => {
    const { window, body } = browser(true);
    const widths: number[] = [];
    const cleanup = subscribeAppViewport(() => widths.push(availableAppWidth()));
    body.clientWidth = 600;
    window.dispatchEvent(new Event(eventName));
    body.clientWidth = 500;
    window.dispatchEvent(new Event("resize"));
    expect(widths).toEqual([600, 500]);
    cleanup();
    window.dispatchEvent(new Event(eventName));
    window.dispatchEvent(new Event("resize"));
    expect(widths).toEqual([600, 500]);
  });
});
