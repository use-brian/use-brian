// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OfficeCommand } from "@use-brian/office-model";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { PresentationEditor } from "../presentation-editor";
import { presentationFixture } from "./editor-fixtures";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("[COMP:app-web/office-presentation-editor] Presentation formatting and insertion", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); let next = 700; vi.stubGlobal("crypto", { randomUUID: vi.fn(() => `10000000-0000-4000-8000-${String(next++).padStart(12, "0")}`) }); });
  afterEach(() => { if (root) act(() => root?.unmount()); root = null; host.remove(); vi.unstubAllGlobals(); });

  function mount() {
    const onCommand = vi.fn<(command: OfficeCommand) => void>();
    const nextRoot = createRoot(host);
    root = nextRoot;
    act(() => nextRoot.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><PresentationEditor snapshot={presentationFixture()} baseVersion={1} role="edit" suggestMode={false} onCommand={onCommand} /></I18nProvider>));
    return onCommand;
  }

  it("applies whole-run formatting with one canonical command", () => {
    const onCommand = mount();
    const frame = host.querySelector<HTMLElement>("[data-slide-object]")!;
    act(() => frame.click());
    const bold = host.querySelector<HTMLButtonElement>(`button[aria-label="${en.office.bold}"]`)!;
    act(() => bold.click());
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "setObjectProperty", path: ["runs"], value: [expect.objectContaining({ style: expect.objectContaining({ bold: true }) })] }));
  });

  it("opens bounded table data and Cancel emits no mutation", () => {
    const onCommand = mount();
    const table = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(en.office.insertTable))!;
    act(() => table.click());
    expect(document.body.textContent).toContain(en.office.tableDataDescription);
    const cancel = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === en.office.cancelWorksheetAction)!;
    act(() => cancel.click());
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("applies a valid bounded table as one canonical insertion", () => {
    const onCommand = mount();
    const table = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(en.office.insertTable))!;
    act(() => table.click());
    const data = [...document.body.querySelectorAll<HTMLLabelElement>("label")].find((candidate) => candidate.textContent?.startsWith(en.office.tableData))!.querySelector<HTMLTextAreaElement>("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    act(() => { setter?.call(data, "Name\tValue\nARR\t2"); data.dispatchEvent(new Event("input", { bubbles: true })); });
    const apply = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === en.office.apply)!;
    act(() => apply.click());
    expect(onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "insertSlideObject", object: expect.objectContaining({ kind: "table", rows: expect.any(Array) }) }));
  });
});
