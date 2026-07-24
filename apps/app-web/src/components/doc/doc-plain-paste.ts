import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";

/**
 * Paste without formatting — Shift+Cmd+V (mac) / Shift+Ctrl+V (win/linux).
 *
 * A keyboard-driven plain paste. It reads the clipboard's TEXT directly
 * (`navigator.clipboard.readText`) and inserts it through ProseMirror's
 * `view.pasteText`, which is context-aware: inside a code block it keeps the
 * newlines literal, and elsewhere it splits into paragraphs / hard breaks the
 * way a plain-text paste does. Because the shortcut consumes the key (returns
 * `true` → the native Cmd-V paste never fires), the editor's own
 * `editorProps.handlePaste` markdown auto-conversion and StarterKit's HTML
 * clipboard parsing are BOTH bypassed by construction — so "strip formatting"
 * and "strip markdown" both hold with no extra logic.
 *
 * `Mod-` resolves to Cmd on mac and Ctrl elsewhere (prosemirror-keymap), so one
 * binding covers every platform with no platform-detection code.
 *
 * Clipboard-read can be unavailable or permission-gated (notably Firefox); the
 * handler no-ops gracefully on a rejected read, and returns `false` when the API
 * is absent so the browser's own default paste still runs as a fallback.
 */
export function pastePlain(editor: Editor): boolean {
  const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (!clip?.readText) return false;
  void clip
    .readText()
    .then((text) => {
      if (text) editor.view.pasteText(text);
    })
    .catch(() => {
      /* clipboard read denied / unavailable → nothing to paste */
    });
  return true;
}

export const DocPlainPaste = Extension.create({
  name: "docPlainPaste",
  addKeyboardShortcuts() {
    return {
      "Shift-Mod-v": ({ editor }) => pastePlain(editor),
    };
  },
});
