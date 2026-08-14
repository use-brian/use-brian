import { hasOfficeBaseSnapshot } from "@use-brian/office-model";
import type * as Y from "yjs";

/** Keyboard routing for client-local Office command history. [COMP:app-web/office-history] */
export type OfficeHistoryAction = "undo" | "redo";
export type OfficeHistoryController = { redo(): unknown; undo(): unknown };
type ObservableOfficeHistoryController = OfficeHistoryController & {
  canUndo(): boolean;
  canRedo(): boolean;
  on(event: "stack-item-added" | "stack-item-popped" | "stack-cleared", listener: () => void): unknown;
  off(event: "stack-item-added" | "stack-item-popped" | "stack-cleared", listener: () => void): unknown;
};
export type OfficeHistoryState = { canUndo: boolean; canRedo: boolean };

/**
 * Wait for provider or cached state to materialize the Office base before
 * installing history. An allocated Y.Doc is observable before it is usable.
 */
export function observeOfficeHistoryReadiness(doc: Y.Doc, listener: () => void): () => void {
  let started = false;
  const startWhenReady = () => {
    if (started || !hasOfficeBaseSnapshot(doc)) return;
    started = true;
    listener();
  };
  doc.on("update", startWhenReady);
  startWhenReady();
  return () => doc.off("update", startWhenReady);
}

export function officeHistoryShortcutAction(event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">): OfficeHistoryAction | null {
  if (event.altKey || !(event.metaKey || event.ctrlKey)) return null;
  const key = event.key.toLocaleLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && !event.shiftKey) return "redo";
  return null;
}

function shortcutBelongsToEditor(target: EventTarget | null, editorRoot: HTMLElement | null): boolean {
  if (!editorRoot || !(target instanceof Node)) return false;
  if (target === document.body || target === document.documentElement) return true;
  return editorRoot.contains(target);
}

/**
 * Handle history only while focus is in the canonical editor (or the page
 * body after a canvas click). Adjacent Brian/comment inputs keep native text
 * undo and can never roll the artifact back accidentally.
 */
export function handleOfficeHistoryShortcut(event: KeyboardEvent, history: OfficeHistoryController, editorRoot: HTMLElement | null): OfficeHistoryAction | null {
  const action = officeHistoryShortcutAction(event);
  if (!action || !shortcutBelongsToEditor(event.target, editorRoot)) return null;
  const changed = action === "undo" ? history.undo() : history.redo();
  if (!changed) return null;
  event.preventDefault();
  event.stopPropagation();
  return action;
}

export function observeOfficeHistory(history: ObservableOfficeHistoryController, listener: (state: OfficeHistoryState) => void): () => void {
  const refresh = () => listener({ canUndo: history.canUndo(), canRedo: history.canRedo() });
  history.on("stack-item-added", refresh);
  history.on("stack-item-popped", refresh);
  history.on("stack-cleared", refresh);
  refresh();
  return () => {
    history.off("stack-item-added", refresh);
    history.off("stack-item-popped", refresh);
    history.off("stack-cleared", refresh);
  };
}
