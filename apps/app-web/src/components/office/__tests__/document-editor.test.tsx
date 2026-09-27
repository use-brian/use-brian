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
import { documentPageStartIds, measureDocumentPaginationBlocks } from "../document/pagination-decorations";
import { documentFixture } from "./editor-fixtures";
import { documentSnapshotToEditorJson, officeCapabilityManifest, snapshotToYDoc, yDocToSnapshot, getDocumentFragment } from "@use-brian/office-model";

vi.mock("@/lib/use-doc-media", () => ({
  useOfficeResourceMedia: () => ({url:"blob:office-header-image",error:null}),
}));

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

  it("measures collapsed margins once, including preceding bottom margins", () => {
    const body = document.createElement('main');
    body.innerHTML = '<p id="one" style="margin-bottom:30px"></p><p id="two" style="margin-top:20px"></p>';
    const children = [...body.children];
    vi.spyOn(children[0], 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 140, height: 40 } as DOMRect);
    vi.spyOn(children[1], 'getBoundingClientRect').mockReturnValue({ top: 170, bottom: 210, height: 40 } as DOMRect);
    const blocks = measureDocumentPaginationBlocks(body);
    expect(blocks.map(b => b.spacingBeforePx)).toEqual([0, 30]);
    expect([...documentPageStartIds(blocks, 105)]).toEqual(['two']);
    expect([...documentPageStartIds(blocks, 110)]).toEqual([]);
  });

  it("centers and separates printable pages without framing the editable canvas", () => {
    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../app/globals.css"),
      "utf8",
    );
    expect(css).not.toContain('grid-template-rows: minmax(2rem, auto)');
    expect(css).toContain('.office-document-body > * { margin-block: 0; }');
    const toolbar = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../document/document-toolbar.tsx'), 'utf8');
    expect(toolbar).toContain('hidden min-w-0 overflow-x-auto');
    const editorSource = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../document-editor.tsx'), 'utf8');
    expect(editorSource).toContain('relative flex min-h-0 min-w-0 flex-1');
    expect(editorSource).toContain('document.fonts?.addEventListener("loadingdone", refresh)');
    expect(editorSource).toContain('new ResizeObserver');
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
      /\.office-document-header\[data-office-header-image="true"\]\s*\{[^}]*min-height:\s*min\(var\(--office-margin-top, 72pt\), max\(1\.5rem, var\(--office-header-image-height\)\)\);[^}]*padding-inline-start:\s*calc\(var\(--office-header-image-width\) \+ 8pt\);[^}]*background-size:/,
    );

    act(() => root.unmount());
    doc.destroy();
    container.remove();
  });

  it.each([
    { width: 120, height: 180, margin: 24, expectedWidth: 16, expectedHeight: 24 },
    { width: 920, height: 20, margin: 72, expectedWidth: 458.5, expectedHeight: 458.5 / 920 * 20 },
    { width: 21, height: 24, margin: 72, expectedWidth: 21, expectedHeight: 24 },
    { width: 120, height: 180, margin: 0, expectedWidth: 0, expectedHeight: 0 },
  ])("bounds header display without changing canonical dimensions: $width x $height, margin $margin", async ({ width, height, margin, expectedWidth, expectedHeight }) => {
    const snapshot = documentFixture();
    snapshot.sections[0].page.marginTopPt = margin;
    snapshot.sections[0].headerImage = { resourceId: snapshot.resources[0].id, altText: 'Synthetic oversized header', decorative: false, widthPt: width, heightPt: height };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const doc = snapshotToYDoc(snapshot);
    act(() => root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><DocumentEditor snapshot={snapshot} baseVersion={1} role="edit" suggestMode={false} doc={doc} synced onCommand={vi.fn()} /></I18nProvider>));
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 10)); });
    const header = container.querySelector<HTMLElement>('.office-document-header')!;
    expect(parseFloat(header.style.getPropertyValue('--office-header-image-width'))).toBeCloseTo(expectedWidth);
    expect(parseFloat(header.style.getPropertyValue('--office-header-image-height'))).toBeCloseTo(expectedHeight);
    expect(yDocToSnapshot(doc)).toEqual(snapshot);
    if (height === 180 && margin === 24) {
      // A live page-margin edit recomputes only the projection, not the image.
      snapshot.sections[0].page.marginTopPt = 12;
      act(() => getDocumentFragment(doc).get(0).setAttribute('page', { ...snapshot.sections[0].page } as never));
      await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 10)); });
      expect(header.style.getPropertyValue('--office-header-image-width')).toBe('8pt');
      expect(header.style.getPropertyValue('--office-header-image-height')).toBe('12pt');
      expect(yDocToSnapshot(doc)).toEqual(snapshot);
    }
    const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../app/globals.css'), 'utf8');
    expect(css).toMatch(/\.office-document-header \{[^}]*max-height: var\(--office-margin-top, 72pt\);[^}]*overflow: hidden;/);
    act(() => root.unmount()); doc.destroy(); container.remove();
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
