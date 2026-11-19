// @vitest-environment jsdom
/**
 * [COMP:app-web/floating-chat] The dock as a presentation of the shared
 * conversation controller (M5 WP-C), exercised with fake transports:
 * every dock instance on the doc thread binds one registry entry before and
 * after the `session` frame, surface effects run once in the instance that
 * started the turn, the dock profile keeps views on the committed reply, the
 * build-activity feed survives a remount, and notice codes map to this dock's
 * existing copy. Replaces the dock's own SSE loop, reconnect effect, turn refs
 * and Stop/approval callbacks (D15).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConversationController, type ConversationController } from "@/lib/chat/conversation-controller";
import { createConversationRegistry, provisionalConversationKey } from "@/lib/chat/conversation-registry";
import { classifyTurnFrame, type ClassifiedTurnFrame } from "@/lib/chat/turn-frames";
import { en } from "@/lib/i18n/dictionaries/en";
import { SCOPE, TURN_A, fakeScheduler, fakeTransport, settle } from "@/lib/chat/__tests__/conversation-fakes";
import {
  claimSurfaceSeed,
  dockErrorCopy,
  dockThreadKey,
  dockTurnNoticeCopy,
  hydrateDockBuildLog,
  observeDockBuildFrame,
  readDockBuildEvents,
  readDockThread,
  resetDockThread,
  updateDockThread,
} from "../floating-chat";

const narration = en.chat.toolNarration;

function fixture() {
  const net = fakeTransport();
  const clock = fakeScheduler();
  const registry = createConversationRegistry({
    createController: (init) => createConversationController({ ...init, transport: net.transport, scheduler: clock.scheduler }),
    setTimeout: (callback, ms) => clock.scheduler.setTimeout(callback, ms),
    currentIdentity: () => ({ viewerId: SCOPE.viewerId, apiOrigin: SCOPE.apiOrigin }),
  });
  // A fresh binding per test: the module keeps one per write authority.
  const origin = `doc-${Math.random().toString(36).slice(2)}`;
  const key = dockThreadKey(SCOPE, SCOPE.workspaceId, origin);
  /** What `FloatingChat` acquires for the current binding. */
  const acquire = (): ConversationController => {
    const binding = readDockThread(key);
    return registry.acquire(
      SCOPE,
      binding.sessionId
        ? { sessionId: binding.sessionId }
        : { provisional: provisionalConversationKey("dock", `${origin}:${binding.clientId}`) },
    );
  };
  /** One dock instance: attach with the dock profile and the dock's observer. */
  const instance = (id: string, controller: ConversationController) => {
    const effects: ClassifiedTurnFrame[] = [];
    const detach = registry.attach(controller, id, {
      profile: "dock",
      onSurfaceEffect: (frame) => effects.push(frame),
      onFrame: (frame) => {
        observeDockBuildFrame(controller, frame, narration);
        // The dock binds the shared thread the moment its turn gets a session.
        if (frame.stream === "direct" && frame.event === "session" && typeof frame.payload.sessionId === "string") {
          const sessionId = frame.payload.sessionId;
          updateDockThread(key, (current) => (current.sessionId ? null : { sessionId }));
        }
      },
      pendingProbe: false,
    });
    return { effects, detach };
  };
  return { net, clock, registry, key, origin, acquire, instance };
}

afterEach(() => vi.restoreAllMocks());

describe("[COMP:app-web/floating-chat] one doc thread, every dock instance", () => {
  it("binds the desktop dock and the drawer to one entry before and after the session frame", async () => {
    const t = fixture();
    const desktop = t.acquire();
    const drawer = t.acquire();
    expect(drawer).toBe(desktop);
    const dock = t.instance("dock-desktop", desktop);
    const sent = desktop.send({ presentationId: "dock-desktop", text: "Draft a plan" });
    await settle();
    const sse = t.net.lastChat().sse;
    sse.send("session", { sessionId: "s-1", turnId: TURN_A });
    sse.send("text_delta", { text: "Working on it" });
    await settle();
    t.clock.runFrames();
    // The binding moved to the session; acquiring now (a resize across `lg`,
    // the drawer opening) yields the same entry and the same live turn.
    expect(readDockThread(t.key).sessionId).toBe("s-1");
    const resized = t.acquire();
    expect(resized).toBe(desktop);
    const sheet = t.instance("dock-drawer", resized);
    expect(resized.getSnapshot().transcript.streamingText).toBe("Working on it");
    expect(t.net.chats).toHaveLength(1);
    sse.send("done", { turnId: TURN_A });
    sse.close();
    expect(await sent).toBe("completed");
    dock.detach();
    sheet.detach();
  });

  it("dispatches surface effects once, to the instance that started the turn, and keeps views on the reply", async () => {
    const t = fixture();
    const controller = t.acquire();
    const desktop = t.instance("dock-desktop", controller);
    const drawer = t.instance("dock-drawer", controller);
    const sent = controller.send({ presentationId: "dock-drawer", text: "Make a board" });
    await settle();
    const sse = t.net.lastChat().sse;
    sse.send("session", { sessionId: "s-2", turnId: TURN_A });
    sse.send("view_payload", { toolUseId: "tu-1", viewId: "page-9", action: "created", entity: "deals" });
    sse.send("doc_title_update", { pageId: "page-9", title: "Deals" });
    sse.send("text_delta", { text: "Done." });
    sse.send("assistant_message_saved", { id: "m-assistant" });
    sse.send("done", { turnId: TURN_A });
    sse.close();
    expect(await sent).toBe("completed");
    expect(drawer.effects.map((frame) => frame.event)).toEqual(["view_payload", "doc_title_update"]);
    expect(desktop.effects).toEqual([]);
    const reply = controller.getSnapshot().transcript.messages.at(-1) as { id: string; views?: Array<{ viewId?: string; action?: string }> };
    expect(reply.id).toBe("m-assistant");
    expect(reply.views).toEqual([expect.objectContaining({ viewId: "page-9", action: "created" })]);
  });

  it("starts a fresh entry on reset while the departing turn keeps its own stream", async () => {
    const t = fixture();
    const before = t.acquire();
    const dock = t.instance("dock-desktop", before);
    void before.send({ presentationId: "dock-desktop", text: "Long research" });
    await settle();
    const { epoch, clientId } = readDockThread(t.key);
    resetDockThread(t.key);
    const binding = readDockThread(t.key);
    expect(binding).toMatchObject({ sessionId: null, epoch: epoch + 1 });
    expect(binding.clientId).not.toBe(clientId);
    dock.detach();
    const after = t.acquire();
    expect(after).not.toBe(before);
    expect(after.getSnapshot().transcript.messages).toEqual([]);
    // Transport is never Stop: no stop request, the old turn stays live.
    expect(t.net.transport.stopTurn).not.toHaveBeenCalled();
    expect(before.hasLiveTurn()).toBe(true);
  });

  it("isolates bindings by identity and origin and starts over when local data is cleared", () => {
    const doc = dockThreadKey(SCOPE, SCOPE.workspaceId, "doc");
    expect(dockThreadKey({ ...SCOPE, viewerId: "viewer-2" }, SCOPE.workspaceId, "doc")).not.toBe(doc);
    expect(dockThreadKey({ ...SCOPE, apiOrigin: "https://other.example" }, SCOPE.workspaceId, "doc")).not.toBe(doc);
    expect(dockThreadKey(SCOPE, SCOPE.workspaceId, "brain")).not.toBe(doc);
    updateDockThread(doc, { sessionId: "s-private" });
    const { epoch } = readDockThread(doc);
    window.dispatchEvent(new Event("brian:local-data-cleared"));
    expect(readDockThread(doc)).toMatchObject({ sessionId: null, epoch: epoch + 1 });
  });

  it("M5Q-20: a surface seed after a resumed doc thread starts a fresh thread and posts no old sessionId", async () => {
    const t = fixture();
    // A reload resumed the latest doc session: the lookup ran and bound it.
    updateDockThread(t.key, { resumeLookup: true });
    updateDockThread(t.key, { sessionId: "s-old" });
    const resumed = t.acquire();
    expect(resumed.getSessionId()).toBe("s-old");
    // The seed resets the shared thread with `resume: false` (resetThread's default).
    resetDockThread(t.key, { resume: false });
    const binding = readDockThread(t.key);
    expect(binding).toMatchObject({ sessionId: null, resumeLookup: true });
    // The latest-session lookup bails on exactly this binding, so it cannot
    // re-bind the thread the seed just left.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(process.cwd(), "src/components/chrome/floating-chat.tsx"), "utf8");
    expect(source).toContain("if (binding.sessionId || binding.resumeLookup) return;");
    expect(source).toMatch(/if \(!claimSurfaceSeed\(seed\)\) return;\s*resetThread\(\);/);
    expect(source).toContain("resetDockThread(threadKeyRef.current, { resume: options.resume ?? false });");
    // The prefilled send goes out on the fresh provisional entry.
    const fresh = t.acquire();
    expect(fresh).not.toBe(resumed);
    t.instance("dock-desktop", fresh);
    void fresh.send({ presentationId: "dock-desktop", text: "Research my company", bodyExtras: { appOrigin: "doc" } });
    await settle();
    expect(t.net.lastChat().body).not.toHaveProperty("sessionId");
    expect(t.net.lastChat().body).toMatchObject({ message: "Research my company", appOrigin: "doc" });
  });

  it("an assistant switch off the doc surface still resumes that assistant's latest thread", () => {
    const t = fixture();
    updateDockThread(t.key, { resumeLookup: true, sessionId: "s-old" });
    resetDockThread(t.key, { resume: true });
    expect(readDockThread(t.key)).toMatchObject({ sessionId: null, resumeLookup: false });
    resetDockThread(t.key);
    expect(readDockThread(t.key).resumeLookup).toBe(false);
  });

  it("lets one dock instance own a surface seed", () => {
    const seed = { prefill: "Research my company", autoSend: true };
    expect(claimSurfaceSeed(seed)).toBe(true);
    expect(claimSurfaceSeed(seed)).toBe(false);
  });
});

describe("[COMP:app-web/floating-chat] turn controls through the controller", () => {
  it("never resends after a dropped stream: it re-attaches and follows the running turn", async () => {
    const t = fixture();
    const controller = t.acquire();
    t.instance("dock-desktop", controller);
    const sent = controller.send({ presentationId: "dock-desktop", text: "Summarize" });
    await settle();
    const sse = t.net.lastChat().sse;
    sse.send("session", { sessionId: "s-3", turnId: TURN_A });
    sse.send("text_delta", { text: "Half" });
    await settle();
    sse.close();
    expect(await sent).toBe("disconnected");
    await settle();
    expect(t.net.chats).toHaveLength(1);
    expect(t.net.follows.at(-1)?.sessionId).toBe("s-3");
    expect(controller.getSnapshot().notices).toContainEqual({ code: "reconnecting" });
    expect(controller.getSnapshot().mirror.active).toBe(true);
  });

  it("shows the askQuestion as a question, never an approval card, and follows the resumed turn", async () => {
    const t = fixture();
    const controller = t.acquire();
    t.instance("dock-desktop", controller);
    const sent = controller.send({ presentationId: "dock-desktop", text: "Book it" });
    await settle();
    const sse = t.net.lastChat().sse;
    sse.send("session", { sessionId: "s-4", turnId: TURN_A });
    // The suspended question is persisted server-side; when the turn ends
    // the pending-input probe presents it with its approvalId and text.
    t.net.pending.current = { pending: { approvalId: "ap-1", question: "Which date?", expiresAt: null }, toolConfirmation: null };
    sse.send("tool_confirmation_required", { toolCallId: "tc-q", toolName: "askQuestion" });
    sse.send("done", { turnId: TURN_A });
    sse.close();
    await sent;
    await settle();
    const state = controller.getSnapshot();
    expect(state.transcript.pendingConfirmations).toEqual([]);
    expect(state.interaction.pending).toMatchObject({ kind: "question", approvalId: "ap-1", payload: { question: "Which date?", sessionId: "s-4" } });
    // The panel posted the answer itself; settling follows the session
    // stream instead of polling messages.
    const follows = t.net.follows.length;
    expect(controller.questionSettled("ap-1")).toBe(true);
    await settle();
    expect(t.net.follows.length).toBe(follows + 1);
    expect(t.net.transport.answerQuestion).not.toHaveBeenCalled();
    expect(controller.getSnapshot().interaction.pending).toBeNull();
  });

  it("maps a 403 approval to confirmNotAllowed and leaves the card retryable", async () => {
    const t = fixture();
    const controller = t.acquire();
    t.instance("dock-desktop", controller);
    void controller.send({ presentationId: "dock-desktop", text: "Send the email" });
    await settle();
    const sse = t.net.lastChat().sse;
    sse.send("session", { sessionId: "s-5", turnId: TURN_A });
    sse.send("tool_confirmation_required", { toolCallId: "tc-1", toolName: "gmailSend", approvalId: "ap-2" });
    await settle();
    t.net.transport.confirmLive.mockResolvedValueOnce({ ok: false, status: 403 });
    expect(await controller.respondConfirmation("tc-1", "approve")).toBe("forbidden");
    const state = controller.getSnapshot();
    expect(state.notices).toContainEqual({ code: "confirmNotAllowed" });
    expect(state.transcript.pendingConfirmations[0]).toMatchObject({ toolCallId: "tc-1", status: "pending" });
  });
});

describe("[COMP:app-web/floating-chat] build-activity feed", () => {
  const frame = (event: string, data: unknown) => classifyTurnFrame("direct", event, data);

  it("folds reasoning runs and build steps in arrival order, retracting dropped steps", () => {
    const owner = {};
    observeDockBuildFrame(owner, frame("reasoning", { text: "Looking at " }), narration);
    observeDockBuildFrame(owner, frame("reasoning", { text: "the page" }), narration);
    observeDockBuildFrame(owner, frame("tool_start", { id: "t1", name: "patchPage" }), narration);
    // A re-emitted start keeps the existing row.
    observeDockBuildFrame(owner, frame("tool_start", { id: "t1", name: "patchPage" }), narration);
    observeDockBuildFrame(owner, frame("tool_start", { id: "t2", name: "askQuestion" }), narration);
    observeDockBuildFrame(owner, frame("tool_dropped", { id: "t2" }), narration);
    const events = readDockBuildEvents(owner);
    expect(events.map((event) => event.kind)).toEqual(["reasoning", "step"]);
    expect(events[1]).toMatchObject({ kind: "step", toolId: "t1" });
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
    // A mid-turn split starts a new feed.
    observeDockBuildFrame(owner, frame("input_applied", { inputId: "in-1" }), narration);
    expect(readDockBuildEvents(owner)).toEqual([]);
  });

  it("rebuilds the feed from the controller's log for an instance that returns mid-turn", async () => {
    const t = fixture();
    const controller = t.acquire();
    const dock = t.instance("dock-desktop", controller);
    void controller.send({ presentationId: "dock-desktop", text: "Build it" });
    await settle();
    const sse = t.net.lastChat().sse;
    sse.send("session", { sessionId: "s-6", turnId: TURN_A });
    sse.send("reasoning", { text: "Planning" });
    sse.send("tool_start", { id: "t1", name: "patchPage" });
    await settle();
    const live = readDockBuildEvents(controller).map((event) => event.kind);
    dock.detach();
    // A remounted instance (a fresh renderer-side feed) replays the log.
    const replayed = { getBuildLog: () => controller.getBuildLog() };
    hydrateDockBuildLog(replayed, narration);
    expect(readDockBuildEvents(replayed).map((event) => event.kind)).toEqual(live);
    expect(live).toEqual(["reasoning", "step"]);
  });
});

describe("[COMP:app-web/floating-chat] notice codes map to existing copy", () => {
  const t = en.chat;
  const tChatApp = en.chatApp;
  it.each([
    [{ code: "error", errorCode: "upstream_connection_reset" } as const, tChatApp.upstreamConnectionReset],
    [{ code: "error", errorCode: "upstream_connection_reset", customEndpoint: true } as const, tChatApp.upstreamConnectionResetCustom],
    [{ code: "error", errorCode: "upstream_unreachable" } as const, tChatApp.upstreamUnreachable],
    [{ code: "error", errorCode: "session_assistant_mismatch" } as const, tChatApp.sessionRebound],
    [{ code: "error", errorCode: "stream_interrupted" } as const, t.streamInterrupted],
    [{ code: "error", errorCode: "stream_failed" } as const, t.streamInterrupted],
    [{ code: "error", errorCode: "insufficient_credits", message: "Out of credits" } as const, "Out of credits"],
    [{ code: "error", errorCode: "something_new" } as const, t.error],
  ])("error %j", (notice, copy) => {
    expect(dockErrorCopy(notice, t, tChatApp)).toBe(copy);
  });

  it("translates known turn notices and keeps server text for the rest", () => {
    expect(dockTurnNoticeCopy({ code: "turnNotice", notice: "budget_downgraded" }, t)).toBe(t.noticeBudgetDowngraded);
    expect(dockTurnNoticeCopy({ code: "turnNotice", notice: "custom_model_image_fallback", message: "raw" }, t)).toBe(t.noticeCustomModelImageFallback);
    expect(dockTurnNoticeCopy({ code: "turnNotice", notice: "new_notice", message: "Server says" }, t)).toBe("Server says");
    expect(dockTurnNoticeCopy({ code: "turnNotice", notice: "silent" }, t)).toBeNull();
  });
});
