// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OfficeCommand } from "@use-brian/office-model";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { clearPresentationClipboardForTest } from "@/lib/office/presentation-clipboard";
import { PresentationEditor } from "../presentation-editor";
import { presentationFixture } from "./editor-fixtures";

vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: vi.fn(async () => true) }));

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
});
