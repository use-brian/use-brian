import { describe, expect, it } from "vitest";
import {
  completeTrailingAssistantMention,
  nextMentionSelectionIndex,
  resolveMentionedAssistants,
  resolveWorkBenchAssistant,
} from "../multi-assistant-response";

const roster = [
  { id: "brian", name: "Brian" },
  { id: "hinson", name: "Hinson" },
  { id: "sales", name: "Sales" },
  { id: "sales-eu", name: "Sales EU" },
];

describe("[COMP:app-web/multi-assistant-response] room response group", () => {
  it("cycles the active mention option in both directions", () => {
    expect(nextMentionSelectionIndex(0, 2, 1)).toBe(1);
    expect(nextMentionSelectionIndex(1, 2, 1)).toBe(0);
    expect(nextMentionSelectionIndex(0, 2, -1)).toBe(1);
  });

  it("completes only the trailing partial mention", () => {
    expect(completeTrailingAssistantMention("Ask @Br", "Brian")).toBe(
      "Ask @Brian ",
    );
    expect(
      completeTrailingAssistantMention("@Brian and @Hi", "Hinson"),
    ).toBe("@Brian and @Hinson ");
  });

  it("returns every distinct mentioned assistant in textual order", () => {
    expect(
      resolveMentionedAssistants("@HINSON and @Brian, what do you both know? @hinson", roster)
        .map((assistant) => assistant.id),
    ).toEqual(["hinson", "brian"]);
  });

  it("uses the longest overlapping assistant name", () => {
    expect(
      resolveMentionedAssistants("Ask @Sales EU, then @Sales.", roster)
        .map((assistant) => assistant.id),
    ).toEqual(["sales-eu", "sales"]);
  });

  it("does not treat a longer word as a mention", () => {
    expect(resolveMentionedAssistants("@Brianna", roster)).toEqual([]);
  });

  it("bounds one response group to eight assistants", () => {
    const largeRoster = Array.from({ length: 10 }, (_, index) => ({
      id: `assistant-${index}`,
      name: `Assistant ${index}`,
    }));
    const message = largeRoster.map((assistant) => `@${assistant.name}`).join(" ");

    expect(resolveMentionedAssistants(message, largeRoster)).toHaveLength(8);
  });

  it("shows the local or followed responder instead of the room default", () => {
    expect(
      resolveWorkBenchAssistant({
        roster,
        fallback: roster[0],
        localActive: true,
        localAssistantId: "hinson",
        remoteActive: false,
        remoteAssistantId: null,
        waitingForInput: false,
      })?.id,
    ).toBe("hinson");

    expect(
      resolveWorkBenchAssistant({
        roster,
        fallback: roster[0],
        localActive: false,
        localAssistantId: null,
        remoteActive: true,
        remoteAssistantId: "sales",
        waitingForInput: false,
      })?.id,
    ).toBe("sales");
  });
});
