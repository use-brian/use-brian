import { describe, it, expect } from "vitest";
import { en } from "@/lib/i18n/dictionaries/en";
import { feedConfirmation, feedTurnMessage, foldFeedChatEvent, mapFeedTranscript, newFeedChatTurn } from "../feed-chat-stream";
import type { DocSessionMessage } from "../api/sessions";
const dict = en.chat.toolNarration;
const fold = (events: [string, Record<string, unknown>][]) => events.reduce((turn, [event, data], index) => foldFeedChatEvent(turn, event, data, dict, 1000 + index * 100), newFeedChatTurn(1000));
describe("[COMP:app-web/feed-chat-stream] protocol display", () => {
  it("retains the reply through saving and finishing and restores a reconnect phase", () => {
    const saving = fold([["text_delta", { text: "Hello" }], ["reply_text_complete", {}]]);
    expect(saving).toMatchObject({ text: "Hello", visibleText: "Hello", replyPhase: "saving" });
    const finishing = foldFeedChatEvent(saving, "assistant_message_saved", { id: "saved" }, dict);
    expect(finishing).toMatchObject({ replyPhase: "finishing", messageId: "saved" });
    expect(foldFeedChatEvent(finishing, "reply_text_complete", {}, dict).replyPhase).toBe("finishing");
    expect(fold([["snapshot", { text: "Hello", replyPhase: "finishing" }]])).toMatchObject({ visibleText: "Hello", replyPhase: "finishing" });
    expect(foldFeedChatEvent(finishing, "text_delta", { text: " again" }, dict).replyPhase).toBe("generating");
    expect(foldFeedChatEvent(finishing, "tool_start", { id: "next", name: "listTasks" }, dict).replyPhase).toBe("generating");
  });
  it("streams interleaved reasoning and delegated tool activity, retracts dropped calls and receipts the final segment", () => {
    const turn = fold([
      ["reasoning", { text: "Checking the opening" }], ["worker_start", { workerId: "worker", description: "Review the source" }],
      ["text_delta", { text: "I will check." }], ["tool_start", { id: "tool", name: "searchKnowledge", workerId: "worker" }],
      ["tool_input", { id: "tool", name: "searchKnowledge", input: { query: "launch" } }],
      ["tool_start", { id: "dropped", name: "readKnowledgeEntry" }], ["tool_dropped", { id: "dropped" }],
      ["tool_result", { id: "tool", isError: true, errorMessage: "Source unavailable" }],
      ["assistant_message_saved", { id: "internal" }], ["reasoning", { text: "Use the verified source" }],
      ["text_delta", { text: "The final " }], ["text_delta", { text: "answer." }], ["assistant_message_saved", { id: "final" }],
    ]);
    expect(turn.text).toBe("The final answer.");
    expect(turn.tools).toHaveLength(1);
    expect(turn.tools[0]).toMatchObject({ workerId: "worker", workerDescription: "Review the source", status: "retried", durationMs: 400, errorMessage: "Source unavailable" });
    expect(turn.log.events.map(event => event.kind)).toEqual(["reasoning", "step", "reasoning"]);
    expect(feedTurnMessage(turn, 3000)).toMatchObject({ id: "final", text: "The final answer.", activityDurationMs: 2000 });
  });
  it("retains an answer followed only by bookkeeping, without duplicate replayed tool rows", () => {
    const turn = fold([["text_delta", { text: "Answer" }], ["tool_start", { id: "save", name: "saveMemory" }], ["tool_start", { id: "save", name: "saveMemory" }]]);
    expect(turn.visibleText).toBe("");
    expect(feedTurnMessage(turn)?.text).toBe("Answer");
    expect(turn.tools).toHaveLength(1);
  });
  it("replaces snapshot text and reasoning without duplicating repeated frames", () => {
    const turn = fold([["text_delta", { text: "Old" }], ["snapshot", { text: "Whole reply", reasoning: "Checking" }], ["snapshot", { text: "Whole reply", reasoning: "Checking" }]]);
    expect(turn.visibleText).toBe("Whole reply");
    expect(turn.log.events).toHaveLength(1);
  });
  it("renders file-only and document-only turns and deduplicates citations and payload ids", () => {
    const file = { fileId: "file", workspaceId: "workspace", path: "draft.txt", name: "draft.txt", mime: "text/plain", sizeBytes: 10 };
    const document = { toolUseId: "doc", title: "Source", content: "Exact text", format: "text" };
    const turn = fold([["attachments", { attachments: [file, file, {}] }], ["document_payload", document], ["document_payload", document], ["citation", { sources: [{ url: "https://example.com", title: "Source" }, { url: "https://example.com", title: "Source" }, {}] }]]);
    expect(feedTurnMessage(turn)).toMatchObject({ text: "", fileAttachments: [file], documents: [{ id: "doc", title: "Source" }], citations: [{ url: "https://example.com", title: "Source" }] });
  });
  it("recovers tool inputs first observed after reconnect and keeps research phases", () => {
    const turn = fold([["status", { phase: "research_parallel" }], ["tool_input", { id: "tool", name: "searchKnowledge", input: { query: "opening" } }], ["tool_result", { id: "tool" }]]);
    expect(turn.researchPhase).toBe("parallel");
    expect(turn.tools).toHaveLength(1);
    expect(turn.tools[0].status).toBe("done");
  });
  it("maps persisted internal rounds to one answer with files and document receipts", () => {
    const row = (id: string, content: unknown): DocSessionMessage => ({ id, role: "assistant", content, timestamp: "2026-01-01T00:00:00Z", senderName: null, senderUserId: null });
    const messages = mapFeedTranscript([
      row("internal", [{ type: "text", text: "Checking" }, { type: "tool_use", id: "tool", name: "searchKnowledge", input: { query: "opening" } }]),
      row("answer", [{ type: "text", text: "Answer" }, { type: "tool_use", id: "doc", name: "presentDocument", input: { title: "Source", content: "Exact text", format: "text" } }]),
    ], dict);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: "answer", text: "Answer", toolsUsed: [{ id: "tool" }, { id: "doc" }], documents: [{ id: "doc" }] });
  });
  it("requires an actual resolver and session for confirmation, preserving the approval identity", () => {
    expect(feedConfirmation({}, "session")).toBeNull();
    expect(feedConfirmation({ toolCallId: "tool" }, "")).toBeNull();
    expect(feedConfirmation({ toolCallId: "tool", approvalId: "approval", toolName: "sendFile", input: { fileId: "file" }, displayLines: ["Review", 3] }, "session")).toMatchObject({ toolCallId: "tool", approvalId: "approval", sessionId: "session", status: "pending", displayLines: ["Review"] });
  });
});
