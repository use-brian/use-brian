import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { nextPresentationSlideIndex, PresentationPresenter } from "../presentation-presenter";
import { presentationFixture } from "./editor-fixtures";

describe("[COMP:app-web/office-presentation-editor] Presentation presenter", () => {
  it("renders the canonical slide in an in-browser modal with visible controls", () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en" dict={en as unknown as Dictionary}>
        <PresentationPresenter snapshot={presentationFixture()} onClose={vi.fn()} />
      </I18nProvider>,
    );
    expect(html).toContain('data-office-presenter="true"');
    expect(html).toContain('data-presentation-slide-visual="true"');
    expect(html).toContain('viewBox="0 0 960 540"');
    expect(html).toContain('font-size:12px');
    expect(html).toContain('aria-label="Exit presentation"');
    expect(html).not.toContain("blob:");
  });

  it("bounds keyboard navigation to the available slides", () => {
    expect(nextPresentationSlideIndex(0, "ArrowLeft", 3)).toBe(0);
    expect(nextPresentationSlideIndex(0, "ArrowRight", 3)).toBe(1);
    expect(nextPresentationSlideIndex(1, "End", 3)).toBe(2);
    expect(nextPresentationSlideIndex(2, "PageDown", 3)).toBe(2);
    expect(nextPresentationSlideIndex(2, "Home", 3)).toBe(0);
  });
});
