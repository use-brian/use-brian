// @vitest-environment jsdom
/**
 * [COMP:app-web/visual-lightbox] Double-click → full-screen zoomable preview.
 *
 * Driven for real in jsdom (`createRoot` + `act`, no `@testing-library/react`,
 * matching the rest of app-web). The base-ui `Dialog` portals to
 * `document.body`, so the preview surface is asserted against the document, not
 * the mount node. Covered:
 *   1. inline render + the hover "expand" affordance (correct aria),
 *   2. closed at rest; double-click on the visual opens the preview,
 *   3. the zoom toolbar steps the percentage readout (100% → 125%),
 *   4. the close button dismisses the preview.
 */

import { describe, expect, it, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { ZoomableVisual } from "../visual-lightbox";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const L = en.docPage.lightbox;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(ui: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <I18nProvider locale="en" dict={en as Dictionary}>
        {ui}
      </I18nProvider>,
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function click(el: Element | null) {
  if (!el) throw new Error("element not found");
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** The preview is open iff its close button (only inside the Popup) is present. */
function previewOpen(): boolean {
  return !!document.querySelector(`[aria-label="${L.close}"]`);
}

describe("[COMP:app-web/visual-lightbox] Visual lightbox", () => {
  it("renders the visual inline with a hover expand affordance", () => {
    mount(
      <ZoomableVisual>
        <svg data-testid="viz" />
      </ZoomableVisual>,
    );
    expect(container!.querySelector('[data-testid="viz"]')).toBeTruthy();
    const expand = container!.querySelector(`[aria-label="${L.open}"]`);
    expect(expand).toBeTruthy();
    // Closed at rest.
    expect(previewOpen()).toBe(false);
  });

  it("opens the preview on double-click and closes via the close button", () => {
    mount(
      <ZoomableVisual>
        <svg data-testid="viz" />
      </ZoomableVisual>,
    );
    const target = container!.querySelector('[data-testid="viz"]')!.parentElement!;
    act(() => {
      target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(previewOpen()).toBe(true);

    click(document.querySelector(`[aria-label="${L.close}"]`));
    expect(previewOpen()).toBe(false);
  });

  it("opens via the expand button and steps the zoom readout", () => {
    mount(
      <ZoomableVisual>
        <svg data-testid="viz" />
      </ZoomableVisual>,
    );
    // The first matching expand button is the inline affordance.
    click(container!.querySelector(`[aria-label="${L.open}"]`));
    expect(previewOpen()).toBe(true);

    const readout = () =>
      document.querySelector(`[aria-label="${L.reset}"]`)?.textContent?.trim();
    expect(readout()).toBe("100%");

    click(document.querySelector(`[aria-label="${L.zoomIn}"]`));
    expect(readout()).toBe("125%");

    click(document.querySelector(`[aria-label="${L.zoomOut}"]`));
    expect(readout()).toBe("100%");
  });
});
