/**
 * [COMP:app-web/feed-post-editor] Proposal replay.
 *
 * The pane reconstructs the assistant's alternatives by walking persisted
 * `proposeDrafts` tool calls, so a reload shows the same chips the live turn
 * produced. Defensive parsing matters here: a half-streamed or malformed tool
 * call must be ignored, never crash the editor.
 */

import { describe, expect, it } from "vitest";
import { compositionHasChanges, replayProposals } from "../post-editor";

function turn(drafts: unknown) {
  return {
    role: "assistant",
    content: [{ type: "tool_use", name: "proposeDrafts", input: { drafts } }],
  };
}

describe("[COMP:app-web/feed-post-editor] proposal replay", () => {
  it("collects drafts in index order", () => {
    const out = replayProposals([
      turn([
        { index: 2, text: "Warm.", label: "warm" },
        { index: 1, text: "Punchy." },
      ]),
    ]);
    expect(out.map((d) => d.index)).toEqual([1, 2]);
    expect(out[1].label).toBe("warm");
  });

  it("upserts by index across turns, so a revision replaces its draft", () => {
    const out = replayProposals([
      turn([{ index: 1, text: "First." }]),
      turn([
        { index: 1, text: "Revised." },
        { index: 2, text: "Added." },
      ]),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe("Revised.");
    expect(out[1].text).toBe("Added.");
  });

  it("drops unusable entries but keeps the rest of the call", () => {
    const out = replayProposals([
      turn([
        { index: 1, text: "Good." },
        { index: 0, text: "Bad index." },
        { index: 3 },
        { text: "No index." },
        "not an object",
      ]),
    ]);
    expect(out.map((d) => d.index)).toEqual([1]);
  });

  it("ignores user turns, other tools, and malformed payloads", () => {
    expect(
      replayProposals([
        {
          role: "user",
          content: [
            { type: "tool_use", name: "proposeDrafts", input: { drafts: [{ index: 1, text: "x" }] } },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", name: "proposePlan", input: { drafts: [] } }],
        },
        { role: "assistant", content: "plain text" },
        { role: "assistant", content: [{ type: "tool_use", name: "proposeDrafts" }] },
      ]),
    ).toEqual([]);
  });

  it("carries the image brief when the model supplied one", () => {
    const out = replayProposals([
      turn([{ index: 1, text: "Copy.", imageBrief: "Close-up, soft light." }]),
    ]);
    expect(out[0].imageBrief).toBe("Close-up, soft light.");
  });

  it("does not mark a persisted article dirty when jsonb reordered its keys", () => {
    expect(compositionHasChanges({
      format: "article",
      text: "Launch analysis",
      threadSegments: ["", ""],
      article: {
        sourceUrl: "https://example.com/launch",
        title: "What we learned",
        description: "A practical guide.",
      },
      saved: {
        draftText: "Launch analysis",
        postedText: null,
        postFormat: "article",
        article: {
          title: "What we learned",
          description: "A practical guide.",
          sourceUrl: "https://example.com/launch",
        },
      },
    })).toBe(false);
  });

  it("requires saving when an article field changes", () => {
    expect(compositionHasChanges({
      format: "article",
      text: "Launch analysis",
      threadSegments: ["", ""],
      article: {
        sourceUrl: "https://example.com/launch",
        title: "Updated title",
        description: "A practical guide.",
      },
      saved: {
        draftText: "Launch analysis",
        postedText: null,
        postFormat: "article",
        article: {
          sourceUrl: "https://example.com/launch",
          title: "What we learned",
          description: "A practical guide.",
        },
      },
    })).toBe(true);
  });
});
