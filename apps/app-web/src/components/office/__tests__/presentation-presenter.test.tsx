import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { formatPresentationElapsed, nextPresentationSlideIndex, PRESENTATION_AUTO_ADVANCE_SECONDS, PresentationPresenter } from "../presentation-presenter";
import { presentationFixture } from "./editor-fixtures";
import { formattedPresentationSnapshot } from "../../../../../../packages/core/src/office/__tests__/fixtures";

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

  it("projects the shared formatted insertion fixture in browser Present mode", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><PresentationPresenter snapshot={formattedPresentationSnapshot()} onClose={vi.fn()} /></I18nProvider>);
    expect(html).toContain("A dependable pitch");
    expect(html).toContain("Edited metric");
    expect(html).toContain("Edited growth");
    expect(html).toContain("#ABCDEF");
    expect(html).toContain("#123456");
  });

  it("bounds keyboard navigation to the available slides", () => {
    expect(nextPresentationSlideIndex(0, "ArrowLeft", 3)).toBe(0);
    expect(nextPresentationSlideIndex(0, "ArrowRight", 3)).toBe(1);
    expect(nextPresentationSlideIndex(1, "End", 3)).toBe(2);
    expect(nextPresentationSlideIndex(2, "PageDown", 3)).toBe(2);
    expect(nextPresentationSlideIndex(2, "Home", 3)).toBe(0);
  });

  it("formats the elapsed wall clock without truncating hours", () => {
    expect(formatPresentationElapsed(65)).toBe("1:05");
    expect(formatPresentationElapsed(3_661)).toBe("1:01:01");
  });

  it("exposes notes, slide picker, auto-advance, laser, fullscreen, and timer controls", () => {
    expect(PRESENTATION_AUTO_ADVANCE_SECONDS).toEqual([5, 10, 15, 30]);
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><PresentationPresenter snapshot={presentationFixture()} onClose={vi.fn()} /></I18nProvider>);
    expect(html).toContain('aria-label="Choose slide"');
    expect(html).toContain('aria-label="Auto-advance"');
    expect(html).toContain("Laser pointer");
    expect(html).toContain("Fullscreen");
    expect(html).toContain("Speaker notes");
    expect(html).toContain(">Notes<");
    expect(html).toContain('data-reduced-motion="false"');
  });
});
