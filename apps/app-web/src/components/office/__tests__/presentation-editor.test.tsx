import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { PresentationEditor } from "../presentation-editor";
import { presentationFixture } from "./editor-fixtures";
describe("[COMP:app-web/office-presentation-editor] Presentation editor", () => {
  it("renders the slide rail, every admitted object, notes and numeric inspector", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><PresentationEditor snapshot={presentationFixture()} baseVersion={1} role="edit" suggestMode={false} onCommand={vi.fn()} /></I18nProvider>);
    for (const text of ["Slide", "Title", "Shape", en.office.connector, "Image", "Revenue", "Cell", en.office.video, "Notes", en.office.properties]) expect(html).toContain(text);
    expect(html).toContain('data-office-editor="presentation"');
  });
});
