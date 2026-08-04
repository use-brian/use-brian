import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { DocumentEditor } from "../document-editor";
import { documentFixture } from "./editor-fixtures";
describe("[COMP:app-web/office-document-editor] Document editor", () => {
  it("renders every admitted document object through the canonical editor", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><DocumentEditor snapshot={documentFixture()} baseVersion={1} role="edit" suggestMode={false} onCommand={vi.fn()} /></I18nProvider>);
    for (const text of ["Summary", "Body copy", "Item", "Cell", "Chart image", "Revenue", "Demo", en.office.pageBreak, en.office.sectionBreak]) expect(html).toContain(text);
    expect(html).toContain('data-office-editor="document"');
  });
});
