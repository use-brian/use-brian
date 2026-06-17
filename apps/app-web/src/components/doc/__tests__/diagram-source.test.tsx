// @vitest-environment jsdom
/**
 * [COMP:app-web/diagram-source] View / edit a diagram's Mermaid source by hand.
 *
 * Driven for real in jsdom (`createRoot` + `act`, no `@testing-library/react`,
 * matching the rest of app-web). `../block-data` is mocked to a marker so the
 * test never pulls in the lazy mermaid compile — we're asserting the source
 * viewer / editor chrome and its write-back, not the SVG render. Covered:
 *   1. has-code + editable: hover "Edit source" button opens the editor seeded
 *      with the code; Update writes the edited code back through `updateBlock`,
 *   2. Update is gated — disabled for an unchanged (no-op) draft,
 *   3. has-code + read-only: "View source" opens a locked textarea with no
 *      Update (Close returns to the render), and never writes back,
 *   4. empty + editable: the editor opens straight away (hand-author a
 *      slash-inserted diagram) and Update is disabled until something is typed,
 *   5. empty + read-only: the "describe it in chat" stub, no editor.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { DiagramBlock } from "@/lib/api/views";

// Stub the data/widget surface so DiagramEmbed's rendered diagram is a marker,
// not the real mermaid-loading renderer.
vi.mock("../block-data", () => ({
  BlockData: ({ widget }: { widget: { code?: string } }) => (
    <div data-testid="rendered-diagram">{widget.code}</div>
  ),
}));

import { DiagramEmbed } from "../node-views/embed-view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const S = en.docPage.diagramSource;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(ui: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <I18nProvider locale="en" dict={en as Dictionary}>
        {ui}
      </I18nProvider>,
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function click(el: Element | null | undefined) {
  if (!el) throw new Error("element not found");
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Set a controlled <textarea> value the way React's onChange expects. */
function typeInto(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const textarea = () => container!.querySelector("textarea") as HTMLTextAreaElement | null;
const updateBtn = () =>
  Array.from(container!.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === S.update,
  ) as HTMLButtonElement | undefined;

const coded: DiagramBlock = {
  kind: "diagram",
  id: "d1",
  syntax: "mermaid",
  code: "graph TD; A-->B",
};
const empty: DiagramBlock = { kind: "diagram", id: "d2", syntax: "mermaid", code: "" };

describe("[COMP:app-web/diagram-source] Diagram source view/edit", () => {
  it("opens the source editor from the rendered diagram and writes an edit back", () => {
    const updateBlock = vi.fn();
    mount(<DiagramEmbed block={coded} editable updateBlock={updateBlock} />);

    // Collapsed: the rendered diagram + a hover "Edit source" button, no editor.
    expect(container!.querySelector('[data-testid="rendered-diagram"]')).toBeTruthy();
    expect(textarea()).toBeNull();
    const open = container!.querySelector(`[aria-label="${S.edit}"]`);
    expect(open).toBeTruthy();

    // Open → textarea seeded with the current code.
    click(open);
    expect(textarea()!.value).toBe(coded.code);

    // Editing then Update writes the new code through updateBlock and collapses.
    typeInto(textarea()!, "graph TD; A-->B; B-->C");
    click(updateBtn());
    expect(updateBlock).toHaveBeenCalledWith({ ...coded, code: "graph TD; A-->B; B-->C" });
  });

  it("disables Update for an unchanged (no-op) draft", () => {
    const updateBlock = vi.fn();
    mount(<DiagramEmbed block={coded} editable updateBlock={updateBlock} />);
    click(container!.querySelector(`[aria-label="${S.edit}"]`));
    // Seeded with the saved code, unchanged → Update disabled.
    expect(updateBtn()!.disabled).toBe(true);
    typeInto(textarea()!, "graph LR; X-->Y");
    expect(updateBtn()!.disabled).toBe(false);
  });

  it("offers read-only View source (no Update) when the page is not editable", () => {
    const updateBlock = vi.fn();
    mount(<DiagramEmbed block={coded} editable={false} updateBlock={updateBlock} />);

    const view = container!.querySelector(`[aria-label="${S.view}"]`);
    expect(view).toBeTruthy();
    expect(container!.querySelector(`[aria-label="${S.edit}"]`)).toBeNull();

    click(view);
    expect(textarea()!.readOnly).toBe(true);
    expect(updateBtn()).toBeUndefined();
    // Close returns to the render without ever writing back.
    const close = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === S.close,
    );
    click(close);
    expect(textarea()).toBeNull();
    expect(updateBlock).not.toHaveBeenCalled();
  });

  it("opens the editor directly for an empty diagram on an editable page", () => {
    const updateBlock = vi.fn();
    mount(<DiagramEmbed block={empty} editable updateBlock={updateBlock} />);

    // No render, no stub — the editor is open, Update disabled until typed.
    expect(textarea()).toBeTruthy();
    expect(updateBtn()!.disabled).toBe(true);
    typeInto(textarea()!, "graph TD; A-->B");
    click(updateBtn());
    expect(updateBlock).toHaveBeenCalledWith({ ...empty, code: "graph TD; A-->B" });
  });

  it("shows the chat stub for an empty diagram on a read-only page", () => {
    mount(<DiagramEmbed block={empty} editable={false} updateBlock={vi.fn()} />);
    expect(textarea()).toBeNull();
    expect(container!.textContent).toContain(en.docPage.embed.emptyDiagram);
  });
});
