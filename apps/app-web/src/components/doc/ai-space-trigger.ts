/**
 * "Press 'space' for AI" — the empty-line AI handoff.
 *
 * On an EMPTY paragraph, pressing Space hands the user into the doc
 * assistant anchored to that line (Notion's space-bar AI affordance) instead
 * of inserting a literal space. The companion `Placeholder` extension
 * (`doc-placeholder.ts`) shows the "Press 'space' for AI or '/' for
 * commands" hint on that same line.
 *
 * The trigger:
 *   1. fires only when the selection is an empty cursor inside an EMPTY
 *      paragraph (so a space mid-word, or on a heading / list / non-empty
 *      line, types normally),
 *   2. mints + stamps a `blockId` on that paragraph if it lacks one (so the
 *      anchor is addressable by the AI's `patchPage add { after }`),
 *   3. calls `onTrigger(blockId, editor)` — the editor wires this to open the
 *      inline AI box (`inline-ai-prompt.tsx`) at the caret, anchored to the line.
 *
 * The predicate is exported separately (`shouldTriggerAiOnSpace`) so it unit-
 * tests without a DOM — app-web's vitest is node-only.
 *
 * [COMP:app-web/ai-space-trigger]
 */

import { Extension, type Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";

/** Mint a stable block id for the anchored paragraph. */
function mintBlockId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `b_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * Decide whether a Space keypress at the current selection should hand off to
 * AI. Returns the anchor paragraph's existing `blockId` (or `null` if it has
 * none yet) when it should, or `null` when the space must type normally.
 *
 * Wrapped in `{ ok, blockId }` so a real (but absent) `blockId` is
 * distinguishable from "don't trigger".
 */
export function shouldTriggerAiOnSpace(
  state: EditorState,
): { blockId: string | null } | null {
  const { selection } = state;
  // Only a collapsed cursor (not a range) on an empty line.
  if (!selection.empty) return null;
  const $from = selection.$from;
  const node = $from.parent;
  // Notion fires this on an empty paragraph specifically — headings, list
  // items, quotes, code keep their normal space.
  if (node.type.name !== "paragraph") return null;
  if (node.content.size !== 0) return null;
  const blockId = (node.attrs?.blockId as string | undefined) ?? null;
  return { blockId };
}

export type AiSpaceTriggerOptions = {
  /**
   * Fired when Space is pressed on an empty line, with the anchor block id and
   * the live editor — the editor lets the handler read the caret coords
   * (`view.coordsAtPos`) so it can mount the inline AI box at that line.
   */
  onTrigger: (blockId: string, editor: Editor) => void;
};

/**
 * Build the Space-for-AI extension. `onTrigger` is captured at install time;
 * the editor supplies a closure that opens the chat anchored to the line.
 */
export function createAiSpaceTriggerExtension(options: AiSpaceTriggerOptions) {
  return Extension.create<AiSpaceTriggerOptions>({
    name: "aiSpaceTrigger",

    addOptions() {
      return { onTrigger: options.onTrigger };
    },

    addKeyboardShortcuts() {
      const ext = this;
      return {
        Space: () => {
          const editor = ext.editor;
          const ctx = shouldTriggerAiOnSpace(editor.state);
          if (!ctx) return false; // not an empty line → type a normal space

          let blockId = ctx.blockId;
          if (!blockId) {
            // Stamp a stable id on the empty paragraph so the AI can target it.
            blockId = mintBlockId();
            editor.chain().updateAttributes("paragraph", { blockId }).run();
          }
          ext.options.onTrigger(blockId, editor);
          return true; // consume the space — the inline AI box takes over
        },
      };
    },
  });
}
