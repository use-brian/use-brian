// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { DocumentEditor } from "../document-editor";
import { DOCUMENT_EDITOR_ACTIONS } from "../document/editor-actions";
import { documentPageStartIds } from "../document/pagination-decorations";
import { documentFixture } from "./editor-fixtures";
import { documentSnapshotToEditorJson, officeCapabilityManifest, snapshotToYDoc } from "@use-brian/office-model";

vi.mock("@/lib/office/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/office/api")>("@/lib/office/api");
  return { ...actual, getOfficeResourceObjectUrl: vi.fn().mockResolvedValue("blob:office-header-image") };
});

const coveredCapabilities = ["richText", "hyperlink", "table", "image", "chart", "video", "namedStyles", "heading", "nestedList", "pageSetup", "pageBreak", "sectionBreak", "headerFooter", "pageNumber"].sort();

describe("[COMP:app-web/office-document-editor] Document editor", () => {
  it("renders every admitted document object through the one structured editor", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const doc = snapshotToYDoc(documentFixture());
    act(() => root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><DocumentEditor snapshot={documentFixture()} baseVersion={1} role="edit" suggestMode={false} doc={doc} synced onCommand={vi.fn()} /></I18nProvider>));
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 10)); });
    const html = container.innerHTML;
    for (const text of ["Summary", "Body copy", "Item", "Cell", "Revenue", "Second header", "Second section body"]) expect(html).toContain(text);
    expect(html).toContain('data-office-editor="document"');
    expect(html).toContain('data-office-structured-editor="true"');
    expect(html).toContain('data-office-document-scroll="true"');
    expect(html).toContain('data-office-document-stage="true"');
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

  it("places visual page starts at overflow and explicit break boundaries", () => {
    const starts = documentPageStartIds([
      { id: "first", heightPx: 70, spacingBeforePx: 0, breakAfter: false },
      { id: "overflow", heightPx: 40, spacingBeforePx: 8, breakAfter: false },
      { id: "break", heightPx: 0, spacingBeforePx: 8, breakAfter: true },
      { id: "after-break", heightPx: 20, spacingBeforePx: 8, breakAfter: false },
    ], 100);
    expect([...starts]).toEqual(["overflow", "after-break"]);
  });

  it("centers and separates printable pages without framing the editable canvas", () => {
    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../app/globals.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.office-document-stage\s*\{[^}]*min-width:\s*100%;[^}]*width:\s*max-content;/,
    );
    expect(css).toMatch(
      /\.office-document-prosemirror\s*\{[^}]*width:\s*100%;[^}]*align-items:\s*center;/,
    );
    expect(css).toMatch(
      /\.office-document-section\s*\{[^}]*border:\s*1px solid[^;]*;[^}]*box-shadow:\s*[^;]*,/,
    );
    expect(css).toMatch(
      /\.office-document-prosemirror:focus-visible[^{]*\{[^}]*outline:\s*none\s*!important;[^}]*box-shadow:\s*none\s*!important;/,
    );
    expect(css).toMatch(
      /\.office-document-page-start\s*\{[^}]*margin-top:\s*calc\(var\(--office-margin-bottom[^;]*var\(--office-margin-top[^;]*;/,
    );
    expect(css).toMatch(
      /\.office-document-page-start::before\s*\{[^}]*border-top:[^;]*;[^}]*border-bottom:[^;]*;[^}]*background:\s*var\(--muted\);[^}]*box-shadow:/,
    );
  });

  it("projects canonical header images through the ProseMirror-owned header view", async () => {
    const snapshot = documentFixture();
    snapshot.sections[0] = {
      ...snapshot.sections[0],
      headerImage: {
        resourceId: snapshot.resources[0].id,
        altText: "Fictional company icon",
        decorative: false,
        widthPt: 21,
        heightPt: 24,
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const doc = snapshotToYDoc(snapshot);
    act(() => root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><DocumentEditor snapshot={snapshot} baseVersion={1} role="edit" suggestMode={false} doc={doc} synced onCommand={vi.fn()} /></I18nProvider>));
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 10)); });

    const header = container.querySelector<HTMLElement>(".office-document-header");
    expect(header?.dataset.officeHeaderImage).toBe("true");
    expect(header?.style.getPropertyValue("--office-header-image-width")).toBe("21pt");
    expect(header?.style.getPropertyValue("--office-header-image-height")).toBe("24pt");
    expect(header?.style.backgroundImage).toContain("blob:office-header-image");
    expect(header?.getAttribute("role")).toBe("img");
    expect(header?.getAttribute("aria-label")).toBe("Fictional company icon");

    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../app/globals.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.office-document-header\[data-office-header-image="true"\]\s*\{[^}]*min-height:\s*max\(1\.5rem, var\(--office-header-image-height\)\);[^}]*padding-inline-start:\s*calc\(var\(--office-header-image-width\) \+ 8pt\);[^}]*background-size:/,
    );

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
