/**
 * [COMP:app-web/conversation-controller] Browser qualification regressions
 * (m5-browser-qualification receipt, M5Q-1/2/3/4/11), replaying the recorded
 * frame sequences on fake transports.
 */
import { describe, expect, it, vi } from "vitest";
import type { DocSessionMessage } from "@/lib/api/sessions";
import type { Message } from "@use-brian/chat-ui";
import { createConversationController, type ConversationState } from "../conversation-controller";
import { SCOPE, TURN_A, deferred, fakeScheduler, fakeTransport, settle } from "./conversation-fakes";

function setup(sessionId: string | null = null) {
  const net = fakeTransport();
  const clock = fakeScheduler();
  const controller = createConversationController({ scope: SCOPE, sessionId, transport: net.transport, scheduler: clock.scheduler });
  controller.attach("page", { profile: "page", pendingProbe: false });
  const seen: ConversationState[] = [];
  controller.subscribe(() => seen.push(controller.getSnapshot()));
  return { net, clock, controller, seen, state: () => controller.getSnapshot() };
}
const errors = (state: ConversationState) => state.notices.filter((notice) => notice.code === "error");

describe("[COMP:app-web/conversation-controller] M5Q-1 confirmed Stop is the outcome", () => {
  it("an error after a pending Stop (server TurnStoppedError) is not shown when Stop confirms", async () => {
    const t = setup();
    const stop = deferred<{ stopped: boolean }>();
    t.net.transport.stopTurn.mockReturnValueOnce(stop.promise);
    const sent = t.controller.send({ presentationId: "page", text: "Stop me during admission" });
    await settle();
    const sse = t.net.lastChat().sse;
    const stopping = t.controller.stop(); // pressed before `session`
    sse.send("session", { sessionId: "s-1", turnId: TURN_A });
    await settle();
    expect(t.net.transport.stopTurn).toHaveBeenCalledWith("s-1", TURN_A);
    sse.send("error", { error: "Something went wrong", turnId: TURN_A });
    sse.send("done", { turnId: TURN_A });
    sse.close();
    await settle();
    stop.resolve({ stopped: true });
    expect(await stopping).toBe("stopped");
    expect(await sent).toBe("stopped");
    expect(t.seen.some((state) => errors(state).length > 0)).toBe(false);
    expect(t.state().run.phase).toBe("cancelled");
  });

  it("a failed Stop surfaces the held error alongside stopTurnFailed", async () => {
    const t = setup();
    const stop = deferred<{ stopped: boolean }>();
    t.net.transport.stopTurn.mockReturnValueOnce(stop.promise);
    void t.controller.send({ presentationId: "page", text: "x" });
    await settle();
    const sse = t.net.lastChat().sse;
    sse.send("session", { sessionId: "s-1", turnId: TURN_A });
    await settle();
    const stopping = t.controller.stop();
    await settle();
    sse.send("error", { error: "Something went wrong", turnId: TURN_A });
    sse.send("done", { turnId: TURN_A });
    sse.close();
    await settle();
    stop.reject(new Error("503"));
    expect(await stopping).toBe("failed");
    expect(t.state().notices).toContainEqual({ code: "stopTurnFailed" });
    expect(errors(t.state())).toEqual([{ code: "error", errorCode: "stream_error", message: "Something went wrong" }]);
  });

  it("a turn_stopped code is the stop, never an error", async () => {
    const t = setup();
    // Keep the post-stop history read pending so the live stopped row is inspected.
    t.net.transport.loadHistory.mockReturnValue(new Promise(() => {}));
    const sent = t.controller.send({ presentationId: "page", text: "x" });
    await settle();
    const sse = t.net.lastChat().sse;
    sse.send("session", { sessionId: "s-1", turnId: TURN_A });
    sse.send("text_delta", { text: "partial" });
    sse.send("error", { code: "turn_stopped", error: "The original turn was stopped.", turnId: TURN_A });
    sse.send("done", { turnId: TURN_A });
    sse.close();
    expect(await sent).toBe("stopped");
    expect(errors(t.state())).toEqual([]);
    expect(t.state().transcript.messages.at(-1)).toMatchObject({ role: "assistant", text: "partial" });
    // A server-side stop is neutral, never "you".
    expect(t.state().notices).toContainEqual({ code: "turnEnd", reason: "stopped_by_user", stoppedByName: null, senderUserId: null });
  });
});

describe("[COMP:app-web/conversation-controller] M5Q-2 stopped text stays", () => {
  it("a confirmed Stop during output keeps w1..w9 as the stopped reply", async () => {
    const t = setup();
    t.net.transport.loadHistory.mockReturnValue(new Promise(() => {}));
    const stop = deferred<{ stopped: boolean }>();
    t.net.transport.stopTurn.mockReturnValueOnce(stop.promise);
    const sent = t.controller.send({ presentationId: "page", text: "Count slowly" });
    await settle();
    const sse = t.net.lastChat().sse;
    sse.send("session", { sessionId: "s-1", turnId: TURN_A });
    for (let i = 1; i <= 5; i++) sse.send("text_delta", { text: `w${i} ` });
    await settle();
    const stopping = t.controller.stop();
    for (let i = 6; i <= 9; i++) sse.send("text_delta", { text: `w${i} ` }); // painting while Stop is pending
    await settle();
    stop.resolve({ stopped: true, via: "aborted" } as { stopped: boolean });
    expect(await stopping).toBe("stopped");
    expect(await sent).toBe("stopped");
    expect(t.state().transcript.isStreaming).toBe(false);
    expect(t.state().transcript.messages.at(-1)).toMatchObject({ role: "assistant", text: "w1 w2 w3 w4 w5 w6 w7 w8 w9" });
  });
});

describe("[COMP:app-web/conversation-controller] M5Q-3 re-attached turns are live", () => {
  it("turnLive is true while a re-attached turn runs, send is busy and queue accepts", async () => {
    const t = setup();
    const sent = t.controller.send({ presentationId: "page", text: "Long" });
    await settle();
    const sse = t.net.lastChat().sse;
    sse.send("session", { sessionId: "s-1", turnId: TURN_A });
    await settle();
    sse.close();
    await sent;
    await settle();
    t.net.status.current = { status: "running", turnId: TURN_A };
    t.net.lastFollow().sse!.send("status", { status: "running", turnId: TURN_A });
    await settle();
    expect(t.state().transcript.isStreaming).toBe(false);
    expect(t.state().turnLive).toBe(true);
    expect(await t.controller.send({ presentationId: "page", text: "while re-attached" })).toBe("busy");
    expect(t.controller.queue("while re-attached", false)).toBe(true);
    expect(t.net.sides.at(-1)).toMatchObject({ message: "while re-attached", sessionId: "s-1", midTurn: true });
  });
});

describe("[COMP:app-web/conversation-controller] M5Q-4 reconnect raises no terminal error", () => {
  it("replays the recorded network-loss sequence without any error notice", async () => {
    const t = setup();
    const sent = t.controller.send({ presentationId: "page", text: "Network loss slow:50" });
    await settle();
    const sse = t.net.lastChat().sse;
    sse.send("session", { sessionId: "s-1", turnId: TURN_A });
    sse.send("user_message_saved", { id: "row-user" });
    sse.send("text_delta", { text: "w1" });
    await settle();
    for (let i = 0; i < 3; i++) t.net.followPlans.push(() => Promise.reject(new TypeError("Failed to fetch")));
    sse.fail(); // TypeError: network error after acceptance
    await sent;
    await settle();
    const online = t.net.transport.authFetch;
    t.net.transport.authFetch = async (url, init) => {
      if (String(url).endsWith("/api/chat")) throw new TypeError("Failed to fetch");
      return online(url, init);
    };
    expect(t.controller.queue("Queued during loss", false)).toBe(true);
    await settle();
    t.net.transport.authFetch = online;
    for (let i = 0; i < 4; i++) await t.clock.advance(30_000);
    const follow = t.net.lastFollow().sse!;
    t.net.status.current = { status: "running", turnId: TURN_A, startedAt: 1 } as never;
    follow.send("status", { status: "running", turnId: TURN_A, turnEndReason: null, startedAt: 1794864009886 });
    await settle();
    t.net.status.current = { status: "idle", turnId: TURN_A };
    follow.send("turn_completed", { senderUserId: SCOPE.viewerId, turnId: TURN_A });
    follow.send("done", { turnId: TURN_A });
    await settle();
    expect(t.seen.some((state) => errors(state).length > 0)).toBe(false);
    expect(t.state().run.phase).toBe("completed");
    expect(t.net.chats).toHaveLength(1);
  });

  it("a successful re-attach clears a transient transport error and bumps reattachEpoch", async () => {
    const t = setup("s-1");
    await settle();
    t.net.status.current = { status: "idle", turnId: null };
    t.net.lastFollow().sse!.send("done", {});
    await settle();
    t.net.failNextChat(new TypeError("Failed to fetch"));
    expect(await t.controller.send({ presentationId: "page", text: "offline send" })).toBe("failed");
    expect(errors(t.state())).toEqual([{ code: "error", errorCode: "stream_failed" }]);
    const epoch = t.state().reattachEpoch;
    expect(t.controller.followTurn()).toBe(true);
    await settle();
    t.net.status.current = { status: "running", turnId: TURN_A };
    t.net.lastFollow().sse!.send("status", { status: "running", turnId: TURN_A });
    await settle();
    expect(errors(t.state())).toEqual([]);
    expect(t.state().reattachEpoch).toBe(epoch + 1);
  });
});

describe("[COMP:app-web/conversation-controller] M5Q-11 deterministic unsent reconciliation", () => {
  const row = (id: string, text: string, timestamp: string) =>
    ({ id, role: "user", content: [{ type: "text", text }], timestamp, attachments: [] }) as unknown as DocSessionMessage;

  async function lostAck(history: () => Promise<DocSessionMessage[]>, seed?: string) {
    const t = setup();
    t.net.transport.fetchHistoryRows = vi.fn(history);
    if (seed) t.controller.loadMessages([{ id: "old-row", role: "user", text: seed, timestamp: new Date(0) }]);
    const sent = t.controller.send({ presentationId: "page", text: "Turn" });
    await settle();
    const sse = t.net.lastChat().sse;
    sse.send("session", { sessionId: "s-1", turnId: TURN_A });
    await settle();
    t.controller.queue("Queued during loss", false);
    await settle();
    sse.close(); // the stream carrying input_applied died: the entry is uncertain
    await sent;
    await settle();
    t.net.status.current = { status: "idle", turnId: TURN_A };
    t.net.lastFollow().sse!.send("done", { turnId: TURN_A });
    await settle();
    await t.clock.advance(0);
    return t;
  }
  const later = () => new Date(1_700_000_000_000 + 1_000).toISOString();

  it("does not return text the server applied (a later user row with that text)", async () => {
    const t = await lostAck(async () => [row("row-applied", "Queued during loss", later())]);
    expect(t.state().unsent).toEqual([]);
    expect(t.net.chats).toHaveLength(1);
  });

  it("returns text the server did not apply", async () => {
    const t = await lostAck(async () => [row("row-other", "Something else", later())]);
    expect(t.state().unsent).toEqual(["Queued during loss"]);
  });

  it("returns the text when the history read fails", async () => {
    const t = await lostAck(async () => { throw new Error("chat_history_failed: 503"); });
    expect(t.state().unsent).toEqual(["Queued during loss"]);
  });

  it("an older identical row already shown does not count as applied", async () => {
    const t = await lostAck(async () => [row("old-row", "Queued during loss", new Date(0).toISOString())], "Queued during loss");
    expect(t.state().unsent).toEqual(["Queued during loss"]);
  });
});

describe("[COMP:app-web/conversation-controller] M5D-2 history after a confirmed Stop", () => {
  const saved = (text: string): Message[] => [
    { id: "row-user", role: "user", text: "Count slowly", timestamp: new Date(0) },
    { id: "row-stopped", role: "assistant", text, timestamp: new Date(0) },
  ];

  it("replays Stop 200, stream abort, GET messages 500 then 200: stopped line, partial kept, no error", async () => {
    const t = setup();
    t.net.transport.loadHistory
      .mockRejectedValueOnce(new Error("chat_history_failed: 500")) // 40001 on the old reader
      .mockResolvedValueOnce(saved("w1 w2 w3 w4 w5"));
    const sent = t.controller.send({ presentationId: "page", text: "Count slowly" });
    await settle();
    const sse = t.net.lastChat().sse;
    sse.send("session", { sessionId: "s-1", turnId: TURN_A });
    for (let i = 1; i <= 5; i++) sse.send("text_delta", { text: `w${i} ` });
    await settle();
    t.net.transport.stopTurn.mockResolvedValueOnce({ stopped: true, via: "aborted", reason: "stopped_by_user" } as { stopped: boolean });
    expect(await t.controller.stop()).toBe("stopped");
    expect(await sent).toBe("stopped");
    expect(sse.aborted()).toBe(true);
    await settle();
    expect(t.net.transport.loadHistory).toHaveBeenCalledTimes(1);
    expect(t.state().run.phase).toBe("cancelled");
    expect(t.state().transcript.messages.at(-1)).toMatchObject({ role: "assistant", text: "w1 w2 w3 w4 w5" });
    expect(t.state().notices).toContainEqual({ code: "turnEnd", reason: "stopped_by_user", stoppedByName: null, senderUserId: SCOPE.viewerId });
    expect(t.seen.some((state) => errors(state).length > 0)).toBe(false);
    // The failed read is retried with the reconnect backoff.
    await t.clock.advance(3_000);
    expect(t.net.transport.loadHistory).toHaveBeenCalledTimes(2);
    expect(t.state().transcript.messages.map((message) => message.id)).toEqual(["row-user", "row-stopped"]);
    expect(errors(t.state())).toEqual([]);
  });

  it("gives up after four retries without ever raising an error notice", async () => {
    const t = setup();
    t.net.transport.loadHistory.mockRejectedValue(new Error("chat_history_failed: 500"));
    const sent = t.controller.send({ presentationId: "page", text: "x" });
    await settle();
    const sse = t.net.lastChat().sse;
    sse.send("session", { sessionId: "s-1", turnId: TURN_A });
    sse.send("text_delta", { text: "kept" });
    await settle();
    await t.controller.stop();
    await sent;
    for (const delay of [3_000, 6_000, 12_000, 24_000, 30_000]) await t.clock.advance(delay);
    expect(t.net.transport.loadHistory).toHaveBeenCalledTimes(5);
    expect(t.state().transcript.messages.at(-1)).toMatchObject({ text: "kept" });
    expect(errors(t.state())).toEqual([]);
  });

  it("a presentation that owns history gets the retry as another historyEpoch bump", async () => {
    const t = setup();
    (t.net.transport as { loadHistory?: unknown }).loadHistory = undefined;
    const sent = t.controller.send({ presentationId: "page", text: "x" });
    await settle();
    const sse = t.net.lastChat().sse;
    sse.send("session", { sessionId: "s-1", turnId: TURN_A });
    await settle();
    const before = t.state().historyEpoch;
    await t.controller.stop();
    await sent;
    expect(t.state().historyEpoch).toBe(before + 1);
    t.controller.reportHistoryFailure(); // the page's own read answered 500
    await t.clock.advance(2_999);
    expect(t.state().historyEpoch).toBe(before + 1);
    await t.clock.advance(1);
    expect(t.state().historyEpoch).toBe(before + 2);
    expect(errors(t.state())).toEqual([]);
  });
});

describe("[COMP:app-web/conversation-controller] pre-save error rejects the send", () => {
  it.each([
    ["assistant_clearance_below_conversation", "This assistant cannot join this conversation."],
    ["assistant_clearance_exceeds_room", "This assistant can see more than this room allows."],
    [undefined, "Something went wrong"],
  ])("%s before session: bubble removed, text returned, notice kept, no follow", async (code, message) => {
    const t = setup("s-1");
    await settle();
    t.net.status.current = { status: "idle", turnId: null };
    t.net.lastFollow().sse!.send("done", {});
    await settle();
    const follows = t.net.follows.length;
    const rejected = vi.fn();
    const accepted = vi.fn();
    const sent = t.controller.send({ presentationId: "page", text: "@Restricted help", assistantId: "asst-2", onRejected: rejected, onAccepted: accepted });
    await settle();
    const sse = t.net.lastChat().sse;
    sse.send("error", { ...(code ? { code } : {}), message, sharedChat: true });
    sse.send("done", {});
    sse.close();
    expect(await sent).toBe("failed");
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(accepted).not.toHaveBeenCalled();
    expect(t.state().transcript.messages).toEqual([]);
    expect(errors(t.state())).toEqual([{ code: "error", errorCode: code ?? "stream_error", message, sharedChat: true }]);
    expect(t.state().run.phase).toBe("failed");
    await settle();
    expect(t.net.follows.length).toBe(follows);
  });

  it("a group's first member rejected before save starts no later member", async () => {
    const t = setup("s-1");
    await settle();
    const rejected = vi.fn();
    const sent = t.controller.send({ presentationId: "page", text: "Both of you", responseGroup: ["asst-1", "asst-2"], onRejected: rejected });
    await settle();
    const sse = t.net.lastChat().sse;
    sse.send("error", { code: "assistant_clearance_exceeds_room", message: "Too broad" });
    sse.send("done", {});
    sse.close();
    expect(await sent).toBe("failed");
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(t.net.chats).toHaveLength(1);
    expect(t.state().transcript.messages).toEqual([]);
  });

  it("control: an error after acceptance still fails the turn and keeps the bubble", async () => {
    const t = setup();
    const rejected = vi.fn();
    const sent = t.controller.send({ presentationId: "page", text: "Accepted first", onRejected: rejected });
    await settle();
    const sse = t.net.lastChat().sse;
    sse.send("session", { sessionId: "s-1", turnId: TURN_A });
    sse.send("user_message_saved", { id: "row-user" });
    sse.send("error", { code: "upstream_unreachable", message: "Provider down" });
    sse.send("done", { turnId: TURN_A });
    sse.close();
    t.net.status.current = { status: "idle", turnId: TURN_A };
    expect(await sent).toBe("failed");
    expect(rejected).not.toHaveBeenCalled();
    expect(t.state().transcript.messages[0]).toMatchObject({ id: "row-user", role: "user", text: "Accepted first" });
    expect(errors(t.state())).toEqual([{ code: "error", errorCode: "upstream_unreachable", message: "Provider down" }]);
  });
});

describe("[COMP:app-web/conversation-controller] second browser pass (M5Q-12, M5Q-18, M5Q-19, M5Q-21)", () => {
  const TURN_DEAD = "4".repeat(64);
  const TURN_OLD = "8".repeat(64);
  const TURN_RESUMED = "c".repeat(64);
  const restoredCard = { toolCallId: "approval:ap-1", approvalId: "ap-1", toolName: "fileWrite", input: {}, sessionId: "s-1", status: "pending" as const };

  it("M5Q-12: Stop during admission ending with done{stopped} shows the stopped line for this viewer", async () => {
    const t = setup();
    const stop = deferred<{ stopped: boolean }>();
    t.net.transport.stopTurn.mockReturnValueOnce(stop.promise);
    t.net.transport.loadHistory.mockReturnValue(new Promise(() => {}));
    const sent = t.controller.send({ presentationId: "page", text: "Stop before output" });
    await settle();
    const sse = t.net.lastChat().sse;
    sse.send("session", { sessionId: "s-1", turnId: TURN_A });
    await settle();
    const stopping = t.controller.stop();
    await settle();
    sse.send("done", { stopped: true, reason: "stopped_by_user", turnId: TURN_A });
    sse.close();
    await settle();
    stop.resolve({ stopped: true, via: "aborted", stoppedByName: "M5 Owner" } as { stopped: boolean });
    expect(await stopping).toBe("stopped");
    expect(await sent).toBe("stopped");
    expect(t.state().run.phase).toBe("cancelled");
    expect(t.state().notices).toContainEqual({ code: "turnEnd", reason: "stopped_by_user", stoppedByName: null, senderUserId: SCOPE.viewerId });
    expect(errors(t.state())).toEqual([]);
  });

  it("M5Q-12: a done{stopped} without this viewer's Stop names the stopper", async () => {
    const t = setup();
    t.net.transport.loadHistory.mockReturnValue(new Promise(() => {}));
    const sent = t.controller.send({ presentationId: "page", text: "x" });
    await settle();
    const sse = t.net.lastChat().sse;
    sse.send("session", { sessionId: "s-1", turnId: TURN_A });
    sse.send("done", { stopped: true, reason: "stopped_by_user", stoppedByName: "Robin", turnId: TURN_A });
    sse.close();
    expect(await sent).toBe("stopped");
    expect(t.state().notices).toContainEqual({ code: "turnEnd", reason: "stopped_by_user", stoppedByName: "Robin", senderUserId: null });
  });

  it("M5Q-21: approving before the reclaim keeps following until the resumed turn runs", async () => {
    const t = setup("s-1");
    await settle();
    t.net.status.current = { status: "running", turnId: TURN_DEAD };
    t.net.lastFollow().sse!.send("status", { status: "running", turnId: TURN_DEAD });
    await settle();
    t.controller.presentConfirmation(restoredCard);
    t.net.transport.respondRestored.mockResolvedValueOnce({ ok: true });
    // Approve about 10 s after the restart, before the sweeper reclaims.
    expect(await t.controller.respondConfirmation("approval:ap-1", "approve")).toBe("resolved");
    await settle();
    // Recorded: the dead turn's reclaim ends the first stream.
    t.net.status.current = { status: "idle", turnId: TURN_DEAD };
    const first = t.net.lastFollow();
    first.sse!.send("turn_completed", { senderUserId: null, turnId: TURN_DEAD, reason: "stalled_reclaimed" });
    first.sse!.send("done", { turnId: TURN_DEAD });
    first.sse!.close(); // recorded `__close`
    await settle();
    expect(t.clock.timerDelays()).toContain(3_000);
    await t.clock.advance(3_000);
    // Recorded: an idle answer before the server holds.
    const second = t.net.lastFollow();
    expect(second).not.toBe(first);
    t.net.status.current = { status: "idle", turnId: TURN_OLD };
    second.sse!.send("status", { status: "idle", turnId: TURN_OLD, turnEndReason: "completed", startedAt: null });
    second.sse!.send("done", { turnId: TURN_OLD });
    second.sse!.close(); // recorded `__close`
    await settle();
    await t.clock.advance(6_000);
    // The scheduler starts the resume job: the reopened stream follows it.
    const third = t.net.lastFollow();
    expect(third).not.toBe(second);
    t.net.status.current = { status: "running", turnId: TURN_RESUMED };
    third.sse!.send("status", { status: "running", turnId: TURN_RESUMED });
    third.sse!.send("snapshot", { text: "Scripted reply to: outcome", turnId: TURN_RESUMED });
    await settle();
    expect(t.state().run.phase).toBe("running");
    const loads = t.net.transport.loadHistory.mock.calls.length;
    t.net.status.current = { status: "idle", turnId: TURN_RESUMED };
    third.sse!.send("turn_completed", { turnId: TURN_RESUMED });
    third.sse!.send("done", { turnId: TURN_RESUMED });
    await settle();
    expect(t.state().run.phase).toBe("completed");
    expect(t.net.transport.loadHistory.mock.calls.length).toBeGreaterThan(loads);
    // M5Q-19 on the same run: the reclaim notice does not stay under the resumed reply.
    expect(t.state().notices.filter((notice) => notice.code === "turnEnd")).toEqual([]);
    await t.clock.advance(130_000);
    expect(t.net.lastFollow()).toBe(third);
  });

  it("M5Q-21: past the window a resume follow that never sees the turn ends with one reload", async () => {
    const t = setup("s-1");
    await settle();
    t.net.status.current = { status: "idle", turnId: null };
    t.net.lastFollow().sse!.send("done", {});
    await settle();
    t.controller.presentConfirmation(restoredCard);
    await t.controller.respondConfirmation("approval:ap-1", "approve");
    await settle();
    await t.clock.advance(121_000);
    const loads = t.net.transport.loadHistory.mock.calls.length;
    const follows = t.net.follows.length;
    t.net.lastFollow().sse!.send("done", { turnId: null });
    await settle();
    await t.clock.advance(60_000);
    expect(t.net.follows.length).toBe(follows);
    expect(t.net.transport.loadHistory.mock.calls.length).toBe(loads + 1);
  });

  it("M5Q-19: a reclaimed-turn notice clears when a later turn starts running", async () => {
    const t = setup("s-1");
    await settle();
    t.net.status.current = { status: "running", turnId: TURN_DEAD };
    const hydrate = t.net.lastFollow().sse!;
    hydrate.send("status", { status: "running", turnId: TURN_DEAD });
    t.net.status.current = { status: "idle", turnId: TURN_DEAD };
    hydrate.send("turn_completed", { turnId: TURN_DEAD, reason: "stalled_reclaimed" });
    hydrate.send("done", { turnId: TURN_DEAD });
    await settle();
    expect(t.state().notices).toContainEqual(expect.objectContaining({ code: "turnEnd", reason: "stalled_reclaimed" }));
    expect(t.controller.followTurn()).toBe(true);
    await settle();
    t.net.status.current = { status: "running", turnId: TURN_RESUMED };
    t.net.lastFollow().sse!.send("status", { status: "running", turnId: TURN_RESUMED });
    await settle();
    expect(t.state().notices.filter((notice) => notice.code === "turnEnd")).toEqual([]);
  });

  it("M5Q-18: a teammate's restored approval maps 403 to forbidden and settles on the live resolution", async () => {
    const t = setup("s-1");
    await settle();
    t.net.status.current = { status: "running", turnId: TURN_A };
    const follow = t.net.lastFollow().sse!;
    follow.send("status", { status: "running", turnId: TURN_A });
    await settle();
    t.controller.presentConfirmation(restoredCard);
    t.net.transport.respondRestored.mockResolvedValueOnce({ ok: false, status: 403 });
    expect(await t.controller.respondConfirmation("approval:ap-1", "approve")).toBe("forbidden");
    expect(t.state().notices).toContainEqual({ code: "confirmNotAllowed" });
    expect(t.state().interaction.pending).toMatchObject({ approvalId: "ap-1", status: "retryable" });
    // The owner approves the live card: the bus frame carries the live toolCallId only.
    follow.send("activity", { event: "tool_confirmation_resolved", toolCallId: "toolu_live_1", decision: "allow", turnId: TURN_A });
    await settle();
    expect(t.state().transcript.pendingConfirmations).toMatchObject([{ approvalId: "ap-1", status: "approved" }]);
    expect(t.state().interaction.pending).toBeNull();
  });
});
