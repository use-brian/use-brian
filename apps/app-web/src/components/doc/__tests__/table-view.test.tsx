// @vitest-environment jsdom
/**
 * [COMP:app-web/doc-table] Native-table React node-view DOM contract.
 *
 * Mounting the live node-view guards the interaction layer that headless
 * command tests cannot see: edge controls share one hover frame with the
 * table, the append rails remain clickable, and table-last content is repaired
 * with an editable paragraph.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorContent, useEditor } from "@tiptap/react";
import { browserDocExtensions } from "../doc-schema";
import { createTableTrailingParagraphExtension } from "../table-trailing-paragraph";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let activeRoot: Root | null = null;
let activeHost: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => {
    activeRoot?.unmount();
  });
  activeRoot = null;
  activeHost?.remove();
  activeHost = null;
});

const table = {
  type: "table",
  attrs: { blockId: "table-dom-test" },
  content: Array.from({ length: 3 }, (_unused, row) => ({
    type: "tableRow",
    content: Array.from({ length: 3 }, (_unusedCell, column) => ({
      type: "tableCell",
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: `${row}:${column}` }],
      }],
    })),
  })),
};

function pointerEvent(
  type: string,
  { clientX = 0, clientY = 0, pointerId = 1 } = {},
): MouseEvent {
  const event = new window.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX,
    clientY,
  });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function mountTable(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);

  function Test() {
    const editor = useEditor({
      immediatelyRender: false,
      extensions: [
        ...browserDocExtensions(),
        createTableTrailingParagraphExtension(),
      ],
      content: { type: "doc", content: [table] },
    });
    return editor
      ? createElement(EditorContent, { editor, className: "doc-collab-editor" })
      : null;
  }

  const root = createRoot(host);
  activeRoot = root;
  activeHost = host;
  await act(async () => {
    root.render(
      createElement(
        I18nProvider,
        { dict: en, locale: "en", children: createElement(Test) } as never,
      ),
    );
  });

  for (let i = 0; i < 100; i++) {
    const editor = host.querySelector(".ProseMirror");
    if (host.querySelector(".doc-table-frame td") && editor?.lastElementChild?.tagName === "P") {
      break;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 10));
  }
  return host;
}

describe("[COMP:app-web/doc-table] TableView interaction frame", () => {
  it("renders edge controls and an editable paragraph after a final table", async () => {
    const host = await mountTable();
    const frame = host.querySelector(".doc-table-frame");
    const editor = host.querySelector(".ProseMirror");

    expect(frame).not.toBeNull();
    expect(frame!.querySelector(".doc-table-add-row")).not.toBeNull();
    expect(frame!.querySelector(".doc-table-add-column")).not.toBeNull();
    expect(host.querySelector(".doc-table-controls")).toBeNull();
    expect(editor?.lastElementChild?.tagName).toBe("P");
  });

  it("shows boundary cues first, then promotes the hovered boundary to a grip", async () => {
    const host = await mountTable();
    const frame = host.querySelector(".doc-table-frame")!;
    const cell = frame.querySelector("td")!;

    await act(async () => {
      cell.dispatchEvent(new window.Event("pointermove", { bubbles: true }));
    });
    await settle();

    const rowHandle = frame.querySelector<HTMLButtonElement>(
      `[aria-label="${en.docPage.table.rowOptions}"]`,
    );
    const columnHandle = frame.querySelector<HTMLButtonElement>(
      `[aria-label="${en.docPage.table.columnOptions}"]`,
    );
    expect(rowHandle).not.toBeNull();
    expect(columnHandle).not.toBeNull();
    const rowSlot = rowHandle!.closest(".doc-table-row-handle-slot")!;
    const columnSlot = columnHandle!.closest(".doc-table-column-handle-slot")!;
    expect(rowSlot.querySelector(".doc-table-axis-cue")).not.toBeNull();
    expect(columnSlot.querySelector(".doc-table-axis-cue")).not.toBeNull();
    expect(rowSlot.getAttribute("data-active")).toBeNull();
    expect(columnSlot.getAttribute("data-active")).toBeNull();

    await act(async () => {
      columnSlot.dispatchEvent(new window.Event("pointerover", { bubbles: true }));
    });
    await settle();
    expect(columnSlot.getAttribute("data-active")).toBe("true");
    expect(frame.contains(rowHandle)).toBe(true);
    expect(frame.contains(columnHandle)).toBe(true);

    await act(async () => {
      columnHandle!.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    await settle();
    expect(document.body.querySelector(`[aria-label="${en.docPage.table.searchActions}"]`))
      .not.toBeNull();
    expect(document.body.textContent).toContain(en.docPage.table.headerColumn);
    expect(document.body.textContent).toContain(en.docPage.table.duplicateColumn);
    expect(document.body.textContent).toContain(en.docPage.table.clearColumnContents);
    expect(document.body.textContent).toContain(en.docPage.table.insertColumnLeft);
  });

  it("executes the row and column append rails", async () => {
    const host = await mountTable();
    const frame = host.querySelector(".doc-table-frame")!;

    await act(async () => {
      frame.querySelector<HTMLButtonElement>(".doc-table-add-row")!.dispatchEvent(
        new window.MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
    });
    await settle();
    expect(frame.querySelectorAll("tr")).toHaveLength(4);

    await act(async () => {
      frame.querySelector<HTMLButtonElement>(".doc-table-add-column")!.dispatchEvent(
        new window.MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
    });
    await settle();
    expect(
      Array.from(frame.querySelectorAll("tr")).every(
        (row) => row.querySelectorAll("td, th").length === 4,
      ),
    ).toBe(true);
  });

  it("treats a grip click as menu intent and a thresholded pointer move as reorder", async () => {
    const host = await mountTable();
    const frame = host.querySelector(".doc-table-frame")!;
    const sourceCell = frame.querySelectorAll<HTMLTableRowElement>("tr")[1]!.cells[0]!;

    await act(async () => {
      sourceCell.dispatchEvent(pointerEvent("pointermove"));
    });
    await settle();

    const rowHandle = frame.querySelector<HTMLButtonElement>(
      `[aria-label="${en.docPage.table.rowOptions}"]`,
    )!;
    const rowSlot = rowHandle.closest<HTMLElement>(".doc-table-row-handle-slot")!;
    const destinationCell = frame.querySelectorAll<HTMLTableRowElement>("tr")[2]!.cells[0]!;
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => destinationCell,
    });

    try {
      await act(async () => {
        rowHandle.dispatchEvent(pointerEvent("pointerdown"));
        rowSlot.dispatchEvent(pointerEvent("pointermove", { clientY: 12 }));
        rowSlot.dispatchEvent(pointerEvent("pointerup", { clientY: 12 }));
      });
      await settle();

      expect(
        Array.from(frame.querySelectorAll("tr"), (row) => row.cells[0]!.textContent),
      ).toEqual(["0:0", "2:0", "1:0"]);
      expect(document.body.querySelector(`[aria-label="${en.docPage.table.searchActions}"]`))
        .toBeNull();

      const movedCell = frame.querySelector<HTMLTableCellElement>("td")!;
      await act(async () => {
        movedCell.dispatchEvent(pointerEvent("pointermove"));
      });
      await settle();
      const columnHandle = frame.querySelector<HTMLButtonElement>(
        `[aria-label="${en.docPage.table.columnOptions}"]`,
      )!;
      await act(async () => {
        columnHandle.dispatchEvent(pointerEvent("pointerdown"));
        columnHandle.dispatchEvent(pointerEvent("pointerup"));
      });
      await settle();
      expect(document.body.querySelector(`[aria-label="${en.docPage.table.searchActions}"]`))
        .not.toBeNull();
    } finally {
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: originalElementFromPoint,
      });
    }
  });
});
