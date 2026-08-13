// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { handleOfficeHistoryShortcut, observeOfficeHistory, officeHistoryShortcutAction } from "../editor-history";

describe("[COMP:app-web/office-history] Office editor history shortcuts", () => {
  it("maps the platform undo and redo shortcuts", () => {
    const event = (key: string, patch: Partial<KeyboardEvent> = {}) => ({ key, altKey: false, ctrlKey: true, metaKey: false, shiftKey: false, ...patch });
    expect(officeHistoryShortcutAction(event("z"))).toBe("undo");
    expect(officeHistoryShortcutAction(event("Z", { metaKey: true, ctrlKey: false }))).toBe("undo");
    expect(officeHistoryShortcutAction(event("z", { shiftKey: true }))).toBe("redo");
    expect(officeHistoryShortcutAction(event("y"))).toBe("redo");
    expect(officeHistoryShortcutAction(event("z", { altKey: true }))).toBeNull();
    expect(officeHistoryShortcutAction(event("a"))).toBeNull();
  });

  it("handles shortcuts inside the editor and ignores the adjacent rail", () => {
    const editor = document.createElement("main");
    const editorInput = document.createElement("textarea");
    const railInput = document.createElement("textarea");
    editor.append(editorInput);
    document.body.append(editor, railInput);
    const undo = vi.fn(() => ({}));
    const redo = vi.fn(() => ({}));
    const history = { undo, redo };

    const inside = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    editorInput.dispatchEvent(inside);
    expect(handleOfficeHistoryShortcut(inside, history, editor)).toBe("undo");
    expect(inside.defaultPrevented).toBe(true);
    expect(undo).toHaveBeenCalledOnce();

    const outside = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    railInput.dispatchEvent(outside);
    expect(handleOfficeHistoryShortcut(outside, history, editor)).toBeNull();
    expect(outside.defaultPrevented).toBe(false);
    expect(undo).toHaveBeenCalledOnce();

    editor.remove();
    railInput.remove();
  });

  it("leaves the browser shortcut alone when the matching history stack is empty", () => {
    const editor = document.createElement("main");
    const input = document.createElement("input");
    editor.append(input);
    document.body.append(editor);
    const event = new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(event);

    expect(handleOfficeHistoryShortcut(event, { undo: () => null, redo: () => null }, editor)).toBeNull();
    expect(event.defaultPrevented).toBe(false);
    editor.remove();
  });

  it("observes the existing manager stack without creating another history", () => {
    const listeners = new Map<string, () => void>();
    let canUndo = false;
    const history = {
      undo: vi.fn(), redo: vi.fn(), canUndo: () => canUndo, canRedo: () => !canUndo,
      on: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
      off: vi.fn((event: string) => listeners.delete(event)),
    };
    const listener = vi.fn();
    const stop = observeOfficeHistory(history, listener);
    expect(listener).toHaveBeenLastCalledWith({ canUndo: false, canRedo: true });
    canUndo = true;
    listeners.get("stack-item-added")?.();
    expect(listener).toHaveBeenLastCalledWith({ canUndo: true, canRedo: false });
    stop();
    expect(history.off).toHaveBeenCalledTimes(3);
  });
});
