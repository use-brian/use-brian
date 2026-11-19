// @vitest-environment jsdom
/**
 * [COMP:app-web/comment-thread-body] The comment thread as a presentation of
 * the shared conversation controller (M5 WP-E), on fake transports: a reply
 * turn posts the doc thread's own session with its model and research choice
 * (no `replyTarget`; no route reads it), a `turn_in_flight` refusal follows
 * the winning turn, a teammate's turn that starts while the thread is open is
 * followed on demand, a failed ending reads as `replyFailed` (a Stop does
 * not), surface effects reach the shell's buses, and error codes map to the
 * thread's copy without server text.
 */
import { describe, expect, it, vi } from "vitest";
import { createConversationController } from "@/lib/chat/conversation-controller";
import { createConversationRegistry } from "@/lib/chat/conversation-registry";
import { classifyTurnFrame } from "@/lib/chat/turn-frames";
import { SCOPE, TURN_A, TURN_B, fakeScheduler, fakeTransport, settle } from "@/lib/chat/__tests__/conversation-fakes";
import {
  applyCommentSurfaceEffect,
  commentLiveTurn,
  commentTurnErrorCopy,
  latestCommentEndNotice,
} from "../comment-thread-body";

function fixture() {
  const net = fakeTransport();
  const clock = fakeScheduler();
  const registry = createConversationRegistry({
    createController: (init) => createConversationController({ ...init, transport: net.transport, scheduler: clock.scheduler }),
    setTimeout: (callback, ms) => clock.scheduler.setTimeout(callback, ms),
    currentIdentity: () => ({ viewerId: SCOPE.viewerId, apiOrigin: SCOPE.apiOrigin }),
  });
  const thread = (sessionId: string) => {
    const controller = registry.acquire(SCOPE, { sessionId });
    registry.attach(controller, "comment", { profile: "dock", pendingProbe: false });
    return controller;
  };
  return { net, clock, thread };
}

const copy = {
  replyAccessUnavailable: "access", replyPageUnavailable: "page", replyFailed: "failed",
  sendUnconfirmed: "unconfirmed", loadError: "load",
};

describe("[COMP:app-web/comment-thread-body] reply turns on the controller", () => {
  it("posts the thread's session with the doc context, model and research mode", async () => {
    const t = fixture();
    t.net.status.current = { status: "idle", turnId: null };
    const controller = t.thread("thread-session");
    const send = controller.send({
      presentationId: "comment", text: "Tighten this paragraph", assistantId: "a1", fileIds: ["f1"], recordingIds: ["r1"],
      bodyExtras: { appOrigin: "doc", docViewId: "page-1", model: "standard", mode: "research" },
    });
    await settle();
    const body = t.net.lastChat().body;
    expect(body).toMatchObject({
      message: "Tighten this paragraph", sessionId: "thread-session", assistantId: "a1", appOrigin: "doc",
      docViewId: "page-1", model: "standard", mode: "research", fileIds: ["f1"], attachedRecordingIds: ["r1"],
    });
    expect(body).not.toHaveProperty("replyTarget");
    const sse = t.net.lastChat().sse;
    sse.send("user_message_saved", { id: "u1" });
    sse.send("tool_start", { id: "t1", name: "patchPage" });
    await settle();
    expect(commentLiveTurn(controller.getSnapshot())).toEqual({ text: "", toolName: "patchPage", mirrored: false });
    sse.send("text_delta", { text: "Done." });
    sse.send("done", { turnId: TURN_A });
    sse.close();
    expect(await send).toBe("completed");
    expect(commentLiveTurn(controller.getSnapshot())).toBeNull();
  });

  it("follows the winning turn after a turn_in_flight refusal", async () => {
    const t = fixture();
    const controller = t.thread("thread-race");
    const send = controller.send({ presentationId: "comment", text: "Seeded comment" });
    await settle();
    const sse = t.net.lastChat().sse;
    sse.send("error", { code: "turn_in_flight" });
    sse.send("done", {});
    sse.close();
    expect(await send).toBe("failed");
    // The winner is another copy's turn; the server's status names it.
    t.net.status.current = { status: "running", turnId: TURN_B };
    await settle();
    const follow = t.net.lastFollow();
    expect(follow.sessionId).toBe("thread-race");
    follow.sse!.send("status", { status: "running", turnId: TURN_B });
    follow.sse!.send("snapshot", { turnId: TURN_B, text: "The winning reply" });
    await settle();
    t.clock.runFrames();
    expect(commentLiveTurn(controller.getSnapshot())).toMatchObject({ text: "The winning reply", mirrored: true });
    expect(commentTurnErrorCopy("turn_in_flight", false, true, copy)).toBeNull();
  });

  it("follows a teammate's turn that starts while the thread is open, and states a failed ending", async () => {
    const t = fixture();
    t.net.status.current = { status: "idle", turnId: null };
    const controller = t.thread("thread-open");
    await settle();
    // The attach's one hydrate probe finds the thread idle.
    t.net.lastFollow().sse!.send("status", { status: "idle", turnId: null });
    t.net.lastFollow().sse!.send("done", {});
    await settle();
    const follows = t.net.follows.length;
    t.net.status.current = { status: "running", turnId: TURN_A };
    expect(controller.followTurn()).toBe(true);
    expect(controller.followTurn()).toBe(false);
    await settle();
    expect(t.net.follows.length).toBe(follows + 1);
    const follow = t.net.lastFollow().sse!;
    follow.send("status", { status: "running", turnId: TURN_A });
    follow.send("snapshot", { turnId: TURN_A, text: "A teammate's reply" });
    await settle();
    t.clock.runFrames();
    expect(commentLiveTurn(controller.getSnapshot())?.text).toBe("A teammate's reply");
    follow.send("turn_completed", { turnId: TURN_A, reason: "failed" });
    follow.send("done", {});
    await settle();
    expect(latestCommentEndNotice(controller.getSnapshot())).toMatchObject({ code: "turnEnd", reason: "failed" });
  });

  it("does not read a Stop as a failed reply", async () => {
    const t = fixture();
    const controller = t.thread("thread-stop");
    await settle();
    const follow = t.net.lastFollow().sse!;
    follow.send("status", { status: "running", turnId: TURN_A });
    follow.send("turn_completed", { turnId: TURN_A, reason: "stopped_by_user", stoppedByName: "Ada" });
    await settle();
    expect(latestCommentEndNotice(controller.getSnapshot())).toBeNull();
  });
});

describe("[COMP:app-web/comment-thread-body] error copy and surface effects", () => {
  it("maps reply errors to the thread's copy", () => {
    expect(commentTurnErrorCopy("delivery_audience_unverified", true, true, copy)).toBe("access");
    expect(commentTurnErrorCopy("authority_changed", false, true, copy)).toBe("access");
    expect(commentTurnErrorCopy("page_context_unavailable", true, false, copy)).toBe("page");
    // An ambiguous transport failure is quiet once the row is known saved.
    expect(commentTurnErrorCopy("stream_failed", true, true, copy)).toBeNull();
    expect(commentTurnErrorCopy("stream_failed", false, true, copy)).toBe("load");
    expect(commentTurnErrorCopy("stream_failed", true, false, copy)).toBe("load");
    // Server refusals (including HTTP refusals) never show server text.
    expect(commentTurnErrorCopy("model_unavailable", true, true, copy)).toBe("failed");
    expect(commentTurnErrorCopy("http_502", false, true, copy)).toBe("unconfirmed");
  });

  it("bridges page, title and recording effects to the shell and quota to the composer", () => {
    const seen: Array<[string, unknown]> = [];
    const listen = (name: string) => {
      const handler = (event: Event) => seen.push([name, (event as CustomEvent).detail]);
      window.addEventListener(name, handler);
      return () => window.removeEventListener(name, handler);
    };
    const stops = ["doc:draft-created", "doc:title-updated", "sidan:recording-participants-updated"].map(listen);
    const quota = vi.fn();
    const frame = (event: string, data: Record<string, unknown>) => classifyTurnFrame("direct", event, data);
    applyCommentSurfaceEffect(frame("page_created", { pageId: "p-new" }), quota);
    applyCommentSurfaceEffect(frame("doc_title_update", { pageId: "p1", title: "Plan", icon: "🌱", nameOrigin: "auto", overwrite: true }), quota);
    applyCommentSurfaceEffect(frame("recording_participants_updated", { recordingId: "rec-1" }), quota);
    applyCommentSurfaceEffect(frame("research_quota", { used: 2, quota: 3, isPaid: false }), quota);
    stops.forEach((stop) => stop());
    expect(seen).toEqual([
      ["doc:draft-created", { viewId: "p-new", action: "created" }],
      ["doc:title-updated", { pageId: "p1", title: "Plan", icon: "🌱", nameOrigin: "auto", overwrite: true }],
      ["sidan:recording-participants-updated", { recordingId: "rec-1" }],
    ]);
    expect(quota).toHaveBeenCalledWith({ type: "research_quota", used: 2, quota: 3, isPaid: false });
  });
});
