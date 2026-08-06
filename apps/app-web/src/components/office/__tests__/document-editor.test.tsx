import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { DocumentEditor } from "../document-editor";
import { documentFixture } from "./editor-fixtures";
import { officeCapabilityManifest } from "@use-brian/office-model";

const coveredCapabilities = ["richText", "hyperlink", "table", "image", "chart", "video", "namedStyles", "heading", "nestedList", "pageSetup", "pageBreak", "sectionBreak", "headerFooter", "pageNumber"].sort();
describe("[COMP:app-web/office-document-editor] Document editor", () => {
  it("renders every admitted document object through the canonical editor", () => {
    const html = renderToStaticMarkup(<I18nProvider locale="en" dict={en as unknown as Dictionary}><DocumentEditor snapshot={documentFixture()} baseVersion={1} role="edit" suggestMode={false} onCommand={vi.fn()} /></I18nProvider>);
    for (const text of ["Summary", "Body copy", "Item", "Cell", "Chart image", "Revenue", "Demo", en.office.pageBreak, en.office.sectionBreak]) expect(html).toContain(text);
    expect(html).toContain('data-office-editor="document"');
    expect(html).toContain('data-office-document-scroll="true"');
    expect(html).toContain('min-h-0 flex-1 overflow-auto');
    expect(html).toContain('data-office-text-input="true"');
    expect(html).toContain('[field-sizing:content]');
    expect(html).toContain(`data-office-document-table="${documentFixture().sections[0].nodes[3].id}"`);
    expect(html).toContain('data-office-table-cell="00000000-0000-4000-8000-000000000019"');
    expect(html).toContain('colSpan="2"');
    expect(html).toContain('width:80px');
    expect(html).toContain('background-color:#131A24');
    expect(html).toContain('border-bottom:1.125px solid #34D3FF');
    expect(html).toContain('font-family:Courier New');
    expect(html).toContain('font-size:7.5pt');
    expect(html).toContain('color:#34D3FF');
  });

  it("keeps an explicit editor fixture for every editable Document capability", () => {
    const expected = officeCapabilityManifest.capabilities.filter((capability) => capability.disposition === "editable" && (capability.family === "shared" || capability.family === "document")).map((capability) => capability.id).sort();
    expect(coveredCapabilities).toEqual(expected);
  });
});
