// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OfficeCommand } from "@use-brian/office-model";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { clearPresentationClipboardForTest } from "@/lib/office/presentation-clipboard";
import { admitOfficeImageResource } from "@/lib/office/api";
import { PresentationEditor } from "../presentation-editor";
import { presentationFixture } from "./editor-fixtures";

vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock("@/lib/office/api", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/office/api")>(), admitOfficeImageResource: vi.fn() }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("[COMP:app-web/office-presentation-editor] Presentation interaction loops", () => {
  let host: HTMLDivElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    clearPresentationClipboardForTest();
    let nextId = 500;
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => `10000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`) });
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
  });
  afterEach(() => { host.remove(); vi.unstubAllGlobals(); });

  function mount(snapshot = presentationFixture()) {
    snapshot.resources = [];
    snapshot.slides[0].objects = snapshot.slides[0].objects.slice(0, 3);
    snapshot.slides[0].readingOrder = snapshot.slides[0].objects.map((object) => object.id);
    const onCommand = vi.fn<(command: OfficeCommand) => void>();
    const onSelectTargets = vi.fn<(ids: string[]) => void>();
    const root = createRoot(host);
    act(() => root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><PresentationEditor snapshot={snapshot} baseVersion={1} role="edit" suggestMode={false} onCommand={onCommand} onSelectTargets={onSelectTargets} /></I18nProvider>));
    return { root, onCommand, onSelectTargets };
  }

  function enter(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("shift-selects exact object targets and deletes them in one batch", () => {
    const snapshot = presentationFixture();
    const { onCommand, onSelectTargets } = mount(snapshot);
    const frames = [...host.querySelectorAll<HTMLElement>("[data-slide-object]")];
    act(() => frames[0].dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => frames[1].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    expect(onSelectTargets).toHaveBeenLastCalledWith([snapshot.slides[0].objects[0].id, snapshot.slides[0].objects[1].id]);
    act(() => frames[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true })));
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "batch", commands: [expect.objectContaining({ kind: "deleteObject" }), expect.objectContaining({ kind: "deleteObject" })] }));
  });

  it("selects every unlocked object with Mod+A while editor focus is owned", () => {
    const snapshot = presentationFixture();
    snapshot.slides[0].objects[1].locked = true;
    const { onSelectTargets } = mount(snapshot);
    const frame = host.querySelector<HTMLElement>("[data-slide-object]")!;
    frame.focus();
    act(() => frame.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true })));
    expect(onSelectTargets).toHaveBeenLastCalledWith(snapshot.slides[0].objects.filter((object) => !object.locked).map((object) => object.id));
  });

  it("duplicates a deeply remapped slide with Mod+D", () => {
    const snapshot = presentationFixture();
    const { onCommand } = mount(snapshot);
    const frame = host.querySelector<HTMLElement>("[data-slide-object]")!;
    frame.focus();
    act(() => frame.dispatchEvent(new KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true, cancelable: true })));
    const command = onCommand.mock.lastCall?.[0];
    expect(command).toMatchObject({ kind: "addSlide", index: 1 });
    if (!command || command.kind !== "addSlide") throw new Error("duplicate command drift");
    expect(command.slide.id).not.toBe(snapshot.slides[0].id);
    expect(command.slide.objects[0].id).not.toBe(snapshot.slides[0].objects[0].id);
  });

  it("confirms slide deletion, protects the final slide, and selects the nearest survivor", async () => {
    const oneSlide = presentationFixture();
    const first = mount(oneSlide);
    expect(host.querySelector<HTMLButtonElement>(`button[aria-label="${en.office.deleteSlide}"]`)?.disabled).toBe(true);
    expect(first.onCommand).not.toHaveBeenCalled();
    act(() => first.root.unmount());

    const snapshot = presentationFixture();
    snapshot.slides.push({ ...structuredClone(snapshot.slides[0]), id: crypto.randomUUID(), title: "Second" });
    const { onCommand, onSelectTargets } = mount(snapshot);
    const deleteButton = host.querySelector<HTMLButtonElement>(`button[aria-label="${en.office.deleteSlide}"]`)!;
    await act(async () => { deleteButton.click(); await Promise.resolve(); });
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "deleteSlide", slideId: snapshot.slides[0].id }));
    expect(onSelectTargets).toHaveBeenLastCalledWith([snapshot.slides[1].id]);
  });

  it("copies and pastes selected objects through one atomic batch", async () => {
    const snapshot = presentationFixture();
    const { onCommand } = mount(snapshot);
    const frames = [...host.querySelectorAll<HTMLElement>("[data-slide-object]")];
    act(() => frames[0].dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => frames[1].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    await act(async () => { frames[1].dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true })); await Promise.resolve(); });
    await act(async () => { frames[1].dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true })); await Promise.resolve(); });
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "batch", commands: [expect.objectContaining({ kind: "insertSlideObject" }), expect.objectContaining({ kind: "insertSlideObject" })] }));
  });

  it("nudges every selected object in one batch and refuses a partly locked mutation", () => {
    const snapshot = presentationFixture();
    const { onCommand } = mount(snapshot);
    const frames = [...host.querySelectorAll<HTMLElement>("[data-slide-object]")];
    act(() => frames[0].dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => frames[1].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    act(() => frames[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true, cancelable: true })));
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "batch", commands: [expect.objectContaining({ kind: "setObjectProperty" }), expect.objectContaining({ kind: "setObjectProperty" })] }));

    onCommand.mockClear();
    snapshot.slides[0].objects[1].locked = true;
    const secondHost = document.createElement("div");
    document.body.append(secondHost);
    const root = createRoot(secondHost);
    act(() => root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><PresentationEditor snapshot={snapshot} baseVersion={1} role="edit" suggestMode={false} onCommand={onCommand} /></I18nProvider>));
    const lockedFrames = [...secondHost.querySelectorAll<HTMLElement>("[data-slide-object]")];
    act(() => lockedFrames[0].dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => lockedFrames[1].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    act(() => lockedFrames[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true })));
    expect(onCommand).not.toHaveBeenCalled();
    act(() => root.unmount());
    secondHost.remove();
  });

  it("emits a single reorder command after pointer filmstrip drag", () => {
    const snapshot = presentationFixture();
    snapshot.slides.push({ ...structuredClone(snapshot.slides[0]), id: crypto.randomUUID(), title: "Second" });
    const { onCommand } = mount(snapshot);
    const thumbnails = [...host.querySelectorAll<HTMLElement>("[data-slide-thumbnail]")];
    const handle = thumbnails[0].querySelector("button")!;
    act(() => handle.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, button: 0, bubbles: true })));
    act(() => thumbnails[1].dispatchEvent(new PointerEvent("pointerover", { pointerId: 1, bubbles: true })));
    act(() => handle.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true })));
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "reorderSlide", slideId: snapshot.slides[0].id, index: 1 }));
  });

  it("leaves neighboring text input clipboard and delete shortcuts untouched", () => {
    const { onCommand } = mount();
    const adjacent = document.createElement("input");
    document.body.append(adjacent);
    act(() => adjacent.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true })));
    act(() => adjacent.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true })));
    expect(onCommand).not.toHaveBeenCalled();
    adjacent.remove();
  });

  it("inserts every canonical shape and connector through adaptive menus", () => {
    const { onCommand } = mount();
    const shapeButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(en.office.addShape))!;
    act(() => shapeButton.click());
    const triangle = [...document.body.querySelectorAll<HTMLElement>("[role='menuitem']")].find((item) => item.textContent === en.office.triangle)!;
    act(() => triangle.click());
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "insertSlideObject", object: expect.objectContaining({ kind: "shape", shape: "triangle" }) }));
    const connectorButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(en.office.addConnector))!;
    act(() => connectorButton.click());
    const elbow = [...document.body.querySelectorAll<HTMLElement>("[role='menuitem']")].find((item) => item.textContent === en.office.elbowConnector)!;
    act(() => elbow.click());
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "insertSlideObject", object: expect.objectContaining({ kind: "connector", connector: "elbow" }) }));
  });

  it("formats whole text runs in one atomic multi-object command", () => {
    const snapshot = presentationFixture();
    const { onCommand } = mount(snapshot);
    const frames = [...host.querySelectorAll<HTMLElement>("[data-slide-object]")];
    act(() => frames[0].dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => frames[1].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    const bold = host.querySelector<HTMLButtonElement>(`button[aria-label="${en.office.bold}"]`)!;
    act(() => bold.click());
    const command = onCommand.mock.lastCall?.[0];
    expect(command).toMatchObject({ kind: "batch" });
    if (!command || command.kind !== "batch") throw new Error("format batch required");
    expect(command.commands).toHaveLength(2);
    expect(command.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "setObjectProperty", targetId: snapshot.slides[0].objects[0].id, path: ["runs"] }),
      expect.objectContaining({ kind: "setObjectProperty", targetId: snapshot.slides[0].objects[1].id, path: ["text"] }),
    ]));
  });

  it("keeps mixed shape controls unset and applies canonical fill to all selected shapes", () => {
    const snapshot = presentationFixture();
    const secondShape = structuredClone(snapshot.slides[0].objects[1]);
    secondShape.id = "00000000-0000-4000-8000-000000000299";
    if (secondShape.kind !== "shape") throw new Error("shape fixture required");
    secondShape.fill = "#FF0000";
    snapshot.slides[0].objects[2] = secondShape;
    const { onCommand } = mount(snapshot);
    const frames = [...host.querySelectorAll<HTMLElement>("[data-slide-object]")];
    act(() => frames[1].dispatchEvent(new MouseEvent("click", { bubbles: true })));
    act(() => frames[2].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    const fill = host.querySelector<HTMLInputElement>(`input[aria-label="${en.office.fillColor}"]`)!;
    expect(fill.value).toBe("");
    act(() => enter(fill, "#123456"));
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "batch", commands: [expect.objectContaining({ path: ["fill"], value: "#123456" }), expect.objectContaining({ path: ["fill"], value: "#123456" })] }));
  });

  it("inserts a bounded table with stable row, cell, and run IDs from Apply", () => {
    const { onCommand } = mount();
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.includes(en.office.insertTable))!;
    act(() => button.click());
    const text = [...document.body.querySelectorAll<HTMLLabelElement>("label")].find((candidate) => candidate.textContent?.startsWith(en.office.tableData))!.querySelector<HTMLTextAreaElement>("textarea")!;
    act(() => enter(text, "Name\tValue\nARR\t42"));
    const apply = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === en.office.apply)!;
    act(() => apply.click());
    const command = onCommand.mock.lastCall?.[0];
    expect(command).toMatchObject({ kind: "insertSlideObject", object: { kind: "table", rows: [{ cells: [{ runs: [{ text: "Name" }] }, { runs: [{ text: "Value" }] }] }, { cells: [{ runs: [{ text: "ARR" }] }, { runs: [{ text: "42" }] }] }] } });
    if (!command || command.kind !== "insertSlideObject" || command.object.kind !== "table") throw new Error("table insertion required");
    expect(new Set([command.object.id, ...command.object.rows.flatMap((row) => [row.id, ...row.cells.flatMap((cell) => [cell.id, ...cell.runs.map((run) => run.id)])])]).size).toBe(11);
  });

  it("rejects invalid chart data and inserts a titled accessible chart after correction", () => {
    const { onCommand } = mount();
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.includes(en.office.insertChart))!;
    act(() => button.click());
    const labels = [...document.body.querySelectorAll<HTMLLabelElement>("label")];
    const field = (label: string) => labels.find((candidate) => candidate.textContent?.startsWith(label))!.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")!;
    act(() => enter(field(en.office.chartTitle), "Revenue"));
    act(() => enter(field(en.office.altText), "Revenue by quarter"));
    act(() => enter(field(en.office.chartData), "Category,ARR\nQ1,nope"));
    const apply = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === en.office.apply)!;
    act(() => apply.click());
    expect(document.body.querySelector("[role='alert']")?.textContent).toBeTruthy();
    expect(onCommand).not.toHaveBeenCalled();
    act(() => enter(field(en.office.chartData), "Category,ARR\nQ1,42"));
    act(() => apply.click());
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "insertSlideObject", object: expect.objectContaining({ kind: "chart", title: "Revenue", altText: "Revenue by quarter", categories: ["Q1"], series: [{ name: "ARR", values: [42] }] }) }));
  });

  it("cancels table insertion without emitting a command", () => {
    const { onCommand } = mount();
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.includes(en.office.insertTable))!;
    act(() => button.click());
    const cancel = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === en.office.cancelWorksheetAction)!;
    act(() => cancel.click());
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("admits an uploaded image then attaches and inserts it in one batch", async () => {
    vi.mocked(admitOfficeImageResource).mockResolvedValue({ resource: { id: "00000000-0000-4000-8000-000000000250", kind: "image", hash: "c".repeat(64), mime: "image/png", sensitivity: "internal" }, widthPx: 1200, heightPx: 600 });
    const { onCommand } = mount();
    const input = host.querySelector<HTMLInputElement>(`input[aria-label="${en.office.insertPresentationImage}"]`)!;
    const file = new File([new Uint8Array([137, 80, 78, 71])], "chart.png", { type: "image/png" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); await Promise.resolve(); });
    const command = onCommand.mock.lastCall?.[0];
    expect(command).toMatchObject({ kind: "batch", commands: [expect.objectContaining({ kind: "attachResource" }), expect.objectContaining({ kind: "insertSlideObject", object: expect.objectContaining({ kind: "image", resourceId: "00000000-0000-4000-8000-000000000250", decorative: true }) })] });
    if (!command || command.kind !== "batch" || command.commands[1].kind !== "insertSlideObject") throw new Error("image insertion batch required");
    expect(command.commands[1].object.geometry.widthPt / command.commands[1].object.geometry.heightPt).toBe(2);
  });

  it("edits accessibility and reading order without changing visual stacking", () => {
    const snapshot = presentationFixture();
    snapshot.slides[0].objects[2] = snapshot.slides[0].objects[3];
    snapshot.slides[0].readingOrder = snapshot.slides[0].objects.slice(0, 3).map((object) => object.id);
    const { onCommand } = mount(snapshot);
    const image = host.querySelectorAll<HTMLElement>("[data-slide-object]")[2];
    act(() => image.click());
    const alt = [...host.querySelectorAll<HTMLLabelElement>("label")].find((candidate) => candidate.textContent?.startsWith(en.office.altText))!.querySelector<HTMLInputElement>("input")!;
    act(() => enter(alt, "Accessible chart image"));
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "setObjectProperty", targetId: snapshot.slides[0].objects[2].id, path: ["altText"], value: "Accessible chart image" }));
    const earlier = [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === en.office.readingOrderEarlier)!;
    act(() => earlier.click());
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "setObjectProperty", targetId: snapshot.slides[0].id, path: ["readingOrder"], value: [snapshot.slides[0].objects[0].id, snapshot.slides[0].objects[2].id, snapshot.slides[0].objects[1].id] }));
  });

  it("cannot make an empty-alt image non-decorative and exposes reading-order boundary reasons", () => {
    const snapshot = presentationFixture();
    const image = structuredClone(snapshot.slides[0].objects[3]);
    if (image.kind !== "image") throw new Error("image fixture required");
    image.altText = "";
    image.decorative = true;
    snapshot.slides[0].objects = [image];
    snapshot.slides[0].readingOrder = [image.id];
    const { onCommand } = mount(snapshot);
    act(() => host.querySelector<HTMLElement>("[data-slide-object]")!.click());
    const decorative = host.querySelector<HTMLElement>(`[role="checkbox"][aria-label="${en.office.decorativeImage}"]`)!;
    act(() => decorative.click());
    expect(onCommand).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLInputElement>(`input[aria-label="${en.office.altText}"]`)).toBeNull();
    const readingButtons = [...host.querySelectorAll<HTMLButtonElement>("button")].filter((button) => [en.office.readingOrderEarlier, en.office.readingOrderLater].includes(button.textContent ?? ""));
    expect(readingButtons.map((button) => button.title)).toEqual([en.office.readingOrderFirst, en.office.readingOrderLast]);
  });
});
