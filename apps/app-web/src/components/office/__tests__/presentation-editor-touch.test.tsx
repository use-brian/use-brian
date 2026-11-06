// @vitest-environment jsdom
/**
 * [COMP:app-web/office-presentation-editor] Phone shapes from the 2026-09
 * review: the filmstrip rail below md (report B row 18), the explicit
 * "Edit text" action and the second still tap that enters text edit on touch
 * (row 20), and the one-strip format toolbars under the canvas (row 21).
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { PresentationEditor } from "../presentation-editor";
import { presentationFixture } from "./editor-fixtures";

vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock("@/lib/office/api", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/office/api")>(), admitOfficeImageResource: vi.fn() }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("[COMP:app-web/office-presentation-editor] touch and phone layout", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    let nextId = 700;
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => `10000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`) });
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  function mount() {
    const snapshot = presentationFixture();
    snapshot.resources = [];
    const onCommand = vi.fn();
    act(() => root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><PresentationEditor snapshot={snapshot} baseVersion={1} role="edit" suggestMode={false} onCommand={onCommand} /></I18nProvider>));
    return { snapshot, onCommand };
  }

  it("offers an explicit Edit text action for a selected text object (row 20)", () => {
    mount();
    expect(host.querySelector("[data-edit-text-action]")).toBeNull();
    const frame = host.querySelector<HTMLElement>("[data-slide-object]")!;
    act(() => frame.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const action = host.querySelector<HTMLButtonElement>("[data-edit-text-action]")!;
    expect(action.textContent).toContain(en.office.editText);
    act(() => action.click());
    expect(host.querySelector("[data-slide-text-editor]")).not.toBeNull();
  });

  it("enters text edit on a second still touch tap of a selected text object (row 20)", () => {
    mount();
    const frame = host.querySelector<HTMLElement>("[data-slide-object]")!;
    const tap = (pointerId: number) => {
      act(() => frame.dispatchEvent(new PointerEvent("pointerdown", { pointerId, pointerType: "touch", button: 0, clientX: 10, clientY: 10, bubbles: true })));
      act(() => frame.dispatchEvent(new PointerEvent("pointerup", { pointerId, pointerType: "touch", clientX: 10, clientY: 10, bubbles: true })));
      act(() => frame.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    };
    tap(1);
    // The first tap only selects.
    expect(host.querySelector("[data-slide-text-editor]")).toBeNull();
    expect(frame.getAttribute("data-selected")).toBe("true");
    tap(2);
    expect(host.querySelector("[data-slide-text-editor]")).not.toBeNull();
  });

  it("lays the rail out as a horizontal filmstrip below md and pans it by touch (rows 18, 19)", () => {
    mount();
    const editor = host.querySelector<HTMLElement>('[data-office-editor="presentation"]')!;
    expect(editor.className).toContain("flex-col");
    expect(editor.className).toContain("md:grid");
    const rail = host.querySelector<HTMLElement>("[data-slide-rail]")!;
    expect(rail.className).toContain("overflow-x-auto");
    expect(rail.className).toContain("md:block");
    const handle = host.querySelector<HTMLElement>("[data-slide-thumbnail] button")!;
    expect(handle.className).toContain("touch-pan-x");
    expect(handle.className).toContain("md:touch-pan-y");
  });

  it("hosts the formatting, accessibility and geometry toolbars in one strip under the canvas below md (row 21)", () => {
    mount();
    const frame = host.querySelector<HTMLElement>("[data-slide-object]")!;
    act(() => frame.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const strip = host.querySelector<HTMLElement>("[data-presentation-format-strip]")!;
    expect(strip.className).toContain("max-md:overflow-x-auto");
    expect(strip.className).toContain("md:contents");
    expect(strip.className).toContain("max-md:order-2");
    expect(strip.querySelector("[data-presentation-formatting-toolbar]")).not.toBeNull();
    expect(strip.querySelector("[data-properties-toolbar]")).not.toBeNull();
  });
});
