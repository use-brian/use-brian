/**
 * Executes a slash-menu / turn-into selection against the live whole-page
 * Tiptap editor. The pure kind→descriptor mapping lives in `slash-actions.ts`
 * (`slashActionFor`); this module is the thin runtime seam that interprets
 * the descriptor into an `editor.chain()` command — kept separate from the
 * React editor component so the dispatch table is unit-testable against a
 * recorded chain (app-web's vitest is node-only).
 *
 * Prose conversions (paragraph / heading / list / quote / code) use Tiptap's
 * built-in node commands. The two custom prose containers (`callout`,
 * `toggle`) and the opaque `embed` atom have no registered command, so we
 * insert them via `insertContent` with a minimal, schema-valid body. For
 * `data` / `chart` embeds the binding is configured later (chat is the
 * primary author of bound data blocks), so the inserted embed carries a
 * blockId-only placeholder that the embed node-view renders as a stub until
 * a binding lands.
 *
 * [COMP:app-web/slash-execute]
 */

import type { Editor } from "@tiptap/core";
// Side-effect import: brings the `toggleTaskList` command into the
// `@tiptap/core` `Commands` augmentation so the chain is typed.
import "@tiptap/extension-task-list";
import { slashActionFor, type EmbedKind } from "./slash-actions";
import type { SlashMenuItem } from "./slash-menu";

/** Mint a stable block id for an inserted node. */
function blockId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `b_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * The minimal, schema-valid JSON for a freshly-inserted embed block. Each
 * kind gets the empty/awaiting-input shape its `blockSchema` member requires
 * (`@sidanclaw/core` `views/blocks.ts`) so the stub round-trips through the
 * Yjs snapshot without tripping validation: media URL kinds carry `url: ''`,
 * file/image carry `ref: null`, and data/chart stay binding-less until chat
 * (or the view-config UI) supplies one — the node-view renders each as a
 * stub card meanwhile.
 */
function embedStubBlock(kind: EmbedKind, id: string): Record<string, unknown> {
  switch (kind) {
    case "video":
    case "audio":
    case "bookmark":
      return { kind, id, url: "" };
    case "image":
    case "file":
      return { kind, id, ref: null };
    case "data":
    case "chart":
      return { kind, id };
    case "diagram":
      // A freshly-inserted diagram has no source yet — chat (the primary
      // author of diagrams) supplies the Mermaid `code` later; the node-view
      // renders a stub meanwhile.
      return { kind, id, syntax: "mermaid", code: "" };
  }
}

/**
 * Minimal schema-valid JSON for a freshly-inserted simple table: a
 * `rows`×`cols` grid (first row `tableHeader`s when `withHeaderRow`), each
 * cell holding one empty paragraph (cells are `paragraph+` in the shared
 * schema). Round-trips through `pmDocToBlocks` to a `table` block. The default
 * is Notion's 3×3 with a header row.
 */
function tableNode(
  id: string,
  rows: number,
  cols: number,
  withHeaderRow: boolean,
): Record<string, unknown> {
  return {
    type: "table",
    attrs: { blockId: id },
    content: Array.from({ length: rows }, (_unused, r) => ({
      type: "tableRow",
      content: Array.from({ length: cols }, () => ({
        type: r === 0 && withHeaderRow ? "tableHeader" : "tableCell",
        content: [{ type: "paragraph" }],
      })),
    })),
  };
}

/**
 * Run the editor command for a chosen slash-menu item. Returns the boolean
 * the underlying Tiptap chain returns (`true` when the command applied).
 * Always focuses first so the change lands at the caret the user typed `/`
 * at — the suggestion plugin has already stripped the `/` + query by the
 * time this runs.
 */
export function executeSlashItem(editor: Editor, item: SlashMenuItem): boolean {
  const action = slashActionFor(item.blockKind);

  // child_page / link_to_page / template are handled by the editor's slash
  // `onSelect` (it owns the workspace context, router, page picker, and template
  // gallery these need). Reaching here means a caller bypassed that intercept —
  // no synchronous chain to run.
  if (
    action.command === "createChildPage" ||
    action.command === "linkToPage" ||
    action.command === "openTemplateGallery"
  ) {
    return false;
  }

  // Prose conversions TRANSFORM THE CURRENT BLOCK IN PLACE. This matches Notion:
  // `/heading` on a text block turns that text into a heading; on an empty line
  // it just sets the empty block's type. (Notion does NOT push the text down
  // and leave an empty heading below — so prose deliberately does not split,
  // despite canvas-notion-clone.md §5's looser "insert below if non-empty"
  // wording, which only holds for the block atoms handled afterwards.)
  switch (action.command) {
    case "setParagraph":
      return editor.chain().focus().setParagraph().run();
    case "setHeading":
      return editor.chain().focus().setHeading({ level: item.headingLevel ?? action.level }).run();
    case "toggleBulletList":
      return editor.chain().focus().toggleBulletList().run();
    case "toggleOrderedList":
      return editor.chain().focus().toggleOrderedList().run();
    case "toggleTaskList":
      return editor.chain().focus().toggleTaskList().run();
    case "setBlockquote":
      return editor.chain().focus().toggleBlockquote().run();
    case "setCodeBlock":
      return editor.chain().focus().setCodeBlock().run();
  }

  // SLASH-2 — block atoms / containers (divider / table / callout / toggle /
  // embed) follow Notion's empty-vs-non-empty rule. When the current block is
  // EMPTY, REPLACE it with the atom (so no stray empty paragraph is left behind
  // — the prior bug); when it already has text, open a fresh block BELOW
  // (`splitBlock`) and drop the atom there, leaving the text untouched.
  const parent = editor.state.selection.$from.parent;
  const blockEmpty = parent.isTextblock && parent.content.size === 0;
  if (!blockEmpty) editor.chain().focus().splitBlock().run();
  const { $from } = editor.state.selection;
  const range = { from: $from.before(), to: $from.after() };
  const replaceCurrentWith = (node: Record<string, unknown>): boolean =>
    editor.chain().focus().insertContentAt(range, node).run();

  switch (action.command) {
    case "insertDivider":
      return replaceCurrentWith({ type: "horizontalRule" });
    case "insertTable":
      // Native `table` nodes (not an embed) so cells co-edit through the CRDT.
      return replaceCurrentWith(tableNode(blockId(), 3, 3, true));
    case "setCallout":
      return replaceCurrentWith({
        type: "callout",
        attrs: { blockId: blockId(), icon: "💡" },
        content: [{ type: "paragraph" }],
      });
    case "setToggle":
      return replaceCurrentWith({
        type: "toggle",
        attrs: { blockId: blockId(), open: true },
        content: [{ type: "paragraph" }],
      });
    case "insertEmbed": {
      // A freshly-inserted embed has no URL / binding yet — the node-view
      // renders a stub card (URL entry for media, "bind via chat" for
      // data/chart) until one lands.
      const id = blockId();
      const block = JSON.stringify(embedStubBlock(action.block, id));
      return replaceCurrentWith({ type: "embed", attrs: { blockId: id, block } });
    }
  }
}
