import { describe, expect, it } from "vitest";
import { nextReplyVoiceHint } from "@/lib/next-reply-voice";

describe("[COMP:app-web/next-reply-voice] nextReplyVoiceHint", () => {
  it("names the selected assistant after a mid-thread switch", () => {
    const messages = [
      { role: "user" },
      { role: "assistant", senderAssistantId: "a_primary" },
    ];
    expect(nextReplyVoiceHint(messages, "a_tasks")).toBe("a_tasks");
  });

  it("stays hidden when the latest reply already came from the selection", () => {
    const messages = [
      { role: "assistant", senderAssistantId: "a_primary" },
      { role: "user" },
      { role: "assistant", senderAssistantId: "a_tasks" },
    ];
    expect(nextReplyVoiceHint(messages, "a_tasks")).toBeNull();
  });

  it("judges by the LATEST reply, skipping trailing user rows", () => {
    const messages = [
      { role: "assistant", senderAssistantId: "a_tasks" },
      { role: "assistant", senderAssistantId: "a_primary" },
      { role: "user" },
    ];
    expect(nextReplyVoiceHint(messages, "a_tasks")).toBe("a_tasks");
  });

  it("stays hidden on an empty thread or with no selection", () => {
    expect(nextReplyVoiceHint([], "a_tasks")).toBeNull();
    expect(nextReplyVoiceHint([{ role: "user" }], "a_tasks")).toBeNull();
    expect(
      nextReplyVoiceHint([{ role: "assistant", senderAssistantId: "a" }], null),
    ).toBeNull();
  });

  it("stays hidden when the latest reply is unstamped (voice unknown)", () => {
    const messages = [
      { role: "assistant", senderAssistantId: "a_primary" },
      { role: "assistant", senderAssistantId: null },
    ];
    expect(nextReplyVoiceHint(messages, "a_tasks")).toBeNull();
  });
});
