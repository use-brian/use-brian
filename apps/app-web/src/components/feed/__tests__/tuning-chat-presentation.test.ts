/**
 * [COMP:app-web/feed-tuning-chat] The Feed rail as a `page`-profile
 * presentation of the shared conversation controller (M5 WP-E), exercised
 * with fake transports: its typed request fields reach the POST (an invalid
 * draft target is refused before any request), a fresh sticky channel sends
 * on a provisional entry that re-keys to its session, Retry resends the
 * original target through `edit`, Always allow is accepted only on cards that
 * offer it, and the committed reply keeps the Feed's documents, citations and
 * files. Replaces the rail's own SSE loops, recovery transport, Stop and
 * approval callbacks. Spec: docs/architecture/feed/draft-collaboration.md →
 * "Feed chat streaming".
 */
import { describe, expect, it } from "vitest";
import { createConversationController } from "@/lib/chat/conversation-controller";
import { createConversationRegistry, provisionalConversationKey } from "@/lib/chat/conversation-registry";
import { SCOPE, TURN_A, fakeScheduler, fakeTransport, settle } from "@/lib/chat/__tests__/conversation-fakes";
import { parsePresentedDocumentPayload } from "@/lib/api/sessions";
import { describeToolFromInput } from "@/lib/tool-narration";
import { en } from "@/lib/i18n/dictionaries/en";
import { feedRequestFields } from "../tuning-chat-panel";

const DRAFT = "11111111-1111-4111-8111-111111111111";

function fixture() {
  const net = fakeTransport();
  const clock = fakeScheduler();
  const registry = createConversationRegistry({
    createController: (init) => createConversationController({ ...init, transport: net.transport, scheduler: clock.scheduler }),
    setTimeout: (callback, ms) => clock.scheduler.setTimeout(callback, ms),
    currentIdentity: () => ({ viewerId: SCOPE.viewerId, apiOrigin: SCOPE.apiOrigin }),
  });
  const capabilities = {
    profile: "page" as const,
    pendingProbe: false,
    describeTool: (name: string, input: Record<string, unknown>) => describeToolFromInput(name, input, en.chat.toolNarration),
    parseDocument: (payload: Record<string, unknown>) => parsePresentedDocumentPayload(payload),
  };
  return { net, clock, registry, capabilities };
}

describe("[COMP:app-web/feed-tuning-chat] Feed rail presentation", () => {
  it("sends the rail's typed fields and refuses an invalid draft target without a request", async () => {
    const t = fixture();
    const controller = t.registry.acquire(SCOPE, { sessionId: DRAFT });
    t.registry.attach(controller, "feed", t.capabilities);
    const bodyExtras = feedRequestFields({
      feedTarget: { sessionId: DRAFT, revision: 4 }, reply: { id: "row-1", text: "Earlier" },
      channelId: "tuning", model: "pro", researchMode: true,
    });
    void controller.send({ presentationId: "feed", text: "Tighten this", assistantId: "writer", bodyExtras });
    await settle();
    expect(t.net.chats[0]!.body).toMatchObject({
      message: "Tighten this", sessionId: DRAFT, assistantId: "writer", feedTarget: { sessionId: DRAFT, revision: 4 },
      replyTo: { id: "row-1", text: "Earlier" }, channelId: "tuning", model: "pro", mode: "research",
    });
    t.net.chats[0]!.sse.send("session", { sessionId: DRAFT, turnId: TURN_A });
    t.net.chats[0]!.sse.send("done", { turnId: TURN_A }); t.net.chats[0]!.sse.close();
    await settle();
    const invalid = await controller.send({
      presentationId: "feed", text: "Again",
      bodyExtras: feedRequestFields({ feedTarget: { sessionId: "not-a-session", revision: 1 } as never, channelId: "tuning", model: "standard", researchMode: false }),
    });
    expect(invalid).toBe("invalid");
    expect(t.net.chats).toHaveLength(1);
  });

  it("omits the sticky channel when a fixed session is bound", () => {
    expect(feedRequestFields({ fixedSessionId: DRAFT, channelId: "plan", model: "standard", researchMode: false })).toEqual({ model: "standard" });
    expect(feedRequestFields({ reply: { text: "Unsaved quote" }, channelId: "plan", model: "max", researchMode: false })).toEqual({ channelId: "plan", model: "max" });
  });

  it("a fresh channel sends on a provisional entry that re-keys to its session", async () => {
    const t = fixture();
    const key = provisionalConversationKey("feed", "writer:plan");
    const controller = t.registry.acquire(SCOPE, { provisional: key });
    t.registry.attach(controller, "feed", t.capabilities);
    void controller.send({ presentationId: "feed", text: "Plan next week", bodyExtras: { channelId: "plan" } });
    await settle();
    expect(t.net.chats[0]!.body).not.toHaveProperty("sessionId");
    t.net.chats[0]!.sse.send("session", { sessionId: DRAFT, turnId: TURN_A });
    await settle();
    // The rail re-renders with the adopted id and acquires the same entry.
    expect(t.registry.acquire(SCOPE, { sessionId: DRAFT })).toBe(controller);
  });

  it("Retry resends the original target and quote through edit", async () => {
    const t = fixture();
    const controller = t.registry.acquire(SCOPE, { sessionId: DRAFT });
    t.registry.attach(controller, "feed", t.capabilities);
    const target = { sessionId: DRAFT, revision: 4 };
    void controller.send({ presentationId: "feed", text: "Refine this", bodyExtras: feedRequestFields({ feedTarget: target, channelId: "tuning", model: "standard", researchMode: false }) });
    await settle();
    const first = t.net.chats[0]!.sse;
    first.send("session", { sessionId: DRAFT, turnId: TURN_A });
    first.send("user_message_saved", { id: "user-row" });
    first.send("text_delta", { text: "Refined" });
    first.send("done", { turnId: TURN_A }); first.close();
    await settle();
    void controller.edit({
      presentationId: "feed", messageId: "user-row", text: "Refine this",
      bodyExtras: feedRequestFields({ feedTarget: target, reply: { id: "quoted", text: "Earlier" }, channelId: "tuning", model: "standard", researchMode: false }),
    });
    await settle();
    expect(t.net.chats[1]!.body).toMatchObject({ truncateFromMessageId: "user-row", feedTarget: target, replyTo: { id: "quoted", text: "Earlier" } });
  });

  it("accepts Always allow only on a card that offers it", async () => {
    const t = fixture();
    const controller = t.registry.acquire(SCOPE, { sessionId: DRAFT });
    t.registry.attach(controller, "feed", t.capabilities);
    void controller.send({ presentationId: "feed", text: "Run the action" });
    await settle();
    const sse = t.net.chats[0]!.sse;
    sse.send("session", { sessionId: DRAFT, turnId: TURN_A });
    sse.send("tool_confirmation_required", { toolCallId: "plain", toolName: "writeExample" });
    sse.send("tool_confirmation_required", { toolCallId: "lasting", toolName: "writeExample", allowPersistentApproval: true });
    await settle();
    expect(await controller.respondConfirmation("plain", "always_allow")).toBe("invalid");
    expect(await controller.respondConfirmation("lasting", "always_allow")).toBe("resolved");
    expect(t.net.transport.confirmLive).toHaveBeenCalledTimes(1);
    expect(t.net.transport.confirmLive).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: "lasting", decision: "always_allow" }));
  });

  it("commits the Feed's documents, citations and files on the page profile", async () => {
    const t = fixture();
    const controller = t.registry.acquire(SCOPE, { sessionId: DRAFT });
    t.registry.attach(controller, "feed", t.capabilities);
    void controller.send({ presentationId: "feed", text: "Improve the draft" });
    await settle();
    const sse = t.net.chats[0]!.sse;
    sse.send("session", { sessionId: DRAFT, turnId: TURN_A });
    sse.send("tool_start", { id: "tool", name: "searchKnowledge" });
    sse.send("tool_result", { id: "tool" });
    sse.send("text_delta", { text: "A clearer opening" });
    sse.send("citation", { sources: [{ url: "https://example.com", title: "Reference" }] });
    sse.send("attachments", { attachments: [{ fileId: "file", workspaceId: SCOPE.workspaceId, path: "draft.txt", name: "draft.txt", mime: "text/plain", sizeBytes: 10 }] });
    sse.send("document_payload", { toolUseId: "doc", title: "Source document", content: "Exact source" });
    sse.send("done", { turnId: TURN_A }); sse.close();
    await settle();
    const reply = controller.getSnapshot().transcript.messages.at(-1)!;
    expect(reply).toMatchObject({ role: "assistant", text: "A clearer opening" });
    expect(reply.toolsUsed?.map((tool) => tool.name)).toEqual(["searchKnowledge"]);
    expect(reply.citations?.map((citation) => citation.title)).toEqual(["Reference"]);
    expect(reply.fileAttachments?.map((file) => file.name)).toEqual(["draft.txt"]);
    expect(reply.documents?.map((document) => document.title)).toEqual(["Source document"]);
  });
});
