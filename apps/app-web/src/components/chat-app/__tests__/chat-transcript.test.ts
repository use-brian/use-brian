import { describe, expect, it } from "vitest";
import type { ToolUsed } from "@use-brian/chat-ui";
import {
  coalesceAssistantRunMessages,
  computeTranscriptRowMeta,
  formatTranscriptDayLabel,
  formatTranscriptTime,
  type ChatSurfaceMessage,
} from "../chat-transcript";

const at = (second: number) => new Date(`2026-08-04T00:00:0${second}.000Z`);

function user(id: string, text: string): ChatSurfaceMessage {
  return { id, role: "user", text, timestamp: at(0) };
}

function assistant(
  id: string,
  text: string,
  options: Partial<ChatSurfaceMessage> = {},
): ChatSurfaceMessage {
  return {
    id,
    role: "assistant",
    text,
    timestamp: at(Number(id.slice(-1))),
    ...options,
  };
}

function tool(id: string): ToolUsed {
  return {
    id,
    name: "imapSearchMessages",
    status: "done",
    description: `step ${id}`,
  };
}

describe("[COMP:app-web/chat-transcript] assistant-run history grouping", () => {
  it("renders one logical assistant message for a multi-step tool run", () => {
    const messages = coalesceAssistantRunMessages([
      user("u0", "send an email"),
      assistant("a1", "Let me find the mailbox.", {
        senderAssistantId: "assistant-a",
        toolsUsed: [tool("t1")],
        documents: [
          { id: "d1", title: "Draft", content: "first", format: "markdown" },
        ],
      }),
      assistant("a2", "", {
        senderAssistantId: "assistant-a",
        toolsUsed: [tool("t2")],
      }),
      assistant("a3", "The email is ready.", {
        senderAssistantId: "assistant-a",
        citations: [{ url: "https://example.com", title: "Example" }],
        fileAttachments: [
          {
            fileId: "f1",
            workspaceId: "w1",
            path: "draft.txt",
            name: "draft.txt",
            mime: "text/plain",
            sizeBytes: 12,
          },
        ],
      }),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      id: "a3",
      role: "assistant",
      text: "The email is ready.",
      senderAssistantId: "assistant-a",
    });
    expect(messages[1]?.timestamp).toEqual(at(3));
    expect(messages[1]?.toolsUsed?.map((entry) => entry.id)).toEqual([
      "t1",
      "t2",
    ]);
    expect(messages[1]?.documents?.map((entry) => entry.id)).toEqual(["d1"]);
    expect(messages[1]?.citations?.map((entry) => entry.url)).toEqual([
      "https://example.com",
    ]);
    expect(messages[1]?.fileAttachments?.map((entry) => entry.fileId)).toEqual([
      "f1",
    ]);
  });

  it("keeps the last non-empty answer when a bookkeeping tool is the final row", () => {
    const messages = coalesceAssistantRunMessages([
      assistant("a1", "Done.", {
        senderAssistantId: "assistant-a",
        toolsUsed: [tool("t1")],
      }),
      assistant("a2", "", {
        senderAssistantId: "assistant-a",
        toolsUsed: [tool("bookkeeping")],
      }),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: "a2", text: "Done." });
    expect(messages[0]?.toolsUsed?.map((entry) => entry.id)).toEqual([
      "t1",
      "bookkeeping",
    ]);
  });

  it("does not merge across a real user message", () => {
    const messages = coalesceAssistantRunMessages([
      assistant("a1", "First answer", { senderAssistantId: "assistant-a" }),
      user("u0", "follow up"),
      assistant("a2", "Second answer", { senderAssistantId: "assistant-a" }),
    ]);

    expect(messages.map((message) => message.id)).toEqual(["a1", "u0", "a2"]);
  });

  it("does not merge replies from different assistants in a shared room", () => {
    const messages = coalesceAssistantRunMessages([
      assistant("a1", "Research result", { senderAssistantId: "assistant-a" }),
      assistant("a2", "Sales result", { senderAssistantId: "assistant-b" }),
    ]);

    expect(messages.map((message) => message.id)).toEqual(["a1", "a2"]);
  });

  it("treats null and absent pre-migration assistant ids as the same fallback voice", () => {
    const messages = coalesceAssistantRunMessages([
      assistant("a1", "Working", {
        senderAssistantId: null,
        toolsUsed: [tool("t1")],
      }),
      assistant("a2", "Finished"),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: "a2", text: "Finished" });
  });
});

describe("[COMP:app-web/chat-transcript] group-chat timeline metadata", () => {
  const msg = (
    over: Partial<ChatSurfaceMessage> & { timestamp: Date },
  ): ChatSurfaceMessage => ({
    id: "m",
    role: "user",
    text: "hi",
    ...over,
  });

  it("opens a day separator on every local calendar day turnover", () => {
    const meta = computeTranscriptRowMeta([
      msg({ timestamp: new Date(2026, 7, 5, 22, 0) }),
      msg({ timestamp: new Date(2026, 7, 5, 23, 59) }),
      msg({ timestamp: new Date(2026, 7, 6, 0, 1) }),
    ]);
    expect(meta.map((m) => m.daySeparator !== null)).toEqual([
      true,
      false,
      true,
    ]);
    // A new day always restarts the sender group.
    expect(meta[2].startsGroup).toBe(true);
  });

  it("groups a same-sender burst and splits on sender change or a long gap", () => {
    const base = new Date(2026, 7, 6, 10, 0);
    const after = (minutes: number) =>
      new Date(base.getTime() + minutes * 60_000);
    const meta = computeTranscriptRowMeta([
      msg({ timestamp: base, senderName: "Alice" }),
      // Same sender, inside the 5-minute window: continuation.
      msg({ timestamp: after(2), senderName: "Alice" }),
      // Sender change splits even inside the window.
      msg({ timestamp: after(3), senderName: "Bob" }),
      // Same sender but past the window: a new burst.
      msg({ timestamp: after(20), senderName: "Bob" }),
      // The assistant's reply is its own group…
      msg({
        timestamp: after(21),
        role: "assistant",
        senderAssistantId: "a-1",
      }),
      // …and a different answering assistant splits again.
      msg({
        timestamp: after(22),
        role: "assistant",
        senderAssistantId: "a-2",
      }),
    ]);
    expect(meta.map((m) => m.startsGroup)).toEqual([
      true,
      false,
      true,
      true,
      true,
      true,
    ]);
  });

  it("treats the viewer's own unattributed rows as one sender", () => {
    const base = new Date(2026, 7, 6, 10, 0);
    const meta = computeTranscriptRowMeta([
      msg({ timestamp: base }),
      msg({ timestamp: new Date(base.getTime() + 60_000) }),
    ]);
    expect(meta[1].startsGroup).toBe(false);
  });

  it("never draws a separator off an unparseable timestamp", () => {
    const meta = computeTranscriptRowMeta([
      msg({ timestamp: new Date(NaN) }),
      msg({ timestamp: new Date(2026, 7, 6, 10, 0) }),
    ]);
    expect(meta[0].daySeparator).toBeNull();
    expect(meta[1].daySeparator).not.toBeNull();
  });

  it("labels today, yesterday, and explicit dates (year only when it differs)", () => {
    const labels = { today: "Today", yesterday: "Yesterday" };
    const now = new Date(2026, 7, 6, 12, 0);
    expect(
      formatTranscriptDayLabel(new Date(2026, 7, 6, 1, 0), now, "en", labels),
    ).toBe("Today");
    expect(
      formatTranscriptDayLabel(new Date(2026, 7, 5, 23, 0), now, "en", labels),
    ).toBe("Yesterday");
    expect(
      formatTranscriptDayLabel(new Date(2026, 7, 1), now, "en", labels),
    ).not.toContain("2026");
    expect(
      formatTranscriptDayLabel(new Date(2025, 7, 1), now, "en", labels),
    ).toContain("2025");
  });

  it("formats the compact per-group time chip", () => {
    const stamp = new Date(2026, 7, 6, 14, 5);
    expect(formatTranscriptTime(stamp, "en")).toMatch(/2:05/);
  });
});
