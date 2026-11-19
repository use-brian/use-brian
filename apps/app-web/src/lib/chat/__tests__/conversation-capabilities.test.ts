/**
 * [COMP:app-web/conversation-controller] Presentation capabilities the dock
 * (items 1 to 11) and the page (P1 to P8) need, over fake transports.
 */
import { describe, expect, it, vi } from "vitest";
import type { Message } from "@use-brian/chat-ui";
import type { DocSessionMessage } from "@/lib/api/sessions";
import { createConversationController, type PresentationCapabilities } from "../conversation-controller";
import { SCOPE, TURN_A, TURN_B, deferred, fakeScheduler, fakeTransport, settle } from "./conversation-fakes";

const row = (id: string, text: string, role: "user" | "assistant" = "assistant") =>
  ({ id, role, content: text, timestamp: "2026-11-16T00:00:00.000Z", attachments: [] }) as unknown as DocSessionMessage;
const mapRows = (rows: DocSessionMessage[]): Message[] =>
  rows.map((item) => ({ id: item.id, role: item.role as "user" | "assistant", text: `mapped:${String(item.content)}`, timestamp: new Date(0) }));

function setup(opts: { sessionId?: string | null; room?: boolean; profile?: "page" | "dock"; capabilities?: Partial<PresentationCapabilities>; mappedHistory?: boolean; historyRows?: () => Promise<DocSessionMessage[]> } = {}) {
  const net = fakeTransport();
  if (opts.mappedHistory === false) (net.transport as { loadHistory?: unknown }).loadHistory = undefined;
  if (opts.historyRows) net.transport.fetchHistoryRows = vi.fn(opts.historyRows);
  const clock = fakeScheduler();
  const controller = createConversationController({
    scope: SCOPE, sessionId: opts.sessionId === undefined ? null : opts.sessionId, room: opts.room,
    transport: net.transport, scheduler: clock.scheduler,
  });
  const frames: string[] = [];
  const capabilities: PresentationCapabilities = {
    profile: opts.profile ?? "dock",
    onFrame: (frame) => frames.push(`${frame.stream}:${frame.event}`),
    ...opts.capabilities,
  };
  controller.attach("host", capabilities);
  return { net, clock, controller, frames, state: () => controller.getSnapshot() };
}

async function begin(t: ReturnType<typeof setup>, input: Partial<Parameters<ReturnType<typeof setup>["controller"]["send"]>[0]> = {}) {
  const sent = t.controller.send({ presentationId: "host", text: "Hello", ...input });
  await settle();
  const sse = t.net.lastChat().sse;
  sse.send("session", { sessionId: "s-1", turnId: TURN_A });
  await settle();
  return { sent, sse };
}

describe("[COMP:app-web/conversation-controller] dock capabilities", () => {
  it("1: seeds and reloads history through the presentation's localized row mapper", async () => {
    const t = setup({ sessionId: "s-1", mappedHistory: false, capabilities: { mapHistoryRows: mapRows }, historyRows: async () => [row("m-1", "Earlier reply")] });
    await settle();
    expect(t.state().transcript.messages.map((item) => item.text)).toEqual(["mapped:Earlier reply"]);
    t.net.transport.fetchHistoryRows = vi.fn(async () => [row("m-1", "Earlier reply"), row("m-2", "Resumed answer")]);
    await t.controller.reloadHistory();
    expect(t.state().transcript.messages.map((item) => item.id)).toEqual(["m-1", "m-2"]);
    // A failed read keeps what is painted instead of emptying it.
    t.net.transport.fetchHistoryRows = vi.fn(async () => { throw new Error("chat_history_failed: 503"); });
    await t.controller.reloadHistory();
    expect(t.state().transcript.messages).toHaveLength(2);
  });

  it("2: appends canonical rows and installs held rows", () => {
    const t = setup({ sessionId: "s-1" });
    t.controller.loadMessages([{ id: "m-1", role: "user", text: "Hi", timestamp: new Date(0) }]);
    t.controller.appendMessage({ id: "voice-1", role: "assistant", text: "Draft", timestamp: new Date(0) });
    t.controller.appendMessage({ id: "voice-1", role: "assistant", text: "Final voice job", timestamp: new Date(0) });
    expect(t.state().transcript.messages.map((item) => item.text)).toEqual(["Hi", "Final voice job"]);
  });

  it("3 and 4: keeps user message extras and commits views with the dock preset", async () => {
    const t = setup();
    const { sent, sse } = await begin(t, { userMessage: { userAttachments: [{ id: "thumb-1" }] } });
    sse.send("user_message_saved", { id: "row-user" });
    sse.send("view_payload", { toolUseId: "v-1", viewId: "view-1", action: "created" });
    sse.send("text_delta", { text: "Drafted." });
    sse.send("done", { turnId: TURN_A });
    sse.close();
    expect(await sent).toBe("completed");
    const [user, reply] = t.state().transcript.messages as Array<Message & Record<string, unknown>>;
    expect(user).toMatchObject({ id: "row-user", userAttachments: [{ id: "thumb-1" }] });
    expect(reply).toMatchObject({ text: "Drafted.", views: [{ toolUseId: "v-1", viewId: "view-1", action: "created" }] });
  });

  it("5: askQuestion is never an approve/deny card; the ended turn restores the question", async () => {
    const t = setup();
    const { sent, sse } = await begin(t);
    sse.send("tool_confirmation_required", { toolCallId: "call-q", toolName: "askQuestion", input: {} });
    // Not a direct frame (server-side loop event): ignorable at the boundary.
    sse.send("awaiting_approval", { toolName: "askQuestion", approvalId: "ignored" });
    await settle();
    expect(t.state().transcript.pendingConfirmations).toEqual([]);
    expect(t.state().interaction.pending).toBeNull();
    t.net.pending.current = { pending: { approvalId: "q-ap", question: "Which SDK?", expiresAt: "2026-11-17T00:00:00.000Z" }, toolConfirmation: null };
    sse.send("done", { turnId: TURN_A });
    sse.close();
    await sent;
    await settle();
    expect(t.state().interaction.pending).toMatchObject({
      kind: "question", approvalId: "q-ap", source: "restored",
      payload: { question: "Which SDK?", sessionId: "s-1", expiresAt: "2026-11-17T00:00:00.000Z" },
    });
  });

  it("6: restores pending input on the hydrate attach and accepts host-presented input", async () => {
    const net = fakeTransport();
    net.pending.current = { pending: { approvalId: "q-1", question: "Proceed?", expiresAt: null }, toolConfirmation: null };
    const controller = createConversationController({ scope: SCOPE, sessionId: "s-1", transport: net.transport, scheduler: fakeScheduler().scheduler });
    controller.attach("dock", { profile: "dock" });
    await settle();
    expect(net.transport.fetchPending).toHaveBeenCalledWith("s-1");
    expect(controller.getSnapshot().interaction.pending).toMatchObject({ kind: "question", approvalId: "q-1", source: "restored" });
    expect(controller.presentConfirmation({ toolCallId: "approval:ap-2", approvalId: "ap-2", toolName: "fileWrite", input: {}, sessionId: "s-1", status: "pending" })).toBe(true);
    expect(controller.getSnapshot().transcript.pendingConfirmations).toMatchObject([{ approvalId: "ap-2", restored: true }]);
  });

  it("7: questionSettled resolves the panel's question and follows the resume without a second POST", async () => {
    const t = setup({ sessionId: "s-1" });
    await settle();
    t.net.status.current = { status: "idle", turnId: null };
    t.net.lastFollow().sse!.send("status", { status: "idle" });
    t.net.lastFollow().sse!.send("done", {});
    await settle();
    t.controller.presentQuestion({ approvalId: "q-1", question: "Proceed?", expiresAt: null, sessionId: "s-1" });
    const before = t.net.follows.length;
    expect(t.controller.questionSettled("other")).toBe(false);
    expect(t.controller.questionSettled("q-1")).toBe(true);
    await settle();
    expect(t.state().interaction.pending).toBeNull();
    expect(t.net.transport.answerQuestion).not.toHaveBeenCalled();
    expect(t.net.follows.length).toBe(before + 1);
  });

  it("8 and 9: keeps research phases and server text with error extras", async () => {
    const t = setup();
    const { sent, sse } = await begin(t);
    sse.send("status", { phase: "research_starting" });
    sse.send("notice", { code: "new_server_notice", message: "Server-authored notice" });
    sse.send("error", { code: "delivery_audience_unverified", message: "Audience changed", sharedChat: true });
    await settle();
    expect(t.state().researchPhase).toBe("starting");
    expect(t.state().notices).toContainEqual({ code: "turnNotice", notice: "new_server_notice", message: "Server-authored notice" });
    expect(t.state().notices).toContainEqual({ code: "error", errorCode: "delivery_audience_unverified", message: "Audience changed", sharedChat: true });
    sse.send("done", {});
    sse.close();
    t.net.status.current = { status: "idle", turnId: TURN_A };
    await sent;
    void t.controller.send({ presentationId: "host", text: "Again" });
    await settle();
    expect(t.state().researchPhase).toBeNull();
  });

  it("10: steer escalates a queued input with the same inputId", async () => {
    const t = setup();
    await begin(t);
    expect(t.controller.queue("Also check refunds", false)).toBe(true);
    await settle();
    const { inputId } = t.state().queued[0]!;
    expect(t.controller.steer(inputId)).toBe(true);
    expect(t.controller.steer(inputId)).toBe(false);
    await settle();
    expect(t.net.sides.map((body) => [body.inputId, body.steer])).toEqual([[inputId, false], [inputId, true]]);
    expect(t.state().queued[0]).toMatchObject({ inputId, steer: true });
  });

  it("11 and P7: observes every direct frame once, in order, before paint batching", async () => {
    const t = setup({ profile: "page" });
    const { sse } = await begin(t);
    sse.send("reasoning", { text: "thinking" });
    sse.send("tool_start", { id: "t-1", name: "webSearch" });
    sse.send("document_payload", { id: "doc-1", title: "Source", content: "x" });
    sse.send("research_saved", { activityId: "act-1", status: "saved" });
    sse.send("text_delta", { text: "Answer" });
    sse.send("unknown_frame", {});
    await settle();
    expect(t.frames).toEqual(["direct:session", "direct:reasoning", "direct:tool_start", "direct:document_payload", "direct:research_saved", "direct:text_delta"]);
    expect(t.state().transcript.streamingText).toBe("");
  });
});

describe("[COMP:app-web/conversation-controller] page capabilities", () => {
  it("P1: reads typing viewers from ViewerPresence.isTyping", async () => {
    const t = setup({ sessionId: "s-1", room: true });
    await settle();
    t.net.lastFollow().sse!.send("presence", { viewers: [
      { userId: "viewer-2", name: "Robin", isTyping: true, lastSeen: "now" },
      { userId: SCOPE.viewerId, name: "Me", isTyping: true, lastSeen: "now" },
      { userId: "viewer-3", name: "Sam", isTyping: false, lastSeen: "now" },
    ] });
    await settle();
    expect(t.state().room.typers).toEqual([{ userId: "viewer-2", name: "Robin" }]);
  });

  it("P2: suppresses the own room echo while the direct POST streams, keeps teammates and the sender", async () => {
    const t = setup({ sessionId: "s-1", room: true, profile: "page" });
    await settle();
    const { sse } = await begin(t);
    const follow = t.net.lastFollow().sse!;
    t.frames.length = 0;
    follow.send("snapshot", { text: "own echo", turnId: TURN_A, senderUserId: SCOPE.viewerId });
    await settle();
    t.clock.runFrames();
    expect(t.state().mirror.active).toBe(false);
    expect(t.frames).toEqual([]);
    follow.send("snapshot", { text: "teammate", turnId: TURN_A, senderUserId: "viewer-2" });
    await settle();
    t.clock.runFrames();
    expect(t.state().mirror).toMatchObject({ active: true, text: "teammate", senderUserId: "viewer-2" });
    sse.close();
    await settle();
    t.net.status.current = { status: "idle", turnId: TURN_A };
    t.net.lastFollow().sse!.send("turn_completed", { turnId: TURN_A, reason: "stopped_by_user", senderUserId: SCOPE.viewerId });
    await settle();
    expect(t.state().notices).toContainEqual({ code: "turnEnd", reason: "stopped_by_user", stoppedByName: null, senderUserId: SCOPE.viewerId });
  });

  it("P3: setRoom starts and stops the whole-life follow", async () => {
    const t = setup({ sessionId: "s-1" });
    await settle();
    t.net.status.current = { status: "idle", turnId: null };
    t.net.lastFollow().sse!.send("status", { status: "idle" });
    t.net.lastFollow().sse!.send("done", {});
    await settle();
    const opened = t.net.follows.length;
    t.controller.setRoom(true);
    await settle();
    expect(t.net.follows.length).toBe(opened + 1);
    const roomFollow = t.net.lastFollow().sse!;
    t.controller.setRoom(false);
    expect(roomFollow.aborted()).toBe(true);
    expect(t.controller.isRoom()).toBe(false);
  });

  it("P4: runs a response group as one user row and continuations from its saved id", async () => {
    const t = setup({ sessionId: "s-1", profile: "page" });
    await settle();
    const saved = vi.fn();
    const accepted = vi.fn();
    // Keep the end-of-group history reload pending so the live rows are inspected.
    t.net.transport.loadHistory.mockReturnValue(new Promise(() => {}));
    const sent = t.controller.send({
      presentationId: "host", text: "Both of you?", responseGroup: ["asst-1", "asst-2"], assistantId: "asst-1",
      fileIds: ["file-1"], override: { truncateFromMessageId: "old" }, onUserMessageSaved: saved, onAccepted: accepted,
    });
    await settle();
    const first = t.net.lastChat();
    expect(first.body).toMatchObject({ assistantId: "asst-1", fileIds: ["file-1"], truncateFromMessageId: "old", roomResponseGroup: { assistantIds: ["asst-1", "asst-2"] } });
    first.sse.send("user_message_saved", { id: "u-1" });
    first.sse.send("text_delta", { text: "First." });
    first.sse.send("done", { turnId: TURN_A });
    first.sse.close();
    await settle();
    expect(saved).toHaveBeenCalledWith("u-1");
    expect(accepted).toHaveBeenCalledWith("u-1");
    const second = t.net.lastChat();
    expect(second).not.toBe(first);
    expect(second.body).toMatchObject({ assistantId: "asst-2", roomResponseGroup: { assistantIds: ["asst-1", "asst-2"], sourceMessageId: "u-1" } });
    expect(second.body).not.toHaveProperty("fileIds");
    expect(second.body).not.toHaveProperty("truncateFromMessageId");
    second.sse.send("text_delta", { text: "Second." });
    second.sse.send("done", { turnId: TURN_B });
    second.sse.close();
    expect(await sent).toBe("completed");
    expect(t.state().transcript.messages.filter((item) => item.role === "user")).toHaveLength(1);
    expect(t.state().transcript.messages.map((item) => item.text)).toEqual(["Both of you?", "First.", "Second."]);
  });

  it("P4: Stop applies to the remaining group members", async () => {
    const t = setup({ sessionId: "s-1", profile: "page" });
    await settle();
    const sent = t.controller.send({ presentationId: "host", text: "Both?", responseGroup: ["asst-1", "asst-2"] });
    await settle();
    const first = t.net.lastChat();
    first.sse.send("session", { sessionId: "s-1", turnId: TURN_A });
    first.sse.send("user_message_saved", { id: "u-1" });
    await settle();
    expect(await t.controller.stop()).toBe("stopped");
    expect(await sent).toBe("stopped");
    expect(t.net.chats).toHaveLength(1);
  });

  it("P5: server-held room input and an addressed send during a teammate's turn", async () => {
    const t = setup({ sessionId: "s-1", room: true, profile: "page" });
    await settle();
    t.net.status.current = { status: "running", turnId: TURN_A };
    t.net.lastFollow().sse!.send("status", { status: "running", turnId: TURN_A, senderUserId: "viewer-2" });
    await settle();
    expect(t.state().run.phase).toBe("running");
    const accepted = vi.fn();
    expect(await t.controller.send({ presentationId: "host", text: "@Brian also this", assistantId: "asst-1", bodyExtras: { midTurn: true, ask: true }, onAccepted: accepted })).toBe("queued");
    expect(t.net.sides.at(-1)).toMatchObject({ message: "@Brian also this", midTurn: true, ask: true, assistantId: "asst-1", sessionId: "s-1" });
    expect(accepted).toHaveBeenCalled();
    expect(t.controller.queue("held post", false, { assistantId: "asst-1", serverHeld: true })).toBe(true);
    expect(t.state().queued.every((item) => item.serverHeld)).toBe(true);
    t.net.status.current = { status: "idle", turnId: TURN_A };
    t.net.lastFollow().sse!.send("turn_completed", { turnId: TURN_A });
    await settle();
    await t.clock.advance(0);
    expect(t.state().queued).toEqual([]);
    expect(t.state().unsent).toEqual([]);
    expect(t.net.chats).toHaveLength(0);
  });

  it("P6: mirrored reply phases and research phase", async () => {
    const t = setup({ sessionId: "s-1", room: true });
    await settle();
    t.net.status.current = { status: "running", turnId: TURN_A };
    const follow = t.net.lastFollow().sse!;
    follow.send("status", { status: "running", turnId: TURN_A });
    follow.send("activity", { event: "status", phase: "research_parallel", turnId: TURN_A });
    follow.send("activity", { event: "reply_text_complete", turnId: TURN_A });
    await settle();
    expect(t.state().mirror).toMatchObject({ researchPhase: "parallel", replyPhase: "saving" });
    follow.send("activity", { event: "assistant_message_saved", turnId: TURN_A });
    await settle();
    expect(t.state().mirror.replyPhase).toBe("finishing");
  });

  it("C17: a re-attached own turn's follow frames reach every observer", async () => {
    const t = setup({ profile: "page" });
    const other = vi.fn();
    const { sent, sse } = await begin(t);
    t.controller.attach("later", { profile: "dock", onFrame: other });
    sse.close();
    await sent;
    await settle();
    t.net.lastFollow().sse!.send("status", { status: "running", turnId: TURN_A });
    await settle();
    expect(t.frames.at(-1)).toBe("follow:status");
    expect(other).toHaveBeenCalledTimes(1);
    expect(other.mock.calls[0]![0]).toMatchObject({ stream: "follow", event: "status" });
  });
});

describe("[COMP:app-web/conversation-controller] cutover rules", () => {
  it("G1: a mirrored resolved card is marked, not left pending", async () => {
    const room = setup({ sessionId: "s-1", room: true });
    await settle();
    room.net.status.current = { status: "running", turnId: TURN_A };
    const follow = room.net.lastFollow().sse!;
    follow.send("status", { status: "running", turnId: TURN_A });
    follow.send("activity", { event: "tool_confirmation_required", toolCallId: "call-2", approvalId: "ap-2", toolName: "fileWrite", turnId: TURN_A, senderUserId: "viewer-2" });
    follow.send("activity", { event: "tool_confirmation_resolved", toolCallId: "call-2", decision: "always_deny", turnId: TURN_A, senderUserId: "viewer-2" });
    await settle();
    expect(room.state().transcript.pendingConfirmations).toMatchObject([{ toolCallId: "call-2", status: "denied" }]);
    expect(room.state().interaction.pending).toBeNull();
  });

  it("G2: follow completion clears mirrored cards but keeps a suspended question", async () => {
    const t = setup({ sessionId: "s-1", room: true });
    await settle();
    t.net.status.current = { status: "running", turnId: TURN_A };
    const follow = t.net.lastFollow().sse!;
    follow.send("status", { status: "running", turnId: TURN_A });
    follow.send("activity", { event: "tool_confirmation_required", toolCallId: "call-3", approvalId: "ap-3", toolName: "fileWrite", turnId: TURN_A, senderUserId: "viewer-2" });
    await settle();
    expect(t.state().interaction.pending).toMatchObject({ approvalId: "ap-3" });
    t.net.status.current = { status: "idle", turnId: TURN_A };
    follow.send("turn_completed", { turnId: TURN_A });
    await settle();
    expect(t.state().transcript.pendingConfirmations).toEqual([]);
    expect(t.state().interaction.pending).toBeNull();
    t.controller.presentQuestion({ approvalId: "q-9", question: "Still there?", expiresAt: null, sessionId: "s-1" });
    expect(t.state().interaction.pending).toMatchObject({ kind: "question", approvalId: "q-9" });
  });

  it("G3: exposes the assistant each response-group member answers as", async () => {
    const t = setup({ sessionId: "s-1", profile: "page" });
    await settle();
    t.net.transport.loadHistory.mockReturnValue(new Promise(() => {}));
    void t.controller.send({ presentationId: "host", text: "Both?", responseGroup: ["asst-1", "asst-2"] });
    await settle();
    expect(t.state().liveAssistantId).toBe("asst-1");
    const first = t.net.lastChat();
    first.sse.send("user_message_saved", { id: "u-1" });
    first.sse.send("done", { turnId: TURN_A });
    first.sse.close();
    await settle();
    expect(t.state().liveAssistantId).toBe("asst-2");
  });

  it("G5: never replaces history owned by a presentation without a mapper", async () => {
    const net = fakeTransport();
    (net.transport as { loadHistory?: unknown }).loadHistory = undefined;
    net.transport.fetchHistoryRows = vi.fn(async () => [row("m-1", "dock mapped")]);
    const controller = createConversationController({ scope: SCOPE, sessionId: "s-1", transport: net.transport, scheduler: fakeScheduler().scheduler });
    controller.attach("page", { profile: "page" });
    controller.loadMessages([{ id: "m-1", role: "assistant", text: "page mapped", timestamp: new Date(0) }]);
    controller.attach("dock", { profile: "dock", mapHistoryRows: mapRows });
    await settle();
    await controller.reloadHistory();
    expect(net.transport.fetchHistoryRows).not.toHaveBeenCalled();
    expect(controller.getSnapshot().transcript.messages.map((item) => item.text)).toEqual(["page mapped"]);
    expect(controller.getSnapshot().historyEpoch).toBeGreaterThan(0);
    controller.detach("page");
    await controller.reloadHistory();
    expect(controller.getSnapshot().transcript.messages.map((item) => item.text)).toEqual(["mapped:dock mapped"]);
  });

  it("G6: keeps a bounded build log while detached so a returning presentation rebuilds its feed", async () => {
    const t = setup({ profile: "page" });
    const { sse } = await begin(t);
    t.controller.detach("host");
    sse.send("reasoning", { text: "thinking" });
    sse.send("tool_start", { id: "t-1", name: "webSearch" });
    await settle();
    const log = t.controller.getBuildLog();
    expect(log.frames.map((frame) => frame.event)).toEqual(["session", "reasoning", "tool_start"]);
    expect(log.dropped).toBe(0);
    for (let i = 0; i < 1_005; i++) sse.send("text_delta", { text: "x" });
    await settle(20);
    expect(t.controller.getBuildLog().frames).toHaveLength(1_000);
    expect(t.controller.getBuildLog().dropped).toBeGreaterThan(0);
    sse.send("done", { turnId: TURN_A });
    sse.close();
    await settle();
    void t.controller.send({ presentationId: "host", text: "Next turn" });
    await settle();
    expect(t.controller.getBuildLog().frames).toEqual([]);
  });

  it("G7: exposes external confirmations from the one hydrate read, or skips the probe", async () => {
    const net = fakeTransport();
    const request = { approvalId: "ext-1", title: "Approve the fictional vendor", expiresAt: "2026-11-18T00:00:00.000Z" };
    net.pending.current = { pending: null, toolConfirmation: null, externalConfirmations: [request] };
    const controller = createConversationController({ scope: SCOPE, sessionId: "s-1", transport: net.transport, scheduler: fakeScheduler().scheduler });
    controller.attach("page", { profile: "page" });
    await settle();
    expect(net.transport.fetchPending).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().pendingInput).toEqual({ sessionId: "s-1", externalConfirmations: [request] });
    // refreshPendingInput updates the same field; an unknown read keeps it.
    net.pending.current = { pending: null, toolConfirmation: null };
    await controller.refreshPendingInput();
    expect(controller.getSnapshot().pendingInput).toEqual({ sessionId: "s-1", externalConfirmations: [request] });
    net.pending.current = { pending: null, toolConfirmation: null, externalConfirmations: [] };
    await controller.refreshPendingInput();
    expect(controller.getSnapshot().pendingInput).toEqual({ sessionId: "s-1", externalConfirmations: [] });
    expect(net.transport.fetchPending).toHaveBeenCalledTimes(3);
    controller.dispose();
    expect(controller.getSnapshot().pendingInput).toBeNull();
    const skipped = fakeTransport();
    const other = createConversationController({ scope: SCOPE, sessionId: "s-2", transport: skipped.transport, scheduler: fakeScheduler().scheduler });
    other.attach("page", { profile: "page", pendingProbe: false });
    await settle();
    expect(skipped.transport.fetchPending).not.toHaveBeenCalled();
  });
});

describe("[COMP:app-web/conversation-controller] follow status rules", () => {
  it("G8: keeps the earlier of the direct start and the server's lease start", async () => {
    const t = setup({ profile: "page" });
    const directStart = t.clock.scheduler.now();
    const { sent, sse } = await begin(t);
    await t.clock.advance(5_000);
    sse.close();
    await sent;
    await settle();
    expect(t.state().mirror.startedAt).toBe(directStart);
    t.net.lastFollow().sse!.send("status", { status: "running", turnId: TURN_A, startedAt: directStart + 4_000 });
    await settle();
    expect(t.state().mirror.startedAt).toBe(directStart);

    const fresh = setup({ sessionId: "s-1" });
    await settle();
    const leaseStart = fresh.clock.scheduler.now() - 9_000;
    fresh.net.lastFollow().sse!.send("status", { status: "running", turnId: TURN_A, startedAt: leaseStart });
    await settle();
    expect(fresh.state().mirror.startedAt).toBe(leaseStart);
    fresh.net.lastFollow().sse!.send("status", { status: "running", turnId: TURN_A, startedAt: Number.NaN });
    await settle();
    expect(fresh.state().mirror.startedAt).toBe(leaseStart);
  });

  it.each([
    [{ status: "timeout" }, "timeout"],
    [{ status: "idle", turnEndReason: "timeout" }, "timeout"],
    [{ status: "idle", turnEndReason: "stalled_reclaimed" }, "stalled_reclaimed"],
    [{ status: "failed" }, "failed"],
  ])("G9: explains an initial terminal status %j", async (status, reason) => {
    const t = setup({ sessionId: "s-1" });
    await settle();
    t.net.status.current = { status: String(status.status), turnId: null };
    t.net.lastFollow().sse!.send("status", status);
    await settle();
    expect(t.state().notices).toContainEqual({ code: "turnEnd", reason, stoppedByName: null, senderUserId: null });
  });

  it("G9: an ordinary idle status explains nothing", async () => {
    const t = setup({ sessionId: "s-1" });
    await settle();
    t.net.status.current = { status: "idle", turnId: null };
    t.net.lastFollow().sse!.send("status", { status: "idle" });
    await settle();
    expect(t.state().notices).toEqual([]);
  });
});

describe("[COMP:app-web/conversation-controller] frame contract alignment", () => {
  it("a kind-only notice reaches presentations with its kind as the code", async () => {
    const t = setup();
    const { sse } = await begin(t);
    sse.send("notice", { kind: "pdf_large_document", message: "Large PDF" });
    await settle();
    expect(t.state().notices).toContainEqual({ code: "turnNotice", notice: "pdf_large_document", message: "Large PDF" });
  });

  it("a mirrored assistant_message_saved moves the reply phase to finishing", async () => {
    const t = setup({ sessionId: "s-1", room: true });
    await settle();
    t.net.status.current = { status: "running", turnId: TURN_A };
    const follow = t.net.lastFollow().sse!;
    follow.send("status", { status: "running", turnId: TURN_A });
    follow.send("assistant_message_saved", { id: "row-9", turnId: TURN_A });
    await settle();
    expect(t.state().mirror).toMatchObject({ active: true, replyPhase: "finishing" });
  });
});

describe("[COMP:app-web/conversation-controller] page cutover follow-ups", () => {
  it("an empty pending probe clears a stale question card but not a newer one", async () => {
    const t = setup({ sessionId: "s-1", capabilities: { pendingProbe: false } });
    await settle();
    t.controller.presentQuestion({ approvalId: "q-old", question: "Stale?", expiresAt: null, sessionId: "s-1" });
    t.net.pending.current = { pending: null, toolConfirmation: null };
    await t.controller.refreshPendingInput();
    expect(t.state().interaction.pending).toBeNull();

    const late = deferred<{ pending: null; toolConfirmation: null }>();
    t.net.transport.fetchPending.mockReturnValueOnce(late.promise);
    const probing = t.controller.refreshPendingInput();
    t.controller.presentQuestion({ approvalId: "q-new", question: "Newer?", expiresAt: null, sessionId: "s-1" }, "live");
    late.resolve({ pending: null, toolConfirmation: null });
    await probing;
    expect(t.state().interaction.pending).toMatchObject({ approvalId: "q-new" });
  });

  it("the own direct turn's follow turn_completed does not refetch history; a teammate's does", async () => {
    const t = setup({ sessionId: "s-1", room: true, profile: "page" });
    await settle();
    const { sent, sse } = await begin(t);
    sse.send("text_delta", { text: "Committed reply" });
    sse.send("done", { turnId: TURN_A });
    sse.close();
    expect(await sent).toBe("completed");
    const epoch = t.state().historyEpoch;
    const loads = t.net.transport.loadHistory.mock.calls.length;
    t.net.status.current = { status: "idle", turnId: TURN_A };
    const follow = t.net.lastFollow().sse!;
    follow.send("turn_completed", { turnId: TURN_A, senderUserId: SCOPE.viewerId });
    await settle();
    expect(t.state().historyEpoch).toBe(epoch);
    expect(t.net.transport.loadHistory.mock.calls.length).toBe(loads);
    expect(t.state().transcript.messages.at(-1)).toMatchObject({ text: "Committed reply" });
    t.net.status.current = { status: "idle", turnId: TURN_B };
    follow.send("turn_completed", { turnId: TURN_B, senderUserId: "viewer-2" });
    await settle();
    expect(t.state().historyEpoch).toBe(epoch + 1);
  });
});

describe("[COMP:app-web/conversation-controller] WP-E host capabilities", () => {
  const FEED_SESSION = "11111111-1111-4111-8111-111111111111";
  const TARGET = "22222222-2222-4222-8222-222222222222";

  it("C1, C3, C7: typed Feed, Office and audience fields ride every send path", async () => {
    const t = setup({ sessionId: "s-1", room: true, profile: "page" });
    await settle();
    const extras = {
      feedTarget: { sessionId: FEED_SESSION, revision: 3 },
      officeSelection: { targetIds: [TARGET] },
      sessionAudience: "personal" as const,
    };
    const { sse } = await begin(t, { bodyExtras: extras });
    expect(t.net.lastChat().body).toMatchObject(extras);
    expect(t.controller.queue("and this", false, { bodyExtras: { officeSelection: { targetIds: [TARGET] } } })).toBe(true);
    expect(t.net.sides.at(-1)).toMatchObject({ officeSelection: { targetIds: [TARGET] } });
    sse.send("done", { turnId: TURN_A });
    sse.close();
    await settle();
    // Room mid-turn post during a teammate's followed turn carries the selection too.
    t.net.status.current = { status: "running", turnId: TURN_B };
    t.net.lastFollow().sse!.send("status", { status: "running", turnId: TURN_B, senderUserId: "viewer-2" });
    await settle();
    expect(await t.controller.send({ presentationId: "host", text: "@Brian edit these", assistantId: "asst-1",
      bodyExtras: { midTurn: true, ask: true, officeSelection: { targetIds: [TARGET] } } })).toBe("queued");
    expect(t.net.sides.at(-1)).toMatchObject({ midTurn: true, officeSelection: { targetIds: [TARGET] } });
    for (const bad of [
      { officeSelection: { targetIds: ["not-a-uuid"] } },
      { officeSelection: { targetIds: Array.from({ length: 51 }, () => TARGET) } },
      { officeSelection: { targetIds: [TARGET], extra: true } },
      { feedTarget: { sessionId: "nope", revision: 1 } },
      { sessionAudience: "workspace" },
    ]) {
      expect(await t.controller.send({ presentationId: "host", text: "x", bodyExtras: bad as never })).toBe("invalid");
    }
  });

  it("C2: always_allow needs the card's persistent capability on both paths", async () => {
    const t = setup({ profile: "page" });
    const { sse } = await begin(t);
    sse.send("tool_confirmation_required", { toolCallId: "call-1", approvalId: "ap-1", toolName: "fileWrite" });
    await settle();
    expect(await t.controller.respondConfirmation("call-1", "always_allow")).toBe("invalid");
    expect(t.net.transport.confirmLive).not.toHaveBeenCalled();
    sse.send("tool_confirmation_required", { toolCallId: "call-2", approvalId: "ap-2", toolName: "fileWrite", allowPersistentApproval: true });
    await settle();
    expect(await t.controller.respondConfirmation("call-2", "always_allow")).toBe("resolved");
    expect(t.net.transport.confirmLive).toHaveBeenCalledWith({ sessionId: "s-1", toolCallId: "call-2", decision: "always_allow" });
    expect(t.state().transcript.pendingConfirmations.find((item) => item.toolCallId === "call-2")?.status).toBe("approved");
    t.controller.presentConfirmation({ toolCallId: "approval:ap-3", approvalId: "ap-3", toolName: "fileWrite", input: {}, sessionId: "s-1", status: "pending", allowPersistentApproval: true });
    expect(await t.controller.respondConfirmation("approval:ap-3", "always_allow", "Keep allowing")).toBe("resolved");
    expect(t.net.transport.respondRestored).toHaveBeenCalledWith("ap-3", "approved", "Keep allowing", { grantAlways: true });
  });

  it("C4: all presentations hidden for 60 s release only the transport, visible reopens", async () => {
    const t = setup({ sessionId: "s-1", room: true });
    t.controller.attach("drawer", { profile: "dock" });
    await settle();
    t.net.status.current = { status: "running", turnId: TURN_A };
    const first = t.net.lastFollow();
    first.sse!.send("status", { status: "running", turnId: TURN_A, senderUserId: "viewer-2" });
    first.sse!.send("snapshot", { text: "teammate", turnId: TURN_A, senderUserId: "viewer-2" });
    await settle();
    t.clock.runFrames();
    t.controller.setVisible("host", false);
    await t.clock.advance(61_000);
    expect(first.sse!.aborted()).toBe(false); // the drawer is still visible
    t.controller.setVisible("drawer", false);
    await t.clock.advance(59_000);
    expect(first.sse!.aborted()).toBe(false);
    await t.clock.advance(2_000);
    expect(first.sse!.aborted()).toBe(true);
    expect(t.state().run.phase).toBe("running");
    expect(t.state().mirror).toMatchObject({ active: true, text: "teammate" });
    expect(t.state().notices.filter((notice) => notice.code === "reconnectFailed")).toEqual([]);
    expect(t.net.transport.stopTurn).not.toHaveBeenCalled();
    const opened = t.net.follows.length;
    t.controller.setVisible("drawer", true);
    await settle();
    expect(t.net.follows.length).toBe(opened + 1);
  });

  it("C4: a personal follow that already saw done has nothing to reopen", async () => {
    const t = setup({ sessionId: "s-1" });
    await settle();
    t.net.status.current = { status: "idle", turnId: null };
    t.net.lastFollow().sse!.send("done", {});
    await settle();
    const opened = t.net.follows.length;
    t.controller.setVisible("host", false);
    await t.clock.advance(61_000);
    t.controller.setVisible("host", true);
    await settle();
    expect(t.net.follows.length).toBe(opened);
  });

  it("C5: releaseOnDetach frees a followed entry; another attached presentation keeps it", async () => {
    const t = setup({ sessionId: "s-1", capabilities: { releaseOnDetach: true } });
    await settle();
    t.net.status.current = { status: "running", turnId: TURN_A };
    const watch = t.net.lastFollow();
    watch.sse!.send("status", { status: "running", turnId: TURN_A });
    await settle();
    expect(t.controller.hasLiveTurn()).toBe(true);
    const detachOther = t.controller.attach("other", { profile: "page" });
    t.controller.detach("host");
    await t.clock.advance(0);
    expect(watch.sse!.aborted()).toBe(false);
    detachOther();
    t.controller.attach("live", { profile: "page", releaseOnDetach: true });
    t.controller.detach("live");
    await t.clock.advance(0);
    expect(watch.sse!.aborted()).toBe(true);
    expect(t.controller.hasLiveTurn()).toBe(false);
    expect(t.net.transport.stopTurn).not.toHaveBeenCalled();
    // A later focus on the same (not yet evicted) entry re-hydrates with one stream.
    const opened = t.net.follows.length;
    t.controller.attach("live", { profile: "page", releaseOnDetach: true });
    await settle();
    expect(t.net.follows.length).toBe(opened + 1);
  });

  it("C5: never interrupts a direct POST", async () => {
    const t = setup({ profile: "page", capabilities: { releaseOnDetach: true } });
    const { sse } = await begin(t);
    t.controller.detach("host");
    await t.clock.advance(0);
    expect(sse.aborted()).toBe(false);
    expect(t.controller.hasLiveTurn()).toBe(true);
  });

  it("C6: stop resolves alreadyEnded when the server reports the turn already over", async () => {
    const t = setup({ profile: "page" });
    const { sent, sse } = await begin(t);
    t.net.transport.stopTurn.mockResolvedValueOnce({ stopped: false });
    expect(await t.controller.stop()).toBe("alreadyEnded");
    expect(sse.aborted()).toBe(false);
    sse.send("done", { turnId: TURN_A });
    sse.close();
    expect(await sent).toBe("completed");
  });
});

describe("[COMP:app-web/conversation-controller] WP-E batch 2", () => {
  it("C8: kbSourceId is a typed non-empty scope anchor", async () => {
    const t = setup({ profile: "page" });
    expect(await t.controller.send({ presentationId: "host", text: "x", bodyExtras: { kbSourceId: "" } })).toBe("invalid");
    const { sse } = await begin(t, { bodyExtras: { kbSourceId: "manual" } });
    expect(t.net.lastChat().body).toMatchObject({ kbSourceId: "manual" });
    sse.close();
  });

  it("C9: followTurn follows on demand, more than once, never beside a live stream", async () => {
    const t = setup({ sessionId: "s-1" });
    await settle();
    expect(t.controller.followTurn()).toBe(false); // the hydrate follow is live
    t.net.status.current = { status: "idle", turnId: null };
    t.net.lastFollow().sse!.send("done", {});
    await settle();
    for (let round = 0; round < 2; round++) {
      const opened = t.net.follows.length;
      expect(t.controller.followTurn()).toBe(true);
      await settle();
      expect(t.net.follows.length).toBe(opened + 1);
      expect(t.controller.followTurn()).toBe(false);
      t.net.lastFollow().sse!.send("done", {});
      await settle();
    }
    const { sse } = await begin(t);
    expect(t.controller.followTurn()).toBe(false); // direct stream live
    sse.close();
  });

  it("C9: a turn_in_flight refusal hands the text back and follows the winning turn", async () => {
    const t = setup({ sessionId: "s-1", profile: "page" });
    await settle();
    t.net.status.current = { status: "idle", turnId: null };
    t.net.lastFollow().sse!.send("done", {});
    await settle();
    const rejected = vi.fn();
    const sent = t.controller.send({ presentationId: "host", text: "Mine", onRejected: rejected });
    await settle();
    const sse = t.net.lastChat().sse;
    sse.send("error", { code: "turn_in_flight", message: "Another turn is running" });
    sse.send("done", {});
    sse.close();
    expect(await sent).toBe("failed");
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(t.state().transcript.messages).toEqual([]);
    expect(t.state().notices).toContainEqual({ code: "error", errorCode: "turn_in_flight", message: "Another turn is running" });
    const follow = t.net.lastFollow();
    t.net.status.current = { status: "running", turnId: TURN_B };
    follow.sse!.send("status", { status: "running", turnId: TURN_B });
    await settle();
    expect(t.state().run.phase).toBe("running");
    expect(t.state().turnId).toBe(TURN_B);
  });

  it.each([
    [new Response(JSON.stringify({ code: "session_unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } }), "session_unauthorized"],
    [new Response("<html>bad gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } }), "http_502"],
    [new Response(JSON.stringify({ error: "bad" }), { status: 400 }), "http_400"],
  ])("C10: a non-2xx answer before any frame is a refusal (%#)", async (response, code) => {
    const t = setup({ sessionId: "s-1", profile: "page", capabilities: { pendingProbe: false } });
    await settle();
    t.net.status.current = { status: "idle", turnId: null };
    t.net.lastFollow().sse!.send("done", {});
    await settle();
    const follows = t.net.follows.length;
    t.net.refuseNextChat(response);
    const rejected = vi.fn();
    expect(await t.controller.send({ presentationId: "host", text: "Refused", onRejected: rejected })).toBe("failed");
    await settle();
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(t.state().notices).toContainEqual({ code: "error", errorCode: code });
    expect(t.state().transcript.messages).toEqual([]);
    expect(t.net.follows.length).toBe(follows);
    expect(t.state().run.phase).toBe("failed");
  });

  it("C10: a non-2xx event stream is read as frames, not refused", async () => {
    const t = setup({ profile: "page" });
    t.net.refuseNextChat(new Response(`event: error\ndata: {"code":"pending_question_exists","approvalId":"q-1","question":"Which?"}\n\nevent: done\ndata: {}\n\n`,
      { status: 409, headers: { "Content-Type": "text/event-stream" } }));
    void t.controller.send({ presentationId: "host", text: "x" });
    await settle();
    expect(t.state().notices.some((notice) => notice.code === "error" && notice.errorCode.startsWith("http_"))).toBe(false);
  });

  it("C11: the drained fallback send keeps the queued body fields and assistant", async () => {
    const t = setup({ profile: "page" });
    const { sent, sse } = await begin(t);
    const TARGET = "22222222-2222-4222-8222-222222222222";
    expect(t.controller.queue("edit the selection", true, { assistantId: "asst-9", bodyExtras: { officeSelection: { targetIds: [TARGET] }, ask: true } })).toBe(true);
    await settle();
    expect(t.net.sides.at(-1)).toMatchObject({ assistantId: "asst-9", officeSelection: { targetIds: [TARGET] }, steer: true });
    sse.send("done", { turnId: TURN_A });
    sse.close();
    await sent;
    await t.clock.advance(0);
    const fallback = t.net.lastChat().body;
    expect(fallback).toMatchObject({ message: "edit the selection", assistantId: "asst-9", officeSelection: { targetIds: [TARGET] }, ask: true });
    expect(fallback).not.toHaveProperty("midTurn");
    expect(fallback).not.toHaveProperty("steer");
  });
});

describe("[COMP:app-web/conversation-controller] final WP-E requests", () => {
  it("C14: an idle hydrate done keeps the approval card the same open restored", async () => {
    const net = fakeTransport();
    const confirmation = { toolCallId: "approval:ap-1", approvalId: "ap-1", toolName: "fileWrite", input: {}, sessionId: "s-1", status: "pending" as const };
    net.pending.current = { pending: null, toolConfirmation: confirmation };
    net.status.current = { status: "idle", turnId: null };
    const controller = createConversationController({ scope: SCOPE, sessionId: "s-1", transport: net.transport, scheduler: fakeScheduler().scheduler });
    controller.attach("page", { profile: "page" });
    await settle();
    net.lastFollow().sse!.send("status", { status: "idle" });
    net.lastFollow().sse!.send("done", {});
    await settle();
    expect(controller.getSnapshot().transcript.pendingConfirmations).toMatchObject([{ approvalId: "ap-1", restored: true }]);
    expect(controller.getSnapshot().interaction.pending).toMatchObject({ approvalId: "ap-1", source: "restored" });
  });

  it("C12: a mirrored input_applied takes the queued entry so it is never drained again", async () => {
    const t = setup({ profile: "page" });
    const { sent, sse } = await begin(t);
    t.controller.queue("folded in", false);
    sse.close(); // disconnect: the entry becomes uncertain and the follow takes over
    await sent;
    await settle();
    const follow = t.net.lastFollow().sse!;
    t.net.status.current = { status: "running", turnId: TURN_A };
    follow.send("status", { status: "running", turnId: TURN_A });
    const { inputId } = t.state().queued[0]!;
    follow.send("activity", { event: "input_applied", inputId, messageId: "row-input", turnId: TURN_A });
    await settle();
    expect(t.state().queued).toEqual([]);
    expect(t.state().transcript.messages.at(-1)).toMatchObject({ id: "row-input", role: "user", text: "folded in" });
    t.net.status.current = { status: "idle", turnId: TURN_A };
    follow.send("done", { turnId: TURN_A });
    await settle();
    await t.clock.advance(0);
    expect(t.state().unsent).toEqual([]);
    expect(t.net.chats).toHaveLength(1);
  });

  it("C13: queueDrain return hands leftover text back instead of sending a turn", async () => {
    const t = setup({ profile: "page", capabilities: { queueDrain: "return" } });
    const { sent, sse } = await begin(t);
    t.controller.queue("steer this", true);
    await settle();
    sse.send("done", { turnId: TURN_A });
    sse.close();
    await sent;
    await t.clock.advance(0);
    expect(t.net.chats).toHaveLength(1);
    expect(t.state().unsent).toEqual(["steer this"]);
  });

  it("C15: a restored question and a restored approval both show and resolve separately", async () => {
    const t = setup({ sessionId: "s-1", capabilities: { pendingProbe: false } });
    await settle();
    t.controller.presentQuestion({ approvalId: "q-1", question: "Which?", expiresAt: null, sessionId: "s-1" });
    t.controller.presentConfirmation({ toolCallId: "approval:ap-1", approvalId: "ap-1", toolName: "fileWrite", input: {}, sessionId: "s-1", status: "pending" });
    expect(t.state().question).toMatchObject({ approvalId: "q-1" });
    expect(t.state().transcript.pendingConfirmations).toMatchObject([{ approvalId: "ap-1", status: "pending" }]);
    expect(await t.controller.respondConfirmation("approval:ap-1", "approve")).toBe("resolved");
    expect(t.state().question).toMatchObject({ approvalId: "q-1" });
    expect(t.state().transcript.pendingConfirmations).toMatchObject([{ approvalId: "ap-1", status: "approved" }]);
    expect(t.controller.questionSettled("q-1")).toBe(true);
    expect(t.state().question).toBeNull();
  });

  it("C16: hydrating holds until the opening probe's first status", async () => {
    const t = setup({ sessionId: "s-1" });
    await settle();
    expect(t.state().hydrating).toBe(true);
    t.net.status.current = { status: "idle", turnId: null };
    t.net.lastFollow().sse!.send("status", { status: "idle" });
    await settle();
    expect(t.state().hydrating).toBe(false);
    // A rejected opening probe ends the follow, so the host is not held forever.
    const net = fakeTransport();
    net.followPlans.push(() => new Response("gone", { status: 404 }));
    const controller = createConversationController({ scope: SCOPE, sessionId: "s-2", transport: net.transport, scheduler: fakeScheduler().scheduler });
    controller.attach("host", { profile: "dock", pendingProbe: false });
    expect(controller.getSnapshot().hydrating).toBe(true);
    await settle();
    expect(controller.getSnapshot().hydrating).toBe(false);
  });

  it("follows the resumed turn after a restored approval resolves", async () => {
    const t = setup({ sessionId: "s-1", capabilities: { pendingProbe: false } });
    await settle();
    t.net.status.current = { status: "idle", turnId: null };
    t.net.lastFollow().sse!.send("done", {});
    await settle();
    t.controller.presentConfirmation({ toolCallId: "approval:ap-2", approvalId: "ap-2", toolName: "fileWrite", input: {}, sessionId: "s-1", status: "pending" });
    const opened = t.net.follows.length;
    expect(await t.controller.respondConfirmation("approval:ap-2", "approve")).toBe("resolved");
    await settle();
    expect(t.net.follows.length).toBe(opened + 1);
  });
});

describe("[COMP:app-web/conversation-controller] C18 per-entry drain policy", () => {
  it("Live's queued steering returns even after the page attaches later; the page's queue still sends", async () => {
    const t = setup({ profile: "page", capabilities: { queueDrain: "return" } }); // "host" plays the Live pane
    const { sent, sse } = await begin(t);
    expect(t.controller.queue("steer now", true, { presentationId: "host" })).toBe(true);
    t.controller.attach("page", { profile: "page" }); // attaches after Live, becomes latest
    expect(t.controller.queue("page follow-up", false, { presentationId: "page" })).toBe(true);
    await settle();
    sse.send("done", { turnId: TURN_A });
    sse.close();
    await sent;
    await t.clock.advance(0);
    expect(t.state().unsent).toEqual(["steer now"]);
    expect(t.net.chats.map((chat) => chat.body.message)).toEqual(["Hello", "page follow-up"]);
  });

  it("an entry queued without a presentation id takes the latest presentation's policy at queue time", async () => {
    const t = setup({ profile: "page", capabilities: { queueDrain: "return" } });
    const { sent, sse } = await begin(t);
    t.controller.queue("returned", true);
    t.controller.attach("page", { profile: "page" });
    await settle();
    sse.send("done", { turnId: TURN_A });
    sse.close();
    await sent;
    await t.clock.advance(0);
    expect(t.state().unsent).toEqual(["returned"]);
    expect(t.net.chats).toHaveLength(1);
  });
});
