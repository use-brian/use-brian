/**
 * [COMP:app-web/block-actions] Block-action helpers — the pure id-rewrite.
 *
 * `remintBlockIds` is the one piece with real branching logic and no editor
 * dependency, so it's directly testable in app-web's node-only vitest. The
 * editor-bound ops (delete/duplicate/color/turn-into) are thin PM-transaction
 * dispatches exercised via web-QA. Duplicating a block MUST mint fresh ids
 * (collisions corrupt comment anchors + data bindings), and `embed` atoms carry
 * the id twice — the global attr and an `id` inside the `block` JSON string —
 * so both must move in lockstep.
 */

import { describe, it, expect } from "vitest";
import type { Editor } from "@tiptap/core";
import { remintBlockIds, applyTurnIntoAt } from "../block-actions";
import type { TurnIntoKind } from "../turn-into-menu";

/**
 * Minimal mock editor: a recorded command chain (each `.run()` pushes the
 * accumulated call string — same idiom as turn-into-menu.test) plus a stub
 * `state.doc` that resolves ONE node at pos 0. Lets us assert the branching of
 * `applyTurnIntoAt` over an atom embed without a live ProseMirror view.
 */
function makeEditor(node: {
  isTextblock: boolean;
  typeName: string;
  nodeSize: number;
}): { editor: Editor; calls: string[] } {
  const calls: string[] = [];
  function makeChain(prefix: string): unknown {
    return new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "run") {
            return () => {
              calls.push(prefix);
              return true;
            };
          }
          return (...args: unknown[]) => {
            const next =
              prefix +
              (prefix ? "." : "") +
              String(prop) +
              (args.length ? `(${args.map((a) => JSON.stringify(a)).join(",")})` : "()");
            return makeChain(next);
          };
        },
      },
    );
  }
  const pmNode = {
    isTextblock: node.isTextblock,
    nodeSize: node.nodeSize,
    type: { name: node.typeName },
    attrs: {},
  };
  const editor = {
    chain: () => makeChain(""),
    state: { doc: { content: { size: 100 }, nodeAt: () => pmNode } },
  } as unknown as Editor;
  return { editor, calls };
}

const embed = { isTextblock: false, typeName: "embed", nodeSize: 1 };

describe("[COMP:app-web/block-actions] remintBlockIds", () => {
  it("re-mints a top-level blockId, preserving other attrs + content", () => {
    const out = remintBlockIds({
      type: "paragraph",
      attrs: { blockId: "old", variant: "muted", color: "blue" },
      content: [{ type: "text", text: "hi" }],
    });
    expect(out.attrs!.blockId).not.toBe("old");
    expect(typeof out.attrs!.blockId).toBe("string");
    expect(out.attrs!.variant).toBe("muted");
    expect(out.attrs!.color).toBe("blue");
    expect(out.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("re-mints an embed's inner block.id in lockstep with blockId", () => {
    const block = JSON.stringify({ kind: "data", id: "old", binding: { x: 1 } });
    const out = remintBlockIds({ type: "embed", attrs: { blockId: "old", block } });
    const fresh = out.attrs!.blockId as string;
    expect(fresh).not.toBe("old");
    const parsed = JSON.parse(out.attrs!.block as string);
    expect(parsed.id).toBe(fresh); // moved together
    expect(parsed.binding).toEqual({ x: 1 }); // rest of the block preserved
  });

  it("recurses into content so child blockIds are re-minted too", () => {
    const out = remintBlockIds({
      type: "bulletList",
      content: [
        {
          type: "listItem",
          attrs: { blockId: "a" },
          content: [{ type: "paragraph", attrs: { blockId: "b" } }],
        },
      ],
    });
    const li = out.content![0];
    expect(li.attrs!.blockId).not.toBe("a");
    expect(li.content![0].attrs!.blockId).not.toBe("b");
  });

  it("leaves a malformed embed block attr untouched without throwing", () => {
    const out = remintBlockIds({
      type: "embed",
      attrs: { blockId: "old", block: "{not json" },
    });
    expect(out.attrs!.blockId).not.toBe("old");
    expect(out.attrs!.block).toBe("{not json");
  });

  it("leaves a node without a string blockId alone", () => {
    const out = remintBlockIds({ type: "paragraph", attrs: { blockId: null, variant: null } });
    expect(out.attrs).toEqual({ blockId: null, variant: null });
  });

  it("mints unique ids across sibling blocks that shared one", () => {
    const out = remintBlockIds({
      type: "doc",
      content: [
        { type: "paragraph", attrs: { blockId: "x" } },
        { type: "paragraph", attrs: { blockId: "x" } },
      ],
    });
    expect(out.content![0].attrs!.blockId).not.toBe(out.content![1].attrs!.blockId);
  });

  it("does not mutate the input JSON", () => {
    const input = { type: "paragraph", attrs: { blockId: "old" } };
    const out = remintBlockIds(input);
    expect(input.attrs.blockId).toBe("old"); // original untouched
    expect(out.attrs!.blockId).not.toBe("old");
  });
});

describe("[COMP:app-web/block-actions] applyTurnIntoAt on an atom embed", () => {
  // An embed (chart / image / data / …) has no inner text, so Turn-into is a
  // structural swap: the two CONTAINER targets WRAP the embed (non-destructive),
  // every textblock target REPLACES it with an empty block of that kind.
  it("wraps the embed for the callout target (non-destructive)", () => {
    const { editor, calls } = makeEditor(embed);
    expect(applyTurnIntoAt(editor, 0, "callout")).toBe(true);
    expect(calls).toEqual(['setNodeSelection(0).wrapIn("callout")']);
  });

  it("wraps the embed for the toggle target (non-destructive)", () => {
    const { editor, calls } = makeEditor(embed);
    expect(applyTurnIntoAt(editor, 0, "toggle")).toBe(true);
    expect(calls).toEqual(['setNodeSelection(0).wrapIn("toggle")']);
  });

  it("replaces the embed with an empty paragraph for the paragraph target", () => {
    const { editor, calls } = makeEditor(embed);
    expect(applyTurnIntoAt(editor, 0, "paragraph")).toBe(true);
    // One chain: swap [0,1] for a paragraph, drop the caret in. No second
    // conversion (it's already a paragraph).
    expect(calls).toEqual([
      'insertContentAt({"from":0,"to":1},{"type":"paragraph"}).setTextSelection(1)',
    ]);
  });

  it("replaces then converts for a non-paragraph textblock target (heading)", () => {
    const { editor, calls } = makeEditor(embed);
    expect(applyTurnIntoAt(editor, 0, "heading_1")).toBe(true);
    // First the replace chain, then applyTurnInto's in-place conversion.
    expect(calls).toEqual([
      'insertContentAt({"from":0,"to":1},{"type":"paragraph"}).setTextSelection(1)',
      'focus().setHeading({"level":1})',
    ]);
  });

  it("still converts a real textblock in place (regression guard)", () => {
    const para = { isTextblock: true, typeName: "paragraph", nodeSize: 3 };
    const { editor, calls } = makeEditor(para);
    expect(applyTurnIntoAt(editor, 0, "heading_2" as TurnIntoKind)).toBe(true);
    // No replace — drop the caret in (chain 1), then convert in place (chain 2).
    expect(calls).toEqual([
      "setTextSelection(1)",
      'focus().setHeading({"level":2})',
    ]);
  });
});

// ── Capability gates — what the block menu may offer on a given editor ─────
//
// `availableTurnIntoKinds` / `blockDeclaresColor` are the pure gates behind
// the BlockActionMenu's schema-awareness: the SAME menu serves the full doc
// surface and the skill body editor's md-restricted StarterKit schema, so the
// gates must resolve the complete catalogue on the former and exactly the
// md-representable subset on the latter (an unfiltered list would throw on
// `toggleTaskList` where task lists aren't registered, or no-op on heading 4).

import { getSchema } from "@tiptap/core";
import { docExtensions } from "@use-brian/doc-model";
import { skillBodySchemaExtensions } from "@/lib/skill-markdown";
import {
  availableTurnIntoKinds,
  blockDeclaresColor,
  editorTurnIntoKinds,
} from "../block-actions";

const docSchema = getSchema(docExtensions({ withViewPlugins: false }));
const skillSchema = getSchema(skillBodySchemaExtensions);

describe("[COMP:app-web/block-actions] availableTurnIntoKinds", () => {
  it("resolves the FULL catalogue on the doc schema (unconfigured levels = 1-6)", () => {
    const kinds = availableTurnIntoKinds(docSchema, [1, 2, 3, 4, 5, 6]);
    expect([...kinds].sort()).toEqual(
      [
        "paragraph",
        "heading_1",
        "heading_2",
        "heading_3",
        "heading_4",
        "bulleted_list",
        "numbered_list",
        "to_do",
        "quote",
        "callout",
        "toggle",
        "code",
      ].sort(),
    );
  });

  it("resolves only the md-representable subset on the skill schema", () => {
    const kinds = availableTurnIntoKinds(skillSchema, [1, 2, 3]);
    expect([...kinds].sort()).toEqual(
      [
        "paragraph",
        "heading_1",
        "heading_2",
        "heading_3",
        "bulleted_list",
        "numbered_list",
        "quote",
        "code",
      ].sort(),
    );
    // The doc-only kinds the skill schema cannot represent.
    expect(kinds.has("heading_4")).toBe(false);
    expect(kinds.has("to_do")).toBe(false);
    expect(kinds.has("callout")).toBe(false);
    expect(kinds.has("toggle")).toBe(false);
  });

  it("editorTurnIntoKinds reads the heading extension's configured levels", () => {
    const editor = {
      schema: skillSchema,
      extensionManager: {
        extensions: [{ name: "heading", options: { levels: [1, 2, 3] } }],
      },
    } as unknown as Editor;
    const kinds = editorTurnIntoKinds(editor);
    expect(kinds.has("heading_3")).toBe(true);
    expect(kinds.has("heading_4")).toBe(false);
  });
});

describe("[COMP:app-web/block-actions] blockDeclaresColor", () => {
  it("doc nodes carry the DocAttrs color/bgColor globals", () => {
    const para = docSchema.nodes.paragraph.create();
    expect(blockDeclaresColor(para)).toBe(true);
  });

  it("plain StarterKit nodes (skill schema) do not", () => {
    const para = skillSchema.nodes.paragraph.create();
    expect(blockDeclaresColor(para)).toBe(false);
  });
});
