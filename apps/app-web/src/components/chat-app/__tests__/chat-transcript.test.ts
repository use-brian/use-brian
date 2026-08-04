import { describe, expect, it } from "vitest";
import type { ToolUsed } from "@use-brian/chat-ui";
import {
  coalesceAssistantRunMessages,
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
