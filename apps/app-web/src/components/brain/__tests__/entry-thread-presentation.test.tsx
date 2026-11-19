// @vitest-environment jsdom
/**
 * [COMP:app-web/review-thread-conversation] The Brain review threads (entry
 * Ask thread, entry Edit thread, memory inspection drawer) as presentations
 * of the shared conversation controller (M5 WP-E), on fake transports:
 * a minted session binds the session-keyed entry before the first turn, the
 * dock profile accumulates the tool timeline the former `reduceToolEvent`
 * owned, Stop is the controller's compare-and-set Stop (the entry thread's
 * former Stop only aborted the local stream), the mid-turn queue drains at
 * `done`, edit approvals go through `respondConfirmation`, and the applied
 * edit's receipt reaches the edit thread once.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/offline/application-write-authority", () => ({
  currentOfflineWriteAuthority: (workspaceId: string) => ({
    viewerId: "viewer-1", workspaceId, applicationId: "native", apiOrigin: "https://api.example",
  }),
}));
const history = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, calls: 0 }));
vi.mock("@/lib/api/sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/sessions")>()),
  fetchSessionMessages: vi.fn(async () => { history.calls++; return history.rows; }),
}));

import { createConversationController, type ConversationController, type ConversationSendResult } from "@/lib/chat/conversation-controller";
import { createConversationRegistry } from "@/lib/chat/conversation-registry";
import type { ClassifiedTurnFrame } from "@/lib/chat/turn-frames";
import { SCOPE, TURN_A, deferred, fakeScheduler, fakeTransport, settle } from "@/lib/chat/__tests__/conversation-fakes";
import { buildEntryPreamble, entryTurnOutcome } from "../entry-thread";
import { appliedEditRowId, editConfirmationCard } from "../entry-edit-thread";
import { buildMemoryPreamble } from "@/components/memories/inspection-drawer";
import {
  mapReviewHistoryRows,
  reviewThreadView,
  stripReviewPreamble,
  useReviewConversation,
  type ReviewThreadKind,
} from "../review-thread-conversation";

function fixture() {
  const net = fakeTransport();
  const clock = fakeScheduler();
  const registry = createConversationRegistry({
    createController: (init) => createConversationController({ ...init, transport: net.transport, scheduler: clock.scheduler }),
    setTimeout: (callback, ms) => clock.scheduler.setTimeout(callback, ms),
    currentIdentity: () => ({ viewerId: SCOPE.viewerId, apiOrigin: SCOPE.apiOrigin }),
  });
  /** One review thread bound to a minted session, as the hook attaches it. */
  const thread = (sessionId: string, onSurfaceEffect?: (frame: ClassifiedTurnFrame) => void) => {
    const controller = registry.acquire(SCOPE, { sessionId });
    const detach = registry.attach(controller, `thread-${sessionId}`, { profile: "dock", onSurfaceEffect, pendingProbe: false });
    return { controller, detach, presentationId: `thread-${sessionId}` };
  };
  return { net, clock, registry, thread };
}

async function streamReply(controller: ConversationController, send: Promise<ConversationSendResult>, net: ReturnType<typeof fakeTransport>, frames: Array<[string, unknown]>) {
  await settle();
  const sse = net.lastChat().sse;
  for (const [event, data] of frames) sse.send(event, data);
  await settle();
  return { sse, send, controller };
}

afterEach(() => { vi.restoreAllMocks(); history.rows = []; history.calls = 0; });

describe("[COMP:app-web/review-thread-conversation] preamble display and history", () => {
  it("shows only the question of a primed first message", () => {
    const entry = buildEntryPreamble("Ship the beta", "Body", { originLine: null }) + "Why was this saved?";
    const memory = buildMemoryPreamble("Ada", "Prefers mornings", null) + "Is this right?";
    expect(stripReviewPreamble(entry)).toBe("Why was this saved?");
    expect(stripReviewPreamble(memory)).toBe("Is this right?");
    expect(stripReviewPreamble("[draft] plain text [User asks]\nkeep")).toBe("[draft] plain text [User asks]\nkeep");
    expect(stripReviewPreamble("A follow-up")).toBe("A follow-up");
  });

  it("maps authorized history to text turns only", () => {
    const messages = mapReviewHistoryRows([
      { id: "u1", role: "user", content: "Question", timestamp: "2026-11-17T00:00:00Z", senderUserId: "viewer-1" },
      { id: "t1", role: "tool", content: "ignored", timestamp: "2026-11-17T00:00:01Z", senderUserId: null },
      { id: "a1", role: "assistant", content: [{ type: "text", text: "Answer" }], timestamp: "2026-11-17T00:00:02Z", senderUserId: null },
      { id: "a2", role: "assistant", content: "   ", timestamp: "2026-11-17T00:00:03Z", senderUserId: null },
    ] as never);
    expect(messages.map((message) => [message.id, message.role, message.text])).toEqual([["u1", "user", "Question"], ["a1", "assistant", "Answer"]]);
  });
});

describe("[COMP:app-web/brain-entry-thread] the Ask thread on the controller", () => {
  it("sends on the session-keyed entry and accumulates the tool timeline", async () => {
    const t = fixture();
    const { controller, presentationId } = t.thread("inspect-1");
    const send = controller.send({ presentationId, text: "Why?", assistantId: "assistant-1", bodyExtras: { timezone: "UTC" } });
    await streamReply(controller, send, t.net, [
      ["session", { sessionId: "inspect-1", turnId: TURN_A }],
      ["reasoning", { text: "Looking at the source\nChecking provenance" }],
      ["tool_start", { id: "t1", name: "searchKnowledge" }],
      ["tool_start", { id: "t1", name: "searchKnowledge" }],
      ["tool_start", { id: "t2", name: "readPage" }],
      ["tool_start", { id: "t3", name: "listTasks" }],
      ["tool_result", { id: "t1" }],
      ["tool_result", { id: "t2", isError: true }],
      ["tool_dropped", { id: "t3" }],
      ["text_delta", { text: "It came from a meeting." }],
    ]);
    t.clock.runFrames();
    expect(t.net.lastChat().body).toMatchObject({ sessionId: "inspect-1", assistantId: "assistant-1", timezone: "UTC", message: "Why?" });
    const live = reviewThreadView(controller.getSnapshot());
    expect(live.busy).toBe(true);
    // Dedup start, done / retried results, dropped removal.
    expect(live.liveTools.map((tool) => [tool.id, tool.status])).toEqual([["t1", "done"], ["t2", "retried"]]);
    expect(live.reasoningTail).toBe("Checking provenance");
    expect(live.streamingText).toBe("It came from a meeting.");
    const sse = t.net.lastChat().sse;
    sse.send("assistant_message_saved", { id: "m-1" });
    sse.send("done", { turnId: TURN_A });
    sse.close();
    expect(await send).toBe("completed");
    const settled = reviewThreadView(controller.getSnapshot());
    expect(settled.busy).toBe(false);
    const reply = settled.messages.at(-1)!;
    // Dock profile: the committed reply keeps the server row id and its steps.
    expect(reply).toMatchObject({ id: "m-1", role: "assistant", text: "It came from a meeting." });
    expect(reply.toolsUsed?.map((tool) => tool.id)).toEqual(["t1", "t2"]);
    expect(entryTurnOutcome("completed", controller.getSnapshot())).toBeNull();
  });

  it("stops the server turn with compare-and-set first, keeps painting while it is pending, then settles", async () => {
    const t = fixture();
    const { controller, presentationId } = t.thread("inspect-2");
    const pendingStop = deferred<{ stopped: boolean }>();
    t.net.transport.stopTurn.mockImplementationOnce(() => pendingStop.promise);
    const send = controller.send({ presentationId, text: "Explain" });
    const { sse } = await streamReply(controller, send, t.net, [["session", { sessionId: "inspect-2", turnId: TURN_A }]]);
    const stopped = controller.stop();
    await settle();
    expect(t.net.transport.stopTurn).toHaveBeenCalledWith("inspect-2", TURN_A);
    // Still reading the direct stream while the stop request is outstanding.
    expect(sse.aborted()).toBe(false);
    sse.send("text_delta", { text: "partial" });
    await settle();
    t.clock.runFrames();
    expect(controller.getSnapshot().transcript.streamingText).toBe("partial");
    pendingStop.resolve({ stopped: true });
    expect(await stopped).toBe("stopped");
    expect(sse.aborted()).toBe(true);
    expect(await send).toBe("stopped");
    expect(entryTurnOutcome("stopped", controller.getSnapshot())).toMatchObject({ kind: "stopped" });
  });

  it("leaves the turn running and says so when the stop request fails", async () => {
    const t = fixture();
    const { controller, presentationId } = t.thread("inspect-3");
    t.net.transport.stopTurn.mockRejectedValueOnce(new Error("offline"));
    const send = controller.send({ presentationId, text: "Explain" });
    const { sse } = await streamReply(controller, send, t.net, [["session", { sessionId: "inspect-3", turnId: TURN_A }]]);
    expect(await controller.stop()).toBe("failed");
    expect(sse.aborted()).toBe(false);
    expect(reviewThreadView(controller.getSnapshot()).busy).toBe(true);
    expect(controller.getSnapshot().notices.map((notice) => notice.code)).toContain("stopTurnFailed");
    sse.send("done", { turnId: TURN_A });
    sse.close();
    await send;
  });

  it("queues a follow-up into the running turn and sends what it never took at done", async () => {
    const t = fixture();
    const { controller, presentationId } = t.thread("inspect-4");
    const send = controller.send({ presentationId, text: "First" });
    const { sse } = await streamReply(controller, send, t.net, [["session", { sessionId: "inspect-4", turnId: TURN_A }]]);
    expect(controller.queue("And the owner?", false, { bodyExtras: { timezone: "UTC" } })).toBe(true);
    await settle();
    expect(t.net.sides.at(-1)).toMatchObject({ message: "And the owner?", midTurn: true, sessionId: "inspect-4", timezone: "UTC" });
    sse.send("text_delta", { text: "Answer" });
    sse.send("done", { turnId: TURN_A });
    sse.close();
    expect(await send).toBe("completed");
    await t.clock.advance(1);
    await settle();
    // The never-taken follow-up became one ordinary turn.
    expect(t.net.chats).toHaveLength(2);
    expect(t.net.lastChat().body).toMatchObject({ message: "And the owner?", sessionId: "inspect-4" });
  });

  it("states a failed or empty turn instead of leaving a silent gap", async () => {
    const t = fixture();
    const { controller, presentationId } = t.thread("inspect-5");
    const send = controller.send({ presentationId, text: "Explain" });
    const { sse } = await streamReply(controller, send, t.net, [
      ["session", { sessionId: "inspect-5", turnId: TURN_A }],
      ["user_message_saved", { id: "u-5" }],
      ["error", { code: "model_unavailable", message: "This model is not available." }],
      ["done", { turnId: TURN_A }],
    ]);
    sse.close();
    expect(await send).toBe("failed");
    expect(entryTurnOutcome("failed", controller.getSnapshot())).toEqual({
      afterMessageId: "u-5", kind: "failed", detail: "This model is not available.",
    });
    const next = controller.send({ presentationId, text: "Again" });
    await streamReply(controller, next, t.net, [["user_message_saved", { id: "u-6" }], ["done", { turnId: TURN_A }]]);
    t.net.lastChat().sse.close();
    expect(await next).toBe("completed");
    expect(entryTurnOutcome("completed", controller.getSnapshot())).toEqual({ afterMessageId: "u-6", kind: "empty" });
  });
});

describe("[COMP:app-web/brain-entry-edit-thread] edit approvals and the applied receipt", () => {
  it("approves through the controller and delivers the applied edit once", async () => {
    const t = fixture();
    const effects: ClassifiedTurnFrame[] = [];
    const { controller, presentationId } = t.thread("edit-1", (frame) => effects.push(frame));
    const send = controller.send({ presentationId, text: "Fix the date", assistantId: "assistant-1" });
    const { sse } = await streamReply(controller, send, t.net, [
      ["session", { sessionId: "edit-1", turnId: TURN_A }],
      ["tool_confirmation_required", { toolCallId: "call-1", toolName: "updateBrainEntry", input: { dueAt: "2026-12-01" }, displayLines: ["Due: 2026-12-01"] }],
    ]);
    const card = controller.getSnapshot().transcript.pendingConfirmations[0]!;
    expect(editConfirmationCard(card, "Edit with assistant")).toMatchObject({ toolCallId: "call-1", displayName: "Edit with assistant", status: "pending" });
    expect(editConfirmationCard({ ...card, toolName: "other", displayName: "Other" }, "Edit with assistant").displayName).toBe("Other");
    expect(await controller.respondConfirmation("call-1", "approve")).toBe("resolved");
    expect(t.net.transport.confirmLive).toHaveBeenCalledWith({ sessionId: "edit-1", toolCallId: "call-1", decision: "allow" });
    sse.send("brain_entry_updated", { primitive: "task", liveRowId: "row-2" });
    sse.send("text_delta", { text: "Updated." });
    sse.send("done", { turnId: TURN_A });
    sse.close();
    expect(await send).toBe("completed");
    expect(effects.map((frame) => frame.event)).toEqual(["brain_entry_updated"]);
    expect(appliedEditRowId(effects[0]!, "task")).toBe("row-2");
    expect(appliedEditRowId(effects[0]!, "memory")).toBeNull();
  });

  it("keeps the card retryable when the server refuses the decision", async () => {
    const t = fixture();
    const { controller, presentationId } = t.thread("edit-2");
    t.net.transport.confirmLive.mockResolvedValueOnce({ ok: false, status: 403 });
    const send = controller.send({ presentationId, text: "Rename it" });
    const { sse } = await streamReply(controller, send, t.net, [
      ["session", { sessionId: "edit-2", turnId: TURN_A }],
      ["tool_confirmation_required", { toolCallId: "call-2", toolName: "updateBrainEntry" }],
    ]);
    expect(await controller.respondConfirmation("call-2", "approve")).toBe("forbidden");
    expect(controller.getSnapshot().transcript.pendingConfirmations[0]!.status).toBe("pending");
    expect(controller.getSnapshot().notices.map((notice) => notice.code)).toContain("confirmNotAllowed");
    sse.send("done", { turnId: TURN_A });
    sse.close();
    await send;
  });
});

describe("[COMP:app-web/brain-inspection-drawer] a dropped reply re-attaches instead of reading as empty", () => {
  it("follows the running turn after a bare close and re-reads history at done", async () => {
    const t = fixture();
    const { controller, presentationId } = t.thread("inspect-9");
    const send = controller.send({ presentationId, text: buildMemoryPreamble("Ada", "Prefers mornings", null) + "Keep it?" });
    const { sse } = await streamReply(controller, send, t.net, [
      ["session", { sessionId: "inspect-9", turnId: TURN_A }],
      ["text_delta", { text: "Probably" }],
    ]);
    sse.close();
    expect(await send).toBe("disconnected");
    await settle();
    expect(reviewThreadView(controller.getSnapshot()).busy).toBe(true);
    expect(controller.getSnapshot().notices.map((notice) => notice.code)).toContain("reconnecting");
    const epoch = controller.getSnapshot().historyEpoch;
    const follow = t.net.lastFollow();
    expect(follow.sessionId).toBe("inspect-9");
    follow.sse!.send("status", { status: "running", turnId: TURN_A });
    follow.sse!.send("turn_completed", { turnId: TURN_A, reason: "completed" });
    follow.sse!.send("done", {});
    await settle();
    expect(reviewThreadView(controller.getSnapshot()).busy).toBe(false);
    expect(controller.getSnapshot().historyEpoch).toBeGreaterThan(epoch);
  });
});

describe("[COMP:app-web/review-thread-conversation] binding a minted session", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = container = null;
  });

  it("sends the first turn on the session-keyed entry once this presentation is attached", async () => {
    const t = fixture();
    let api: ReturnType<typeof useReviewConversation> | null = null;
    function Probe({ sessionId, kind }: { sessionId: string | null; kind: ReviewThreadKind }) {
      api = useReviewConversation({ workspaceId: SCOPE.workspaceId, sessionId, kind, registry: t.registry });
      return null;
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<Probe sessionId={null} kind="entry-thread" />); });
    const provisional = api!.controller!;
    expect(provisional.getSessionId()).toBeNull();
    let sent!: Promise<ConversationSendResult>;
    // The host mints the session, binds it and sends in the same tick.
    await act(async () => {
      sent = api!.sendBound("inspect-7", { text: "Why?", assistantId: "assistant-1" });
      root!.render(<Probe sessionId="inspect-7" kind="entry-thread" />);
    });
    await act(async () => { await settle(); });
    const bound = api!.controller!;
    expect(bound).not.toBe(provisional);
    expect(bound.getSessionId()).toBe("inspect-7");
    expect(bound.presentationCount()).toBe(1);
    // An async send reads its outcome from the entry bound now, not its render's.
    expect(api!.currentController()).toBe(bound);
    expect(t.net.chats).toHaveLength(1);
    expect(t.net.lastChat().body).toMatchObject({ sessionId: "inspect-7", assistantId: "assistant-1", message: "Why?" });
    // No pending-input probe for a fresh row-bound session.
    expect(t.net.transport.fetchPending).not.toHaveBeenCalled();
    await act(async () => {
      const sse = t.net.lastChat().sse;
      sse.send("session", { sessionId: "inspect-7", turnId: TURN_A });
      sse.send("done", { turnId: TURN_A });
      sse.close();
      await settle();
    });
    expect(await sent).toBe("completed");
  });

  it("re-reads authorized rows when the controller bumps history", async () => {
    const t = fixture();
    history.rows = [{ id: "u1", role: "user", content: "Q", timestamp: "2026-11-17T00:00:00Z", senderUserId: "viewer-1" }];
    let api: ReturnType<typeof useReviewConversation> | null = null;
    function Probe() {
      api = useReviewConversation({ workspaceId: SCOPE.workspaceId, sessionId: "inspect-8", kind: "inspection-drawer", registry: t.registry });
      return null;
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(<Probe />); });
    expect(history.calls).toBe(0);
    await act(async () => { await api!.controller!.reloadHistory(); await settle(); });
    expect(history.calls).toBe(1);
    expect(api!.state!.transcript.messages.map((message) => message.id)).toEqual(["u1"]);
  });
});
