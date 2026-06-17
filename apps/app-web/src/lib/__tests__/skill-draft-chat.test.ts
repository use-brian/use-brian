/**
 * Unit tests for the skill iteration chat's pure wire helpers.
 * Component tag: [COMP:app-web/skill-draft-chat].
 */

import { describe, it, expect } from "vitest";
import {
  clampDraftForWire,
  draftHasContent,
  toWireMessages,
  SKILL_CHAT_TURN_MAX_CHARS,
  SKILL_CHAT_WIRE_MAX_MESSAGES,
  type SkillChatTurn,
} from "../skill-draft-chat";
import type { SkillDraft } from "../api/skills";

function turn(
  role: "user" | "assistant",
  content: string,
  failed?: boolean,
): SkillChatTurn {
  return { id: crypto.randomUUID(), role, content, failed };
}

describe("[COMP:app-web/skill-draft-chat] toWireMessages", () => {
  it("maps turns to wire shape, dropping failed sends and empties", () => {
    const wire = toWireMessages([
      turn("user", "draft it"),
      turn("assistant", "Who is it for?"),
      turn("user", "this send failed", true),
      turn("user", "   "),
      turn("user", "our angels"),
    ]);
    expect(wire).toEqual([
      { role: "user", content: "draft it" },
      { role: "assistant", content: "Who is it for?" },
      { role: "user", content: "our angels" },
    ]);
  });

  it("clamps each turn to the server per-message cap and keeps the freshest window", () => {
    const long = "x".repeat(SKILL_CHAT_TURN_MAX_CHARS + 500);
    const many: SkillChatTurn[] = [];
    for (let i = 0; i < SKILL_CHAT_WIRE_MAX_MESSAGES + 6; i++) {
      many.push(turn(i % 2 === 0 ? "user" : "assistant", `turn ${i}`));
    }
    many.push(turn("user", long));

    const wire = toWireMessages(many);
    expect(wire.length).toBe(SKILL_CHAT_WIRE_MAX_MESSAGES);
    expect(wire[wire.length - 1]!.content.length).toBe(SKILL_CHAT_TURN_MAX_CHARS);
    // Freshest suffix survives — the oldest turns fell off.
    expect(wire[0]!.content).not.toBe("turn 0");
  });
});

describe("[COMP:app-web/skill-draft-chat] clampDraftForWire / draftHasContent", () => {
  const draft: SkillDraft = {
    name: "n".repeat(200),
    description: "d".repeat(400),
    whenToUse: "w".repeat(1200),
    content: "c".repeat(7000),
    sensitivity: "internal",
  };

  it("clamps every field to the lenient wire caps (never 400s a hand-paste)", () => {
    const clamped = clampDraftForWire(draft);
    expect(clamped.name.length).toBe(120);
    expect(clamped.description.length).toBe(300);
    expect(clamped.whenToUse.length).toBe(1000);
    expect(clamped.content.length).toBe(6000);
    expect(clamped.sensitivity).toBe("internal");
  });

  it("draftHasContent is false only for a fully blank document", () => {
    expect(draftHasContent(draft)).toBe(true);
    expect(
      draftHasContent({
        name: " ",
        description: "",
        whenToUse: "",
        content: "",
        sensitivity: "internal",
      }),
    ).toBe(false);
    expect(
      draftHasContent({
        name: "",
        description: "",
        whenToUse: "",
        content: "# body",
        sensitivity: "internal",
      }),
    ).toBe(true);
  });
});
