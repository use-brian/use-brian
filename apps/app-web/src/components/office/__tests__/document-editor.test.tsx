// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { DocumentEditor } from "../document-editor";
import { DOCUMENT_EDITOR_ACTIONS } from "../document/editor-actions";
import { documentFixture } from "./editor-fixtures";
import { documentSnapshotToEditorJson, officeCapabilityManifest, snapshotToYDoc } from "@use-brian/office-model";

const coveredCapabilities = ["richText", "hyperlink", "table", "image", "chart", "video", "namedStyles", "heading", "nestedList", "pageSetup", "pageBreak", "sectionBreak", "headerFooter", "pageNumber"].sort();

describe("[COMP:app-web/office-document-editor] Document editor", () => {
  it("renders every admitted document object through the one structured editor", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const doc = snapshotToYDoc(documentFixture());
    act(() => root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><DocumentEditor snapshot={documentFixture()} baseVersion={1} role="edit" suggestMode={false} doc={doc} synced onCommand={vi.fn()} /></I18nProvider>));
    const html = container.innerHTML;
    for (const text of ["Summary", "Body copy", "Item", "Cell", "Revenue", "Second header", "Second section body"]) expect(html).toContain(text);
    expect(html).toContain('data-office-editor="document"');
    expect(html).toContain('data-office-structured-editor="true"');
    expect(html).toContain('data-office-document-scroll="true"');
    expect(container.querySelector(".office-document-prosemirror")).not.toBeNull();
    expect(container.querySelectorAll(".office-document-section")).toHaveLength(2);
    expect(container.querySelector(".office-document-table")).not.toBeNull();
    expect(container.innerHTML).toContain("officeImage");
    expect(container.querySelector(".office-document-chart")).not.toBeNull();
    expect(container.querySelector(".office-document-video")).not.toBeNull();
    expect(container.querySelector('a[href="https://example.com/format"]')).not.toBeNull();
    const link = container.querySelector<HTMLElement>('a[href="https://example.com/format"]');
    expect(link?.style.textDecoration).toContain("underline");
    expect(link?.style.color).toBe("rgb(51, 102, 153)");
    act(() => root.unmount());
    doc.destroy();
    container.remove();
  });

  it("keeps an explicit editor JSON fixture for every admitted Document capability", () => {
    const editor = documentSnapshotToEditorJson(documentFixture());
    const serialized = JSON.stringify(editor);
    for (const type of ["paragraph", "heading", "officeList", "officeTable", "officeImage", "officeChart", "officeVideo", "officePageBreak", "officeSectionBreak"]) expect(serialized).toContain(`\"type\":\"${type}\"`);
    const expected = officeCapabilityManifest.capabilities.filter((capability) => capability.disposition === "editable" && (capability.family === "shared" || capability.family === "document")).map((capability) => capability.id).sort();
    expect(coveredCapabilities).toEqual(expected);
  });

  it("maps every manual Document capability to behavior-level editor actions", () => {
    const manual = officeCapabilityManifest.capabilities.filter((capability) => (capability.family === "document" || capability.family === "shared") && capability.browserAuthoring === "manual").map((capability) => capability.id).sort();
    expect(Object.keys(DOCUMENT_EDITOR_ACTIONS).sort()).toEqual(manual);
    for (const actions of Object.values(DOCUMENT_EDITOR_ACTIONS)) expect(actions.length).toBeGreaterThan(0);
  });
});
