/**
 * [COMP:app-web/ai-space-trigger] "Press 'space' for AI" predicate.
 *
 * The Space keypress only hands off to AI on an EMPTY paragraph; anywhere
 * else it types a normal space. We exercise `shouldTriggerAiOnSpace` against
 * real ProseMirror states built from the shared doc schema (node-only, no
 * editor / DOM).
 */

import { describe, expect, it } from "vitest";
import { docSchema } from "@use-brian/doc-model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { shouldTriggerAiOnSpace } from "../ai-space-trigger";

const schema = docSchema();

function stateOf(docJSON: unknown, from: number, to = from): EditorState {
  const doc = schema.nodeFromJSON(docJSON) as PMNode;
  const base = EditorState.create({ schema, doc });
  return base.apply(base.tr.setSelection(TextSelection.create(base.doc, from, to)));
}

describe("[COMP:app-web/ai-space-trigger] shouldTriggerAiOnSpace", () => {
  it("triggers on a collapsed cursor in an empty paragraph", () => {
    const state = stateOf({ type: "doc", content: [{ type: "paragraph" }] }, 1);
    expect(shouldTriggerAiOnSpace(state)).toEqual({ blockId: null });
  });

  it("surfaces an existing blockId on the empty paragraph", () => {
    const state = stateOf(
      { type: "doc", content: [{ type: "paragraph", attrs: { blockId: "b-1" } }] },
      1,
    );
    expect(shouldTriggerAiOnSpace(state)).toEqual({ blockId: "b-1" });
  });

  it("does NOT trigger in a non-empty paragraph (space types normally)", () => {
    const state = stateOf(
      { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] },
      1,
    );
    expect(shouldTriggerAiOnSpace(state)).toBeNull();
  });

  it("does NOT trigger on an empty heading", () => {
    const state = stateOf(
      { type: "doc", content: [{ type: "heading", attrs: { level: 1 } }] },
      1,
    );
    expect(shouldTriggerAiOnSpace(state)).toBeNull();
  });

  it("does NOT trigger on a non-collapsed selection", () => {
    const state = stateOf(
      { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] },
      1,
      4,
    );
    expect(shouldTriggerAiOnSpace(state)).toBeNull();
  });
});
