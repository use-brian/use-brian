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

  async function mount(options: { role?: "view" | "edit"; expiresAt?: string; onCommand?: (command: unknown) => Promise<void> } = {}) {
    const snapshot = fixture();
    const onCommand = vi.fn(options.onCommand ?? (async () => undefined));
    await act(async () => root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><PdfEditor workspaceId={snapshot.workspaceId} snapshot={snapshot} seq={2} baseVersion={1} artifactVersion={1} expiresAt={options.expiresAt ?? "2099-01-01T00:00:00.000Z"} role={options.role ?? "edit"} onCommand={onCommand} onReadback={vi.fn(async () => undefined)} onSelectTargets={vi.fn()} /></I18nProvider>));
    return { onCommand };
  }

  async function openPhoneSheet(name: "pages" | "fields") {
    const actions = host.querySelector(`[aria-label="${en.office.pdf.mobileActions}"]`)!;
    const trigger = [...actions.querySelectorAll("button")].find(button => name === "fields" ? button.textContent === en.office.pdf.fields : button.textContent === "1/2");
    expect(trigger).toBeDefined();
    await act(async () => trigger!.click());
    return host.querySelector(`[data-pdf-phone-sheet="${name}"]`)!;
  }

  function sheetAction(sheet: Element, label: string) {
    const action = [...sheet.querySelectorAll("button")].find(button => button.textContent === label);
    expect(action).toBeDefined();
    return action!;
  }

  it.each(["pages", "fields"] as const)("inserts canonical dates and checkmarks from the phone %s sheet", async name => {
    const { onCommand } = await mount();
    const sheet = await openPhoneSheet(name);
    for (const [label, kind] of [[en.office.pdf.addDate, "date"], [en.office.pdf.addCheckmark, "checkmark"]] as const) {
      await act(async () => sheetAction(sheet, label).click());
      expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "addPdfOverlay", pageId: id(10), overlay: expect.objectContaining({ kind }) }));
    }
    expect(onCommand).toHaveBeenCalledTimes(2);
  });

  it.each(["view", "expired"] as const)("keeps phone insertion disabled for %s sessions", async state => {
    const { onCommand } = await mount(state === "view" ? { role: "view" } : { expiresAt: "2000-01-01T00:00:00.000Z" });
    const sheet = await openPhoneSheet("fields");
    for (const label of [en.office.pdf.addDate, en.office.pdf.addCheckmark]) {
      const action = sheetAction(sheet, label);
      expect(action.disabled).toBe(true);
      await act(async () => action.click());
    }
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("prevents a second phone insertion while its command is pending", async () => {
    let finish!: () => void;
    const { onCommand } = await mount({ onCommand: () => new Promise(resolve => { finish = resolve; }) });
    const sheet = await openPhoneSheet("fields");
    await act(async () => sheetAction(sheet, en.office.pdf.addDate).click());
    const checkmark = sheetAction(sheet, en.office.pdf.addCheckmark);
    expect(checkmark.disabled).toBe(true);
    await act(async () => checkmark.click());
    expect(onCommand).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(checkmark.disabled).toBe(false);
  });

  it("keeps the phone expiry countdown available before a sheet opens and marks expiry", async () => {
    vi.useFakeTimers();
    try {
      await mount({ expiresAt: new Date(Date.now() + 1_000).toISOString() });
      const expiry = host.querySelector("[data-pdf-phone-expiry]")!;
      expect(expiry).not.toBeNull();
      expect(expiry.textContent).toBe(en.office.pdf.expiresIn.replace("{time}", "0:00:01"));
      await act(async () => vi.advanceTimersByTime(1_000));
      expect(expiry.textContent).toBe(en.office.pdf.expired);
      const sheet = await openPhoneSheet("fields");
      expect(sheetAction(sheet, en.office.pdf.addDate).disabled).toBe(true);
    } finally { vi.useRealTimers(); }
  });

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
