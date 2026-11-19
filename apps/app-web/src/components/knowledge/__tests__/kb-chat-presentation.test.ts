/**
 * [COMP:app-web/kb-chat-panel] The KB panel as a presentation of the shared
 * conversation controller (M5 WP-E), on fake transports: every turn carries
 * its `kbSourceId` scope anchor and sticky channel, a fresh scope's entry is
 * adopted by its `session` frame, per-edit approvals go through
 * `respondConfirmation` (live and restored after a reload), Stop is the
 * compare-and-set Stop, and notices map to the panel's copy.
 */
import { describe, expect, it } from "vitest";
import { createConversationController } from "@/lib/chat/conversation-controller";
import { createConversationRegistry, provisionalConversationKey } from "@/lib/chat/conversation-registry";
import { SCOPE, TURN_A, fakeScheduler, fakeTransport, settle } from "@/lib/chat/__tests__/conversation-fakes";
import { kbNoticeText, mapKbHistoryRows } from "../kb-chat-panel";

function fixture() {
  const net = fakeTransport();
  const clock = fakeScheduler();
  const registry = createConversationRegistry({
    createController: (init) => createConversationController({ ...init, transport: net.transport, scheduler: clock.scheduler }),
    setTimeout: (callback, ms) => clock.scheduler.setTimeout(callback, ms),
    currentIdentity: () => ({ viewerId: SCOPE.viewerId, apiOrigin: SCOPE.apiOrigin }),
  });
  return { net, clock, registry };
}

const copy = {
  streamError: "Stream failed", stopTurnFailed: "Could not stop", confirmNotAllowed: "Not allowed",
  reconnecting: "Reconnecting", reconnectFailed: "Could not reconnect",
};

describe("[COMP:app-web/kb-chat-panel] the KB panel on the controller", () => {
  it("sends the scope anchor and channel, and the session frame adopts the provisional entry", async () => {
    const t = fixture();
    const provisional = provisionalConversationKey("kb", "kb-scope:src-1:client");
    const controller = t.registry.acquire(SCOPE, { provisional });
    t.registry.attach(controller, "kb", { profile: "dock", mapHistoryRows: mapKbHistoryRows });
    const send = controller.send({
      presentationId: "kb", text: "Update the fee", assistantId: "a-primary",
      bodyExtras: { channelId: "kb-scope:src-1", kbSourceId: "src-1" },
    });
    await settle();
    expect(t.net.lastChat().body).toMatchObject({
      message: "Update the fee", assistantId: "a-primary", channelId: "kb-scope:src-1", kbSourceId: "src-1",
    });
    expect(t.net.lastChat().body).not.toHaveProperty("sessionId");
    const sse = t.net.lastChat().sse;
    sse.send("session", { sessionId: "kb-session", turnId: TURN_A });
    sse.send("tool_confirmation_required", { toolCallId: "call-1", toolName: "updateKnowledgeEntry", displayLines: ["- 5 bps", "+ 4 bps"] });
    await settle();
    // What the panel acquires on its next render: the same, re-keyed entry.
    expect(t.registry.acquire(SCOPE, { sessionId: "kb-session" })).toBe(controller);
    expect(await controller.respondConfirmation("call-1", "approve")).toBe("resolved");
    expect(t.net.transport.confirmLive).toHaveBeenCalledWith({ sessionId: "kb-session", toolCallId: "call-1", decision: "allow" });
    sse.send("text_delta", { text: "Updated." });
    sse.send("done", { turnId: TURN_A });
    sse.close();
    expect(await send).toBe("completed");
  });

  it("accepts the manual pool's sentinel as the scope anchor", async () => {
    const t = fixture();
    const controller = t.registry.acquire(SCOPE, { provisional: "new:kb:manual" });
    t.registry.attach(controller, "kb", { profile: "dock" });
    void controller.send({ presentationId: "kb", text: "Hi", bodyExtras: { channelId: "kb-scope:manual", kbSourceId: "manual" } });
    await settle();
    expect(t.net.lastChat().body).toMatchObject({ kbSourceId: "manual" });
    t.net.lastChat().sse.close();
  });

  it("restores a pending edit approval on a resumed session and settles it through the approvals API", async () => {
    const t = fixture();
    t.net.status.current = { status: "running", turnId: TURN_A };
    t.net.pending.current = {
      pending: null,
      toolConfirmation: {
        toolCallId: "call-9", approvalId: "approval-9", toolName: "updateKnowledgeEntry", input: {},
        sessionId: "kb-session", status: "pending",
      },
    };
    const controller = t.registry.acquire(SCOPE, { sessionId: "kb-session" });
    t.registry.attach(controller, "kb", { profile: "dock", mapHistoryRows: mapKbHistoryRows });
    await settle();
    const card = controller.getSnapshot().transcript.pendingConfirmations[0]!;
    expect(card).toMatchObject({ toolCallId: "call-9", restored: true });
    expect(await controller.respondConfirmation("call-9", "approve")).toBe("resolved");
    expect(t.net.transport.respondRestored).toHaveBeenCalledWith("approval-9", "approved", undefined);
  });

  it("stops with compare-and-set and maps notices to the panel's copy", async () => {
    const t = fixture();
    const controller = t.registry.acquire(SCOPE, { sessionId: "kb-2" });
    t.registry.attach(controller, "kb", { profile: "dock", pendingProbe: false });
    t.net.transport.stopTurn.mockRejectedValueOnce(new Error("offline"));
    const send = controller.send({ presentationId: "kb", text: "Go", bodyExtras: { kbSourceId: "src-2" } });
    await settle();
    const sse = t.net.lastChat().sse;
    sse.send("session", { sessionId: "kb-2", turnId: TURN_A });
    await settle();
    expect(await controller.stop()).toBe("failed");
    expect(t.net.transport.stopTurn).toHaveBeenCalledWith("kb-2", TURN_A);
    expect(kbNoticeText(controller.getSnapshot(), copy)).toEqual({ text: "Could not stop", tone: "error" });
    sse.send("error", { code: "model_unavailable", message: "This model is not available." });
    sse.send("done", { turnId: TURN_A });
    sse.close();
    await send;
    expect(kbNoticeText(controller.getSnapshot(), copy)).toEqual({ text: "This model is not available.", tone: "error" });
  });

  it("maps authorized history to text turns", () => {
    expect(mapKbHistoryRows([
      { id: "m1", role: "user", content: "What are the fees?", timestamp: "2026-11-17T00:00:00Z", senderUserId: "viewer-1" },
      { id: "m2", role: "tool", content: "x", timestamp: "2026-11-17T00:00:01Z", senderUserId: null },
      { id: "m3", role: "assistant", content: "5 bps.", timestamp: "2026-11-17T00:00:02Z", senderUserId: null },
    ] as never).map((message) => message.id)).toEqual(["m1", "m3"]);
  });
});
