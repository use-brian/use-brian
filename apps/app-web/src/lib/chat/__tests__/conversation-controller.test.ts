/**
 * [COMP:app-web/conversation-controller] [COMP:app-web/chat-controller]
 * Send, follow, Stop, approval and recovery over fake transports.
 */
import { describe, expect, it, vi } from "vitest";
import { createConversationController, type ConversationState } from "../conversation-controller";
import { SCOPE, TURN_A, TURN_B, TURN_C, deferred, fakeScheduler, fakeTransport, settle } from "./conversation-fakes";

function setup(opts: { sessionId?: string | null; room?: boolean; reconnect?: Parameters<typeof createConversationController>[0]["reconnect"] } = {}) {
  const net = fakeTransport();
  const clock = fakeScheduler();
  const controller = createConversationController({
    scope: SCOPE, sessionId: opts.sessionId ?? null, room: opts.room, transport: net.transport,
    scheduler: clock.scheduler, reconnect: opts.reconnect,
  });
  const snapshots: ConversationState[] = [];
  controller.subscribe(() => snapshots.push(controller.getSnapshot()));
  const effects = vi.fn();
  controller.attach("page-1", { profile: "page", onSurfaceEffect: effects });
  return { net, clock, controller, snapshots, effects, state: () => controller.getSnapshot() };
}

/** Start a direct turn and bind it to session s-1 / TURN_A. */
async function startTurn(t: ReturnType<typeof setup>, text = "Hello") {
  const onAccepted = vi.fn();
  const onRejected = vi.fn();
  const sent = t.controller.send({ presentationId: "page-1", text, assistantId: "assistant-1", onAccepted, onRejected });
  await settle();
  const sse = t.net.lastChat().sse;
  sse.send("session", { sessionId: "s-1", turnId: TURN_A });
  sse.send("user_message_saved", { id: "row-user-1" });
  await settle();
  return { sent, sse, onAccepted, onRejected };
}

describe("[COMP:app-web/conversation-controller] paint batching", () => {
  it("coalesces deltas per frame and flushes synchronously before terminal frames", async () => {
    const t = setup();
    const { sent, sse } = await startTurn(t);
    const before = t.clock.frameRequests();
    sse.send("text_delta", { text: "Order " });
    sse.send("text_delta", { text: "#1042 " });
    sse.send("reasoning", { text: "checking" });
    await settle();
    // Three paint frames, one scheduled animation frame, nothing published yet.
    expect(t.clock.frameRequests() - before).toBe(1);
    expect(t.state().transcript.streamingText).toBe("");
    t.clock.runFrames();
    expect(t.state().transcript.streamingText).toBe("Order #1042 ");
    sse.send("text_delta", { text: "shipped." });
    sse.send("done", { turnId: TURN_A });
    sse.close();
    await settle();
    expect(await sent).toBe("completed");
    const completed = t.snapshots.findIndex((snapshot) => snapshot.run.phase === "completed");
    const flushed = t.snapshots.findIndex((snapshot) => snapshot.transcript.streamingText === "Order #1042 shipped.");
    expect(flushed).toBeGreaterThan(-1);
    expect(flushed).toBeLessThan(completed);
    expect(t.state().transcript.messages.at(-1)).toMatchObject({ role: "assistant", text: "Order #1042 shipped.", senderAssistantId: "assistant-1" });
    expect(t.state().transcript.messages[0]).toMatchObject({ id: "row-user-1", role: "user", text: "Hello" });
    expect(t.clock.pendingFrames()).toBe(0);
  });

  it("dispatches surface effects once to the originating presentation and ignores unknown frames", async () => {
    const t = setup();
    const dock = vi.fn();
    t.controller.attach("dock-1", { profile: "dock", onSurfaceEffect: dock });
    const { sse } = await startTurn(t);
    sse.send("view_payload", { toolUseId: "v1", viewId: "view-1", action: "created" });
    sse.send("future_frame_v9", { anything: true });
    sse.send("tool_start", { name: "missing-id" });
    await settle();
    expect(t.effects).toHaveBeenCalledTimes(1);
    expect(t.effects.mock.calls[0]![0]).toMatchObject({ event: "view_payload", class: "surface-effect" });
    expect(dock).not.toHaveBeenCalled();
    t.controller.detach("page-1");
    sse.send("page_created", { pageId: "page-9" });
    await settle();
    expect(dock).toHaveBeenCalledTimes(1);
    expect(t.state().activity.pageLinks).toEqual(["page-9"]);
  });
});

describe("[COMP:app-web/conversation-controller] retained access invalidation", () => {
  it("withdraws the matching conversation on a typed follow denial", async () => {
    const t = setup({ sessionId: "s-1", room: true });
    const withdraw = vi.fn(async () => {});
    t.net.transport.withdrawRetainedHistory = withdraw;
    t.controller.loadMessages([{ id: "old", role: "assistant", text: "Retained private reply", timestamp: new Date() }]);
    await settle();
    const follow = t.net.lastFollow();
    follow.sse!.send("access_denied", { code: "conversation_access_denied" }); await settle();
    expect(t.state().transcript.messages).toEqual([]);
    expect(withdraw).toHaveBeenCalledExactlyOnceWith(SCOPE, "s-1");
    expect(follow.sse!.aborted()).toBe(true);
    expect(t.state().run.reconnect.nextAt).toBeNull();
    t.controller.dispose();
  });

  it("removes idle retained content without a refetch loop", async () => {
    const t = setup({ sessionId: "s-1" });
    t.controller.loadMessages([{ id: "old", role: "assistant", text: "Retained private reply", timestamp: new Date("2026-11-18T00:00:00Z") }]);
    t.controller.invalidateRetainedHistory(); await settle();
    expect(t.state().transcript.messages).toEqual([]);
    expect(t.net.transport.loadHistory).not.toHaveBeenCalled();
    t.controller.dispose();
  });
  it("preserves an owned optimistic send and reconciles once after it settles", async () => {
    const t = setup();
    const { sent, sse } = await startTurn(t, "Keep my submitted input");
    const persisted = [{ id: "canonical", role: "assistant" as const, text: "Authoritative final reply", timestamp: new Date("2026-11-18T00:00:00Z") }];
    t.net.transport.loadHistory.mockResolvedValue(persisted);
    t.controller.invalidateRetainedHistory(); t.controller.invalidateRetainedHistory();
    expect(t.state().transcript.messages[0]?.text).toBe("Keep my submitted input");
    expect(t.net.transport.loadHistory).not.toHaveBeenCalled();
    sse.send("text_delta", { text: "Live reply" }); sse.send("done", { turnId: TURN_A }); sse.close();
    await sent; await settle();
    expect(t.net.transport.loadHistory).toHaveBeenCalledTimes(1);
    expect(t.state().transcript.messages).toEqual(persisted);
    t.controller.dispose();
  });
});

describe("[COMP:app-web/conversation-controller] unified Stop", () => {
  it("waits for the pending start, keeps reading the direct stream, and aborts only on confirmation", async () => {
    const t = setup();
    const stopResult = deferred<{ stopped: boolean }>();
    t.net.transport.stopTurn.mockReturnValueOnce(stopResult.promise);
    const sent = t.controller.send({ presentationId: "page-1", text: "Long task" });
    await settle();
    const sse = t.net.lastChat().sse;
    const stopping = t.controller.stop();
    await settle();
    expect(t.state().run.stopRequested).toBe(true);
    expect(t.net.transport.stopTurn).not.toHaveBeenCalled();
    expect(t.net.transport.readStatus).not.toHaveBeenCalled();
    // A preclaim acknowledgement carries no owner and cannot bind Stop.
    sse.send("session", { sessionId: "s-1", turnId: null });
    await settle();
    expect(t.net.transport.stopTurn).not.toHaveBeenCalled();
    // The postclaim session frame carries the captured SQL owner.
    sse.send("session", { sessionId: "s-1", turnId: TURN_A });
    await settle();
    expect(t.net.transport.stopTurn).toHaveBeenCalledExactlyOnceWith("s-1", TURN_A);
    // Still pending: the direct stream keeps painting.
    sse.send("text_delta", { text: "still streaming" });
    await settle();
    t.clock.runFrames();
    expect(t.state().transcript.streamingText).toBe("still streaming");
    expect(sse.aborted()).toBe(false);
    stopResult.resolve({ stopped: true });
    expect(await stopping).toBe("stopped");
    expect(await sent).toBe("stopped");
    expect(sse.aborted()).toBe(true);
    expect(t.state().run).toMatchObject({ phase: "cancelled", stopRequested: false });
    expect(t.state().transcript.isStreaming).toBe(false);
  });

  it("leaves the run unchanged and reports stopTurnFailed when the request fails", async () => {
    const t = setup();
    const { sent, sse } = await startTurn(t);
    t.net.transport.stopTurn.mockRejectedValueOnce(new Error("503"));
    expect(await t.controller.stop()).toBe("failed");
    expect(t.state().run).toMatchObject({ phase: "running", connection: "connected", stopRequested: false });
    expect(t.state().notices).toContainEqual({ code: "stopTurnFailed" });
    expect(sse.aborted()).toBe(false);
    sse.send("text_delta", { text: "finished anyway" });
    sse.send("done", { turnId: TURN_A });
    sse.close();
    expect(await sent).toBe("completed");
  });

  it("compare-and-sets against the captured turn and never cancels a successor", async () => {
    const t = setup();
    const first = await startTurn(t);
    const stopResult = deferred<{ stopped: boolean }>();
    t.net.transport.stopTurn.mockReturnValueOnce(stopResult.promise);
    const stopping = t.controller.stop();
    await settle();
    expect(t.net.transport.stopTurn).toHaveBeenCalledWith("s-1", TURN_A);
    first.sse.send("done", { turnId: TURN_A });
    first.sse.close();
    expect(await first.sent).toBe("completed");
    const successor = t.controller.send({ presentationId: "page-1", text: "Next" });
    await settle();
    const next = t.net.lastChat().sse;
    next.send("session", { sessionId: "s-1", turnId: TURN_B });
    await settle();
    stopResult.resolve({ stopped: false });
    expect(await stopping).toBe("revoked");
    expect(t.state().run.phase).toBe("running");
    expect(t.state().turnId).toBe(TURN_B);
    expect(next.aborted()).toBe(false);
    next.send("done", { turnId: TURN_B });
    next.close();
    expect(await successor).toBe("completed");
  });
});

describe("[COMP:app-web/conversation-controller] one reconnect policy", () => {
  it("disconnect moves to the mirror, follows, and flushes the queue only at done", async () => {
    const t = setup();
    const { sent, sse } = await startTurn(t);
    sse.send("text_delta", { text: "partial" });
    await settle();
    expect(t.controller.queue("posted before the cut", false)).toBe(true);
    await settle();
    sse.close(); // bare close, no terminal frame
    expect(await sent).toBe("disconnected");
    expect(t.state().run).toMatchObject({ phase: "running", connection: "reconnecting" });
    expect(t.state().mirror).toMatchObject({ active: true, text: "partial" });
    expect(t.state().notices).toContainEqual({ code: "reconnecting" });
    expect(t.controller.queue("posted after the cut", false)).toBe(true);
    await settle();
    expect(t.net.chats).toHaveLength(1);
    const follow = t.net.lastFollow();
    expect(follow.sessionId).toBe("s-1");
    follow.sse!.send("status", { status: "running", turnId: TURN_A });
    follow.sse!.send("snapshot", { text: "partial and more", turnId: TURN_A });
    await settle();
    t.clock.runFrames();
    expect(t.state().mirror.text).toBe("partial and more");
    expect(t.state().run.connection).toBe("connected");
    expect(t.net.chats).toHaveLength(1);
    t.net.status.current = { status: "idle", turnId: TURN_A };
    follow.sse!.send("done", { turnId: TURN_A });
    await settle();
    expect(t.state().run.phase).toBe("completed");
    expect(t.state().mirror.active).toBe(false);
    expect(t.state().notices).not.toContainEqual({ code: "reconnecting" });
    expect(t.net.transport.loadHistory).toHaveBeenCalled();
    expect(t.net.chats).toHaveLength(1);
    // The deferred fallback send rechecks ownership, then starts one turn.
    await t.clock.advance(0);
    expect(t.state().run.phase).toBe("running");
    // The uncertain entry is handed back; the certain one becomes one turn.
    expect(t.state().unsent).toEqual(["posted before the cut"]);
    expect(t.net.chats).toHaveLength(2);
    expect(t.net.lastChat().body).toMatchObject({ message: "posted after the cut", sessionId: "s-1" });
  });

  it("backs off within one budget bounded by the shorter server turn cap", async () => {
    const t = setup({ reconnect: { serverTurnCapMs: 60_000 } });
    const { sent, sse } = await startTurn(t);
    for (let i = 0; i < 6; i++) t.net.followPlans.push(() => Promise.reject(new Error("offline")));
    sse.close();
    await sent;
    await settle();
    const delays: number[] = [];
    for (let i = 0; i < 6 && t.state().run.phase === "running"; i++) {
      delays.push(...t.clock.timerDelays());
      await t.clock.advance(t.clock.timerDelays()[0] ?? 0);
    }
    expect(delays.slice(0, 4)).toEqual([3_000, 6_000, 12_000, 24_000]);
    expect(t.state().run.phase).toBe("failed");
    expect(t.state().notices).toContainEqual({ code: "reconnectFailed", cause: "budget" });
    expect(t.net.transport.stopTurn).not.toHaveBeenCalled();
  });

  it("caps the delay and reopens immediately when connectivity returns", async () => {
    const t = setup();
    const { sent, sse } = await startTurn(t);
    for (let i = 0; i < 7; i++) t.net.followPlans.push(() => Promise.reject(new Error("offline")));
    sse.close();
    await sent;
    await settle();
    for (let i = 0; i < 6; i++) await t.clock.advance(t.clock.timerDelays()[0]!);
    expect(t.clock.timerDelays()).toEqual([30_000]);
    expect(t.state().run.reconnect).toMatchObject({ attempt: 7 });
    const opened = t.net.follows.length;
    t.controller.notifyOnline();
    await settle();
    expect(t.net.follows.length).toBe(opened + 1);
  });

  it("a rejected open ends the re-attach and keeps the rejection's authority", async () => {
    const t = setup();
    const { sent, sse } = await startTurn(t);
    t.net.followPlans.push(() => new Response("forbidden", { status: 403 }));
    sse.close();
    await sent;
    await settle();
    expect(t.state().run.phase).toBe("failed");
    expect(t.state().notices).toContainEqual({ code: "reconnectFailed", cause: "rejected", status: 403 });
    expect(t.clock.timerDelays()).toEqual([]);
    expect(t.net.follows).toHaveLength(1);
  });

  it("runs one hydrate probe on attach and re-attaches a running turn after reload", async () => {
    const net = fakeTransport();
    const clock = fakeScheduler();
    const controller = createConversationController({ scope: SCOPE, sessionId: "s-1", transport: net.transport, scheduler: clock.scheduler });
    // StrictMode setup, cleanup, setup.
    const detach = controller.attach("dock-1", { profile: "dock" });
    detach();
    controller.attach("dock-1", { profile: "dock" });
    await settle();
    expect(net.follows).toHaveLength(1);
    net.status.current = { status: "running", turnId: TURN_A };
    net.lastFollow().sse!.send("status", { status: "running", turnId: TURN_A });
    await settle();
    expect(controller.getSnapshot().run).toMatchObject({ phase: "running", connection: "connected" });
    expect(controller.getSnapshot().mirror.active).toBe(true);
    net.status.current = { status: "idle", turnId: TURN_A };
    net.lastFollow().sse!.send("turn_completed", { turnId: TURN_A, reason: "stopped_by_user", stoppedByName: "Robin" });
    net.lastFollow().sse!.send("done", { turnId: TURN_A });
    await settle();
    expect(controller.getSnapshot().run.phase).toBe("completed");
    expect(controller.getSnapshot().notices).toContainEqual({ code: "turnEnd", reason: "stopped_by_user", stoppedByName: "Robin", senderUserId: null });
    expect(net.transport.loadHistory).toHaveBeenCalledTimes(1);
  });
});

describe("[COMP:app-web/conversation-controller] acceptance and lost acknowledgement", () => {
  it("reconciles an accepted turn whose stream errors instead of resending it", async () => {
    const t = setup();
    const { sent, sse, onAccepted, onRejected } = await startTurn(t);
    expect(onAccepted).toHaveBeenCalledTimes(1);
    sse.fail();
    expect(await sent).toBe("disconnected");
    await settle();
    const follow = t.net.lastFollow();
    t.net.status.current = { status: "idle", turnId: TURN_A };
    follow.sse!.send("status", { status: "idle", turnId: TURN_A });
    follow.sse!.send("done", { turnId: TURN_A });
    await settle();
    expect(t.net.chats).toHaveLength(1);
    expect(onRejected).not.toHaveBeenCalled();
    expect(t.state().run.phase).toBe("completed");
    expect(t.net.transport.loadHistory).toHaveBeenCalled();
  });

  it("returns the draft on a failure before acceptance and never auto-sends it", async () => {
    const t = setup({ sessionId: null });
    t.net.failNextChat();
    const onAccepted = vi.fn();
    const onRejected = vi.fn();
    expect(await t.controller.send({ presentationId: "page-1", text: "Unsent offline text", onAccepted, onRejected })).toBe("failed");
    expect(onAccepted).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(t.state().transcript.messages).toEqual([]);
    expect(t.state().notices).toContainEqual({ code: "error", errorCode: "stream_failed" });
    t.controller.notifyOnline();
    await t.clock.advance(60_000);
    expect(t.net.chats).toHaveLength(0);
    expect(t.net.follows).toHaveLength(0);
  });

  it("rejects body fields outside the typed allowlist", async () => {
    const t = setup();
    expect(await t.controller.send({ presentationId: "page-1", text: "x", bodyExtras: { workspaceId: "other" } as never })).toBe("invalid");
    expect(t.net.chats).toHaveLength(0);
  });
});

describe("[COMP:app-web/conversation-controller] approvals and questions", () => {
  it("answers a live card through /api/chat/confirm and maps 403 to confirmNotAllowed", async () => {
    const t = setup();
    const { sse } = await startTurn(t);
    sse.send("tool_confirmation_required", { toolCallId: "call-1", approvalId: "ap-1", toolName: "fileWrite", input: { path: "a" } });
    await settle();
    expect(t.state().interaction.pending).toMatchObject({ approvalId: "ap-1", source: "live" });
    expect(t.state().run.phase).toBe("suspended");
    t.net.transport.confirmLive.mockResolvedValueOnce({ ok: false, status: 403 });
    expect(await t.controller.respondConfirmation("call-1", "approve")).toBe("forbidden");
    expect(t.state().notices).toContainEqual({ code: "confirmNotAllowed" });
    expect(t.state().interaction.pending).toMatchObject({ status: "retryable" });
    expect(await t.controller.respondConfirmation("call-1", "approve")).toBe("resolved");
    expect(t.net.transport.confirmLive).toHaveBeenLastCalledWith({ sessionId: "s-1", toolCallId: "call-1", decision: "allow" });
    expect(t.net.transport.respondRestored).not.toHaveBeenCalled();
    expect(t.state().interaction.pending).toBeNull();
  });

  it("answers a restored card through the approval route", async () => {
    const t = setup();
    const { sent, sse } = await startTurn(t);
    sse.close();
    await sent;
    await settle();
    t.net.pending.current = {
      pending: null,
      toolConfirmation: { toolCallId: "approval:ap-9", approvalId: "ap-9", restored: true, toolName: "fileWrite", input: {}, sessionId: "s-1", status: "pending" },
    };
    t.net.status.current = { status: "idle", turnId: TURN_A };
    t.net.lastFollow().sse!.send("done", { turnId: TURN_A });
    await settle();
    expect(t.state().interaction.pending).toMatchObject({ approvalId: "ap-9", source: "restored" });
    expect(await t.controller.respondConfirmation("approval:ap-9", "deny", "Not now")).toBe("resolved");
    expect(t.net.transport.respondRestored).toHaveBeenCalledWith("ap-9", "rejected", "Not now");
    expect(t.net.transport.confirmLive).not.toHaveBeenCalled();
  });

  it("follows the resumed turn after an answer instead of polling messages", async () => {
    const t = setup();
    const { sent, sse } = await startTurn(t);
    sse.send("tool_start", { id: "q-1", name: "askQuestion" });
    sse.send("awaiting_approval", { kind: "question" });
    t.net.status.current = { status: "idle", turnId: TURN_A };
    t.net.pending.current = { pending: { approvalId: "q-ap", question: "Which SDK?", expiresAt: null }, toolConfirmation: null };
    sse.send("done", { turnId: TURN_A });
    sse.close();
    expect(await sent).toBe("completed");
    await settle();
    expect(t.state().interaction.pending).toMatchObject({ kind: "question", approvalId: "q-ap" });
    expect(await t.controller.answerQuestion("The Cardano SDK")).toBe("resolved");
    expect(t.net.transport.answerQuestion).toHaveBeenCalledWith("s-1", "q-ap", "The Cardano SDK");
    await settle();
    // The server holds this one stream open until the resumed owner starts:
    // idle first, then its turn_started relayed as status running.
    const resumed = t.net.lastFollow();
    resumed.sse!.send("status", { status: "idle", turnId: TURN_A });
    await settle();
    expect(t.clock.timerDelays()).toEqual([]);
    t.net.status.current = { status: "running", turnId: TURN_C };
    resumed.sse!.send("status", { status: "running", turnId: TURN_C });
    resumed.sse!.send("snapshot", { text: "Using the Cardano SDK", turnId: TURN_C });
    await settle();
    expect(t.state().run.phase).toBe("running");
    const opened = t.net.follows.length;
    t.net.status.current = { status: "idle", turnId: TURN_C };
    resumed.sse!.send("turn_completed", { turnId: TURN_C });
    resumed.sse!.send("done", { turnId: TURN_C });
    await settle();
    expect(t.net.follows.length).toBe(opened);
    expect(t.state().run.phase).toBe("completed");
    expect(t.net.transport.loadHistory).toHaveBeenCalled();
  });
});

describe("[COMP:app-web/conversation-controller] resume follow without re-probe", () => {
  it("keeps the canonical reclaimed reason on an initial terminal hydrate", async () => {
    const t = setup({ sessionId: "s-1" });
    t.net.transport.readStatus.mockResolvedValue({ status: "timeout", turnId: TURN_A, turnEndReason: "stalled_reclaimed" });
    await settle();
    t.net.lastFollow().sse!.send("status", { status: "timeout", turnId: TURN_A, turnEndReason: "stalled_reclaimed" });
    t.net.lastFollow().sse!.send("done", { turnId: TURN_A }); await settle();
    expect(t.state().notices).toContainEqual({ code: "turnEnd", reason: "stalled_reclaimed", stoppedByName: null, senderUserId: null });
    t.controller.dispose();
  });

  it("preserves a failed terminal successor's reason during authoritative catch-up", async () => {
    const t = setup({ sessionId: "s-1" }); await settle();
    t.net.lastFollow().sse!.send("status", { status: "running", turnId: TURN_A }); await settle();
    t.net.transport.readStatus.mockResolvedValue({ status: "failed", turnId: TURN_B, turnEndReason: "failed" });
    t.net.lastFollow().sse!.send("status", { status: "failed", turnId: TURN_B, turnEndReason: "failed" }); await settle();
    expect(t.state().notices).toContainEqual({ code: "turnEnd", reason: "failed", stoppedByName: null, senderUserId: null });
    expect(t.state().mirror.active).toBe(false); t.controller.dispose();
  });
  it("loads the committed resumed reply when its whole running interval fell between connections", async () => {
    const t = setup({ sessionId: "s-1" });
    t.net.pending.current = { pending: null, toolConfirmation: { toolCallId: "approval:ap-fast", approvalId: "ap-fast", restored: true, toolName: "fileWrite", input: {}, sessionId: "s-1", status: "pending" } };
    await t.controller.refreshPendingInput(); await settle();
    const old = t.net.lastFollow().sse!;
    old.send("status", { status: "running", turnId: TURN_A });
    await settle();
    expect(t.state().mirror.active).toBe(true);
    await t.controller.respondConfirmation("approval:ap-fast", "approve");
    expect(t.net.transport.respondRestored).toHaveBeenCalledWith("ap-fast", "approved", undefined);
    const saved = { id: "saved-fast-reply", role: "assistant" as const, text: "The resumed reply is durably saved.", timestamp: new Date() };
    // The page owns history and refuses to paint it while a live mirror is
    // active. Model the receiving guard, rather than only count invalidations.
    let admittedReads = 0;
    t.net.transport.loadHistory.mockImplementation(async () => {
      if (t.state().mirror.active) return [];
      admittedReads++; return [saved];
    });
    t.net.status.current = { status: "idle", turnId: TURN_B };
    old.send("turn_completed", { turnId: TURN_A, reason: "stalled_reclaimed" });
    old.send("done", { turnId: TURN_A }); old.close(); await settle();
    await t.clock.advance(3000);
    const caughtUp = t.net.lastFollow().sse!;
    caughtUp.send("status", { status: "idle", turnId: TURN_B, turnEndReason: "completed" });
    caughtUp.send("done", { turnId: TURN_B }); caughtUp.close(); await settle();
    expect(t.state().mirror.active).toBe(false);
    expect(t.state().transcript.messages).toEqual([saved]);
    expect(admittedReads).toBe(1);
    expect(t.net.chats).toHaveLength(0);
    expect(t.state().notices.some(notice => notice.code === "turnEnd")).toBe(false);
  });

  it("never uses terminal catch-up to clear an owned direct successor or its optimistic input", async () => {
    const t = setup({ sessionId: "s-1", room: true });
    const { sse } = await startTurn(t, "Keep this new draft input");
    await settle();
    t.net.status.current = { status: "idle", turnId: TURN_B };
    const follow = t.net.lastFollow().sse!;
    follow.send("status", { status: "idle", turnId: TURN_B }); follow.send("done", { turnId: TURN_B }); await settle();
    expect(t.state().transcript.isStreaming).toBe(true);
    expect(t.state().transcript.messages[0]?.text).toBe("Keep this new draft input");
    expect(sse.aborted()).toBe(false);
    expect(t.net.chats).toHaveLength(1);
    t.controller.dispose();
  });
  it("a resume follow that ends unseen reloads history once and does not reopen", async () => {
    const t = setup({ sessionId: "s-1" });
    await settle();
    t.net.status.current = { status: "idle", turnId: null };
    t.net.lastFollow().sse!.send("status", { status: "idle" });
    t.net.lastFollow().sse!.send("done", {});
    await settle();
    t.controller.presentQuestion({ approvalId: "q-1", question: "Proceed?", expiresAt: null, sessionId: "s-1" });
    expect(t.controller.questionSettled("q-1")).toBe(true);
    await settle();
    const follows = t.net.follows.length;
    const loads = t.net.transport.loadHistory.mock.calls.length;
    // The server held the stream for its 120 s bound with no owner start,
    // then closed it: the client's resume window has passed too.
    t.net.lastFollow().sse!.send("status", { status: "idle" });
    await settle();
    await t.clock.advance(121_000);
    t.net.lastFollow().sse!.send("done", { turnId: null });
    await settle();
    await t.clock.advance(130_000);
    expect(t.net.follows.length).toBe(follows);
    expect(t.net.transport.loadHistory.mock.calls.length).toBe(loads + 1);
    expect(t.state().run.phase).not.toBe("failed");
  });

  it("a resume follow cut by the transport reconnects with the normal backoff", async () => {
    const t = setup({ sessionId: "s-1" });
    await settle();
    t.net.status.current = { status: "idle", turnId: null };
    t.net.lastFollow().sse!.send("done", {});
    await settle();
    t.controller.presentQuestion({ approvalId: "q-2", question: "Go?", expiresAt: null, sessionId: "s-1" });
    t.controller.questionSettled("q-2");
    await settle();
    t.net.lastFollow().sse!.close();
    await settle();
    expect(t.clock.timerDelays()).toEqual([3_000]);
  });
});

describe("[COMP:app-web/conversation-controller] identity disposal", () => {
  it("aborts transport without a Stop request and rejects late frames", async () => {
    const t = setup();
    const { sent, sse } = await startTurn(t);
    t.controller.dispose();
    expect(sse.aborted()).toBe(true);
    expect(await sent).toBe("disposed");
    expect(t.net.transport.stopTurn).not.toHaveBeenCalled();
    expect(t.state()).toMatchObject({ disposed: true, transcript: { messages: [] }, queued: [] });
    expect(await t.controller.send({ presentationId: "page-1", text: "late" })).toBe("disposed");
  });
});

describe("[COMP:app-web/conversation-controller] queue drain ownership", () => {
  it("a successor generation before the deferred send keeps the queued text unsent", async () => {
    const t = setup();
    const { sent, sse } = await startTurn(t);
    expect(t.controller.queue("send this after the turn", false)).toBe(true);
    await settle();
    sse.send("done", { turnId: TURN_A });
    sse.close();
    expect(await sent).toBe("completed");
    expect(t.state().queued).toEqual([]);
    // The user starts their own turn before the deferred fallback fires.
    void t.controller.send({ presentationId: "page-1", text: "manual follow-up" });
    await settle();
    await t.clock.advance(0);
    expect(t.net.chats.map((chat) => chat.body.message)).toEqual(["Hello", "manual follow-up"]);
    expect(t.state().unsent).toEqual(["send this after the turn"]);
  });

  it("disposal before the deferred send drops the text without sending it anywhere", async () => {
    const t = setup();
    const { sent, sse } = await startTurn(t);
    t.controller.queue("never resent", false);
    await settle();
    sse.send("done", { turnId: TURN_A });
    sse.close();
    await sent;
    t.controller.dispose();
    await t.clock.advance(0);
    expect(t.net.chats).toHaveLength(1);
    expect(t.state()).toMatchObject({ queued: [], unsent: [] });
  });

  it("never drains one conversation's entry into another conversation", async () => {
    const shared = fakeTransport();
    const clock = fakeScheduler();
    const make = (sessionId: string) => {
      const controller = createConversationController({ scope: SCOPE, sessionId, transport: shared.transport, scheduler: clock.scheduler });
      controller.attach(`p-${sessionId}`, { profile: "dock", pendingProbe: false });
      return controller;
    };
    const first = make("s-1");
    const second = make("s-2");
    await settle();
    for (const follow of shared.follows) follow.sse?.close();
    const sendFirst = first.send({ presentationId: "p-s-1", text: "first turn" });
    await settle();
    const firstStream = shared.lastChat().sse;
    firstStream.send("session", { sessionId: "s-1", turnId: TURN_A });
    const sendSecond = second.send({ presentationId: "p-s-2", text: "second turn" });
    await settle();
    const secondStream = shared.lastChat().sse;
    secondStream.send("session", { sessionId: "s-2", turnId: TURN_B });
    await settle();
    expect(first.queue("belongs to s-1", false)).toBe(true);
    await settle();
    secondStream.send("done", { turnId: TURN_B });
    secondStream.close();
    expect(await sendSecond).toBe("completed");
    await clock.advance(0);
    expect(shared.chats.map((chat) => [chat.body.sessionId, chat.body.message])).toEqual([[ "s-1", "first turn" ], [ "s-2", "second turn" ]]);
    expect(first.getSnapshot().queued.map((item) => item.text)).toEqual(["belongs to s-1"]);
    firstStream.send("done", { turnId: TURN_A });
    firstStream.close();
    await sendFirst;
    await clock.advance(0);
    expect(shared.lastChat().body).toMatchObject({ sessionId: "s-1", message: "belongs to s-1" });
  });
});
