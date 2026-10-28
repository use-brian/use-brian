// @vitest-environment jsdom
import { act, StrictMode } from "react";
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
const pdf = vi.hoisted(() => ({ getDocument: vi.fn() }));

vi.mock("@/lib/office/api", () => api);
vi.mock("@/lib/user", () => ({ getUserInfo: () => ({ id: "00000000-0000-4000-8000-000000000003" }) }));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: pdf.getDocument,
}));
vi.mock("../pdf/page-canvas", () => ({ PdfPageCanvas: ({ sourcePageIndex, document }: { sourcePageIndex: number; document: { testId: string } }) => <div data-test-pdf-canvas={sourcePageIndex} data-test-document={document.testId} /> }));

import { PdfEditor } from "../pdf-editor";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const id = (ordinal: number) => `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
const source = () => ({ bytes: new ArrayBuffer(8), validForMs: 30_000 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function loadingTask(testId: string) {
  const document = { testId, destroy: vi.fn(async () => undefined) };
  const pending = deferred<typeof document>();
  return { document, pending, task: { promise: pending.promise, destroy: vi.fn(async () => { await document.destroy(); }) } };
}

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
    api.readOfficePdfSource.mockReset().mockResolvedValue(source());
    pdf.getDocument.mockReset().mockImplementation(() => {
      const load = loadingTask("default"); load.pending.resolve(load.document); return load.task;
    });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    let next = 100;
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => id(next++)) });
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  async function mount(options: { role?: "view" | "edit"; expiresAt?: string; onCommand?: (command: unknown) => Promise<void>; snapshot?: PdfSnapshot; strict?: boolean } = {}) {
    const snapshot = options.snapshot ?? fixture();
    const onCommand = vi.fn(options.onCommand ?? (async () => undefined));
    const editor = <I18nProvider locale="en" dict={en as unknown as Dictionary}><PdfEditor workspaceId={snapshot.workspaceId} snapshot={snapshot} seq={2} baseVersion={1} artifactVersion={1} expiresAt={options.expiresAt ?? "2099-01-01T00:00:00.000Z"} role={options.role ?? "edit"} onCommand={onCommand} onReadback={vi.fn(async () => undefined)} onSelectTargets={vi.fn()} /></I18nProvider>;
    await act(async () => root.render(options.strict ? <StrictMode>{editor}</StrictMode> : editor));
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

  it.each(["focus", "visibility"] as const)("starts every %s refresh while source is still loading", async event => {
    vi.useFakeTimers();
    api.readOfficePdfSource.mockImplementation(() => new Promise(() => {}));
    await mount();
    for (let attempt = 2; attempt <= 3; attempt++) {
      await act(async () => {
        if (event === "focus") window.dispatchEvent(new Event("focus"));
        else {
          Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
          document.dispatchEvent(new Event("visibilitychange"));
        }
      });
      expect(api.readOfficePdfSource).toHaveBeenCalledTimes(attempt);
    }
  });

  it("ignores the cleaned-up StrictMode source read and leaves one renewal owner", async () => {
    vi.useFakeTimers();
    const obsolete = deferred<ReturnType<typeof source>>();
    api.readOfficePdfSource.mockReturnValueOnce(obsolete.promise);
    await mount({ strict: true });
    expect(api.readOfficePdfSource).toHaveBeenCalledTimes(2);
    expect(pdf.getDocument).toHaveBeenCalledTimes(1);
    await act(async () => obsolete.resolve(source()));
    expect(pdf.getDocument).toHaveBeenCalledTimes(1);
    api.readOfficePdfSource.mockImplementation(() => new Promise(() => {}));
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(api.readOfficePdfSource).toHaveBeenCalledTimes(3);
    expect(host.querySelector("[data-test-pdf-canvas]")).toBeNull();
  });

  it("does not publish an old artifact after its replacement becomes ready", async () => {
    const obsolete = deferred<ReturnType<typeof source>>();
    api.readOfficePdfSource.mockReturnValueOnce(obsolete.promise);
    await mount();
    await mount({ snapshot: { ...fixture(), artifactId: id(900) } });
    expect(host.querySelector("[data-test-document=default]")).not.toBeNull();
    await act(async () => obsolete.resolve(source()));
    expect(pdf.getDocument).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-test-document=default]")).not.toBeNull();
  });

  it("disposes a pending PDF.js task and ignores its late document after refresh", async () => {
    const obsolete = loadingTask("obsolete");
    pdf.getDocument.mockReturnValueOnce(obsolete.task);
    await mount();
    expect(host.querySelector("[data-test-pdf-canvas]")).toBeNull();
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(obsolete.task.destroy).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-test-document=default]")).not.toBeNull();
    await act(async () => obsolete.pending.resolve(obsolete.document));
    expect(host.querySelector("[data-test-document=obsolete]")).toBeNull();
    expect(host.querySelector("[data-test-document=default]")).not.toBeNull();
  });

  it("does not start PDF.js or renew after its pending source owner unmounts", async () => {
    vi.useFakeTimers();
    const obsolete = deferred<ReturnType<typeof source>>();
    api.readOfficePdfSource.mockReturnValueOnce(obsolete.promise);
    await mount();
    await act(async () => root.render(null));
    await act(async () => obsolete.resolve(source()));
    await act(async () => vi.advanceTimersByTimeAsync(31_000));
    expect(pdf.getDocument).not.toHaveBeenCalled();
    expect(api.readOfficePdfSource).toHaveBeenCalledTimes(1);
  });

  it("disposes a PDF.js task when its editor unmounts before parsing completes", async () => {
    vi.useFakeTimers();
    const obsolete = loadingTask("unmounted");
    pdf.getDocument.mockReturnValueOnce(obsolete.task);
    await mount();
    await act(async () => root.render(null));
    expect(obsolete.task.destroy).toHaveBeenCalledTimes(1);
    await act(async () => obsolete.pending.resolve(obsolete.document));
    await act(async () => vi.advanceTimersByTimeAsync(31_000));
    expect(host.querySelector("[data-test-pdf-canvas]")).toBeNull();
    expect(api.readOfficePdfSource).toHaveBeenCalledTimes(1);
  });

  it("clears a ready artifact while its replacement source is pending", async () => {
    await mount();
    const task = pdf.getDocument.mock.results[0].value;
    api.readOfficePdfSource.mockImplementation(() => new Promise(() => {}));
    await mount({ snapshot: { ...fixture(), artifactId: id(900) } });
    expect(task.destroy).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-test-pdf-canvas]")).toBeNull();
    expect(host.querySelector(`[aria-label="${en.office.pdf.sourceLoading}"]`)).not.toBeNull();
  });

  it("keeps the latest refusal when an obsolete PDF.js task completes", async () => {
    const obsolete = loadingTask("obsolete");
    pdf.getDocument.mockReturnValueOnce(obsolete.task);
    await mount();
    api.readOfficePdfSource.mockRejectedValue(new Error("current refusal"));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(host.querySelector(`[aria-label="${en.office.pdf.sourceFailed}"]`)).not.toBeNull();
    await act(async () => obsolete.pending.resolve(obsolete.document));
    expect(host.querySelector("[data-test-pdf-canvas]")).toBeNull();
    expect(host.querySelector(`[aria-label="${en.office.pdf.sourceFailed}"]`)).not.toBeNull();
  });

  it("keeps the latest successful document when an obsolete read rejects", async () => {
    const obsolete = deferred<ReturnType<typeof source>>();
    api.readOfficePdfSource.mockReturnValueOnce(obsolete.promise);
    await mount();
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(host.querySelector("[data-test-document=default]")).not.toBeNull();
    await act(async () => obsolete.reject(new Error("obsolete refusal")));
    expect(host.querySelector("[data-test-document=default]")).not.toBeNull();
    expect(host.querySelector(`[aria-label="${en.office.pdf.sourceFailed}"]`)).toBeNull();
  });

  it("purges a ready document on lease renewal and preserves denial", async () => {
    vi.useFakeTimers();
    api.readOfficePdfSource.mockResolvedValueOnce({ ...source(), validForMs: 500 });
    await mount();
    expect(host.querySelector("[data-test-pdf-canvas]")).not.toBeNull();
    api.readOfficePdfSource.mockRejectedValue(new Error("source unavailable"));
    await act(async () => vi.advanceTimersByTimeAsync(501));
    expect(api.readOfficePdfSource).toHaveBeenCalledTimes(2);
    expect(host.querySelector("[data-test-pdf-canvas]")).toBeNull();
    expect(host.querySelector(`[aria-label="${en.office.pdf.sourceFailed}"]`)).not.toBeNull();
  });

  it("expires a source lease while PDF.js is pending and cannot resurrect that task", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    const obsolete = loadingTask("expired");
    pdf.getDocument.mockReturnValueOnce(obsolete.task);
    api.readOfficePdfSource.mockResolvedValueOnce({ ...source(), validForMs: 500 });
    await mount();
    api.readOfficePdfSource.mockImplementation(() => new Promise(() => {}));
    await act(async () => vi.advanceTimersByTimeAsync(501));
    expect(api.readOfficePdfSource).toHaveBeenCalledTimes(2);
    expect(obsolete.task.destroy).toHaveBeenCalledTimes(1);
    await act(async () => obsolete.pending.resolve(obsolete.document));
    expect(host.querySelector("[data-test-document=expired]")).toBeNull();
  });

  it("maps rotated overlay geometry and pointer deltas in the canonical point plane", () => {
    const page = fixture().pages[0];
    expect(pdfRectToCss(page, { x: 60, y: 80, width: 120, height: 160 })).toEqual({ left: 0.1, top: 0.7, width: 0.2, height: 0.2 });
    expect(cssDeltaToPdf(page, 60, 80, 600, 800)).toEqual({ x: 60, y: -80 });
    expect(pdfRectToCss({ ...page, rotation: 90 }, { x: 60, y: 80, width: 120, height: 160 })).toEqual({ left: 0.1, top: 0.1, width: 0.2, height: 0.2 });
  });
});
