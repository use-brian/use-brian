// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfSnapshot } from "@use-brian/office-model";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { cssDeltaToPdf, pdfRectToCss } from "../pdf/geometry";

const api = vi.hoisted(() => ({
  readOfficePdfSource: vi.fn(async () => ({ bytes: new ArrayBuffer(8), validForMs: 30_000 })),
  submitOfficeCommand: vi.fn(async () => ({ snapshot: {}, seq: 3, baseVersion: 1 })),
  releaseOfficeArtifact: vi.fn(),
  readOfficeReleasedFile: vi.fn(),
  saveOfficePdfToFiles: vi.fn(),
  uploadPdfSessionImage: vi.fn(),
  admitPdfSessionImage: vi.fn(),
}));

vi.mock("@/lib/office/api", () => api);
vi.mock("@/lib/user", () => ({ getUserInfo: () => ({ id: "00000000-0000-4000-8000-000000000003" }) }));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: () => ({ promise: Promise.resolve({ destroy: vi.fn(async () => undefined) }) }),
}));
vi.mock("../pdf/page-canvas", () => ({ PdfPageCanvas: ({ sourcePageIndex }: { sourcePageIndex: number }) => <div data-test-pdf-canvas={sourcePageIndex} /> }));

import { PdfEditor } from "../pdf-editor";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const id = (ordinal: number) => `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;

function fixture(): PdfSnapshot {
  return {
    schemaVersion: 1, capabilityVersion: 1, artifactId: id(1), workspaceId: id(2), locale: "en-US", defaultLanguage: "en-US",
    templateVersionId: null, rootId: id(4), title: "Fictional form", resources: [], accessibility: { title: "Fictional form" }, family: "pdf",
    source: { fileId: id(5), sha256: "a".repeat(64), byteLength: 100, originalFileName: "fictional-form.example.pdf", pageCount: 2 },
    pages: [0, 1].map((sourcePageIndex) => ({
      id: id(10 + sourcePageIndex), sourcePageIndex, mediaBox: { x: 0, y: 0, width: 600, height: 800 }, cropBox: { x: 0, y: 0, width: 600, height: 800 }, rotation: 0 as const,
      fields: sourcePageIndex === 0 ? [{ id: id(20), originalName: "customer", label: "Customer", kind: "text" as const, readOnly: false, required: false, value: null, widgets: [{ id: id(21), pageId: id(10), rect: { x: 40, y: 700, width: 180, height: 24 } }] }] : [],
      overlays: [], placementTargets: [],
    })),
  };
}

describe("[COMP:app-web/office-pdf-editor] protected responsive PDF editor", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    api.readOfficePdfSource.mockClear();
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    let next = 100;
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => id(next++)) });
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

  async function mount() {
    const snapshot = fixture();
    const onCommand = vi.fn(async () => undefined);
    await act(async () => root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><PdfEditor workspaceId={snapshot.workspaceId} snapshot={snapshot} seq={2} baseVersion={1} artifactVersion={1} expiresAt="2099-01-01T00:00:00.000Z" role="edit" onCommand={onCommand} onReadback={vi.fn(async () => undefined)} onSelectTargets={vi.fn()} /></I18nProvider>));
    return { onCommand };
  }

  it("renders one selected page, desktop rails, phone actions, and canonical add commands", async () => {
    const { onCommand } = await mount();
    expect(host.querySelector("[data-pdf-editor]")?.getAttribute("data-phone-single-page")).toBe("true");
    expect(host.querySelectorAll("[data-pdf-selected-page]")).toHaveLength(1);
    expect(host.textContent).toContain(en.office.pdf.fields);
    const addText = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(en.office.pdf.addText)) as HTMLButtonElement;
    await act(async () => addText.click());
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ kind: "addPdfOverlay", pageId: id(10), overlay: expect.objectContaining({ kind: "text" }) }));
  });

  it("purges and refetches protected source bytes when the window regains focus", async () => {
    await mount();
    expect(api.readOfficePdfSource).toHaveBeenCalledTimes(1);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(api.readOfficePdfSource).toHaveBeenCalledTimes(2);
  });

  it("maps rotated overlay geometry and pointer deltas in the canonical point plane", () => {
    const page = fixture().pages[0];
    expect(pdfRectToCss(page, { x: 60, y: 80, width: 120, height: 160 })).toEqual({ left: 0.1, top: 0.7, width: 0.2, height: 0.2 });
    expect(cssDeltaToPdf(page, 60, 80, 600, 800)).toEqual({ x: 60, y: -80 });
    expect(pdfRectToCss({ ...page, rotation: 90 }, { x: 60, y: 80, width: 120, height: 160 })).toEqual({ left: 0.1, top: 0.1, width: 0.2, height: 0.2 });
  });
});
